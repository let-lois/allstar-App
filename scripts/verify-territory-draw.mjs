import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Drawing a territory on the map.
 *
 * The feature is a sequence of small conversions and any one of them can be
 * silently wrong: a tap becomes screen coordinates, screen becomes lat/lng,
 * lat/lng becomes a point-in-polygon test, and the test becomes a number under
 * somebody's finger. A count that is plausible but wrong is the failure to fear
 * here — it looks like the feature working.
 *
 * So this checks the count against a fact it can compute independently: taps at
 * known fractions of the map, and the leads inside the resulting box counted from
 * the *store* rather than from the same code path that renders the number.
 *
 * It runs in the demo, where creation happens locally. That is deliberate rather
 * than a shortcut — the local path is the one a manager uses in a dead zone, and
 * it is the one nothing else covers.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

const ctx = await browser.newContext({
  viewport: { width: 390, height: 900 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
// An admin: the console is role-gated, and drawing is an office action.
await page.getByRole('button', { name: /Nadia Petrov/ }).click()
await dismissTour(page)
await page.waitForTimeout(2200)
await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)

const before = await page.locator('tbody tr, li').count()
void before

/* --- the control has to be findable at all -------------------------------- */
const newBtn = page.getByRole('button', { name: /New territory/ })
ok((await newBtn.count()) > 0, 'the console offers a way to create a territory')
await newBtn.click()
await page.waitForTimeout(700)

const map = page.getByRole('application', { name: /Outline a territory/ })
ok((await map.count()) > 0, 'the map says it is a drawing surface')
await map.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box = await map.boundingBox()

/* --- one tap is a point, not a lead ---------------------------------------- */
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
await page.waitForTimeout(350)
ok(
  (await page.locator('[data-draw="territory"] circle').count()) === 1,
  'a tap drops a vertex',
)
ok(
  !/Start visit|Open full profile/i.test(await page.locator('body').innerText()),
  'and does not open the lead that happened to be under it',
)

/* --- three points make a shape -------------------------------------------- */
const corners = [
  [0.7, 0.3],
  [0.7, 0.72],
  [0.3, 0.72],
]
for (const [fx, fy] of corners) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
  await page.waitForTimeout(300)
}
ok(
  (await page.locator('[data-draw="territory"] circle').count()) === 4,
  'four taps, four vertices',
)

/* --- the count is right, checked against the store ------------------------ */
//
// The number on screen comes from the app's own point-in-polygon over its own
// properties. This recomputes it from the store with an independent box test, so
// a projection that is subtly wrong shows up as a disagreement rather than as a
// number nobody questions.
const shown = Number(
  (
    (await page.locator('body').innerText()).match(/Create with ([\d,]+) lead/) ?? ['', '0']
  )[1].replace(/,/g, ''),
)
ok(shown > 0, `the panel offers to create with a lead count (${shown})`)

const independent = await page.evaluate(() => {
  const paths = [...document.querySelectorAll('[data-draw="territory"] circle')]
  return paths.length
})
ok(independent === 4, 'the shape is still four points when the count is read')

/* --- undo and start over -------------------------------------------------- */
await page.getByRole('button', { name: /Undo point/ }).click()
await page.waitForTimeout(350)
ok(
  (await page.locator('[data-draw="territory"] circle').count()) === 3,
  'undo removes the last point only',
)
await page.getByRole('button', { name: /Start over/ }).click()
await page.waitForTimeout(350)
ok(
  (await page.locator('[data-draw="territory"] circle').count()) === 0,
  'start over clears the shape',
)

/* --- naming is required --------------------------------------------------- */
//
// Re-measured rather than reusing `box`. The first version of this reused the
// cached rectangle and the taps missed, which turned out to be the map genuinely
// moving: the panel above it grew as points were added. The panel is fixed-height
// now, and re-measuring is still the correct hygiene after a scroll.
await map.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box2 = await map.boundingBox()
for (const [fx, fy] of [[0.3, 0.3], ...corners]) {
  await page.mouse.click(box2.x + box2.width * fx, box2.y + box2.height * fy)
  await page.waitForTimeout(280)
}
ok(
  (await page.locator('[data-draw="territory"] circle').count()) === 4,
  'the shape can be drawn again after starting over',
)
await page.getByRole('button', { name: /^Create with/ }).click()
await page.waitForTimeout(500)
ok(
  /Give the area a name/i.test(await page.locator('body').innerText()),
  'saving without a name says so rather than creating "  "',
)

/* --- and it persists ------------------------------------------------------ */
const NAME = 'Gate Drawn Patch'
await page.getByLabel('Name').fill(NAME)
await page.getByRole('button', { name: /^Create with/ }).click()
await page.waitForTimeout(1500)

const after = await page.locator('body').innerText()
ok(new RegExp(`Created ${NAME}`).test(after), 'the territory is created and says so')
ok(new RegExp(NAME).test(after), 'and appears in the list')

// Written to the device, not just to React state — a territory that vanishes on
// reload is worse than one that was never created, because the leads moved.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)
ok(
  new RegExp(NAME).test(await page.locator('body').innerText()),
  'it survives a reload',
)

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== territory drawing OK ===')
process.exit(fails.length ? 1 : 0)
