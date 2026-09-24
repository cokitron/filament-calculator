/**
 * Responsive layout check.
 *
 * Drives the production build at phone, tablet and desktop widths and asserts
 * the one thing that actually breaks a small screen: nothing may overflow
 * horizontally. A single fixed-width grid column or an unwrapped flex row is
 * enough to make the whole page pan sideways, and that is invisible in a
 * desktop-sized test.
 *
 * Every tab is measured, with a job row expanded, because the widest layouts in
 * the app (the three-column cost breakdown, the four-column material row) only
 * exist inside an expanded record.
 *
 * Run with: node scripts/responsive-check.mjs   (needs `vite build` first)
 */
import { chromium } from 'playwright'
import { serveDist } from './serve-dist.mjs'

const PORT = 41778

const VIEWPORTS = [
  { name: 'iPhone SE  375×667', width: 375, height: 667, mobileBar: true },
  { name: 'iPhone 14  390×844', width: 390, height: 844, mobileBar: true },
  { name: 'iPad       768×1024', width: 768, height: 1024, mobileBar: true },
  { name: 'Desktop   1440×900', width: 1440, height: 900, mobileBar: false },
]

const fail = msg => {
  console.error(`  ✗ FAIL: ${msg}`)
  process.exitCode = 1
}
const pass = msg => console.log(`  ✓ ${msg}`)

/**
 * Horizontal overflow, plus the elements responsible.
 *
 * documentElement.scrollWidth alone says only *that* the page is too wide; the
 * offender list is what makes a failure fixable. 2px of tolerance absorbs
 * sub-pixel rounding in fractional layouts.
 */
const measureOverflow = page =>
  page.evaluate(() => {
    const vw = window.innerWidth
    const doc = document.documentElement

    // Content inside a container that scrolls horizontally on purpose (the
    // filter strips) is allowed to sit past the edge — it is reachable by
    // swiping and does not pan the page.
    const inScroller = el => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
      }
      return false
    }

    const offenders = [...document.querySelectorAll('body *')]
      .filter(el => {
        const r = el.getBoundingClientRect()
        // Ignore invisible nodes.
        if (r.width === 0 && r.height === 0) return false
        if (r.right <= vw + 2 && r.left >= -2) return false
        return !inScroller(el)
      })
      .slice(0, 6)
      .map(el => {
        const r = el.getBoundingClientRect()
        const cls = typeof el.className === 'string' ? el.className.trim().slice(0, 40) : ''
        return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}> right=${Math.round(r.right)}`
      })
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, viewport: vw, offenders }
  })

async function checkTab(page, label) {
  const { scrollWidth, clientWidth, offenders } = await measureOverflow(page)
  if (scrollWidth > clientWidth + 2) {
    fail(
      `${label}: page is ${scrollWidth}px wide in a ${clientWidth}px viewport\n` +
        (offenders.length ? `      offenders: ${offenders.join('\n                 ')}` : ''),
    )
    return false
  }
  if (offenders.length > 0) {
    fail(`${label}: elements extend past the viewport: ${offenders.join(', ')}`)
    return false
  }
  pass(label)
  return true
}

const server = await serveDist(PORT)
const browser = await chromium.launch({ channel: 'chrome' })

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n${vp.name}`)
    // A fresh context per viewport: OPFS allows one connection, and this also
    // guarantees each width starts from an identical, empty database.
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.width < 820,
      hasTouch: vp.width < 820,
    })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
    await page.waitForFunction(
      () => !document.body.innerText.includes('ABRIENDO BASE DE DATOS'),
      null,
      { timeout: 30_000 },
    )
    if ((await page.innerText('body')).includes('NO SE PUDO ABRIR')) {
      fail(`${vp.name}: database did not open`)
      await context.close()
      continue
    }

    // --- Calculator, the densest form ---------------------------------------
    await checkTab(page, 'calculator (empty form)')

    // The summary panel is off-screen once the layout stacks, so the running
    // total has to be repeated in a bar that stays put.
    const barVisible = await page.locator('.calc-mobile-bar').isVisible()
    if (vp.mobileBar && !barVisible) fail('sticky total bar missing on a narrow viewport')
    else if (!vp.mobileBar && barVisible) fail('sticky total bar should not show on desktop')
    else pass(vp.mobileBar ? 'sticky total bar present' : 'sticky total bar correctly hidden')

    // Add a second material and a second labor stage: the four-column material
    // grid and the labor row are the widest things in the form.
    await page.click('text=+ ADD MATERIAL')
    await page.click('text=+ ADD LABOR STAGE')
    await checkTab(page, 'calculator (2 materials, 2 labor stages)')

    // --- Queue --------------------------------------------------------------
    const jobName = `Responsive ${vp.width}`
    await page.fill('input[placeholder="e.g. Mechanical Enclosure"]', jobName)
    await page.fill('input[placeholder="Internal / Name"]', 'Cliente de prueba con nombre largo')
    await page.locator('input[type="checkbox"]').first().check()
    // The fixed bar's button on narrow screens, the panel's on desktop.
    await page.click(vp.mobileBar ? '.calc-mobile-bar button' : 'text=CONFIRM & QUEUE')
    await page.waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 15_000 })
    await checkTab(page, 'queue (collapsed row)')

    await page.click(`text=${jobName}`)
    await page.waitForSelector('text=COST BREAKDOWN (PER UNIT)', { timeout: 10_000 })
    await checkTab(page, 'queue (expanded row: breakdown + labor + actions)')

    // --- History ------------------------------------------------------------
    await page.locator('button', { hasText: 'DONE' }).first().click()
    await page.waitForFunction(n => !document.body.innerText.includes(n), jobName, { timeout: 15_000 })
    await page.click('text=/^WORK HISTORY/')
    await page.waitForFunction(n => document.body.innerText.includes(n), jobName, { timeout: 15_000 })
    await checkTab(page, 'history (stat cards + collapsed row)')

    await page.click(`text=${jobName}`)
    await page.waitForSelector('text=/CIFRAS/', { timeout: 10_000 })
    await checkTab(page, 'history (expanded record)')

    // --- Filaments ----------------------------------------------------------
    await page.click('text=FILAMENT INVENTORY')
    await page.click('text=+ ADD FILAMENT')
    await page.waitForSelector('text=NEW FILAMENT', { timeout: 10_000 })
    await checkTab(page, 'filaments (add form open)')

    await context.close()
  }
} catch (err) {
  fail(err.stack ?? err.message)
} finally {
  await browser.close()
  server.close()
}

console.log(process.exitCode ? '\nRESPONSIVE CHECK FAILED' : '\nRESPONSIVE CHECK PASSED')
