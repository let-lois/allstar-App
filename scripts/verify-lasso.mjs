import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Selecting a block by drawing round it, and acting on the lot.
 *
 * The office job this exists for: a canvass comes back and forty houses on one
 * street need moving. Ticking forty checkboxes is not a workflow, and the
 * checkbox list is paginated, so "the ones on that street" was not even
 * expressible.
 *
 * Almost nothing here is new code, which is the point. `FieldMap` already turns
 * taps into coordinates and draws the shape — that is how territories are
 * outlined — and `pointInPolygon` is the same function the server uses to decide
 * which leads a territory claims, kept in step by `verify:geo-parity`. What is
 * new is where the answer goes: into the selection the checkboxes already feed,
 * so the bulk bar needed no changes at all.
 *
 * ## What this can and cannot assert
 *
 * Tapping a *specific* house would mean reimplementing the projection out here
 * to turn a lat/lng into a screen pixel, and a test that reimplements the thing
 * it is testing agrees with itself by construction. So the shapes are drawn
 * against the map element's own corners instead:
 *
 *   - the whole viewport → every lead on screen falls inside
 *   - a small square in one corner → none do
 *
 * Both are decisive without knowing where any individual pin landed, and the
 * second is what catches a shape that selects everything regardless.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const ADMIN = {
  id: 'u_live_admin',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'admin@ridgeline.test',
  name: 'Nadia Petrov',
  role: 'client_admin',
}

/*
  Three leads tight together and one far away.

  The far one is load-bearing: with every lead in one cluster, "the shape round
  the whole map caught them all" and "the code ignores the shape" are the same
  observation. It sits outside the viewport once the map fits the cluster, so a
  correct implementation reports three and a broken one reports four.
*/
const NEAR = [
  { id: 'p1', address1: '1 Cedar Bend Dr', lat: 30.5100, lng: -97.6700, status: 'new' },
  { id: 'p2', address1: '2 Cedar Bend Dr', lat: 30.5105, lng: -97.6695, status: 'new' },
  { id: 'p3', address1: '3 Cedar Bend Dr', lat: 30.5110, lng: -97.6690, status: 'follow_up' },
]
const FAR = { id: 'p9', address1: '900 Faraway Rd', lat: 41.8800, lng: -87.6300, status: 'new' }

const leads = [...NEAR, FAR].map((p) => ({
  ...p,
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  score: 50,
  contacts: [],
}))

const EMPTY_BOOTSTRAP = {
  user: ADMIN,
  properties: [],
  routes: [],
  appointments: [],
  tasks: [],
  activity: [],
  dailyStats: [],
  serverTime: Date.now(),
}
const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

let statusPosted = null

try {
  await page.route('**/api/auth/login', json(200, { token: 'tok_admin', user: ADMIN }))
  await page.route('**/api/users', json(200, {
    users: [{ id: 'u_rep_1', name: 'Marcus Vance', email: 'm@x.test', role: 'field_rep', active: true, pending: false }],
  }))
  await page.route('**/api/bootstrap', json(200, { ...EMPTY_BOOTSTRAP, properties: leads, territories: [] }))
  await page.route('**/api/leads/status', async (route) => {
    statusPosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ updated: statusPosted.propertyIds.length, protectedDnc: 0 }),
    })
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await dismissTour(page)
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const body = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

  ok(/4 matching/.test(await body()), 'all four leads are in scope to begin with', await body().then((t) => t.slice(0, 60)))

  /* ===== the map view ==================================================== */
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'map' }).click()
  await page.waitForTimeout(1000)
  // The container carries the role and the label, not the svg inside it — the
  // svg is sized from a measured box and has no accessible identity of its own.
  const map = page.getByRole('application')
  ok(await map.isVisible(), 'the map view opens')

  ok(
    (await map.boundingBox())?.width > 200,
    'the map has a usable area to draw in',
    `${Math.round((await map.boundingBox())?.width ?? 0)}px`,
  )

  /**
   * Tap a point given as a fraction of the map box.
   *
   * The box is re-read on every tap rather than captured once. Filtering the
   * list changes the layout above the map, so a box measured earlier put the
   * later taps outside it — and the failure was silent: no points registered,
   * no "N leads inside" text appeared, and the assertion read as the shape
   * finding nothing rather than as the taps missing.
   */
  const tapAt = async (fx, fy) => {
    const b = await map.boundingBox()
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy)
    await page.waitForTimeout(180)
  }

  /* ===== 1. a shape covering nothing selects nothing ===================== */
  //
  // Deliberately first. If this passed only because the map happened to be
  // empty, the assertion below about the map being usable has already failed.
  {
    await page.getByRole('button', { name: /Select an area/ }).click()
    await page.waitForTimeout(300)
    // A small square hugging the top-left corner. The map fits the cluster,
    // which sits mid-frame, so nothing should be in here.
    await tapAt(0.02, 0.02)
    await tapAt(0.10, 0.02)
    await tapAt(0.10, 0.10)
    await tapAt(0.02, 0.10)
    const txt = await body()
    ok(/0 leads inside/.test(txt), 'a shape drawn over empty map selects nothing', /(\d+) leads? inside/.exec(txt)?.[0])
    ok(
      await page.getByRole('button', { name: /Add 0 to selection/ }).isDisabled(),
      'and there is nothing to add, so the button is disabled',
    )
    await page.getByRole('button', { name: /^Cancel$/ }).click()
    await page.waitForTimeout(300)
  }

  /* ===== 2. a shape round the whole map catches the cluster =============== */
  {
    await page.getByRole('button', { name: /Select an area/ }).click()
    await page.waitForTimeout(300)
    await tapAt(0.03, 0.03)
    await tapAt(0.97, 0.03)
    await tapAt(0.97, 0.97)
    await tapAt(0.03, 0.97)
    const txt = await body()
    // Three, not four: the far lead is off-screen, which is what makes this an
    // assertion about the shape rather than about the lead count.
    ok(/3 leads inside/.test(txt), 'a shape round the visible map catches the three on screen, not the one far away',
      /(\d+) leads? inside/.exec(txt)?.[0])

    await page.getByRole('button', { name: /Add 3 to selection/ }).click()
    await page.waitForTimeout(400)
    ok(/3 selected/.test(await body()), 'and they land in the selection the checkboxes feed')
  }

  /* ===== 3. the bulk bar needed no changes =============================== */
  {
    await page.getByLabel('Set status').selectOption('follow_up')
    await page.getByRole('button', { name: /^Set$/ }).click()
    await page.waitForTimeout(800)
    ok(statusPosted?.propertyIds?.length === 3, 'the bulk status change is sent for exactly those three',
      JSON.stringify(statusPosted?.propertyIds))
    ok(
      !statusPosted?.propertyIds?.includes('p9'),
      'and never for the lead that was outside the shape',
    )
    ok(statusPosted?.status === 'follow_up', 'with the status that was chosen', statusPosted?.status)
  }

  /* ===== 4. the shape respects the filters =============================== */
  //
  // The map shows the filtered set, so a shape drawn after narrowing to one
  // status must not quietly reach the leads that filter is hiding.
  {
    // No need to clear first: a successful bulk action empties the selection
    // itself, which is what removed the bulk bar — and the "Clear selection"
    // button with it. This case used to click that button and time out.
    ok(!/selected/.test(await body()), 'applying a bulk action clears the selection behind it')
    await page.locator('input[type="search"]').fill('3 Cedar Bend')
    await page.waitForTimeout(700)
    await page.getByRole('button', { name: /Select an area/ }).click()
    await page.waitForTimeout(300)
    await tapAt(0.03, 0.03)
    await tapAt(0.97, 0.03)
    await tapAt(0.97, 0.97)
    await tapAt(0.03, 0.97)
    const txt = await body()
    ok(/1 lead inside/.test(txt), 'with the list filtered to one lead, the same shape finds one',
      /(\d+) leads? inside/.exec(txt)?.[0])
  }

  /* ===== 5. a selection becomes a list, handed to a rep, in one bar ======= */
  //
  // The office's half of "select area, create list, assign rep". The Lists page
  // can draw the same shape, but a manager who has already lassoed the block
  // here should not have to draw it again there. What is asserted is the wire:
  // exactly the selected ids, the name typed, and the rep ticked — not a count
  // on screen, which a bar that ignored the selection could still get right.
  const madeLists = []
  let listPosted = null
  const mutationsPosted = []
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...EMPTY_BOOTSTRAP,
        properties: leads,
        territories: [],
        leadLists: [
          { id: 'll_monday', name: 'Monday Route', description: null, createdBy: ADMIN.id, archived: false, createdAt: 1, updatedAt: 1, leadIds: [], repIds: [] },
          ...madeLists,
        ],
      }),
    }),
  )
  await page.route('**/api/lists', async (route) => {
    listPosted = JSON.parse(route.request().postData() || '{}')
    const list = {
      id: listPosted.id ?? 'll_made',
      name: listPosted.name,
      description: listPosted.description ?? null,
      createdBy: ADMIN.id,
      archived: false,
      createdAt: 2,
      updatedAt: 2,
      leadIds: listPosted.propertyIds ?? [],
      repIds: listPosted.repIds ?? [],
    }
    madeLists.push(list)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list, skipped: 0 }) })
  })
  await page.route('**/api/mutations', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    for (const m of body.mutations ?? []) mutationsPosted.push(m)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: (body.mutations ?? []).map((m) => ({ id: m.id, status: 'applied' })) }),
    })
  })
  {
    // Back to the whole block: the search from case 4 narrowed the map to one.
    await page.locator('input[type="search"]').fill('')
    await page.waitForTimeout(700)
    ok(/3 leads inside/.test(await body()), 'with the search cleared the open shape holds the three again')
    await page.getByRole('button', { name: /Add 3 to selection/ }).click()
    await page.waitForTimeout(400)
    ok(/3 selected/.test(await body()), 'and they are selected')

    await page.getByTestId('bulk-list').click()
    await page.waitForTimeout(300)
    const panel = page.getByTestId('bulk-list-panel')
    ok((await panel.count()) === 1, 'Add to list opens a panel in the bar')
    ok(/Put 3 leads on a list/.test(await panel.innerText()), 'which says how many it is about to place')
    await panel.getByLabel('List name').fill('Oak Street Area')
    await panel.getByLabel('Marcus Vance').check()
    const apply = page.getByTestId('bulk-list-apply')
    ok(/Create list with 3/.test(await apply.innerText()), 'the button names the action and the count')
    await apply.click()
    await page.waitForTimeout(1500)

    ok(!!listPosted, 'creating posts the list to the server')
    ok(listPosted?.name === 'Oak Street Area', 'with the name typed', listPosted?.name)
    ok(
      JSON.stringify([...(listPosted?.propertyIds ?? [])].sort()) === JSON.stringify(['p1', 'p2', 'p3']),
      'holding exactly the three selected leads and never the one outside the shape',
      JSON.stringify(listPosted?.propertyIds),
    )
    ok(JSON.stringify(listPosted?.repIds) === JSON.stringify(['u_rep_1']), 'handed to the rep that was ticked', JSON.stringify(listPosted?.repIds))
    ok(
      /Created Oak Street Area with 3 leads\. Handed to Marcus Vance\./.test(await body()),
      'and the bar says what it made and who has it',
    )
    ok(!/selected/.test(await body()), 'the selection is cleared behind it')
    ok((await page.getByTestId('bulk-list-panel').count()) === 0, 'and the panel closes')
  }

  /* ===== 6. or joins a list that already exists ========================== */
  {
    await page.getByRole('button', { name: /Select an area/ }).click()
    await page.waitForTimeout(300)
    await tapAt(0.03, 0.03)
    await tapAt(0.97, 0.03)
    await tapAt(0.97, 0.97)
    await tapAt(0.03, 0.97)
    await page.getByRole('button', { name: /Add 3 to selection/ }).click()
    await page.waitForTimeout(400)
    await page.getByTestId('bulk-list').click()
    await page.waitForTimeout(300)
    const panel = page.getByTestId('bulk-list-panel')
    const options = await panel.getByLabel('Which list').locator('option').allInnerTexts()
    ok(options.some((o) => /Monday Route/.test(o)) && options.some((o) => /Oak Street Area/.test(o)),
      'the existing lists are offered, including the one just made', options.join(' | '))
    await panel.getByLabel('Which list').selectOption('ll_monday')
    await page.waitForTimeout(200)
    ok((await panel.getByLabel('List name').count()) === 0, 'choosing an existing list hides the name and the hand-to')
    const apply = page.getByTestId('bulk-list-apply')
    ok(/Add 3 to list/.test(await apply.innerText()), 'and the button says so')
    await apply.click()
    await page.waitForTimeout(1500)
    const members = mutationsPosted.find((m) => m.kind === 'list.members')
    ok(!!members, 'adding to an existing list queues a membership change')
    ok(members?.payload?.id === 'll_monday', 'for the list chosen', members?.payload?.id)
    ok(
      JSON.stringify([...(members?.payload?.add ?? [])].sort()) === JSON.stringify(['p1', 'p2', 'p3']),
      'adding exactly the three selected leads',
      JSON.stringify(members?.payload?.add),
    )
    ok(/Added 3 leads to Monday Route\./.test(await body()), 'and the bar says which list they joined')
  }

  ok(errors.length === 0, 'and the app threw nothing doing it', errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== a block can be selected by drawing round it ===')
