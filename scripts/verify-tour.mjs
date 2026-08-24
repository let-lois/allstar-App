import { chromium } from 'playwright'
import { REP_STEPS, OFFICE_STEPS } from '../src/data/tour.ts'

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

/* --- the step lists are product decisions, so assert them without a browser - */
console.log('--- the steps themselves ---')
for (const [who, steps] of [['rep', REP_STEPS], ['office', OFFICE_STEPS]]) {
  ok(steps.length >= 15, `${who}: covers the app rather than one screen (${steps.length} steps)`)
  ok(steps.every((s) => s.title && s.body), `${who}: every step says something`)
  ok(
    new Set(steps.map((s) => s.target)).size === steps.length,
    `${who}: no target is spotlighted twice`,
  )
  /*
    Every step names its route. Without one the tour spotlights whatever happens
    to be on screen, which for a walkthrough that navigates means "the previous
    step's screen" — and the failure is silent, because there is always
    *something* to point at.
  */
  ok(steps.every((s) => s.route), `${who}: every step knows which screen it lives on`)
}
ok(
  REP_STEPS.some((s) => s.target === 'sync'),
  'the offline promise is in the rep tour — the claim nobody believes unprompted',
)
ok(
  REP_STEPS.some((s) => s.target === 'start-visit'),
  'and so is the button that starts a knock',
)
ok(
  OFFICE_STEPS.some((s) => s.route?.startsWith('/admin')),
  'the office tour reaches the console, which is most of their job',
)
ok(
  OFFICE_STEPS.every((s) => s.target !== 'start-visit'),
  'and does not explain knocking to somebody who does not knock',
)

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
ok(total >= 15, `it covers the app rather than one screen (${total} steps)`)

/*
 * Walked by following the card, not by counting to a number.
 *
 * The tour navigates between screens and steps itself over any anchor that
 * never appears — a rep with no route has no next stop, offline maps are absent
 * until imagery is configured. Asserting "step i is on screen" would be
 * asserting the demo's data rather than the tour's behaviour, so this follows
 * whatever it shows and checks the properties that must hold for all of them.
 */
const seen = []
let guard = 0
while ((await card().count()) > 0 && guard++ < 60) {
  const at = await stepNo()
  if (!at) break
  if (seen.includes(at.at)) {
    // Same step twice means Next did nothing — a dead tour, which is worse than
    // a wrong one because it strands somebody on their first morning.
    ok(false, `step ${at.at} advanced rather than repeating`)
    break
  }
  seen.push(at.at)

  /*
    A step either spotlights something or steps itself over — both are correct,
    and which one happens depends on the account rather than on the code. The
    offline-maps step has no anchor until tile imagery is configured; a rep with
    no route has no next stop. Asserting "spotlights something" flatly would be
    asserting this build's configuration.

    What must never happen is the third case: a step that shows a card, never
    finds its anchor, and stays there.
  */
  await page.locator('.tour-hole').first().waitFor({ state: 'attached', timeout: 2500 }).catch(() => {})
  const spotted = (await page.locator('.tour-hole').count()) === 1
  if (!spotted) {
    await page.waitForTimeout(1400)
    const now = await stepNo()
    ok(
      !now || now.at !== at.at,
      `step ${at.at} has no anchor here and steps over itself rather than stalling`,
    )
    if (!now) break
    continue
  }
  ok(spotted, `step ${at.at} spotlights something`)

  const fit = await cardInside()
  ok(fit.inside, `step ${at.at}'s card is fully on screen (${fit.why})`)

  if (at.at >= at.of) break
  await page.locator('[data-tour-next]').click({ timeout: 8000 })
  await page.waitForTimeout(850)
}
ok(seen.length >= 15, `it walked the whole thing (${seen.length} steps shown)`)
ok(
  seen.every((n, i) => i === 0 || n > seen[i - 1]),
  'and it only ever moved forward',
)

console.log('\n--- back goes back ---')
const beforeBack = (await stepNo())?.at ?? 0
await page.locator('[data-tour-back]').click()
await page.waitForTimeout(900)
const afterBack = (await stepNo())?.at ?? 0
ok(afterBack < beforeBack, `Back returns to an earlier step (${beforeBack} -> ${afterBack})`)
ok((await page.locator('[data-tour-back]').count()) === 1, 'and Back is still offered')

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
let fin = 0
while ((await card().count()) > 0 && fin++ < 60) {
  await page.locator('[data-tour-next]').click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(700)
}
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

/* --- the office gets one too, and can ask for it back --------------------- */
console.log('\n--- the office ---')
const ctx3 = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})
const p3 = await ctx3.newPage()
p3.on('pageerror', (e) => errors.push(String(e)))
await p3.goto(BASE, { waitUntil: 'networkidle' })
await p3.getByRole('button', { name: /Try the demo/ }).click()
await p3.getByRole('button', { name: /Nadia Petrov/ }).click()
await p3.waitForTimeout(2600)
ok((await p3.locator('[data-tour-card]').count()) > 0, 'an admin gets a tour on a first run')
const officeFirst = await p3.locator('[data-tour-card]').innerText()
ok(
  /1 of (1[5-9]|2\d)/.test(officeFirst),
  `and it is the long one, not a stub (${(officeFirst.match(/\d+ of \d+/) ?? ['?'])[0]})`,
)
await p3.locator('[data-tour-skip]').click()
await p3.waitForTimeout(500)

/*
 * The replay row is for everyone.
 *
 * It was gated to field reps for one release, from before the office had a tour
 * at all — which left the people with the most screens to learn as the only
 * ones who could not ask to see them again.
 */
await p3.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
await p3.waitForTimeout(900)
const officeReplay = p3.getByRole('button', { name: /Show the tutorial again/i })
ok((await officeReplay.count()) === 1, 'More offers it to the office as well')
await officeReplay.click()
await p3.waitForTimeout(2800)
ok((await p3.locator('[data-tour-card]').count()) > 0, 'and it comes back for them too')

ok(errors.length === 0, `no page errors${errors.length ? ` -> ${errors[0]}` : ''}`)

await browser.close()
console.log(`\n${fails.length ? `${fails.length} FAILED` : '=== tour OK ==='}`)
process.exit(fails.length ? 1 : 0)
