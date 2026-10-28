/**
 * Browser-mode replacement for `@tauri-apps/api/window`.
 *
 * Aliased only when `BUILD_TARGET=web`. Without this, `getCurrentWindow()`
 * reads `window.__TAURI_INTERNALS__.metadata` and throws — which callers do
 * catch, but it would log an error on every page load from `App.tsx`'s mount
 * effect. A browser tab has no OS window to drive, so the honest shape is a
 * window object whose queries return neutral values and whose commands are
 * no-ops rather than crashes.
 */

export type UnlistenFn = () => void;

/** Only the members this app actually uses are implemented. */
class BrowserWindow {
  constructor(readonly label: string) {}

  async isMaximized(): Promise<boolean> {
    // A tab is neither maximized nor restorable by script; the app renders its
    // own window controls off this, so `false` keeps them in the inert state.
    return false;
  }

  async isMinimized(): Promise<boolean> {
    return false;
  }

  async onResized(): Promise<UnlistenFn> {
    return () => {};
  }

  async onFocusChanged(): Promise<UnlistenFn> {
    return () => {};
  }

  async setDecorations(): Promise<void> {}

  async minimize(): Promise<void> {}

  async maximize(): Promise<void> {}

  async unmaximize(): Promise<void> {}

  async toggleMaximize(): Promise<void> {}

  async setFocus(): Promise<void> {}

  async show(): Promise<void> {}

  async hide(): Promise<void> {}

  /** Closing the tab is the user's call, not the app's. */
  async close(): Promise<void> {}
}

const current = new BrowserWindow("main");

export function getCurrentWindow(): BrowserWindow {
  return current;
}

export function getAllWindows(): BrowserWindow[] {
  return [current];
}

export { BrowserWindow as Window };
