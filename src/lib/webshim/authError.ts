/**
 * Renders a plain-DOM overlay when the server rejects our token.
 *
 * Deliberately not a React component: this can fire before React has mounted
 * (the very first `invoke()` in `main.tsx`'s `bootstrap()`), and it must not
 * depend on i18n or any app state that might itself be what's failing to load.
 */

const OVERLAY_ATTR = "data-cc-switch-auth-error";

let shown = false;

/** Idempotent: repeated 401s (one per failed `invoke()`) show the message once. */
export function showAuthErrorOnce(): void {
  if (shown || document.querySelector(`[${OVERLAY_ATTR}]`)) {
    shown = true;
    return;
  }
  shown = true;

  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTR, "");
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-live", "assertive");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(15,15,15,0.92)",
    "color:#f5f5f5",
    "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
    "padding:24px",
    "text-align:center",
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = "max-width:440px;line-height:1.5;";

  const title = document.createElement("p");
  title.style.cssText = "font-size:18px;font-weight:600;margin:0 0 12px;";
  title.textContent = "Session token rejected";

  const body = document.createElement("p");
  body.style.cssText = "font-size:14px;margin:0;opacity:0.85;";
  body.textContent =
    "This tab's token is missing or no longer valid. Reopen the URL printed " +
    "in the terminal that started the server, or restart it and open the " +
    "new URL it prints.";

  box.appendChild(title);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
