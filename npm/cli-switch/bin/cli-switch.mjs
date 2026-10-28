#!/usr/bin/env node
// Launcher for @spec-ade/cli-switch: detects the current platform, resolves
// the matching prebuilt-binary package (an esbuild-style optional dependency),
// and execs its `server` binary with the arguments this was invoked with.
//
// Deliberately dependency-free: this is the one file every install runs
// before anything else exists, so it should not have its own install step
// that can fail.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES = {
  "win32-x64": "@spec-ade/cli-switch-win32-x64",
  "win32-arm64": "@spec-ade/cli-switch-win32-arm64",
  "darwin-x64": "@spec-ade/cli-switch-darwin-x64",
  "darwin-arm64": "@spec-ade/cli-switch-darwin-arm64",
  "linux-x64": "@spec-ade/cli-switch-linux-x64",
  "linux-arm64": "@spec-ade/cli-switch-linux-arm64",
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function binaryName() {
  return process.platform === "win32" ? "server.exe" : "server";
}

function resolveServerBinary() {
  const key = platformKey();
  const pkgName = PLATFORM_PACKAGES[key];

  if (!pkgName) {
    const supported = Object.keys(PLATFORM_PACKAGES).join(", ");
    fail(
      `cli-switch does not ship a prebuilt binary for "${key}".\n` +
        `Supported platforms: ${supported}.`,
    );
  }

  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  } catch {
    fail(
      `The "${pkgName}" package is not installed.\n\n` +
        `This usually means npm skipped an optional dependency for your platform.\n` +
        `Try:\n` +
        `  npm install ${pkgName}\n` +
        `or reinstall with optional dependencies enabled:\n` +
        `  npm install --include=optional @spec-ade/cli-switch`,
    );
  }

  const binaryPath = path.join(path.dirname(pkgJsonPath), "bin", binaryName());
  if (!existsSync(binaryPath)) {
    fail(
      `"${pkgName}" is installed but is missing its binary at:\n  ${binaryPath}\n` +
        `The package may be corrupted; try reinstalling it.`,
    );
  }

  return binaryPath;
}

function fail(message) {
  console.error(`cli-switch: ${message}`);
  process.exit(1);
}

function main() {
  const binaryPath = resolveServerBinary();
  const args = process.argv.slice(2);

  const child = spawn(binaryPath, args, { stdio: "inherit" });

  child.on("error", (error) => {
    fail(`failed to start the server binary: ${error.message}`);
  });

  // Forward the child's exit as our own, and pass through signals so Ctrl+C
  // stops the server instead of leaving it orphaned.
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}

main();
