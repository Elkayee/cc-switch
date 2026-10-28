/**
 * Browser-mode replacements for the small Tauri surfaces this app touches
 * outside of `core`/`event`/`window`.
 *
 * Each is aliased individually in `vite.config.ts`. They exist so that code
 * paths reaching them degrade in a way the user can act on, instead of throwing
 * `__TAURI_INTERNALS__ is undefined` from deep inside a vendored module.
 */

import { version as APP_VERSION } from "../../../package.json";

// ---------------------------------------------------------------------------
// @tauri-apps/plugin-dialog
// ---------------------------------------------------------------------------

export interface MessageDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
}

/**
 * The native message dialog is blocking and modal. `window.alert` is the
 * browser's closest equivalent, and the one call site (a fatal config-load
 * error) genuinely needs the user to see it before the app gives up.
 */
export async function message(
  text: string,
  options?: MessageDialogOptions,
): Promise<void> {
  const title = typeof options === "object" ? options?.title : undefined;
  window.alert(title ? `${title}\n\n${text}` : text);
}

export async function ask(
  text: string,
  options?: MessageDialogOptions,
): Promise<boolean> {
  const title = typeof options === "object" ? options?.title : undefined;
  return window.confirm(title ? `${title}\n\n${text}` : text);
}

export async function confirm(
  text: string,
  options?: MessageDialogOptions,
): Promise<boolean> {
  return ask(text, options);
}

/** File pickers have no browser equivalent here; the bridge rejects them too. */
export async function open(): Promise<null> {
  throw new Error("File dialogs are not available in browser mode");
}

export async function save(): Promise<null> {
  throw new Error("File dialogs are not available in browser mode");
}

// ---------------------------------------------------------------------------
// @tauri-apps/plugin-process
// ---------------------------------------------------------------------------

/**
 * There is no process to exit from a tab. Closing the document is the closest
 * honest behavior: the one caller uses this to stop the user interacting with a
 * broken config, and the server keeps running under npx either way.
 */
export async function exit(code = 0): Promise<void> {
  console.warn(`[webshim] exit(${code}) requested; closing the page instead`);
  window.close();
  // `window.close()` is a no-op for a tab the script did not open, so make the
  // UI unusable rather than appearing to work.
  document.body.innerHTML =
    "<p style='font:14px system-ui;padding:2rem'>Viber Switch has stopped. You can close this tab.</p>";
}

export async function relaunch(): Promise<void> {
  window.location.reload();
}

// ---------------------------------------------------------------------------
// @tauri-apps/api/app
// ---------------------------------------------------------------------------

/** So the About screen shows the real version rather than a placeholder. */
export async function getVersion(): Promise<string> {
  return APP_VERSION;
}

export async function getName(): Promise<string> {
  return "Viber Switch";
}

export async function getTauriVersion(): Promise<string> {
  return "";
}

// ---------------------------------------------------------------------------
// @tauri-apps/plugin-log
// ---------------------------------------------------------------------------

/**
 * Frontend logs go to the browser console instead of the backend log file. The
 * alternative would be a bridged command per log line, which is a lot of
 * traffic for something the devtools already show.
 */
export async function error(message: string): Promise<void> {
  console.error(message);
}

export async function warn(message: string): Promise<void> {
  console.warn(message);
}

export async function info(message: string): Promise<void> {
  console.info(message);
}

export async function debug(message: string): Promise<void> {
  console.debug(message);
}

export async function trace(message: string): Promise<void> {
  console.debug(message);
}
