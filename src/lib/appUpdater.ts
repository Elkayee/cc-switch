export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type AppUpdateInfo = {
  version: string;
  body?: string | null;
  downloadAndInstall: (
    onEvent?: (event: DownloadEvent) => void,
  ) => Promise<void>;
};

export async function checkAppUpdate(): Promise<AppUpdateInfo | null> {
  if (!isDesktopApp()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      body: update.body,
      downloadAndInstall: (onEvent) => update.downloadAndInstall(onEvent),
    };
  } catch (error) {
    console.error("[appUpdater] check failed", error);
    throw error;
  }
}

export async function installAppUpdate(
  update: AppUpdateInfo,
  onProgress?: (percent: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      downloaded = 0;
      onProgress?.(total ? 0 : null);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(
        total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
      );
    } else if (event.event === "Finished") {
      onProgress?.(100);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
