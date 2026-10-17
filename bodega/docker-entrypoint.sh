#!/bin/sh
set -eu
# Railway mounts volumes as root. Prepare the private state directory, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/.bodega
  chown node:node /app/.bodega
  chmod 700 /app/.bodega
  exec gosu node "$@"
fi
exec "$@"
