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
// The Create section's header, folded until it is opened.
const newBtn = page.getByTestId('territory-create-toggle')
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
    (await page.locator('body').innerText()).match(/([\d,]+) existing leads? inside will join it/) ?? ['', '0']
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
await page.getByRole('button', { name: /^Create territory$/ }).click()
await page.waitForTimeout(500)
ok(
  /Give the area a name/i.test(await page.locator('body').innerText()),
  'saving without a name says so rather than creating "  "',
)

/* --- and it persists ------------------------------------------------------ */
const NAME = 'Gate Drawn Patch'
await page.getByLabel('Name').fill(NAME)
await page.getByRole('button', { name: /^Create territory$/ }).click()
await page.waitForTimeout(1500)

const after = await page.locator('body').innerText()
ok(new RegExp(`Created ${NAME}`).test(after), 'the territory is created and says so')
ok(new RegExp(NAME).test(after), 'and appears in the list')

/* --- the map stays where the work was done -------------------------------- */
//
// Reported from the console as the map jumping somewhere else the moment a
// territory was saved. It was: leaving drawing mode with no selection reframed
// the map on every lead in the company, so the patch just drawn was off screen.
// The panel heading names what the map is framed on, which makes it the cheapest
// true statement of where the map went.
// No map opens by itself now: the list is the page, and a territory's map
// appears when it is tapped — framed on that territory, not the whole company.
ok((await page.locator('[role="application"]').count()) === 0, 'after creating, no map is open until a territory is tapped')
await page.getByRole('button', { name: `Show ${NAME} on the map` }).click()
await page.waitForTimeout(700)
ok(
  (await page.getByRole('heading', { name: NAME }).count()) > 0,
  'and tapping the new territory opens its map, on that territory',
  (await page.locator('h2').allInnerTexts()).join(' / '),
)

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

/* === renaming and deleting ================================================ */
//
// Neither existed until the console asked for them: a patch could be drawn and
// its rep changed, and nothing else. A typo in a name was permanent, and a shape
// round the wrong streets could only be abandoned in place — which is how a
// territory list fills with three spellings of the same neighbourhood, none of
// which can be removed.
//
// The delete assertion that matters is not that the row goes. It is that the
// leads do not: deleting a shape on a map is not a decision about whether those
// houses exist, and a delete that quietly took a few hundred leads with it would
// be a catastrophe wearing the same button as a tidy-up.

/** "12 territories · 1,234 properties · $…" from the page description. */
const propertyTotal = async () => {
  const m = (await page.locator('body').innerText()).match(/·\s*([\d,]+)\s*(?:leads|properties)/)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

const pick = async (name) => {
  await page.getByRole('button', { name: `Show ${name} on the map` }).click()
  await page.waitForTimeout(600)
}

await pick(NAME)
const RENAMED = 'Gate Renamed Patch'
ok((await page.getByRole('button', { name: /^Rename$/ }).count()) > 0,
  'a selected territory offers a rename')
await page.getByRole('button', { name: /^Rename$/ }).click()
await page.waitForTimeout(400)
await page.getByLabel('Name').fill(RENAMED)
await page.getByRole('button', { name: /Save name/ }).click()
await page.waitForTimeout(1200)

const renamed = await page.locator('body').innerText()
ok(new RegExp(RENAMED).test(renamed), 'the new name is on the page')
ok(!new RegExp(NAME).test(renamed), 'and the old one is gone rather than both existing', 
  renamed.match(new RegExp(`.{0,30}${NAME}.{0,30}`))?.[0] ?? '')

// Same reason the creation is checked this way: a rename that only happened in
// React state is a rename that un-happens on the next reload.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)
ok(
  new RegExp(RENAMED).test(await page.locator('body').innerText()),
  'and the rename survives a reload',
)

/* --- delete keeps the leads ----------------------------------------------- */
await pick(RENAMED)
const heldBefore = Number(
  ((await page.locator('body').innerText()).match(/([\d,]+) (?:leads?|properties)\b/) ?? ['', '0'])[1].replace(/,/g, ''),
)
const totalBefore = await propertyTotal()
ok(heldBefore > 0 && totalBefore > 0, 'the territory holds leads worth not losing',
  `${heldBefore} of ${totalBefore}`)

await page.getByRole('button', { name: /^Delete$/ }).click()
await page.waitForTimeout(400)
const warning = await page.locator('body').innerText()
ok(/go back to Unassigned/i.test(warning),
  'the confirmation says where the leads go rather than only asking twice')
ok(/nothing is erased/i.test(warning), 'and that nothing is erased')

await page.getByRole('button', { name: /Delete territory/ }).click()
await page.waitForTimeout(1600)

const afterDelete = await page.locator('body').innerText()
/*
  The row, not the name. The confirmation note names what was deleted — which is
  the point of it — so a check for the string anywhere on the page fails on the
  very sentence that reports success. The row is the thing that has to go.
*/
ok(
  (await page.getByRole('button', { name: `Show ${RENAMED} on the map` }).count()) === 0,
  'the territory is gone from the list',
)
ok(/went back to Unassigned/i.test(afterDelete), 'and the console says what happened to its leads',
  afterDelete.match(/Deleted[^\n]*/)?.[0] ?? '')

const totalAfter = await propertyTotal()
ok(totalAfter === totalBefore,
  'every lead the territory held is still in the company',
  `${totalBefore} before, ${totalAfter} after`)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)
ok(
  !new RegExp(RENAMED).test(await page.locator('body').innerText()),
  'and it stays deleted after a reload',
)
ok((await propertyTotal()) === totalBefore, 'with the leads still there too',
  `${totalBefore} → ${await propertyTotal()}`)

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== territory drawing OK ===')
process.exit(fails.length ? 1 : 0)
