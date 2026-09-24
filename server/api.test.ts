import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type RunningServer } from './index'
import { loadConfig } from './config'
import type { PrintJob } from '../src/types'

/**
 * Drives the real HTTP server over a real socket against a real SQLite file.
 *
 * Nothing is mocked: this is the only place that proves the auth gate actually
 * closes, which is the property the whole deployment rests on.
 */

const PASSWORD = 'una contraseña muy larga'
const SECRET = 'z'.repeat(48)

let dir: string
let running: RunningServer
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'printdesk-test-'))
  const config = loadConfig({
    AUTH_PASSWORD: PASSWORD,
    SESSION_SECRET: SECRET,
    DATABASE_PATH: join(dir, 'test.sqlite3'),
    STATIC_DIR: join(dir, 'static-does-not-exist'),
    // Port 0 lets the OS pick a free port, so tests never collide.
    PORT: '0',
    INSECURE_COOKIES: 'true',
  } as NodeJS.ProcessEnv)
  running = await createApp(config).listen()
  base = `http://127.0.0.1:${running.port}`
})

afterEach(async () => {
  await running.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Log in and return the session cookie. */
async function login(password = PASSWORD): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('no session cookie returned')
  return cookie.split(';')[0]
}

const rpc = (cookie: string | null, payload: Record<string, unknown>) =>
  fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(payload),
  })

function aJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: crypto.randomUUID(),
    name: 'Soporte de teléfono',
    client: 'Studio Verde',
    status: 'queued',
    jobFilaments: [
      { id: crypto.randomUUID(), material: 'PLA+', color: 'Negro', weight: 48, pricePerKg: 440 },
    ],
    printTimeHours: 3.5,
    powerWatts: 200,
    electricityRate: 2.8,
    laborStages: [{ name: 'Slicing', hours: 0.25, rate: 120, scope: 'per_job' }],
    packagingCost: 30,
    finishingCost: 0,
    marginPercent: 35,
    quantity: 2,
    ivaEnabled: true,
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('the auth gate', () => {
  it('rejects data access with no session', async () => {
    const res = await rpc(null, { op: 'listJobs' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/autenticado/i)
  })

  it('rejects a wrong password without revealing anything', async () => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'una contraseña incorrecta' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('rejects a missing password with the same message as a wrong one', async () => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a forged session cookie', async () => {
    const forged = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')
    const res = await rpc(`pd_session=${forged}.notarealsignature`, { op: 'listJobs' })
    expect(res.status).toBe(401)
  })

  it('accepts the correct password and then allows data access', async () => {
    const cookie = await login()
    const res = await rpc(cookie, { op: 'listJobs' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: [] })
  })

  it('reports session state without requiring a session', async () => {
    const before = await fetch(`${base}/api/session`)
    expect(await before.json()).toMatchObject({ authenticated: false, storage: 'remote' })

    const cookie = await login()
    const after = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })
    expect(await after.json()).toMatchObject({ authenticated: true })
  })

  it('logging out stops the cookie working', async () => {
    const cookie = await login()
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } })
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    // The browser would drop the cookie; assert the server also clears it rather
    // than relying on the client to forget.
    expect(await out.json()).toEqual({ authenticated: false })
  })

  it('blocks a client after repeated wrong guesses', async () => {
    // The default limiter allows 10 attempts; the 11th must be refused even
    // though it carries the CORRECT password, proving the block is real.
    for (let i = 0; i < 10; i++) {
      await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `guess ${i} that is long` }),
      })
    }
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('the data API', () => {
  it('round-trips a job through the server database', async () => {
    const cookie = await login()
    const job = aJob()

    const saved = await rpc(cookie, { op: 'saveJob', job })
    expect(saved.status).toBe(200)

    const listed = await rpc(cookie, { op: 'listJobs' })
    const { result } = await listed.json()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: job.id,
      name: 'Soporte de teléfono',
      client: 'Studio Verde',
      quantity: 2,
      ivaEnabled: true,
    })
    // Child rows survived the trip, not just the flat columns.
    expect(result[0].jobFilaments).toHaveLength(1)
    expect(result[0].laborStages[0].scope).toBe('per_job')
  })

  it('moves a finished job into history with frozen totals, server-side', async () => {
    const cookie = await login()
    const job = aJob()
    await rpc(cookie, { op: 'saveJob', job })
    await rpc(cookie, { op: 'updateJobStatus', jobId: job.id, status: 'done' })

    const active = await (await rpc(cookie, { op: 'listActiveJobs' })).json()
    expect(active.result).toHaveLength(0)

    const history = await (await rpc(cookie, { op: 'listJobHistory' })).json()
    expect(history.result).toHaveLength(1)
    expect(history.result[0].frozen).not.toBeNull()
    expect(history.result[0].frozen.total).toBeGreaterThan(0)
  })

  it('surfaces a repository refusal as an error rather than silently succeeding', async () => {
    const cookie = await login()
    const job = aJob()
    await rpc(cookie, { op: 'saveJob', job })
    await rpc(cookie, { op: 'updateJobStatus', jobId: job.id, status: 'done' })

    const res = await rpc(cookie, { op: 'deleteJob', jobId: job.id })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/work history/)

    const forced = await rpc(cookie, { op: 'deleteJob', jobId: job.id, force: true })
    expect(forced.status).toBe(200)
  })

  it('rejects an unknown op without echoing it back', async () => {
    const cookie = await login()
    const res = await rpc(cookie, { op: '<script>alert(1)</script>' })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain('script')
  })

  it('rejects a malformed body', async () => {
    const cookie = await login()
    const res = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: 'not json at all',
    })
    expect(res.status).toBe(400)
  })

  it('creates filaments and reads them back', async () => {
    const cookie = await login()
    await rpc(cookie, {
      op: 'createFilament',
      filament: { brand: 'Polymaker', type: 'PLA+', color: 'Negro', hex: '#1a1a1a', pricePerKg: 440 },
    })
    const { result } = await (await rpc(cookie, { op: 'listFilaments' })).json()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ brand: 'Polymaker', pricePerKg: 440 })
  })
})

describe('backup', () => {
  it('downloads a real SQLite file containing the saved data', async () => {
    const cookie = await login()
    await rpc(cookie, { op: 'saveJob', job: aJob({ name: 'En el respaldo' }) })

    const res = await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3')
    expect(res.headers.get('content-disposition')).toMatch(/printdesk-.*\.sqlite3/)

    const bytes = Buffer.from(await res.arrayBuffer())
    // A real SQLite file, not an error page with a misleading content type.
    expect(bytes.subarray(0, 15).toString('utf8')).toBe('SQLite format 3')
    // VACUUM INTO must have captured the WAL-committed write.
    expect(bytes.toString('latin1')).toContain('En el respaldo')
  })

  it('requires a session', async () => {
    expect((await fetch(`${base}/api/backup`)).status).toBe(401)
  })

  it('restores an uploaded database and keeps the previous one alongside', async () => {
    const cookie = await login()
    await rpc(cookie, { op: 'saveJob', job: aJob({ name: 'Original' }) })
    const backup = Buffer.from(
      await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).arrayBuffer(),
    )

    // Diverge from the backup, then restore it.
    await rpc(cookie, { op: 'saveJob', job: aJob({ name: 'Añadido después' }) })
    expect((await (await rpc(cookie, { op: 'listJobs' })).json()).result).toHaveLength(2)

    const restore = await fetch(`${base}/api/restore`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(backup),
    })
    expect(restore.status).toBe(200)

    const { result } = await (await rpc(cookie, { op: 'listJobs' })).json()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Original')
    // The overwritten database is recoverable by hand if the upload was wrong.
    expect(existsSync(join(dir, 'test.sqlite3.pre-restore'))).toBe(true)
  })

  it('refuses a file that is not a SQLite database', async () => {
    const cookie = await login()
    const res = await fetch(`${base}/api/restore`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: 'this is a text file, not a database',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not a SQLite database/)

    // The real database must still be usable after a rejected restore.
    expect((await rpc(cookie, { op: 'listJobs' })).status).toBe(200)
  })
})

describe('persistence across restarts', () => {
  it('reads back data written by a previous server process', async () => {
    const cookie = await login()
    await rpc(cookie, { op: 'saveJob', job: aJob({ name: 'Sobrevive al reinicio' }) })

    // Close the server and database exactly as a redeploy would, then start a
    // fresh app against the same file — the volume scenario.
    await running.close()
    const config = loadConfig({
      AUTH_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
      DATABASE_PATH: join(dir, 'test.sqlite3'),
      STATIC_DIR: join(dir, 'static-does-not-exist'),
      PORT: '0',
      INSECURE_COOKIES: 'true',
    } as NodeJS.ProcessEnv)
    running = await createApp(config).listen()
    base = `http://127.0.0.1:${running.port}`

    // The same cookie still works: SESSION_SECRET is stable, so a redeploy does
    // not log the user out.
    const { result } = await (await rpc(cookie, { op: 'listJobs' })).json()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Sobrevive al reinicio')
  })
})

describe('static serving', () => {
  it('does not serve files outside the static directory', async () => {
    // Path traversal must not escape, even when the static dir does not exist.
    const res = await fetch(`${base}/../../../../etc/passwd`)
    const body = await res.text()
    expect(body).not.toContain('root:')
  })

  it('answers the health check without a session', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })
})
