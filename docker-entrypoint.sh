#!/bin/sh
# Launch the same headless `server` binary npm mode ships, bound so the
# published port is reachable from outside the container.
set -eu

port="${PORT:-3369}"
host="${HOST:-0.0.0.0}"

set -- --host "$host" --port "$port" --no-open
if [ -n "${TOKEN:-}" ]; then
  set -- "$@" --token "$TOKEN"
fi

exec /app/server "$@"
