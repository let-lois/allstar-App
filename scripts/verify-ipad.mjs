import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The field app on an iPad, upright and on its side.
 *
 * Door-to-door teams carry tablets as often as phones, so the app ships for
 * iPad too (`supportsTablet`, every orientation on iPad, portrait on iPhone).
 * This walks a rep's day — Today, the map, Leads, a lead, a visit through to
 * Sold, the pipeline, More — at the iPad sizes Apple sells, in both
 * orientations, and fails on what ruins a tablet layout: a page that pans
 * sideways, a screen that throws, or a primary action that is off screen.
 *
 *   SHOTS=dir node scripts/verify-ipad.mjs    # also saves a screenshot per step
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const SHOTS = process.env.SHOTS
const IPADS = [
  { name: 'ipad-mini-portrait', width: 744, height: 1133 },
  { name: 'ipad-air-portrait', width: 820, height: 1180 },
  { name: 'ipad-air-landscape', width: 1180, height: 820 },
  { name: 'ipad-pro13-portrait', width: 1032, height: 1376 },
  { name: 'ipad-pro13-landscape', width: 1376, height: 1032 },
]
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined && !cond ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}
const browser = await chromium.launch({ executablePath: chromiumPath() })

/** Nothing pans sideways: not the page, not a scroll pane. Chip rows that scroll on purpose excepted. */
const sideways = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    if (document.scrollingElement.scrollWidth > vw + 1) return `page ${document.scrollingElement.scrollWidth}>${vw}`
    for (const el of document.querySelectorAll('*')) {
      if (el.classList.contains('snap-x-row') || el.closest('.gm-style, .maplibregl-map, [data-map]')) continue
      const s = getComputedStyle(el)
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} ${el.scrollWidth}>${el.clientWidth}`
      }
    }
    return ''
  })
/** A button by name is on screen, not below the fold of a fixed layout or behind something. */
const onScreen = async (page, loc) => {
  const box = await loc.boundingBox()
  const vp = page.viewportSize()
  return !!box && box.y >= 0 && box.y + box.height <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1
}
const go = (page, to) => page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, to)

try {
  for (const vp of IPADS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    const step = async (label) => {
      await page.waitForTimeout(700)
      const s = await sideways(page)
      ok(s === '', `${vp.name}: ${label} does not pan sideways`, s)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${vp.name}--${label.replace(/\W+/g, '-')}.png` })
    }
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    await step('sign-in')
    await page.getByRole('button', { name: /Try the demo/ }).click()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(page)
    await step('today')
    for (const [label, path] of [['map', '/map'], ['leads', '/leads'], ['pipeline', '/pipeline'], ['more', '/more']]) {
      await go(page, path)
      await dismissTour(page, 800)
      await step(label)
    }
    const lead = await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('allstar-field')
      q.onsuccess = () => { const r = q.result.transaction('properties').objectStore('properties').getAll(); r.onsuccess = () => res(r.result.find((p) => !['won', 'dnc', 'lost'].includes(p.status))) }
    }))
    await go(page, `/property/${lead.id}`)
    await dismissTour(page, 800)
    await step('lead')
    ok(await onScreen(page, page.getByRole('button', { name: /Start visit/ }).first()), `${vp.name}: Start visit is on screen on a lead`)
    await page.getByRole('button', { name: /Start visit/ }).first().click()
    await page.waitForURL(/\/visit\//, { timeout: 8000 })
    await step('visit-outcome')
    await page.getByRole('button', { name: /^Sold/ }).first().click()
    await step('visit-sold-plan')
    ok(await onScreen(page, page.getByRole('button', { name: /^Continue$/ })), `${vp.name}: Continue is on screen in a visit`)
    await page.getByRole('button', { name: /^Continue$/ }).click()
    await step('visit-next')
    const done = page.getByRole('button', { name: /^Complete visit$/ })
    ok(await onScreen(page, done), `${vp.name}: Complete visit is on screen`)
    await done.click()
    await page.waitForTimeout(900)
    await go(page, `/property/${lead.id}`)
    await step('lead-sold')
    ok((await page.getByTestId('lead-sale').count()) === 1, `${vp.name}: the sale shows on the lead`)
    ok(errors.length === 0, `${vp.name}: no page errors`, errors[0])
    await ctx.close()
  }
} finally {
  await browser.close()
}
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== the field app works on iPad, upright and on its side ===')
