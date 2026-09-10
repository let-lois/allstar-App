import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Lead lists in a rep's hand, on a phone.
 *
 * The office's half of this feature is gated in `verify:adminlists`. This is
 * the rep's half: find my lists, start one, put a door on it from the door,
 * open it on the map and see only its houses, take a door off it, and have all
 * of that survive a reload — at 390px, where the sheet's opening detent is the
 * whole screen a rep sees.
 *
 * It also checks the line the server draws: a rep's controls are their own
 * lists only. Nothing here offers to hand a list to somebody, because nothing
 * the server would accept from a rep does that.
 *
 * Demo mode, so every write is the local-first path — the one a rep in a dead
 * zone takes.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}
const text = async (page) => page.locator('body').innerText()

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
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
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(2200)

/* --- the way in, and the empty state -------------------------------------- */
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await dismissTour(page)
const way = page.getByTestId('open-lists')
ok((await way.count()) === 1, 'Leads carries a way to the lists')
await way.click()
await page.waitForTimeout(800)
ok(/No lists yet/.test(await text(page)), 'a rep with no lists is told so, and what to do')
ok(!/Hand to|Assign/i.test(await text(page)), 'and is offered nothing that hands a list to somebody')

/* --- start one ------------------------------------------------------------ */
await page.getByRole('button', { name: /Start a list/ }).click()
await page.waitForTimeout(400)
const NAME = 'Gate Come Back Saturday'
await page.getByLabel('Name').fill(NAME)
await page.getByRole('button', { name: /^Create list$/ }).click()
await page.waitForTimeout(1200)
ok(new RegExp(`^${NAME}`).test((await text(page)).trim()), 'creating opens the new list')
ok(/No houses on this list yet/.test(await text(page)), 'which is empty and says how to fill it')
ok(await page.getByTestId('open-on-map').isDisabled(), 'and cannot be opened on a map with nothing on it')

/* --- put a door on it, from the door -------------------------------------- */
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
const firstRow = page.getByTestId('lead-row').first()
const address = (await firstRow.innerText()).split('\n')[0].trim()
await firstRow.click()
await page.waitForTimeout(1000)
ok(/Lists/.test(await text(page)), 'the lead’s page has a Lists section')
const membership = page.getByTestId('list-membership')
if ((await membership.count()) === 0) {
  // The section is collapsed when the lead is on nothing — open it.
  await page.getByRole('button', { name: /^Lists/ }).click()
  await page.waitForTimeout(400)
}
ok((await page.getByTestId('list-membership').count()) === 1, 'and it renders the membership control')
ok(/No lists yet/.test(await page.getByTestId('list-membership').innerText()), 'which says the lead is on nothing')
await page.getByRole('button', { name: /Add to list/ }).click()
await page.waitForTimeout(400)
const picker = page.getByTestId('list-picker')
ok((await picker.count()) === 1, 'Add to list opens a picker')
ok((await picker.locator('input[type=checkbox]').count()) === 1, 'offering exactly the rep’s one list')
await picker.getByLabel(NAME).click()
await page.waitForTimeout(700)
ok(await picker.getByLabel(NAME).isChecked(), 'ticking it puts the door on the list')
ok((await page.getByTestId('on-list').count()) === 1, 'and the list appears on the lead')

/* --- and a second one, straight from the picker --------------------------- */
const NAME2 = 'Gate Dog Houses'
await picker.getByLabel('New list').fill(NAME2)
await picker.getByRole('button', { name: /^Create$/ }).click()
await page.waitForTimeout(900)
ok((await picker.locator('input[type=checkbox]').count()) === 2, 'a list made from the picker joins it')
ok((await page.getByTestId('on-list').count()) === 2, 'with the door already on it')

/* --- the peek shows it too ------------------------------------------------ */
await page.getByLabel('Back', { exact: true }).click()
await page.waitForTimeout(800)

/* --- the list has the door, and opens on the map -------------------------- */
await page.goto(`${BASE}/lists`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
ok((await page.getByTestId('list-row').count()) === 2, 'both lists are listed')
ok(new RegExp(`${NAME}\\s*\\n\\s*1 lead`).test(await text(page)), 'with the count of one')
await page.getByTestId('list-row').filter({ hasText: NAME }).click()
await page.waitForTimeout(800)
const leads = page.getByTestId('list-lead')
ok((await leads.count()) === 1 && (await leads.innerText()).includes(address), `the list holds ${address}`)

const openMap = page.getByTestId('open-on-map')
ok(!(await openMap.isDisabled()), 'and can be opened on the map now')
await openMap.click()
await page.waitForTimeout(2000)
ok(/\/map\?list=/.test(page.url()), 'Open on map goes to the map with the list')
const chip = page.getByTestId('map-list-chip')
ok((await chip.count()) === 1 && (await chip.innerText()).includes(NAME), 'the map says which list it is showing')
// The count lives in the search box's placeholder — "Search N leads" — and
// the pins are on the SVG. Both are read: the number the rep sees, and the
// dots under it, so a count that lies about the map is caught either way.
const mapCount = async () => {
  const ph = (await page.locator('input[placeholder^="Search "]').getAttribute('placeholder')) ?? ''
  const m = ph.match(/Search (\d+) lead/)
  return m ? Number(m[1]) : -1
}
const pins = () => page.locator('[data-marker="pin"], [data-marker="cluster"]').count()
ok((await mapCount()) === 1, `the map counts one house (${await mapCount()})`)
ok((await pins()) === 1, `and draws one pin (${await pins()})`)

// Tap the chip: the list goes and the rest of the leads come back.
await chip.click()
await page.waitForTimeout(800)
ok((await page.getByTestId('map-list-chip').count()) === 0, 'tapping the chip clears the list')
ok((await mapCount()) > 1, `and the rest of the leads return (${await mapCount()})`)

/* --- take it off again ---------------------------------------------------- */
await page.goto(`${BASE}/lists`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByTestId('list-row').filter({ hasText: NAME }).click()
await page.waitForTimeout(800)
await page.getByRole('button', { name: /^Remove / }).click()
await page.waitForTimeout(700)
ok((await page.getByTestId('list-lead').count()) === 0, 'Remove takes the door off the list')
ok(/No houses on this list yet/.test(await text(page)), 'and the list says it is empty again')

/* --- rename, and it all survives a reload --------------------------------- */
await page.getByTestId('edit-list').click()
await page.waitForTimeout(300)
const RENAMED = 'Gate Come Back Sunday'
await page.getByTestId('list-edit').getByLabel('Name').fill(RENAMED)
await page.getByTestId('list-edit').getByRole('button', { name: /^Save$/ }).click()
await page.waitForTimeout(700)
ok(new RegExp(`^${RENAMED}`).test((await text(page)).trim()), 'renaming updates the title')

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.goto(`${BASE}/lists`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const body = await text(page)
ok(new RegExp(RENAMED).test(body) && new RegExp(NAME2).test(body), 'both lists survive a reload')
ok(new RegExp(`${NAME2}\\s*\\n\\s*1 lead`).test(body), 'and the second still holds its door')

// The outbox has nothing in the demo — but the lists are in the store the sync
// reads from, which is what "offline-first" means here.
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
  return rows.map((l) => ({ name: l.name, leads: l.leadIds.length, reps: l.repIds.length, createdBy: l.createdBy }))
})
ok(stored.length === 2 && stored.every((l) => l.createdBy === 'u_rep'), 'both lists are stored on the phone as the rep’s own')
ok(stored.every((l) => l.reps === 0), 'and a rep’s own list is handed to nobody — the server would refuse otherwise')

/* --- archive puts one away ------------------------------------------------ */
await page.getByTestId('list-row').filter({ hasText: NAME2 }).click()
await page.waitForTimeout(800)
await page.getByTestId('edit-list').click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /Archive list/ }).click()
await page.waitForTimeout(900)
ok(/\/lists$/.test(page.url()), 'archiving returns to the lists')
ok((await page.getByTestId('list-row').count()) === 1, 'and the archived list is gone from them')

/* --- a lead on an archived list no longer shows it ------------------------ */
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByTestId('lead-row').first().click()
await page.waitForTimeout(1000)
if ((await page.getByTestId('list-membership').count()) === 0) {
  await page.getByRole('button', { name: /^Lists/ }).click()
  await page.waitForTimeout(400)
}
ok((await page.getByTestId('on-list').count()) === 0, 'an archived list is not shown on the lead')

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== rep lists OK ===')
process.exit(fails.length ? 1 : 0)
