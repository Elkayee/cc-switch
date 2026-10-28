/**
 * Browser-mode replacement for `@tauri-apps/api/path`.
 *
 * Used only to build the placeholder paths shown in the directory settings UI.
 * The browser cannot know the host's home directory, so it is derived from the
 * backend's own app-config path (`~/.cc-switch/config.json`) — the same value
 * the server resolves — rather than guessed.
 */

import { invoke } from "./core";

let cachedHome: string | null = null;

function separatorFor(path: string): string {
  return path.includes("\\") && !path.startsWith("/") ? "\\" : "/";
}

export async function homeDir(): Promise<string> {
  if (cachedHome !== null) return cachedHome;

  try {
    // `<home>/.cc-switch/config.json` → `<home>`, honoring a config-dir
    // override by walking up from the file rather than assuming a layout.
    const configPath = await invoke<string>("get_app_config_path");
    const sep = separatorFor(configPath);
    const parts = configPath.split(sep);
    parts.pop(); // config.json
    parts.pop(); // .cc-switch
    cachedHome = parts.join(sep) || sep;
  } catch (error) {
    console.warn("[webshim] could not resolve home directory", error);
    cachedHome = "~";
  }

  return cachedHome;
}

export async function join(...parts: string[]): Promise<string> {
  const [first = ""] = parts;
  const sep = separatorFor(first);
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0 ? part.replace(/[/\\]+$/, "") : part.replace(/^[/\\]+/, ""),
    )
    .join(sep);
}

export async function appConfigDir(): Promise<string> {
  return join(await homeDir(), ".cc-switch");
}

export function sep(): string {
  return separatorFor(cachedHome ?? "/");
}
