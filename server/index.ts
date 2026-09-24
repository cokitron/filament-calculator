import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  SESSION_COOKIE,
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  LoginRateLimiter,
  readCookie,
  secretsMatch,
  verifySessionToken,
} from './auth'
import { type ServerConfig } from './config'
import { openDatabase, exportDatabase, importDatabase, type ServerDatabase } from './db'
import { handleRpc, UnknownOpError, type RpcRequest } from './api'

/**
 * PrintDesk server: the static frontend, plus an authenticated data API over a
 * SQLite file on a persistent volume.
 *
 * Everything under /api requires a valid session except /api/login and
 * /api/session, and the default for an unrecognised path is to serve the app
 * shell — never to fall through to the filesystem.
 */

/** Request body caps. An unbounded read is a trivial way to exhaust memory. */
const MAX_RPC_BODY_BYTES = 2 * 1024 * 1024 // 2 MB: a job payload is a few KB
const MAX_RESTORE_BODY_BYTES = 256 * 1024 * 1024 // 256 MB: a whole database file

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/** Headers applied to every response. */
function baseSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The app renders business data; deny it being embedded or probed.
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
}

/** Read a request body with a hard size cap, aborting early if exceeded. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        // Destroy rather than just rejecting: otherwise the client keeps sending
        // and the socket holds the memory we are trying not to allocate.
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Client identity for rate limiting.
 *
 * Railway puts the real client address in X-Forwarded-For; the socket address is
 * its proxy and would lump every user together. Only the first hop is used, as
 * the rest are attacker-supplied.
 */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (raw) {
    const first = raw.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export function createApp(config: ServerConfig) {
  let db: ServerDatabase = openDatabase(config.databasePath)
  const limiter = new LoginRateLimiter()

  const isAuthenticated = (req: IncomingMessage): boolean =>
    verifySessionToken(config.sessionSecret, readCookie(req.headers.cookie, SESSION_COOKIE)).valid

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    // --- Session state: safe to call unauthenticated, reveals nothing ------
    if (pathname === '/api/session' && req.method === 'GET') {
      sendJson(res, 200, { authenticated: isAuthenticated(req), storage: 'remote' })
      return
    }

    // --- Login -------------------------------------------------------------
    if (pathname === '/api/login' && req.method === 'POST') {
      const key = clientKey(req)
      const retryAfterMs = limiter.retryAfterMs(key)
      if (retryAfterMs > 0) {
        sendJson(
          res,
          429,
          { error: 'Demasiados intentos. Espera unos minutos.' },
          { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
        )
        return
      }

      let password = ''
      try {
        const body = await readBody(req, 4096)
        password = String((JSON.parse(body.toString('utf8')) as { password?: unknown }).password ?? '')
      } catch {
        sendJson(res, 400, { error: 'Solicitud inválida.' })
        return
      }

      if (!password || !secretsMatch(password, config.password)) {
        limiter.recordFailure(key)
        // One generic message: distinguishing "no password sent" from "wrong
        // password" tells an attacker their request shape was accepted.
        sendJson(res, 401, { error: 'Contraseña incorrecta.' })
        return
      }

      limiter.recordSuccess(key)
      const token = createSessionToken(config.sessionSecret, config.sessionTtlSeconds)
      sendJson(res, 200, { authenticated: true }, {
        'Set-Cookie': buildSessionCookie(token, {
          secure: config.secureCookies,
          maxAgeSeconds: config.sessionTtlSeconds,
        }),
      })
      return
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      sendJson(res, 200, { authenticated: false }, {
        'Set-Cookie': buildLogoutCookie({ secure: config.secureCookies }),
      })
      return
    }

    // --- Everything below requires a session ------------------------------
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: 'No autenticado.' })
      return
    }

    if (pathname === '/api/rpc' && req.method === 'POST') {
      let msg: RpcRequest
      try {
        const body = await readBody(req, MAX_RPC_BODY_BYTES)
        msg = JSON.parse(body.toString('utf8')) as RpcRequest
      } catch (err) {
        sendJson(res, 400, { error: 'Solicitud inválida.' })
        console.warn('[rpc] bad request:', (err as Error).message)
        return
      }
      if (!msg || typeof msg.op !== 'string') {
        sendJson(res, 400, { error: 'Solicitud inválida.' })
        return
      }

      try {
        const result = handleRpc(db.executor, msg)
        sendJson(res, 200, { ok: true, result: result === undefined ? null : result })
      } catch (err) {
        const status = err instanceof UnknownOpError ? 400 : 500
        // The repository's messages are written for the user (constraint
        // violations, "job is part of the work history"), so they are returned.
        // Anything unexpected still surfaces as a message, which is acceptable
        // for a single-tenant tool and far more debuggable than a blank 500.
        console.error(`[rpc] op=${msg.op} failed:`, err)
        sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // --- Backup download ---------------------------------------------------
    if (pathname === '/api/backup' && req.method === 'GET') {
      try {
        const bytes = exportDatabase(db)
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        res.writeHead(200, {
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Length': bytes.byteLength,
          'Content-Disposition': `attachment; filename="printdesk-${stamp}.sqlite3"`,
          'Cache-Control': 'no-store',
        })
        res.end(bytes)
      } catch (err) {
        console.error('[backup] failed:', err)
        sendJson(res, 500, { error: 'No se pudo exportar la base de datos.' })
      }
      return
    }

    // --- Backup restore ----------------------------------------------------
    if (pathname === '/api/restore' && req.method === 'POST') {
      try {
        const bytes = await readBody(req, MAX_RESTORE_BODY_BYTES)
        db = importDatabase(db, bytes, openDatabase)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        console.error('[restore] failed:', err)
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Restore falló.' })
      }
      return
    }

    sendJson(res, 404, { error: 'No encontrado.' })
  }

  /** Serve a file from the build output, or the app shell. */
  function serveStatic(res: ServerResponse, pathname: string): void {
    const root = resolve(config.staticDir)
    // Normalise, then confirm the result is still inside the root. Without this
    // check a path like /../../etc/passwd would escape the static directory.
    const requested = resolve(join(root, normalize(pathname)))
    const insideRoot = requested === root || requested.startsWith(root + sep)

    let filePath = requested
    if (!insideRoot || !existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = join(root, 'index.html')
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }

    const ext = extname(filePath)
    const isHashedAsset = filePath.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Vite fingerprints asset filenames, so they never change in place.
      // index.html must not be cached or a deploy leaves clients on a stale
      // bundle whose asset hashes no longer exist.
      'Cache-Control': isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, must-revalidate',
      ...baseSecurityHeaders(),
    })
    createReadStream(filePath).pipe(res)
  }

  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0])

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, schema: db.schema.to })
      return
    }

    if (pathname.startsWith('/api/')) {
      // Security headers on API responses too, so an error page cannot be framed
      // or sniffed into something executable.
      for (const [k, v] of Object.entries(baseSecurityHeaders())) res.setHeader(k, v)
      handleApi(req, res, pathname).catch(err => {
        console.error('[api] unhandled:', err)
        if (!res.headersSent) sendJson(res, 500, { error: 'Error interno.' })
      })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }

    serveStatic(res, pathname)
  })

  return {
    server,
    listen(): Promise<RunningServer> {
      return new Promise(resolvePromise => {
        server.listen(config.port, () => {
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : config.port
          resolvePromise({
            port,
            close: () =>
              new Promise<void>(done => {
                server.close(() => {
                  db.close()
                  done()
                })
              }),
          })
        })
      })
    },
  }
}
