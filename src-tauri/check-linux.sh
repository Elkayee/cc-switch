#!/usr/bin/env bash
# Type-checks the crate for Linux in a container, because several files are
# `#[cfg(target_os = "linux")]`-only and are therefore invisible to any check
# run on Windows or macOS. A `WebviewWindow` hard-coded to the default `Wry`
# runtime inside such a file compiles fine everywhere else and only fails on a
# Linux runner — a 15-minute CI round trip per attempt.
#
# Cross-compiling from Windows does not work here: `aws-lc-sys` builds C code
# and needs a Linux C toolchain, so this runs inside Linux instead.
#
# Usage (from src-tauri/):
#   bash check-linux.sh                  # default features
#   bash check-linux.sh server-runtime   # browser-mode feature
set -euo pipefail

FEATURES="${1:-}"
IMAGE="cc-switch-linux-check:1.95"

cd "$(dirname "$0")/.."

# Git Bash on Windows rewrites container-absolute paths and mangles `--build-arg`
# style flags; this disables that rewriting for every docker invocation below.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

echo "==> docker build (uses layer cache; only slow the first time or after Cargo.toml changes)"
docker build -f src-tauri/Dockerfile.linux-check -t "$IMAGE" .

feature_args=()
if [ -n "$FEATURES" ]; then
  feature_args=(--features "$FEATURES")
fi

echo "==> cargo check --target x86_64-unknown-linux-gnu ${feature_args[*]:-}"
# No bind mount: Docker Desktop file sharing is not reliably available in this
# environment, so the Dockerfile COPYs sources in and this just runs the check
# against that copy. A named volume still caches the build output across runs.
docker run --rm \
  -v cc-switch-linux-target:/work/src-tauri/target \
  -e CARGO_TERM_COLOR=always \
  "$IMAGE" \
  cargo check --target x86_64-unknown-linux-gnu --all-targets "${feature_args[@]}"
