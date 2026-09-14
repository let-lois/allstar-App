import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The manager's list screen: area → list → reps.
 *
 * The whole point of a lead list is that a manager can draw round a block of
 * houses, name it, and hand it to reps — and that the reps then see it. This
 * walks that path in the console, on a desktop, as a manager, and checks that
 * every surface agrees with every other: the count offered under the finger,
 * the count in the table, the count over the map, and the names in the Reps
 * column.
 *
 * It also checks the two things the feature must *not* do: a rep must not get
 * in (the console is role-gated, and this screen is the one that can widen what
 * their phone receives), and creating a list must not move any lead's owner —
 * that is what territories do, and the copy promises the difference.
 *
 * Demo mode, deliberately: creation runs locally there, which is the path a
 * manager in a dead zone takes, and the one no API smoke covers.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}
const text = async (page) => page.locator('body').innerText()

const signIn = async (ctx, name) => {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name }).click()
  await dismissTour(page)
  await page.waitForTimeout(2200)
  return page
}
const errors = []

/* ========================================================================== */
/* A manager, on a desktop                                                    */
/* ========================================================================== */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await signIn(ctx, /Ray Okafor/)

/* --- it is in the nav, and it is empty ------------------------------------ */
await page.goto(`${BASE}/admin/lists`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)
ok(
  await page.evaluate(() => !!document.querySelector('nav a[href="/admin/lists"]')),
  'manager: the console offers Lists',
)
ok(/No lists yet/i.test(await text(page)), 'a fresh account has no lists and says so')
ok(
  /territory is the ground/i.test(await text(page)),
  'the copy tells a territory from a list',
)

// The owners of every lead, before anything is drawn. A list must not move them.
const ownersBefore = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  const rows = await new Promise((res, rej) => {
    const r = db.transaction('properties').objectStore('properties').getAll()
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return Object.fromEntries(rows.map((p) => [p.id, p.assignedRepId ?? null]))
})
ok(Object.keys(ownersBefore).length > 0, `the demo has leads to draw round (${Object.keys(ownersBefore).length})`)

/* --- draw one ------------------------------------------------------------- */
await page.getByRole('button', { name: /New list/ }).click()
await page.waitForTimeout(700)
const map = page.getByRole('application', { name: /Outline a list/ })
ok((await map.count()) > 0, 'the map says it is outlining a list, not a territory')
await map.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box = await map.boundingBox()
for (const [fx, fy] of [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.7, 0.72],
  [0.3, 0.72],
]) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
  await page.waitForTimeout(300)
}
ok((await page.locator('[data-draw="territory"] circle').count()) === 4, 'four taps, four vertices')

const offered = Number(
  ((await text(page)).match(/Create with ([\d,]+) lead/) ?? ['', '0'])[1].replace(/,/g, ''),
)
ok(offered > 0, `the panel offers to create with a lead count (${offered})`)

/* --- a name is required; reps are optional but stick --------------------- */
await page.getByRole('button', { name: /^Create with/ }).click()
await page.waitForTimeout(400)
ok(/Give the list a name/i.test(await text(page)), 'saving without a name says so')

const NAME = 'Gate Storm Re-knock'
await page.getByLabel('Name').fill(NAME)
await page.getByLabel('Description').fill('Hail on the 9th — every roof on the ridge')
const handTo = page.locator('fieldset', { hasText: 'Hand to' })
await handTo.getByLabel('Dana Whitfield').check()
await handTo.getByLabel('Marcus Reyna').check()
await page.getByRole('button', { name: /^Create with/ }).click()
await page.waitForTimeout(1500)

const after = await text(page)
ok(new RegExp(`Created ${NAME} with ${offered} lead`).test(after), 'the list is created with the offered count')
ok(/Handed to Dana Whitfield, Marcus Reyna/.test(after), 'and says who it went to')

/* --- every surface agrees on the count ------------------------------------ */
const row = page.locator('tbody tr', { hasText: NAME })
ok((await row.count()) === 1, 'it appears in the table once')
const rowText = await row.innerText()
ok(new RegExp(`\\b${offered}\\b`).test(rowText), `the row shows ${offered} leads`)
ok(/Dana Whitfield, Marcus Reyna/.test(rowText), 'the row names both reps')
ok(new RegExp(`${offered} leads?\\s*$`, 'm').test(await page.locator('h2', { hasText: NAME }).locator('..').innerText()),
  'the map header shows the same count')
// Progress by status, and it must add up: a tally that names statuses the
// list does not hold, or drops one it does, is worse than the total alone.
const progress = page.getByTestId('list-progress')
ok((await progress.count()) === 1, 'the console shows the list’s progress by status')
{
  const txt = (await progress.count()) ? await progress.innerText() : ''
  const parts = txt.split('·').map((x) => x.trim())
  const total = Number(/^(\d+) total/.exec(parts[0] ?? '')?.[1])
  const sum = parts.slice(1).reduce((a, x) => a + Number(/^(\d+) /.exec(x)?.[1] ?? 0), 0)
  ok(total === offered, `which starts with the total (${txt})`)
  ok(parts.length > 1 && sum === total, 'and whose status counts add up to it', `${sum} of ${total}`)
}

/* --- no lead changed hands ------------------------------------------------ */
const ownersAfter = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  const rows = await new Promise((res, rej) => {
    const r = db.transaction('properties').objectStore('properties').getAll()
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return Object.fromEntries(rows.map((p) => [p.id, p.assignedRepId ?? null]))
})
const moved = Object.keys(ownersBefore).filter((id) => ownersBefore[id] !== ownersAfter[id])
ok(moved.length === 0, `a list moves no leads between reps (${moved.length} moved)`)

// And the list is stored with exactly the count shown — read from the device,
// not from the screen that produced the number.
const stored = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  const rows = await new Promise((res, rej) => {
    const r = db.transaction('leadLists').objectStore('leadLists').getAll()
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return rows.map((l) => ({ name: l.name, leads: l.leadIds.length, leadIds: l.leadIds, reps: l.repIds, boundary: (l.boundary ?? []).length }))
})
const mine = stored.find((l) => l.name === NAME)
ok(!!mine && mine.leads === offered, `the stored list holds ${offered} leads`)
ok(!!mine && mine.reps.length === 2, 'and two reps')
ok(!!mine && mine.boundary === 4, 'and the four-point shape it was drawn from')

/* --- the no-move check has to be able to fail ----------------------------- */
//
// The first version of this checked that no owner changed and passed against a
// build that reassigned every inside lead to the first rep handed the list —
// because the houses inside that box all happened to be Dana's already, and
// Dana was first. An invariant asserted only where it cannot be violated is
// not asserted. So: the same shape again, handed first to a rep who owns none
// of the leads inside it. If creation moves anything, this is where it shows.
// The demo roster, by id — the team is seeded in memory in the demo, not in
// IndexedDB, so the owners' ids are matched to names here.
const REPS = ['Dana Whitfield', 'Marcus Reyna', 'Alicia Osei', 'Tony Baptiste', 'Priya Lindqvist']
const REP_IDS = { u_rep: REPS[0], u_rep2: REPS[1], u_rep3: REPS[2], u_rep4: REPS[3], u_rep5: REPS[4] }
const ownerNames = [...new Set((mine?.leadIds ?? []).map((id) => REP_IDS[ownersBefore[id]]).filter(Boolean))]
ok(ownerNames.length > 0, `the leads inside have owners to protect (${ownerNames.join(', ')})`)
const stranger = REPS.find((n) => !ownerNames.includes(n))
ok(!!stranger, `a rep who owns none of the leads inside exists (${stranger}; owners: ${ownerNames.join(', ') || 'nobody'})`)

const NAME2 = 'Gate Same Block Again'
await page.getByRole('button', { name: /New list/ }).click()
await page.waitForTimeout(700)
const map2 = page.getByRole('application', { name: /Outline a list/ })
await map2.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box2 = await map2.boundingBox()
for (const [fx, fy] of [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.7, 0.72],
  [0.3, 0.72],
]) {
  await page.mouse.click(box2.x + box2.width * fx, box2.y + box2.height * fy)
  await page.waitForTimeout(300)
}
await page.getByLabel('Name').fill(NAME2)
await page.locator('fieldset', { hasText: 'Hand to' }).getByLabel(stranger).check()
await page.getByRole('button', { name: /^Create with/ }).click()
await page.waitForTimeout(1500)
ok(new RegExp(`Handed to ${stranger}\.`).test(await text(page)), `the second list went to ${stranger}`)

const second = await page.evaluate(async (name) => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  const [lists, props] = await Promise.all(
    ['leadLists', 'properties'].map(
      (store) =>
        new Promise((res, rej) => {
          const r = db.transaction(store).objectStore(store).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        }),
    ),
  )
  const l = lists.find((x) => x.name === name)
  return {
    leadIds: l ? l.leadIds : [],
    owners: Object.fromEntries(props.map((p) => [p.id, p.assignedRepId ?? null])),
  }
}, NAME2)
ok(
  second.leadIds.length === offered && second.leadIds.every((id) => mine.leadIds.includes(id)),
  'the same shape holds the same leads',
)
const moved2 = Object.keys(ownersBefore).filter((id) => ownersBefore[id] !== second.owners[id])
ok(moved2.length === 0, `handing a list to a stranger moves no leads (${moved2.length} moved)`)

// Back to the first list for the rest of the walk.
await page.locator('tbody tr', { hasText: NAME }).first().click()
await page.waitForTimeout(400)

/* --- filter by rep -------------------------------------------------------- */
const filter = page.getByLabel('Filter by rep')
// A rep who has neither list — so the empty state is the filter's, not luck.
const nobody = REPS.find((n) => !['Dana Whitfield', 'Marcus Reyna', stranger].includes(n))
await filter.selectOption({ label: nobody })
await page.waitForTimeout(400)
ok((await page.locator('tbody tr', { hasText: NAME }).count()) === 0, 'filtering by a rep who does not have it hides it')
ok(/No lists match/i.test(await text(page)), 'and the empty state says it is the filter')
await filter.selectOption({ label: 'Dana Whitfield' })
await page.waitForTimeout(400)
ok((await page.locator('tbody tr', { hasText: NAME }).count()) === 1, 'filtering by a rep who has it shows it')
await filter.selectOption({ label: 'All reps' })
await page.waitForTimeout(300)

/* --- unassign one rep ----------------------------------------------------- */
// `click`, not `uncheck`: the box is controlled by the store and flips after
// the write lands, which is later than Playwright's same-tick state check.
const editor = page.locator('[data-list-editor]')
await editor.getByLabel('Marcus Reyna').click()
await page.waitForTimeout(700)
ok(!(await editor.getByLabel('Marcus Reyna').isChecked()), 'the box reflects the store, not the tap')
ok(/Marcus Reyna no longer has/.test(await text(page)), 'unassigning says so')
ok(
  !/Marcus Reyna/.test(await page.locator('tbody tr', { hasText: NAME }).innerText()),
  'and the row drops the name',
)

/* --- rename --------------------------------------------------------------- */
const RENAMED = 'Gate Storm Re-knock — Ridge'
await editor.getByLabel('Name').fill(RENAMED)
await editor.getByRole('button', { name: /Save changes/ }).click()
await page.waitForTimeout(700)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 1, 'renaming updates the table')

/* --- archive hides it; show archived brings it back; restore -------------- */
await editor.getByRole('button', { name: /^Archive$/ }).click()
await page.waitForTimeout(700)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 0, 'an archived list leaves the live table')
await page.getByLabel('Show archived').check()
await page.waitForTimeout(400)
const archivedRow = page.locator('tbody tr', { hasText: RENAMED })
ok((await archivedRow.count()) === 1 && /Archived/i.test(await archivedRow.innerText()), 'and is shown, marked, when asked for')
await archivedRow.click()
await page.waitForTimeout(400)
await page.locator('[data-list-editor]').getByRole('button', { name: /^Restore$/ }).click()
await page.waitForTimeout(700)
await page.getByLabel('Show archived').uncheck()
await page.waitForTimeout(400)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 1, 'restore puts it back among the live lists')

/* --- it survives a reload ------------------------------------------------- */
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.goto(`${BASE}/admin/lists`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1600)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 1, 'the list survives a reload')

/* --- delete asks first, then goes ---------------------------------------- */
await page.locator('tbody tr', { hasText: RENAMED }).click()
await page.waitForTimeout(400)
const editor2 = page.locator('[data-list-editor]')
await editor2.getByRole('button', { name: /^Delete$/ }).click()
await page.waitForTimeout(300)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 1, 'one tap on Delete does not delete')
await editor2.getByRole('button', { name: /Keep it/ }).click()
await page.waitForTimeout(300)
await editor2.getByRole('button', { name: /^Delete$/ }).click()
await editor2.getByRole('button', { name: /Yes, delete/ }).click()
await page.waitForTimeout(700)
ok((await page.locator('tbody tr', { hasText: RENAMED }).count()) === 0, 'confirming deletes it')
ok(/deleted\. The leads themselves are untouched/i.test(await text(page)), 'and says the leads are untouched')

await ctx.close()

/* ========================================================================== */
/* A rep cannot get in                                                        */
/* ========================================================================== */
{
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const rep = await signIn(ctx2, /Dana Whitfield/)
  ok(
    !(await rep.evaluate(() => !!document.querySelector('a[href="/admin/lists"]'))),
    'rep: no Lists link anywhere',
  )
  await rep.goto(`${BASE}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await rep.waitForTimeout(1500)
  const body = await text(rep)
  ok(/Not available for your role/i.test(body), 'rep: /admin/lists is refused by URL')
  ok(!/New list/.test(body), 'rep: and the screen itself never rendered')
  await ctx2.close()
}

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== manager lists OK ===')
process.exit(fails.length ? 1 : 0)
