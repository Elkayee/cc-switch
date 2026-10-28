export async function check(): Promise<null> {
  return null;
}

export async function downloadAndInstall(): Promise<void> {
  throw new Error("App updates are not available in browser mode");
}
