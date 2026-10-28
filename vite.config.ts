import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      // 托盘面板是单独的入口，不加载主界面
      input: {
        main: path.resolve(__dirname, "src/index.html"),
        "tray-panel": path.resolve(__dirname, "src/tray-panel.html"),
      },
    },
  },
  server: {
    port: 54264,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Browser (server) mode: swap Tauri's IPC/window/plugin modules for
      // HTTP-backed shims, so the existing call sites keep importing
      // "@tauri-apps/*" unchanged. Desktop builds are unaffected.
      ...(process.env.BUILD_TARGET === "web"
        ? {
            "@tauri-apps/api/core": path.resolve(
              __dirname,
              "./src/lib/webshim/core.ts",
            ),
            "@tauri-apps/api/event": path.resolve(
              __dirname,
              "./src/lib/webshim/event.ts",
            ),
            "@tauri-apps/api/window": path.resolve(
              __dirname,
              "./src/lib/webshim/window.ts",
            ),
            "@tauri-apps/api/path": path.resolve(
              __dirname,
              "./src/lib/webshim/path.ts",
            ),
            "@tauri-apps/api/app": path.resolve(
              __dirname,
              "./src/lib/webshim/misc.ts",
            ),
            "@tauri-apps/plugin-dialog": path.resolve(
              __dirname,
              "./src/lib/webshim/misc.ts",
            ),
            "@tauri-apps/plugin-process": path.resolve(
              __dirname,
              "./src/lib/webshim/misc.ts",
            ),
            "@tauri-apps/plugin-log": path.resolve(
              __dirname,
              "./src/lib/webshim/misc.ts",
            ),
            "@tauri-apps/plugin-updater": path.resolve(
              __dirname,
              "./src/lib/webshim/updater.ts",
            ),
          }
        : {}),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
