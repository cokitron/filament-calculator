#!/bin/sh
# Hand the volume to the unprivileged user, then drop privileges.
#
# Railway attaches the volume after the image is built and mounts it owned by
# root, which discards the chown done in the Dockerfile. So the container has to
# start as root, take ownership of the mount, and only then become `node` —
# otherwise the server cannot create the SQLite file and exits with
# ERR_SQLITE_ERROR "unable to open database file".
set -eu

DB_DIR="$(dirname "${DATABASE_PATH:-/data/printdesk.sqlite3}")"

mkdir -p "$DB_DIR"
# Only the mount point itself needs fixing. -R would rewrite every page of an
# existing database on every boot, which gets slower as the data grows.
chown node:node "$DB_DIR"

# BusyBox `su` rather than su-exec/gosu: it is already in the base image, so the
# build needs no package installation and no network.
#
# Both `exec`s matter. The outer one replaces this script, the inner one replaces
# the shell that `su` starts, so the server ends up as PID 1 and receives
# Railway's SIGTERM directly — that is what lets it close SQLite and checkpoint
# the WAL instead of being killed mid-write.
exec su node -s /bin/sh -c 'exec "$@"' -- sh "$@"
