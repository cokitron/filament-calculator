# PrintDesk production image.
#
# Serves the frontend AND the data API, with SQLite on a mounted volume. The
# frontend is built with VITE_STORAGE_MODE=remote so the browser talks to that
# API instead of opening its own in-browser database — the two modes are
# mutually exclusive, and the choice is made here at build time rather than
# guessed at runtime.
#
# Versions are pinned rather than floating on :alpine so a rebuild months from
# now produces the same image.

# --- Build ------------------------------------------------------------------
FROM node:22.14.0-alpine AS build

WORKDIR /app

# pnpm version matches .mise.toml, so CI, local and this image resolve the
# lockfile identically.
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

# Dependencies first: this layer is cached unless the lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# The frontend, wired to the server API.
RUN VITE_STORAGE_MODE=remote pnpm build

# The server and the data layer it shares with the frontend, compiled to
# CommonJS (see tsconfig.server.json for why).
RUN pnpm build:server

# --- Runtime ----------------------------------------------------------------
FROM node:22.14.0-alpine

WORKDIR /app

# node:sqlite is built in, and the server has no npm dependencies at all, so no
# node_modules are installed here. Smaller image, and nothing to audit.
ENV NODE_ENV=production

COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./public
# Read at runtime by server/db.ts to create or migrate the database. Resolved
# relative to WORKDIR, which is why this path matters.
COPY --from=build /app/src/db/schema.sql ./src/db/schema.sql

ENV STATIC_DIR=/app/public
# Must point at a Railway volume mount. Without one the container filesystem is
# ephemeral and every redeploy would silently start from an empty database.
ENV DATABASE_PATH=/data/printdesk.sqlite3

# Drop privileges: the server only ever needs to read the bundle and read/write
# the database file.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# No shell form, so the process is PID 1 and receives Railway's SIGTERM directly
# — which is what lets it close SQLite cleanly and checkpoint the WAL.
CMD ["node", "dist-server/server/main.js"]
