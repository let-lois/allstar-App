import { chromium } from 'playwright'
import { TOUR_STEPS } from '../src/data/tour.ts'

/**
 * The first-run tour.
 *
 * A tutorial is shown to someone exactly once, on the morning they are least
 * inclined to forgive it, and every failure here is invisible afterwards: it
 * appears twice, or never, or points at nothing, and by the time anyone
 * notices, the person it was for has already formed their opinion of the app.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/* --- the step list is a product decision, so assert it without a browser --- */
console.log('--- the steps themselves ---')
ok(TOUR_STEPS.length > 0 && TOUR_STEPS.length <= 6,
   `short enough that it gets read (${TOUR_STEPS.length} steps)`)
ok(TOUR_STEPS.some((s) => s.target === 'sync'),
   'the offline promise is one of them — it is the claim nobody believes unattended')
ok(TOUR_STEPS.some((s) => s.target === 'start-visit'),
   'and so is the button that starts a knock')
ok(TOUR_STEPS.every((s) => s.title && s.body),
   'every step says something')
ok(new Set(TOUR_STEPS.map((s) => s.target)).size === TOUR_STEPS.length,
   'no target is spotlighted twice')

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const signIn = async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(2400)
}

const card = () => page.locator('[data-tour-card]')
const stepNo = async () => {
  const t = await card().innerText()
  const m = t.match(/(\d+) of (\d+)/)
  return m ? { at: Number(m[1]), of: Number(m[2]) } : null
}

/*
 * The card must be reachable.
 *
 * This is the assertion that exists because of a real bug: the card centred
 * itself with a translate and then ran an entrance animation that also set
 * `transform`, with fill-mode `both`. The centring lost, the card sat half off
 * the right edge of the phone, and Next could not be tapped at all — on step
 * one, on a 390px screen, which is the single most common way this app is
 * opened. It looked fine in a screenshot of the spotlight.
 */
const cardInside = async () => {
  const b = await card().boundingBox()
  const vp = page.viewportSize()
  if (!b) return { inside: false, why: 'no box' }
  const inside =
    b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 1 && b.y + b.height <= vp.height + 1
  return { inside, why: `x ${Math.round(b.x)}..${Math.round(b.x + b.width)} of ${vp.width}, y ${Math.round(b.y)}..${Math.round(b.y + b.height)} of ${vp.height}` }
}

await signIn()

console.log('\n--- it shows up ---')
ok(await card().count() > 0, 'the tour opens by itself on a first run')
const first = await stepNo()
ok(first?.at === 1, `it starts at the first step (${first?.at})`)

console.log('\n--- and every step of it is usable ---')
const total = first?.of ?? 0
ok(total >= 4, `it has steps to show (${total})`)
for (let i = 1; i <= total; i++) {
  const at = await stepNo()
  ok(at?.at === i, `step ${i} is the one on screen`)
  const spot = await page.locator('.tour-hole').count()
  ok(spot === 1, `step ${i} spotlights something`)
  const fit = await cardInside()
  ok(fit.inside, `step ${i}'s card is fully on screen (${fit.why})`)
  if (i < total) {
    await page.locator('[data-tour-next]').click()
    await page.waitForTimeout(600)
  }
}

console.log('\n--- back goes back ---')
await page.locator('[data-tour-back]').click()
await page.waitForTimeout(500)
ok((await stepNo())?.at === total - 1, 'Back returns to the previous step')
ok((await page.locator('[data-tour-back]').count()) === 1, 'and Back is still offered')

// Walk to the first step and confirm Back disappears there.
for (let i = total - 1; i > 1; i--) {
  await page.locator('[data-tour-back]').click()
  await page.waitForTimeout(350)
}
ok((await stepNo())?.at === 1, 'Back walks all the way to the start')
ok((await page.locator('[data-tour-back]').count()) === 0,
   'and there is no Back on the first step, because there is nothing behind it')

/*
 * The tour blocks the app underneath it. A tour where the highlighted control
 * still works is one tap from pointing at a screen that no longer exists.
 */
console.log('\n--- it holds the screen ---')
/*
 * Clicked by coordinate, not by locator.
 *
 * The first version of this aimed a forced click at the Start visit button and
 * passed whether the overlay blocked or not — that button is scrolled out of
 * view at this point in the walk, so the click landed nowhere and the URL was
 * unchanged for a reason that had nothing to do with the thing being tested.
 *
 * The Map tab is always on screen and always navigates, so a click at its
 * centre either reaches it or is caught by the overlay, and the URL says which.
 */
const before = page.url()
const mapTab = await page.locator('[data-tour="nav-map"]').boundingBox()
ok(mapTab !== null, 'the Map tab is on screen to aim at')
if (mapTab) {
  await page.mouse.click(mapTab.x + mapTab.width / 2, mapTab.y + mapTab.height / 2)
  await page.waitForTimeout(600)
}
ok(page.url() === before, `a tap on live navigation underneath does nothing (${page.url().split('/').pop() || '/'})`)
ok((await card().count()) === 1, 'and the tour is still up')

console.log('\n--- finishing it means finished ---')
for (let i = 1; i < total; i++) {
  await page.locator('[data-tour-next]').click()
  await page.waitForTimeout(400)
}
await page.locator('[data-tour-next]').click()
await page.waitForTimeout(600)
ok((await card().count()) === 0, 'the last step closes it')

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2400)
ok((await card().count()) === 0, 'and it stays gone after a reload')

/* --- skipping counts too ------------------------------------------------- */
console.log('\n--- skip means skip ---')
const ctx2 = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})
const p2 = await ctx2.newPage()
p2.on('pageerror', (e) => errors.push(String(e)))
await p2.goto(BASE, { waitUntil: 'networkidle' })
await p2.getByRole('button', { name: /Try the demo/ }).click()
await p2.getByRole('button', { name: /Dana Whitfield/ }).click()
await p2.waitForTimeout(2400)
ok((await p2.locator('[data-tour-card]').count()) > 0, 'a fresh device gets the tour')
await p2.locator('[data-tour-skip]').click()
await p2.waitForTimeout(500)
ok((await p2.locator('[data-tour-card]').count()) === 0, 'Skip closes it')
await p2.reload({ waitUntil: 'networkidle' })
await p2.waitForTimeout(2400)
ok(
  (await p2.locator('[data-tour-card]').count()) === 0,
  'and a skipped tour does not come back tomorrow — skipping was a decision',
)

/* --- but it can be asked for again ---------------------------------------- */
console.log('\n--- replay ---')
await p2.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
await p2.waitForTimeout(900)
const replay = p2.getByRole('button', { name: /Show the tutorial again/i })
ok((await replay.count()) === 1, 'More offers it again')
await replay.click()
await p2.waitForTimeout(2600)
ok((await p2.locator('[data-tour-card]').count()) > 0, 'and asking for it brings it back')

ok(errors.length === 0, `no page errors${errors.length ? ` -> ${errors[0]}` : ''}`)

await browser.close()
console.log(`\n${fails.length ? `${fails.length} FAILED` : '=== tour OK ==='}`)
process.exit(fails.length ? 1 : 0)
