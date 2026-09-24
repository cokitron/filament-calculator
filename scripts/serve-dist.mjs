/**
 * Static file server for the production build, shared by the browser checks.
 *
 * Deliberately sets NO Cross-Origin-Opener-Policy or Cross-Origin-Embedder-Policy
 * headers, matching static Figma Make hosting. If the app ever needed them,
 * SQLite would fail to open here — which is the point.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: this project's directory contains spaces and
// .pathname leaves them percent-encoded, which makes every readFile 404.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

/** Start serving dist/ on `port`. Returns the server, already listening. */
export async function serveDist(port) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
      const body = await readFile(join(DIST, rel))
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  return server
}
