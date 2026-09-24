# PrintDesk production image.
#
# The app is a pure static bundle: HTML, JS, CSS and the 869 KB SQLite WASM
# binary. There is no server-side application and no server-side database —
# SQLite runs in the browser and stores its file in OPFS, on the user's device.
# This image therefore only has to serve files, and serve them with the right
# content types: an incorrect MIME type on the .wasm binary is the one failure
# that appears in production and never in local development.
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
RUN pnpm build

# --- Serve ------------------------------------------------------------------
FROM caddy:2.9.1-alpine

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

# Railway injects PORT; the Caddyfile defaults it for local `docker run`.
EXPOSE 8080
