import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Headings have a size, and the size means something.
 *
 * A root screen announces itself: its title is the largest thing on it, the way
 * a native app names a tab. A screen reached through Back is a place the rep
 * went, and its title is a label beside the arrow. One component decides which
 * is which, and this measures the result rather than trusting the rule: every
 * root screen at least 26px, every inner screen at most 18px, exactly one h1 a
 * screen, and nothing wider than the phone while doing it.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(2000)

const measure = () =>
  page.evaluate(() => {
    const h1s = [...document.querySelectorAll('h1')]
    const visible = h1s.filter((h) => {
      const r = h.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(h).visibility !== 'hidden'
    })
    const el = visible[0]
    return {
      count: h1s.length,
      text: el?.textContent?.trim() ?? '',
      size: el ? parseFloat(getComputedStyle(el).fontSize) : 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })

/* --- root screens: a large title ------------------------------------------ */
for (const [path, name] of [['/today', 'Today'], ['/leads', 'Leads'], ['/pipeline', 'Pipeline'], ['/more', 'More']]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await dismissTour(page)
  const m = await measure()
  ok(m.count === 1, `${name}: exactly one h1`, `${m.count}`)
  ok(m.size >= 26, `${name}: the title announces the screen`, `${m.size}px "${m.text}"`)
  ok(m.overflow <= 0, `${name}: and nothing is wider than the phone`, `${m.overflow}px over`)
}

/* --- inner screens: a label beside Back ------------------------------------ */
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByTestId('lead-row').first().click()
await page.waitForTimeout(1200)
{
  const m = await measure()
  ok(m.count === 1, 'a lead’s page: exactly one h1', `${m.count}`)
  ok(m.size > 0 && m.size <= 18, 'a lead’s page: the title is a label beside Back, not a banner', `${m.size}px "${m.text}"`)
  ok(m.overflow <= 0, 'a lead’s page: nothing is wider than the phone', `${m.overflow}px over`)
}
await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
{
  const m = await measure()
  ok(m.size > 0 && m.size <= 18, 'Add lead: the same label size', `${m.size}px "${m.text}"`)
}

/* --- the two are told apart by the component, not by each screen ----------- */
//
// Lists is reached from Leads and carries a Back control, so it is an inner
// screen and labels itself — whatever its own importance. The rule lives in
// the top bar, and the bar says which size it chose.
{
  await page.goto(`${BASE}/lists`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const m = await measure()
  ok(m.size > 0 && m.size <= 18, 'Lists, reached through Back, labels itself', `${m.size}px`)
  ok((await page.locator('header[data-title-size]').first().getAttribute('data-title-size')) === 'compact', 'and the top bar says so')
  await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok((await page.locator('header[data-title-size]').first().getAttribute('data-title-size')) === 'large', 'while Leads, a root, is declared large')
}

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== a root screen announces itself; an inner one labels itself ===')
process.exit(fails.length ? 1 : 0)
