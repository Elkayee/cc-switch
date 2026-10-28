#!/usr/bin/env node
// Stamps a version across the launcher and all platform packages.
//
// The versions in `npm/**/package.json` are placeholders: CI derives the real
// one from the release tag. Without this, a release of v3.20.0 would publish
// npm packages still labelled 3.19.2 — either wrong, or rejected outright as an
// already-published version.
//
// The launcher pins its platform packages at an exact version, so its
// `optionalDependencies` must move in lockstep; a mismatch there installs fine
// and only fails at run time with "package is not installed".
//
// Usage:
//   node npm/set-version.mjs 3.20.0
//   node npm/set-version.mjs 3.20.0 --check      # verify only, write nothing
//   node npm/set-version.mjs 3.20.0 --allow-app-mismatch

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NPM_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(NPM_DIR, "..");

const PLATFORMS = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

/** Thrown by `normalizeVersion` instead of exiting, so it stays a pure
 * function that other scripts (the release workflow's version-resolve step)
 * can import and call without pulling in this file's CLI side effects. */
export class InvalidVersionError extends Error {}

function fail(message) {
  console.error(`set-version: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (const arg of argv) {
    if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return { version: positional[0], flags };
}

/**
 * Accepts `1.2.3`, `v1.2.3`, `npm-v1.2.3` and prerelease/build suffixes, so the
 * same function works for a release tag or a bare version.
 *
 * Exported (and side-effect-free — throws instead of calling `process.exit`)
 * so the release workflow's version-resolve step can import and reuse the
 * exact same validation instead of keeping a second regex in sync by hand.
 */
export function normalizeVersion(raw) {
  if (!raw) {
    throw new InvalidVersionError(
      "a version is required, e.g. `node npm/set-version.mjs 3.20.0`",
    );
  }
  const stripped = raw
    .trim()
    .replace(/^npm-v/, "")
    .replace(/^v/, "");
  const semver =
    /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(stripped)) {
    throw new InvalidVersionError(
      `\`${raw}\` is not a valid semver version (parsed as \`${stripped}\`)`,
    );
  }
  return stripped;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Preserves the trailing newline so the write is a clean one-line diff. */
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const { version: rawVersion, flags } = parseArgs(process.argv.slice(2));
  let version;
  try {
    version = normalizeVersion(rawVersion);
  } catch (error) {
    if (error instanceof InvalidVersionError) fail(error.message);
    throw error;
  }
  const checkOnly = flags.has("--check");

  // The npm packages ship the same app as the desktop bundles, so a version
  // that disagrees with the app's own is almost always a mistagged release.
  // npm publishes are irreversible, so this fails rather than warns.
  const appVersion = readJson(path.join(REPO_ROOT, "package.json")).version;
  if (version !== appVersion && !flags.has("--allow-app-mismatch")) {
    fail(
      `version \`${version}\` does not match the app version \`${appVersion}\` ` +
        `(package.json).\nBump the app version first, or pass ` +
        `--allow-app-mismatch if the divergence is intentional.`,
    );
  }

  const changes = [];

  const launcherPath = path.join(NPM_DIR, "cli-switch", "package.json");
  const launcher = readJson(launcherPath);
  changes.push([launcherPath, launcher.version, version]);
  launcher.version = version;

  const optional = launcher.optionalDependencies ?? {};
  for (const platform of PLATFORMS) {
    const name = `@spec-ade/cli-switch-${platform}`;
    if (!(name in optional)) {
      fail(`launcher is missing the optional dependency \`${name}\``);
    }
    optional[name] = version;
  }
  // Guard against a platform being added to the launcher but not to PLATFORMS,
  // which would leave it pinned at a stale version.
  for (const name of Object.keys(optional)) {
    if (optional[name] !== version) {
      fail(
        `\`${name}\` is an optional dependency but not in this script's ` +
          `PLATFORMS list, so it kept the stale version \`${optional[name]}\``,
      );
    }
  }

  const platformPaths = PLATFORMS.map((platform) => {
    const file = path.join(NPM_DIR, "platforms", platform, "package.json");
    if (!fs.existsSync(file)) fail(`missing platform package: ${file}`);
    return [platform, file];
  });

  const platformPackages = platformPaths.map(([platform, file]) => {
    const pkg = readJson(file);
    changes.push([file, pkg.version, version]);
    pkg.version = version;
    return [platform, file, pkg];
  });

  if (checkOnly) {
    const stale = changes.filter(([, from, to]) => from !== to);
    if (stale.length > 0) {
      console.error(
        `set-version --check: ${stale.length} file(s) out of date:`,
      );
      for (const [file, from, to] of stale) {
        console.error(`  ${path.relative(REPO_ROOT, file)}: ${from} -> ${to}`);
      }
      process.exit(1);
    }
    console.log(`All npm packages already at ${version}.`);
    return;
  }

  writeJson(launcherPath, launcher);
  for (const [, file, pkg] of platformPackages) {
    writeJson(file, pkg);
  }

  console.log(`Set npm package versions to ${version}:`);
  for (const [file, from, to] of changes) {
    const marker = from === to ? "=" : "*";
    console.log(
      `  ${marker} ${path.relative(REPO_ROOT, file)}: ${from} -> ${to}`,
    );
  }
}

// Only run the CLI when this file is invoked directly
// (`node npm/set-version.mjs`), not when it is `import`ed by another script
// (e.g. the workflow's version-resolve step) — otherwise importing it would
// drag in the file-writing and process-exiting behaviour too.
//
// Uses `pathToFileURL` rather than concatenating `file://` + the path:
// `process.argv[1]` may be relative, and on Windows the correct URL is
// `file:///D:/...` (three slashes) — hand-built strings never match, and the
// CLI would silently do nothing.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
