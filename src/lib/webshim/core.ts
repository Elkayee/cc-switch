/**
 * Browser-mode replacement for `@tauri-apps/api/core`.
 *
 * Vite aliases `@tauri-apps/api/core` to this module when `BUILD_TARGET=web`,
 * so the ~30 existing `invoke()` call sites are untouched — they keep importing
 * the Tauri path and get this implementation instead.
 *
 * Backed by `POST /api/invoke`, which dispatches through the same Tauri IPC
 * engine the desktop webview uses, so argument and return shapes are identical.
 */

import { showAuthErrorOnce } from "./authError";

export type InvokeArgs =
  Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;

export interface InvokeOptions {
  headers?: Record<string, string> | Headers;
}

const TOKEN_STORAGE_KEY = "cc-switch:server-token";

/**
 * The server prints a URL containing the token and opens it. We move the token
 * into `localStorage` and strip it from the address bar on first load, so it
 * does not linger in history, bookmarks, or a copy-pasted URL.
 *
 * `localStorage` (not `sessionStorage`): the `--token` value a user chooses is
 * stable across restarts, unlike the old auto-generated one, so a bookmarked
 * tab or a freshly opened one should still find it rather than starting from
 * scratch each time.
 */
function readToken(): string {
  let token = "";
  try {
    token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    // Private-mode or blocked storage — fall through to the URL.
  }

  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    token = fromUrl;
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // Keep the in-memory value; only persistence failed.
    }
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }

  return token;
}

let cachedToken: string | null = null;

export function getServerToken(): string {
  if (cachedToken === null) {
    cachedToken = readToken();
  }
  return cachedToken;
}

/** Drops a token that the server just rejected, so it is not retried forever. */
function forgetServerToken(): void {
  cachedToken = "";
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}

/** Thrown for transport-level failures, to keep them distinguishable from a command's own error. */
export class InvokeTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InvokeTransportError";
  }
}

export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  const token = getServerToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch("/api/invoke", {
    method: "POST",
    headers,
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });

  if (response.ok) {
    // 204 or an empty body maps to the unit return of a `-> Result<(), _>` command.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  if (response.status === 401) {
    // A previously-working token stopped being accepted (server restarted
    // with a different `--token`, or this tab's copy is simply wrong) or none
    // was ever available. Either way retrying with the same value cannot
    // succeed, and the failure is otherwise invisible: this is commonly the
    // very first `invoke()` in `bootstrap()`, before React has rendered
    // anything a user could see.
    forgetServerToken();
    showAuthErrorOnce();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new InvokeTransportError(
      `invoke("${cmd}") failed with HTTP ${response.status}`,
      response.status,
    );
  }

  // The bridge envelopes command errors as `{ error: <value> }`. Rejecting with
  // the inner value matches what Tauri's real `invoke()` rejects with, so
  // existing error handling keeps working unchanged.
  if (payload && typeof payload === "object" && "error" in payload) {
    throw (payload as { error: unknown }).error;
  }
  throw payload;
}

/** False by design: this build is not running inside a Tauri webview. */
export function isTauri(): boolean {
  return false;
}

export function convertFileSrc(filePath: string, protocol = "asset"): string {
  // No custom protocol handler exists in browser mode; returning the path
  // unchanged is the closest honest answer.
  void protocol;
  return filePath;
}

export const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

/**
 * `transformCallback` and `Channel` exist so that anything importing them from
 * `@tauri-apps/api/core` still type-checks under the alias. Channels are a
 * streaming IPC primitive with no HTTP equivalent here, and nothing in this app
 * uses them; they throw rather than silently doing nothing.
 */
export function transformCallback(): number {
  throw new Error("transformCallback is not available in browser mode");
}

export class Channel<T = unknown> {
  id = 0;
  constructor(onmessage?: (response: T) => void) {
    void onmessage;
    throw new Error("Channel is not available in browser mode");
  }
}

/**
 * The remaining exports exist because the alias also intercepts Tauri's own
 * plugin packages (`plugin-updater`, `plugin-dialog`, ...), which import them
 * from `@tauri-apps/api/core`. They must resolve for the bundle to build.
 *
 * Their commands are plugin-prefixed (`plugin:updater|...`) and are not
 * registered on the server's `invoke_handler`, so calling one fails with a
 * "not found" error from the bridge — the same class of failure as any other
 * unavailable native feature, surfaced at the call site rather than hidden.
 */
export class Resource {
  constructor(readonly rid: number) {}

  async close(): Promise<void> {
    // No resource table in browser mode; nothing to release.
  }
}

export class PluginListener {
  constructor(
    readonly plugin: string,
    readonly event: string,
    readonly channelId: number,
  ) {}

  async unregister(): Promise<void> {}
}

export function addPluginListener<T>(
  plugin: string,
  event: string,
  cb: (payload: T) => void,
): Promise<PluginListener> {
  void cb;
  return Promise.reject(
    new Error(
      `addPluginListener("${plugin}", "${event}") is not available in browser mode`,
    ),
  );
}

export type PermissionState =
  "granted" | "denied" | "prompt" | "prompt-with-rationale";

export function checkPermissions<T>(plugin: string): Promise<T> {
  return Promise.reject(
    new Error(`checkPermissions("${plugin}") is not available in browser mode`),
  );
}

export function requestPermissions<T>(plugin: string): Promise<T> {
  return Promise.reject(
    new Error(
      `requestPermissions("${plugin}") is not available in browser mode`,
    ),
  );
}
