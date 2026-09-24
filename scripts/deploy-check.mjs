/**
 * Deployment smoke check: drive a *running* PrintDesk URL in a real browser.
 *
 * Complements scripts/e2e-check.mjs, which serves dist/ itself. This one points
 * at a deployed origin (a container, or the live Railway URL) so it also
 * validates the things only a real server decides: the .wasm content type, the
 * cache headers, TLS, and that no proxy strips or rewrites the WASM payload.
 *
 * With a password it additionally checks the server-backed deployment: that the
 * data API refuses unauthenticated callers, that the password gate works, and
 * that data written through the UI is really on the server.
 *
 * Usage:
 *   node scripts/deploy-check.mjs <url>              # local OPFS build
 *   node scripts/deploy-check.mjs <url> <password>   # server-backed build
 */
import { chromium } from 'playwright'

const target = process.argv[2]
const password = process.argv[3] ?? process.env.AUTH_PASSWORD ?? ''
if (!target) {
  console.error('usage: node scripts/deploy-check.mjs <url> [password]')
  process.exit(2)
}
const remoteMode = Boolean(password)

const fail = msg => {
  console.error(`✗ FAIL: ${msg}`)
  process.exitCode = 1
}
const pass = msg => console.log(`✓ ${msg}`)

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext()
const page = await context.newPage()

const consoleErrors = []
const failedResources = []
// The WASM binary is requested by the Web Worker, not the page, so it never
// appears in the main thread's performance entries. Observing responses at the
// network level is the only way to see it.
const wasmResponses = []
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
page.on('response', r => {
  if (r.status() >= 400) failedResources.push(`${r.status()} ${r.url()}`)
  if (r.url().endsWith('.wasm')) {
    wasmResponses.push({
      url: r.url(),
      status: r.status(),
      type: r.headers()['content-type'],
      cache: r.headers()['cache-control'],
    })
  }
})

try {
  // --- The security property, checked before anything else ------------------
  // A server-backed deployment is a public URL holding business data. If the API
  // answers without a session, nothing else about the deploy matters.
  if (remoteMode) {
    const probe = await fetch(new URL('/api/rpc', target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'listJobs' }),
    })
    if (probe.status !== 401) {
      fail(`UNAUTHENTICATED API ACCESS: /api/rpc returned ${probe.status}, expected 401`)
    } else {
      pass('data API refuses unauthenticated callers (401)')
    }

    const backupProbe = await fetch(new URL('/api/backup', target))
    if (backupProbe.status !== 401) {
      fail(`UNAUTHENTICATED BACKUP DOWNLOAD: /api/backup returned ${backupProbe.status}`)
    } else {
      pass('backup download refuses unauthenticated callers (401)')
    }

    const wrong = await fetch(new URL('/api/login', target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'definitivamente incorrecta' }),
    })
    if (wrong.status !== 401) fail(`wrong password returned ${wrong.status}, expected 401`)
    else if (wrong.headers.get('set-cookie')) fail('a failed login still issued a session cookie')
    else pass('wrong password rejected with no session cookie')
  }

  const response = await page.goto(target, { waitUntil: 'load', timeout: 60_000 })
  if (!response?.ok()) fail(`page returned HTTP ${response?.status()}`)
  else pass(`page served (HTTP ${response.status()})`)

  // Secure context is not optional for the local build: OPFS, and therefore all
  // persistence, is unavailable on plain HTTP outside localhost.
  const secure = await page.evaluate(() => window.isSecureContext)
  if (!secure && !target.includes('127.0.0.1') && !target.includes('localhost')) {
    fail('origin is not a secure context — cookies and OPFS both need HTTPS')
  } else {
    pass(`secure context: ${secure}`)
  }

  await page.waitForSelector('#root', { timeout: 15_000 })

  // --- Log in ---------------------------------------------------------------
  if (remoteMode) {
    await page.waitForSelector('#pd-password', { timeout: 20_000 })
    pass('password gate shown before any data is reachable')

    // A wrong password must not let the app through.
    await page.fill('#pd-password', 'otra incorrecta')
    await page.click('button[type="submit"]')
    const refused = await page
      .waitForSelector('[role="alert"]', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!refused) fail('the UI did not report a wrong password')
    else pass('UI reports a wrong password')

    await page.fill('#pd-password', password)
    await page.click('button[type="submit"]')
    const entered = await page
      .waitForFunction(() => document.body.innerText.includes('PIPELINE VALUE'), null, {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false)
    if (!entered) {
      fail(`correct password did not open the app. Body:\n${(await page.innerText('body')).slice(0, 400)}`)
      throw new Error('cannot continue')
    }
    pass('correct password opens the app')
  }

  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 45_000 },
  )

  const body = await page.innerText('body')
  if (body.includes('NO SE PUDO ABRIR LA BASE DE DATOS')) {
    fail(`storage failed to open on the deployed origin:\n${body.slice(0, 500)}`)
  } else if (!body.includes('PRINTDESK')) {
    fail(`app shell did not render:\n${body.slice(0, 300)}`)
  } else {
    pass('app opened its storage on the deployed origin')
  }

  // The app must say where the data lives, so nobody mistakes a device-local
  // database for the shared one.
  const label = remoteMode ? 'SERVIDOR' : 'ESTE EQUIPO'
  if (!body.includes(label)) fail(`storage indicator does not show "${label}"`)
  else pass(`storage indicator shows ${label}`)

  // The WASM binary is the asset most likely to be mangled by a proxy or served
  // with the wrong type, and the local build is dead without it. The server
  // build does not ship it at all, which is a win for a phone on mobile data.
  const wasm = wasmResponses[0]
  if (remoteMode) {
    if (wasm) fail('server build still downloaded the SQLite WASM engine; it should not need it')
    else pass('no WASM engine downloaded (server holds the database)')
  } else if (!wasm) {
    fail('no .wasm resource was fetched — the SQLite engine never loaded')
  } else if (wasm.type !== 'application/wasm') {
    fail(`.wasm served as "${wasm.type}", must be application/wasm`)
  } else {
    pass(`WASM engine served as ${wasm.type} (cache-control: ${wasm.cache ?? 'none'})`)
  }

  // --- A real write, and a reload to prove it persisted --------------------
  const jobName = `Deploy check ${Date.now()}`
  await page.fill('input[placeholder="e.g. Mechanical Enclosure"]', jobName)
  await page.fill('input[placeholder="Internal / Name"]', 'Cliente deploy')
  await page.click('text=CONFIRM & QUEUE')
  await page.waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 20_000 })
  pass('job written into storage')

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 45_000 },
  )
  // The session cookie survives a reload, so no second login should be needed.
  if (remoteMode) {
    const stillLocked = await page.locator('#pd-password').count()
    if (stillLocked > 0) fail('session did not survive a reload — the cookie is not sticking')
    else pass('session survived a reload')
  }
  await page.click('text=/^QUEUE/')
  const persisted = await page
    .waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (!persisted) fail('data did NOT survive a reload on the deployed origin')
  else pass('data survived a reload')

  // In remote mode the data must be on the SERVER, not this browser. A fresh
  // browser context shares no storage with the first, so seeing the job there is
  // what actually proves the database is shared rather than device-local.
  if (remoteMode) {
    const second = await browser.newContext()
    const secondPage = await second.newPage()
    await secondPage.goto(target, { waitUntil: 'load' })
    await secondPage.waitForSelector('#pd-password', { timeout: 20_000 })
    await secondPage.fill('#pd-password', password)
    await secondPage.click('button[type="submit"]')
    await secondPage.waitForFunction(
      () => document.body.innerText.includes('PIPELINE VALUE'),
      null,
      { timeout: 30_000 },
    )
    await secondPage.click('text=/^QUEUE/')
    const shared = await secondPage
      .waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    if (!shared) fail('a second browser did NOT see the job — data is not actually shared')
    else pass('a second, separate browser sees the same data (storage is shared)')
    await second.close()
  }

  // --- Asset and console hygiene -------------------------------------------
  // 401s on /api/ are the auth gate working, and this script provokes several on
  // purpose; they are asserted explicitly above rather than counted as breakage.
  const realMisses = failedResources.filter(
    r => !r.includes('/favicon.ico') && !(r.startsWith('401') && r.includes('/api/')),
  )
  if (realMisses.length > 0) fail(`assets failed to load:\n  ${realMisses.join('\n  ')}`)
  else pass('every asset loaded')

  const unexpected = consoleErrors.filter(
    e => !e.includes('COOP') && !e.includes('OPFS sqlite3_vfs') && !e.includes('Failed to load resource'),
  )
  if (unexpected.length > 0) fail(`unexpected console errors:\n  ${unexpected.join('\n  ')}`)
  else pass('no unexpected console errors')
} catch (err) {
  fail(err.message)
} finally {
  await browser.close()
}

console.log(process.exitCode ? '\nDEPLOY CHECK FAILED' : '\nDEPLOY CHECK PASSED')
