# Deploy image for browser (npm) mode: the same `server` binary and sibling
# `dist/` that `npx @spec-ade/cli-switch` ships.
#
# Build from this directory:
#   docker build -t cc-switch .
# Run:
#   docker run --rm -p 3369:3369 -v cc-switch-data:/data cc-switch

# ---------- frontend (BUILD_TARGET=web) ----------
FROM oven/bun:1.3.14 AS frontend
WORKDIR /web

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY vite.config.ts tsconfig.json tsconfig.node.json \
     tailwind.config.cjs postcss.config.cjs components.json ./
COPY src ./src

ENV BUILD_TARGET=web
RUN bun run build:web

# ---------- rust server binary ----------
FROM rust:1.95-slim-bookworm AS builder

# Tauri keeps its default `wry` feature even under `server-runtime`, so the
# headless binary still links WebKitGTK. clang is for rquickjs-sys bindgen.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config libssl-dev clang libclang-dev \
        libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
        libwebkit2gtk-4.1-dev libsoup-3.0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY rust-toolchain.toml ./
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
COPY src-tauri/tauri.conf.json src-tauri/build.rs \
     src-tauri/common-controls.manifest src-tauri/Info.plist ./src-tauri/
COPY src-tauri/capabilities ./src-tauri/capabilities
COPY src-tauri/icons ./src-tauri/icons
# `generate_context!()` reads frontendDist (`../dist`) at compile time.
COPY --from=frontend /web/dist-web ./dist
COPY src-tauri/src ./src-tauri/src

WORKDIR /src/src-tauri
RUN cargo build --release --bin server --features server-runtime

# ---------- runtime ----------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
        libgtk-3-0 librsvg2-2 libayatana-appindicator3-1 \
        libwebkit2gtk-4.1-0 libsoup-3.0-0 \
        libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=builder /src/src-tauri/target/release/server /app/server
COPY --from=frontend /web/dist-web /app/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/server /app/docker-entrypoint.sh \
    && chown -R app:app /app /data

USER app
ENV HOME=/data \
    PORT=3369 \
    HOST=0.0.0.0

EXPOSE 3369
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3369}/" >/dev/null

ENTRYPOINT ["/app/docker-entrypoint.sh"]
