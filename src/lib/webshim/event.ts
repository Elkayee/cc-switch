/**
 * Browser-mode replacement for `@tauri-apps/api/event`.
 *
 * Vite aliases `@tauri-apps/api/event` to this module when `BUILD_TARGET=web`.
 * Backed by a single `EventSource` on `/api/events` that every `listen()` call
 * shares, so N subscriptions cost one connection rather than N — the backend
 * registers one Tauri listener set per connection.
 */

import { getServerToken } from "./core";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
export type EventName = string;

export interface Options {
  target?: unknown;
}

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let nextId = 1;

/** Opens the shared stream on first use, and re-attaches per-event listeners. */
function ensureSource(): void {
  if (source) return;

  const token = getServerToken();
  // EventSource cannot set headers, so the token goes in the query string; the
  // server accepts it there for exactly this reason.
  const url = token
    ? `/api/events?token=${encodeURIComponent(token)}`
    : "/api/events";
  const created = new EventSource(url);

  created.onerror = () => {
    // EventSource reconnects on its own, and the backend drops the old
    // listener set when the connection closes. Nothing to do but surface it.
    if (created.readyState === EventSource.CLOSED) {
      console.warn("[webshim] event stream closed");
    }
  };

  source = created;
  for (const name of handlers.keys()) {
    attach(name);
  }
}

const attached = new Set<string>();

function attach(name: string): void {
  if (!source || attached.has(name)) return;
  attached.add(name);

  source.addEventListener(name, (raw) => {
    const set = handlers.get(name);
    if (!set || set.size === 0) return;

    let payload: unknown;
    try {
      payload = JSON.parse((raw as MessageEvent<string>).data);
    } catch {
      // Tauri emits `()` for payload-less events, which serializes to "null";
      // anything genuinely unparseable is passed through raw rather than
      // dropped, so a handler can still react to the event having happened.
      payload = (raw as MessageEvent<string>).data;
    }

    // Snapshot: a handler may unlisten (or listen) during iteration.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[webshim] handler for "${name}" threw`, error);
      }
    }
  });
}

export function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  void options;

  const id = nextId++;
  const wrapped: Handler = (payload) => {
    handler({ event, id, payload: payload as T });
  };

  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(wrapped);

  ensureSource();
  attach(event);

  // Promise-returning to match Tauri's real signature: callers `await listen(...)`.
  return Promise.resolve(() => {
    const current = handlers.get(event);
    current?.delete(wrapped);
  });
}

export async function once<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  const off = await listen<T>(
    event,
    (evt) => {
      off();
      handler(evt);
    },
    options,
  );
  return off;
}

/**
 * Emitting from the frontend has no browser-mode equivalent: the SSE bridge is
 * one-directional (backend → browser). Nothing in this app emits from the
 * frontend, so this rejects rather than failing silently.
 */
export function emit<T>(event: string, payload?: T): Promise<void> {
  void payload;
  return Promise.reject(
    new Error(`emit("${event}") is not available in browser mode`),
  );
}

export function emitTo<T>(
  target: unknown,
  event: string,
  payload?: T,
): Promise<void> {
  void target;
  void payload;
  return Promise.reject(
    new Error(`emitTo("${event}") is not available in browser mode`),
  );
}

export enum TauriEvent {
  WINDOW_RESIZED = "tauri://resize",
  WINDOW_MOVED = "tauri://move",
  WINDOW_CLOSE_REQUESTED = "tauri://close-requested",
  WINDOW_DESTROYED = "tauri://destroyed",
  WINDOW_FOCUS = "tauri://focus",
  WINDOW_BLUR = "tauri://blur",
  WINDOW_SCALE_FACTOR_CHANGED = "tauri://scale-change",
  WINDOW_THEME_CHANGED = "tauri://theme-changed",
  WINDOW_CREATED = "tauri://window-created",
  WEBVIEW_CREATED = "tauri://webview-created",
  DRAG_ENTER = "tauri://drag-enter",
  DRAG_OVER = "tauri://drag-over",
  DRAG_DROP = "tauri://drag-drop",
  DRAG_LEAVE = "tauri://drag-leave",
}
