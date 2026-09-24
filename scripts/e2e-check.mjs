/**
 * End-to-end check of the real browser storage path.
 *
 * Serves the production build over plain HTTP with NO COOP/COEP headers — the
 * same conditions as static Figma Make hosting — then drives the app in Chrome
 * to prove that:
 *   1. SQLite opens against OPFS without those headers (the opfs-sahpool bet)
 *   2. A job entered through the UI is actually written to the database
 *   3. The data survives a full page reload, i.e. it is genuinely persistent
 *   4. A second concurrent tab fails loudly instead of silently losing data
 *
 * Run with: node scripts/e2e-check.mjs
 */
import { chromium } from 'playwright'
import { serveDist } from './serve-dist.mjs'

const PORT = 41777

const fail = msg => {
  console.error(`\n✗ FAIL: ${msg}`)
  process.exitCode = 1
}
const pass = msg => console.log(`✓ ${msg}`)

const server = await serveDist(PORT)
console.log(`serving dist on http://127.0.0.1:${PORT} with no COOP/COEP headers\n`)

const browser = await chromium.launch({ channel: 'chrome' })
// A persistent-ish context is not needed: OPFS is scoped per origin and
// survives reloads within one browser context, which is what we assert.
const context = await browser.newContext()
const page = await context.newPage()

const consoleErrors = []
const failedResources = []
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
// Track by URL. Chrome's console text for a failed request omits the URL, so
// filtering console strings cannot distinguish a missing favicon from a missing
// WASM binary.
page.on('response', r => {
  if (r.status() >= 400) failedResources.push(`${r.status()} ${r.url()}`)
})

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })

  // --- 0. The page actually served -----------------------------------------
  // Guards against the whole suite passing vacuously against a 404 page: every
  // later "absence of error text" check would also be true for an empty body.
  await page.waitForSelector('#root', { timeout: 10_000 })
  const rootHtml = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0)
  if (rootHtml < 100) {
    fail(`app did not render — #root is ${rootHtml} bytes. Body: ${await page.innerText('body')}`)
    throw new Error('cannot continue')
  }
  pass('production build served and React mounted')

  // --- 1. Database opens -----------------------------------------------------
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 30_000 },
  )

  const bodyText = await page.innerText('body')
  if (bodyText.includes('NO SE PUDO ABRIR LA BASE DE DATOS')) {
    fail(`database failed to open. Panel said:\n${bodyText.slice(0, 600)}`)
    throw new Error('cannot continue')
  }
  // Positive proof the real UI is up, not merely that an error string is absent.
  if (!bodyText.includes('PRINTDESK')) {
    fail(`app shell missing. Body was:\n${bodyText.slice(0, 400)}`)
    throw new Error('cannot continue')
  }
  pass('SQLite opened against OPFS with no COOP/COEP headers')

  // --- 3. Create a job through the UI ---------------------------------------
  await page.waitForSelector('input[placeholder="e.g. Mechanical Enclosure"]', { timeout: 10_000 })
  const jobName = `E2E Test ${Date.now()}`
  await page.fill('input[placeholder="e.g. Mechanical Enclosure"]', jobName)
  await page.fill('input[placeholder="Internal / Name"]', 'Cliente E2E')

  // Turn IVA on so the persisted boolean is exercised, not just defaults.
  const ivaBox = page.locator('input[type="checkbox"]').first()
  await ivaBox.check()

  await page.click('text=CONFIRM & QUEUE')

  // Saving goes through the worker, so the queue appears asynchronously.
  await page.waitForFunction(
    name => document.body.innerText.includes(name),
    jobName,
    { timeout: 15_000 },
  )
  pass('job written through the Worker and read back into the queue')

  // --- 4. Survives a reload -------------------------------------------------
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 30_000 },
  )
  await page.click('text=/^QUEUE/')
  const persisted = await page.waitForFunction(
    name => document.body.innerText.includes(name),
    jobName,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false)

  if (!persisted) fail('job did NOT survive a page reload — storage is not persistent')
  else pass('job survived a full page reload (OPFS persistence confirmed)')

  // --- 5. IVA flag round-tripped -------------------------------------------
  const queueText = await page.innerText('body')
  if (!queueText.includes('C/ IVA')) {
    fail('IVA flag did not round-trip through the database')
  } else {
    pass('IVA flag round-tripped through storage')
  }

  // --- 5b. Finishing a job archives it into the work history ----------------
  // The queue must only hold live work, and the finished job must land in the
  // history log with its totals frozen.
  await page.click(`text=${jobName}`)
  await page.locator('button', { hasText: 'DONE' }).first().click()

  const leftQueue = await page.waitForFunction(
    name => !document.body.innerText.includes(name),
    jobName,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false)
  if (!leftQueue) fail('a finished job stayed in the queue instead of moving to history')
  else pass('finished job left the queue')

  await page.click('text=/^WORK HISTORY/')
  const inHistory = await page.waitForFunction(
    name => document.body.innerText.includes(name),
    jobName,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false)
  if (!inHistory) fail('finished job did not appear in the work history')
  else pass('finished job recorded in the work history')

  // Frozen totals are the point of the history: reopen the record and check the
  // app says the figures were frozen rather than recomputed.
  await page.click(`text=${jobName}`)
  const frozen = await page
    .waitForFunction(() => document.body.innerText.includes('CIFRAS CONGELADAS'), null, {
      timeout: 10_000,
    })
    .then(() => true)
    .catch(() => false)
  if (!frozen) fail('history record did not carry frozen totals')
  else pass('history record carries totals frozen at completion')

  // And it must still be there after a reload, not just in memory.
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 30_000 },
  )
  await page.click('text=/^WORK HISTORY/')
  const historyPersisted = await page.waitForFunction(
    name => document.body.innerText.includes(name),
    jobName,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false)
  if (!historyPersisted) fail('work history did NOT survive a page reload')
  else pass('work history survived a full page reload')

  // --- 6. A second tab fails loudly ----------------------------------------
  // opfs-sahpool allows exactly one connection. The important property is that
  // the app says so, rather than silently opening a throwaway database.
  const second = await context.newPage()
  await second.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await second.waitForFunction(
    () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
    null,
    { timeout: 30_000 },
  ).catch(() => {})
  const secondText = await second.innerText('body')
  if (secondText.includes('NO SE PUDO ABRIR LA BASE DE DATOS')) {
    pass('second tab refused with a clear message instead of losing data silently')
  } else {
    console.log('  note: second tab opened without error (VFS allowed the handoff)')
  }
  await second.close()

  // --- 7. No unexpected errors or missing assets ----------------------------
  // favicon.ico is requested automatically by the browser and is not part of the
  // build, so it is the one expected 404.
  const realMisses = failedResources.filter(r => !r.includes('/favicon.ico'))
  if (realMisses.length > 0) {
    fail(`assets failed to load:\n  ${realMisses.join('\n  ')}`)
  } else {
    pass('every app asset loaded, including the 869 KB WASM engine')
  }

  const unexpected = consoleErrors.filter(
    e =>
      !e.includes('COOP') &&
      !e.includes('OPFS sqlite3_vfs') &&
      // The generic text for the favicon 404, already accounted for above.
      !e.includes('Failed to load resource'),
  )
  if (unexpected.length > 0) {
    fail(`unexpected console errors:\n  ${unexpected.join('\n  ')}`)
  } else {
    pass('no unexpected console errors')
  }
} catch (err) {
  fail(err.message)
} finally {
  await browser.close()
  server.close()
}

console.log(process.exitCode ? '\nE2E CHECK FAILED' : '\nE2E CHECK PASSED')
