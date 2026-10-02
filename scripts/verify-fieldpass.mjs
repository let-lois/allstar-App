import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The October field pass, each item held to what was reported.
 *
 *   Map. Comes back where the rep left it — not on the first lead in the
 *   store (a Phoenix test lead) — and after a visit, on that house.
 *   Visit. The contact can be filled in during the visit and saves to the
 *   lead; the end of a visit offers the lead itself; the visit's duration and
 *   rep show in the lead's history, including a visit from another phone.
 *   Lead details. No roof age, square feet or placeholder score; territory by
 *   name; a sales summary.
 *   Console. Appointments as a column and filter; "select all" means all;
 *   export is exactly the selection or the matching view; Team filters by
 *   office; a failure shows a reference; the error log lists failures.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured !== undefined ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const errors = []
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const REP = { id: 'u_rep', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'rep@ridgeline.test', name: 'Marcus Vance', role: 'field_rep' }
const base = { city: 'Round Rock', state: 'TX', zip: '78664', status: 'new', score: 50, assignedRepId: REP.id, territoryId: 't_north' }
// The first lead in the store is in Phoenix: the map used to open on it, every time.
const PHX = { ...base, id: 'p_phx', address1: '1 Test Lead Way', city: 'Phoenix', state: 'AZ', zip: '85004', lat: 33.4484, lng: -112.074, contacts: [] }
const WITH = { ...base, id: 'p_with', address1: '118 Cedar Bend Dr', lat: 30.5115, lng: -97.6755, roofAgeYears: 12, squareFeet: 2100, contacts: [{ id: 'c1', name: 'Sam Brooks', phone: '(512) 555-0920', email: 'sam@example.com', isPrimary: true }] }
const WITHOUT = { ...base, id: 'p_without', address1: '120 Cedar Bend Dr', lat: 30.5117, lng: -97.6757, contacts: [] }
const TERR = { id: 't_north', name: 'North Cedar', repIds: [REP.id], boundary: [{ lat: 30.5, lng: -97.7 }, { lat: 30.5, lng: -97.6 }, { lat: 30.52, lng: -97.6 }] }
// A visit knocked on another phone by a teammate: it reaches this phone through bootstrap now.
const OTHER_VISIT = { id: 'v_other', propertyId: WITHOUT.id, repId: 'u_other', startedAt: Date.now() - 86_400_000, endedAt: Date.now() - 86_400_000 + 252_000, outcome: 'not_home', durationMs: 252_000, photoIds: [] }

async function signIn(page, who) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(who.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
}
const open = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1100)
  await dismissTour(page, 1500)
}
const savedView = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('allstar.map.view.v1') || 'null') } catch { return null } })

try {
  /* ===== the field rep, on a phone ===== */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    const mutations = []
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    await page.route('**/api/auth/login', json(200, { token: 'tok', user: REP }))
    await page.route('**/api/bootstrap', json(200, {
      user: REP, properties: [PHX, WITH, WITHOUT], routes: [], appointments: [], tasks: [], activity: [], dailyStats: [],
      territories: [TERR], visits: [OTHER_VISIT], team: [{ id: 'u_other', name: 'Dana Ortiz', role: 'field_rep', active: true }, { id: REP.id, name: REP.name, role: 'field_rep', active: true }], serverTime: Date.now(),
    }))
    await page.route('**/api/mutations', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      mutations.push(...(body.mutations ?? []))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: (body.mutations ?? []).map((m) => ({ id: m.id, status: 'applied' })), serverTime: Date.now() }) })
    })
    await page.route('**/api/properties/*/photos', json(200, { photos: [] }))
    await signIn(page, REP)

    /* --- map: a saved view comes back, Phoenix does not --- */
    await page.evaluate(() => localStorage.setItem('allstar.map.view.v1', JSON.stringify({ lat: 30.5116, lng: -97.6756, zoom: 17 })))
    await open(page, '/map')
    await page.waitForTimeout(1200)
    let v = await savedView(page)
    ok(v && Math.abs(v.lat - 30.5116) < 0.01 && Math.abs(v.lng + 97.6756) < 0.01, 'the map opens where the rep last left it, not on the Phoenix lead first in the store', JSON.stringify(v))
    // Pan, then leave and come back: the new place is remembered.
    const box = await page.locator('[data-testid="field-map"], svg[role="application"], [aria-roledescription="map"]').first().boundingBox().catch(() => null)
    const mapBox = box ?? { x: 0, y: 200, width: 390, height: 400 }
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(mapBox.x + mapBox.width / 2 - 120, mapBox.y + mapBox.height / 2 + 60, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    const panned = await savedView(page)
    ok(panned && (Math.abs(panned.lng - v.lng) > 0.0001 || Math.abs(panned.lat - v.lat) > 0.0001), 'moving the map is remembered', JSON.stringify(panned))
    await open(page, '/today')
    await open(page, '/map')
    await page.waitForTimeout(1200)
    v = await savedView(page)
    ok(v && panned && Math.abs(v.lat - panned.lat) < 0.0005 && Math.abs(v.lng - panned.lng) < 0.0005 && Math.abs(v.lat - PHX.lat) > 1, 'after leaving and coming back it is still there', JSON.stringify(v))

    /* --- a visit: the contact is edited inside it --- */
    await open(page, `/property/${WITH.id}?start=1`)
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: /Interested/ }).first().click()
    await page.waitForTimeout(600)
    ok((await page.getByTestId('visit-contact').count()) === 1, 'the visit’s Details step has the contact fields')
    ok((await page.getByTestId('visit-contact-name').inputValue()) === 'Sam Brooks' && (await page.getByTestId('visit-contact-phone').inputValue()) === '(512) 555-0920', 'prefilled from the lead')
    ok((await page.getByTestId('visit-contact-phone').getAttribute('type')) === 'tel' && (await page.getByTestId('visit-contact-email').getAttribute('type')) === 'email', 'with the phone and email keyboards')
    await page.getByTestId('visit-contact-phone').fill('(512) 555-7777')
    await page.getByTestId('visit-contact-save').click()
    await page.waitForTimeout(800)
    const upd = mutations.filter((m) => m.kind === 'property.update' && m.payload?.id === WITH.id).pop()
    ok(upd && upd.payload.contacts?.length === 1 && upd.payload.contacts[0].phone === '(512) 555-7777' && upd.payload.contacts[0].id === 'c1', 'saving updates the lead’s own contact — the same record, not a second one', JSON.stringify(upd?.payload?.contacts))
    // Finish the visit.
    for (let i = 0; i < 3; i++) {
      const next = page.getByRole('button', { name: /^(Next|Continue|Complete visit|Finish)/ }).last()
      if ((await next.count()) === 0) break
      await next.click()
      await page.waitForTimeout(700)
      if ((await page.getByTestId('visit-done-lead').count()) > 0) break
    }
    ok((await page.getByTestId('visit-done-lead').count()) === 1, 'the end of a visit offers View lead')
    const done = mutations.find((m) => m.kind === 'visit.complete')
    ok(done && done.payload?.startedAt > 0 && done.payload?.endedAt >= done.payload?.startedAt && done.payload?.durationMs >= 0, 'start, end and duration go to the server with the visit', JSON.stringify({ s: done?.payload?.startedAt, e: done?.payload?.endedAt, d: done?.payload?.durationMs }))
    await page.getByTestId('visit-done-lead').click()
    await page.waitForTimeout(900)
    ok(new URL(page.url()).pathname === `/property/${WITH.id}`, 'and it goes straight to that lead', page.url())

    /* --- the lead: history, details, sales summary --- */
    const body = await page.locator('body').innerText()
    ok((await page.getByTestId('visit-history').count()) === 1 && (await page.getByTestId('visit-row').count()) >= 1, 'Visit history is open with the visit in it')
    ok((await page.getByTestId('visit-duration').count()) >= 1, 'with its duration')
    ok(/Marcus Vance/.test(await page.getByTestId('visit-history').innerText()), 'and who knocked')
    ok(!/Roof age|Square feet|Lead score/.test(body), 'no roof age, square feet or placeholder score on the lead')
    ok((await page.getByTestId('lead-sales').count()) === 1, 'a Sales activity summary')
    const details = page.getByRole('button', { name: /^Property & assignment/ }).first()
    if ((await details.getAttribute('aria-expanded')) === 'false') await details.click()
    await page.waitForTimeout(300)
    ok(/North Cedar/.test(await page.getByTestId('lead-details').innerText()), 'territory by its name, not its id', await page.getByTestId('lead-details').innerText())
    ok(!/Owner occupied/.test(await page.getByTestId('lead-details').innerText()), 'no "Owner occupied: No" when nobody recorded it')

    /* --- a teammate's visit from another phone shows --- */
    await open(page, `/property/${WITHOUT.id}`)
    ok(/Dana Ortiz/.test(await page.getByTestId('visit-history').innerText().catch(() => '')), 'a visit knocked on another phone is in the history, with who knocked')

    /* --- back to the map from a visit opens on that house --- */
    await open(page, `/map?lead=${WITH.id}`)
    await page.waitForTimeout(800)
    ok(/118 Cedar Bend Dr/.test(await page.locator('body').innerText()), 'the map opened from a visit shows that lead')
    await ctx.close()
  }

  /* ===== the office, on a desktop ===== */
  {
    const ADMIN = { id: 'u_admin', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'admin@ridgeline.test', name: 'Nadia Petrov', role: 'client_admin' }
    const leads = Array.from({ length: 140 }, (_, i) => ({ ...base, id: `p${i}`, address1: `${100 + i} Oak St`, lat: 30.51 + i * 0.0001, lng: -97.67, assignedRepId: i % 2 ? 'u_rep' : undefined, contacts: [] }))
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    const exports = []
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    await page.route('**/api/**', json(200, {}))
    await page.route('**/api/auth/login', json(200, { token: 'tok', user: ADMIN }))
    await page.route('**/api/me', json(200, { user: ADMIN }))
    await page.route('**/api/users', json(200, { users: [
      { id: 'u_rep', name: 'Marcus Vance', email: 'm@x.test', role: 'field_rep', active: true, pending: false, teamId: 'tm1', teamName: 'Gaffney Office' },
      { id: 'u_mgr', name: 'Jo Lee', email: 'j@x.test', role: 'manager', active: true, pending: false, teamId: 'tm2', teamName: 'Spartanburg Office' },
    ] }))
    await page.route('**/api/bootstrap', json(200, {
      user: ADMIN, properties: leads, routes: [], tasks: [{ id: 'tk1', repId: 'u_rep', propertyId: 'p3', title: 'Follow up', dueAt: Date.now() - 2 * 86_400_000, done: false, kind: 'follow_up' }],
      appointments: [{ id: 'a1', propertyId: 'p5', repId: 'u_rep', startsAt: Date.now() + 2 * 86_400_000, durationMin: 45, title: 'Appointment' }],
      activity: [], dailyStats: [{ id: 'u_mgr:2026-10-01', repId: 'u_mgr', day: new Date().toISOString().slice(0, 10), knocks: 9, conversations: 4, appointments: 1, quotes: 0, sold: 1, closedValue: 0 }],
      territories: [TERR, { id: 't_empty', name: 'Failed Patch', repIds: [] }], leadLists: [], serverTime: Date.now(),
    }))
    await page.route('**/api/leads/export.csv**', async (route) => {
      exports.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/csv' }, body: 'lead_id\r\n' })
    })
    await page.route('**/api/properties/assign', json(500, { error: 'Something went wrong.', reference: 'abc12345' }))
    await page.route('**/api/audit**', json(200, { entries: [] }))
    await page.route('**/api/errors**', json(200, { errors: [{ reference: 'abc12345', at: Date.now(), userId: 'u_admin', userName: 'Nadia Petrov', method: 'POST', route: '/api/properties/assign', status: 500, operation: 'leads.assign', records: 140, message: 'D1_ERROR: too many SQL variables', ms: 40 }] }))
    await signIn(page, ADMIN)

    await open(page, '/admin/leads')
    ok(/Appointment/.test(await page.locator('thead').innerText()), 'Leads has an Appointment column')
    await page.getByTestId('leads-appointment-filter').selectOption('upcoming')
    await page.waitForTimeout(400)
    ok((await page.locator('tbody tr').count()) === 1 && (await page.getByTestId('lead-appointment-cell').count()) >= 1, 'Upcoming appointment narrows to the one lead with one', String(await page.locator('tbody tr').count()))
    await page.getByTestId('leads-appointment-filter').selectOption('any')
    await page.getByTestId('leads-followup-filter').selectOption('overdue')
    await page.waitForTimeout(400)
    ok((await page.locator('tbody tr').count()) === 1, 'Follow-up overdue narrows to the lead with an overdue follow-up')
    await page.getByTestId('leads-followup-filter').selectOption('any')
    await page.waitForTimeout(400)

    // Select all means all 140, not the 100 on the first page.
    await page.locator('thead input[type="checkbox"]').first().check()
    await page.waitForTimeout(300)
    ok(/^100 selected/.test(await page.getByTestId('bulk-count').innerText()), 'the header box selects the page', await page.getByTestId('bulk-count').innerText())
    await page.getByTestId('select-all-matching').click()
    await page.waitForTimeout(300)
    ok(/^140 selected/.test(await page.getByTestId('bulk-count').innerText()), '"Select all 140 matching" selects all 140', await page.getByTestId('bulk-count').innerText())
    await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), page.getByTestId('export-selected').click()])
    await page.waitForTimeout(500)
    ok(exports[0]?.ids?.length === 140 && exports[0]?.label === 'selected', 'Export selected sends exactly the 140', JSON.stringify({ n: exports[0]?.ids?.length, label: exports[0]?.label }))

    // A failure carries its reference.
    await page.getByRole('button', { name: /^(Reassign|Assign|Apply)/ }).first().click().catch(() => {})
    await page.waitForTimeout(800)
    ok(/Reference: ERR-ABC12345/.test(await page.locator('body').innerText()), 'a failed bulk action shows a reference, not a bare "Something went wrong"')
    await page.getByTestId('bulk-clear').click().catch(() => {})

    // Territory filter → export of exactly that view, named for it.
    await page.getByTestId('leads-territory-filter').selectOption('t_north')
    await page.waitForTimeout(400)
    await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), page.getByTestId('export-csv').click()])
    await page.waitForTimeout(500)
    const last = exports[exports.length - 1]
    ok(last?.ids?.length === 140 && last?.label === 'North Cedar', 'Export matching sends the filtered view and names the file for the territory', JSON.stringify({ n: last?.ids?.length, label: last?.label }))
    await page.getByTestId('leads-territory-filter').selectOption('t_empty')
    await page.waitForTimeout(400)
    ok(await page.getByTestId('export-csv').isDisabled(), 'an empty view exports nothing — never "everything"')

    // Territories lists the empty one, so it can be found and deleted.
    await open(page, '/admin/territories')
    ok(/Failed Patch/.test(await page.locator('body').innerText()), 'a territory with no leads is on the Territories page, not only in the filters')

    // Team: office filter, and activity by who knocked.
    await open(page, '/admin/team')
    await page.getByTestId('team-office-filter').selectOption('Gaffney Office')
    await page.waitForTimeout(400)
    const teamText = await page.locator('main').last().innerText()
    ok(/Marcus Vance/.test(teamText) && !/Jo Lee/.test(teamText), 'Team filters by team / office')

    // The error log.
    await open(page, '/admin/audit')
    await page.getByRole('button', { name: /^Errors$/ }).click()
    await page.waitForTimeout(600)
    const errText = await page.getByTestId('errors-table').innerText().catch(() => '')
    ok(/ERR-ABC12345/.test(errText) && /leads\.assign/.test(errText) && /140/.test(errText), 'the Activity log lists failures with reference, action and record count')
    await ctx.close()
  }
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300))
if (fails.length) {
  console.log(`\n${fails.length} failure(s)`)
  process.exit(1)
}
console.log('\n=== field pass OK ===')
