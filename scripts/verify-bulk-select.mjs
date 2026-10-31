import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Selecting leads in bulk, in the console.
 *
 * Ticking, counting, "select all matching", clear and the bulk actions all
 * existed. This gates the three things that did not, and the old behaviour they
 * replace:
 *
 *   Select all is there before the first tick. The bulk bar — and its "select
 *   all matching" — only appeared after one lead was ticked, and the header
 *   checkbox is a desktop column, so on a phone there was no visible way to
 *   begin.
 *
 *   A tick never outlives its row. Narrowing the search or a filter used to
 *   leave earlier ticks in place, so the bar could read "5 selected" over a list
 *   showing none of them, and Reassign, Set status and Delete acted on leads
 *   nobody could see.
 *
 *   The bulk request carries exactly what is selected, in batches under the
 *   server's 500 cap, and nothing a filter has hidden.
 *
 * The server's half — who may do what, tenant scoping, the 500 cap — is pinned
 * in the API tests; this is the screen's half.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) })
const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim())

const TOTAL = 230
function makeWorld(role = 'client_admin') {
  const props = Array.from({ length: TOTAL }, (_, i) => ({
    id: `p${i + 1}`,
    // Every third lead is on Maple, the rest on Cedar: a search that matches a known third.
    address1: `${100 + i} ${i % 3 === 0 ? 'Maple Court' : 'Cedar Bend Dr'}`,
    city: 'Round Rock', state: 'TX', zip: '78664',
    lat: 30.5115 + i * 0.0002, lng: -97.6755 + i * 0.0002,
    status: i % 2 === 0 ? 'new' : 'contacted',
    score: 60, assignedRepId: 'u_rep', contacts: [],
  }))
  return { role, props, calls: { assign: [], status: [] } }
}
const meOf = (w) => ({
  id: 'u_admin', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'nadia@ridgeline.test', name: 'Nadia Petrov', role: w.role,
  onboarding: { status: 'complete', version: 1, completedAt: Date.now() - 86_400_000 }, badge: null,
  company: { name: 'Ridgeline Roofing', timezone: 'America/Chicago' },
})
async function mockApi(page, w) {
  await page.route('**/api/**', (r) => r.fulfill(json(200, {})))
  await page.route('**/api/auth/login', (r) => r.fulfill(json(200, { token: 'tok', user: meOf(w) })))
  await page.route('**/api/me', (r) => r.fulfill(json(200, { user: meOf(w) })))
  await page.route('**/api/bootstrap', (r) =>
    r.fulfill(json(200, { user: meOf(w), properties: w.props, routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], erased: [], serverTime: Date.now() })),
  )
  await page.route('**/api/users', (r) => r.fulfill(json(200, { users: [{ id: 'u_rep', name: 'Marcus Vance', email: 'marcus@ridgeline.test', role: 'field_rep', active: true, pending: false, invitation: 'accepted', onboarding: 'complete', badge: 'active', createdAt: Date.now() }] })))
  await page.route('**/api/leads/status', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}')
    w.calls.status.push(body)
    return r.fulfill(json(200, { updated: body.propertyIds.length, protectedDnc: 0 }))
  })
  await page.route('**/api/properties/assign', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}')
    w.calls.assign.push(body)
    return r.fulfill(json(200, { assigned: body.propertyIds.length }))
  })
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
}
async function signIn(page, email) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.locator('input[type="email"]').first().fill(email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
}
const rowBoxes = (page) => page.locator('tbody tr input[type="checkbox"]')
const headerBox = (page) => page.locator('thead input[type="checkbox"]')
const rows = (page) => page.locator('tbody tr')
const count = async (page) => ((await page.getByTestId('bulk-count').count()) ? text(page.getByTestId('bulk-count')) : 'none')
const search = async (page, q) => {
  await page.getByPlaceholder(/Search address/).fill(q)
  await page.waitForTimeout(400)
}

/* ====== desktop: the table ================================================== */
{
  const w = makeWorld()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  ok((await rows(page).count()) === 100, 'the first page is a hundred of the leads', `${await rows(page).count()} of ${TOTAL}`)
  ok((await page.getByTestId('bulk-count').count()) === 0, 'nothing is selected and there is no bulk bar')
  const all = page.getByTestId('select-all-visible')
  ok((await all.count()) === 1 && (await text(all)) === `Select all ${TOTAL}`, 'but Select all is already there, with the count', await all.count() ? await text(all) : 'missing')

  /* --- individual ------------------------------------------------------------ */
  await rowBoxes(page).nth(0).check()
  await rowBoxes(page).nth(1).check()
  ok((await count(page)) === '2 selected', 'ticking two leads says two are selected', await count(page))
  ok((await page.getByTestId('select-all-visible').count()) === 0, 'and the pre-tick Select all gives way to the bar’s')
  ok(await headerBox(page).evaluate((el) => el.indeterminate && !el.checked), 'with the header box half-ticked')
  await rowBoxes(page).nth(1).uncheck()
  ok((await count(page)) === '1 selected', 'unticking one leaves one', await count(page))
  await rowBoxes(page).nth(0).uncheck()
  ok((await count(page)) === 'none', 'and unticking the last puts the bar away')

  /* --- pagination ------------------------------------------------------------ */
  await headerBox(page).check()
  ok((await count(page)) === '100 selected', 'the header box selects the page that is showing', await count(page))
  ok(await headerBox(page).evaluate((el) => el.checked && !el.indeterminate), 'and reads fully ticked')
  const more = page.getByRole('button', { name: /Show 100 more/ })
  await more.click()
  await page.waitForTimeout(300)
  ok((await rows(page).count()) === 200 && (await count(page)) === '100 selected', 'showing more rows does not change the selection', `${await rows(page).count()} rows, ${await count(page)}`)
  ok(await headerBox(page).evaluate((el) => el.indeterminate), 'the header box now reads partial, because the new rows are not ticked')
  const matching = page.getByTestId('select-all-matching')
  ok((await text(matching)) === `Select all ${TOTAL} matching`, 'the bar offers every lead, not just those loaded', await text(matching))
  await matching.click()
  ok((await count(page)) === `${TOTAL} selected`, 'and takes all of them, including pages not yet shown', await count(page))
  await page.getByTestId('bulk-clear').click()
  ok((await count(page)) === 'none', 'Clear selection empties it')

  /* --- search: select all follows what matches -------------------------------- */
  await search(page, 'Maple')
  const maple = w.props.filter((p) => p.address1.includes('Maple')).length
  ok((await rows(page).count()) === maple, 'searching narrows the list', `${await rows(page).count()} rows`)
  const allMaple = page.getByTestId('select-all-visible')
  ok((await text(allMaple)) === `Select all ${maple} matching`, 'Select all names what it will select', await text(allMaple))
  await allMaple.click()
  ok((await count(page)) === `${maple} selected`, 'and selects only the matches, not the whole company', await count(page))

  /* --- a tick never outlives its row ----------------------------------------- */
  await search(page, '')
  ok((await count(page)) === `${maple} selected`, 'clearing the search keeps the ticks — those leads are still showing', await count(page))
  await search(page, '100 Maple')
  ok((await count(page)) === '1 selected', 'narrowing past some of them drops those ticks', await count(page))
  await search(page, 'Cedar')
  ok((await count(page)) === 'none', 'and a search that shows none of them leaves nothing selected — no bar acting on hidden leads', await count(page))

  /* --- filters behave the same way -------------------------------------------- */
  await search(page, '')
  await headerBox(page).check()
  ok((await count(page)) === '100 selected', 'ticking the page again')
  await page.getByRole('button', { name: /^Contacted$/ }).click()
  await page.waitForTimeout(400)
  const contacted = w.props.filter((p) => p.status === 'contacted').length
  const left = await count(page)
  ok(left === 'none' || Number(left.split(' ')[0]) <= 100, 'a status filter keeps only the ticks that are still showing', left)
  const shownIds = await rowBoxes(page).evaluateAll((els) => els.length)
  ok(shownIds === Math.min(100, contacted), 'the list shows the contacted leads', `${shownIds}`)
  await page.getByRole('button', { name: /^All statuses$/ }).click()
  await page.waitForTimeout(300)
  ok((await count(page)) === '50 selected', 'and widening again keeps what was ticked', await count(page))
  await page.getByTestId('bulk-clear').click()

  /* --- the bulk action carries exactly the selection --------------------------- */
  await search(page, 'Maple')
  await page.getByTestId('select-all-visible').click()
  await page.getByLabel('Reassign to').selectOption('u_rep')
  await page.getByRole('button', { name: /^Apply$/ }).click()
  await page.waitForTimeout(800)
  ok(w.calls.assign.length === 1, 'one reassign request', `${w.calls.assign.length}`)
  const sent = w.calls.assign[0]?.propertyIds ?? []
  const mapleIds = w.props.filter((p) => p.address1.includes('Maple')).map((p) => p.id)
  ok(sent.length === mapleIds.length && mapleIds.every((id) => sent.includes(id)), 'carrying every Maple lead and nothing else', `${sent.length} ids`)
  ok((await count(page)) === 'none', 'and the selection clears afterwards')

  /* --- a selection bigger than one request goes up in batches ------------------ */
  await search(page, '')
  await page.getByTestId('select-all-visible').click()
  await page.getByLabel('Reassign to').selectOption('u_rep')
  w.calls.assign.length = 0
  await page.getByRole('button', { name: /^Apply$/ }).click()
  await page.waitForTimeout(1200)
  const batches = w.calls.assign.map((c) => c.propertyIds.length)
  ok(batches.length === 1 && batches[0] === TOTAL, `${TOTAL} leads fit one request under the 500 cap`, JSON.stringify(batches))
  ok(new Set(w.calls.assign.flatMap((c) => c.propertyIds)).size === TOTAL, 'with no id sent twice')

  /* --- destructive stays behind its confirmation ------------------------------ */
  await page.getByTestId('select-all-visible').click()
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(300)
  ok((await page.getByTestId('bulk-delete-dialog').count()) === 1, 'Delete selected opens a confirmation, not a deletion')
  ok(/^Delete 230 leads\?/.test(await text(page.getByTestId('bulk-delete-dialog').locator('h2'))), 'that names the count', await text(page.getByTestId('bulk-delete-dialog').locator('h2')))
  await page.keyboard.press('Escape')

  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ====== a phone: cards, no header column ======================================== */
{
  const w = makeWorld()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await dismissTour(page)
  const all = page.getByTestId('select-all-visible')
  ok((await all.count()) === 1 && (await all.isVisible()), 'on a phone Select all is visible before anything is ticked')
  const box = await all.boundingBox()
  ok(!!box && box.height >= 44, 'and is a full thumb target', box ? `${Math.round(box.height)}px` : 'no box')
  await all.tap()
  await page.waitForTimeout(300)
  ok((await count(page)) === `${TOTAL} selected`, 'one tap selects every lead', await count(page))
  ok(await page.getByTestId('bulk-clear').isVisible(), 'and Clear selection is in reach')
  await page.getByTestId('bulk-clear').tap()
  ok((await count(page)) === 'none', 'which clears it')
  await ctx.close()
}

/* ====== a manager: no delete, same selection ==================================== */
{
  const w = makeWorld('manager')
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByTestId('select-all-visible').click()
  ok((await count(page)) === `${TOTAL} selected`, 'a manager selects the same way')
  ok((await page.getByTestId('bulk-delete').count()) === 0, 'but is not offered Delete, which the server would refuse')
  ok((await page.getByRole('button', { name: /^Apply$/ }).count()) === 1, 'and keeps the actions they are allowed')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll checks passed')
process.exit(fails.length ? 1 : 0)
