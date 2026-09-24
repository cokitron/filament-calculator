/**
 * Deployment smoke check: drive a *running* PrintDesk URL in a real browser.
 *
 * Complements scripts/e2e-check.mjs, which serves dist/ itself. This one points
 * at a deployed origin (a container, or the live Railway URL) so it also
 * validates the things only a real server decides: the .wasm content type, the
 * cache headers, TLS, and that no proxy strips or rewrites the WASM payload.
 *
 * Usage: node scripts/deploy-check.mjs https://your-app.up.railway.app
 */
import { chromium } from 'playwright'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/deploy-check.mjs <url>')
  process.exit(2)
}

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
  const response = await page.goto(target, { waitUntil: 'load', timeout: 60_000 })
  if (!response?.ok()) fail(`page returned HTTP ${response?.status()}`)
  else pass(`page served (HTTP ${response.status()})`)

  // Secure context is not optional: OPFS, and therefore all persistence, is
  // unavailable on plain HTTP outside localhost.
  const secure = await page.evaluate(() => window.isSecureContext)
  if (!secure && !target.includes('127.0.0.1') && !target.includes('localhost')) {
    fail('origin is not a secure context — OPFS will be unavailable and nothing will persist')
  } else {
    pass(`secure context: ${secure}`)
  }

  await page.waitForSelector('#root', { timeout: 15_000 })
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 45_000 },
  )

  const body = await page.innerText('body')
  if (body.includes('NO SE PUDO ABRIR LA BASE DE DATOS')) {
    fail(`SQLite failed to open on the deployed origin:\n${body.slice(0, 500)}`)
  } else if (!body.includes('PRINTDESK')) {
    fail(`app shell did not render:\n${body.slice(0, 300)}`)
  } else {
    pass('SQLite opened against OPFS on the deployed origin')
  }

  // The WASM binary is the asset most likely to be mangled by a proxy or served
  // with the wrong type, and the app is dead without it. Browsers refuse to
  // instantiate a module that does not arrive as application/wasm.
  const wasm = wasmResponses[0]
  if (!wasm) {
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
  pass('job written through the Worker into SQLite')

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 45_000 },
  )
  await page.click('text=/^QUEUE/')
  const persisted = await page
    .waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (!persisted) fail('data did NOT survive a reload on the deployed origin')
  else pass('data survived a reload (OPFS persistence confirmed in production)')

  // --- Asset and console hygiene -------------------------------------------
  const realMisses = failedResources.filter(r => !r.includes('/favicon.ico'))
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
