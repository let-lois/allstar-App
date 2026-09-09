import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * A live rep's first morning.
 *
 * This suite exists because of two defects that only appear on a real account
 * and are invisible in the demo, where a route is always seeded:
 *
 *   1. Today told a rep with five assigned leads and no route "Route complete —
 *      0 doors knocked today. Nice work." It congratulated them for work they
 *      hadn't done and offered no way to start.
 *   2. The map defaults to "My route" and so showed "0 properties", while the
 *      Leads tab one tap away showed five.
 *
 * Neither threw an error. Both would have been found by the first real rep to
 * open the app, which is the worst possible place to find them.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const REP = {
  id: 'u_rep',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'rep@ridgeline.test',
  name: 'Marcus Vance',
  role: 'field_rep',
}

const leads = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    address1: `${100 + i * 2} Cedar Bend Dr`,
    city: 'Round Rock',
    state: 'TX',
    zip: '78664',
    lat: 30.5115 + i * 0.0004,
    lng: -97.6755 - i * 0.0004,
    status: 'new',
    score: 60,
    assignedRepId: REP.id,
    contacts: [],
  }))

const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * A stateful mock of the API.
 *
 * Stateful on purpose: a mock that accepts a write and then serves a bootstrap
 * that doesn't contain it isn't a server, it's a trap, and a client can't be
 * expected to satisfy it without keeping deleted rows forever. Applying the
 * write is what makes "does the rep's day survive a refresh" a fair question.
 *
 * `blockMutations` simulates the case the sync layer actually has to survive:
 * work queued on the phone that has not reached the server yet.
 */
async function signIn(ctx, properties, { blockMutations = false } = {}) {
  const page = await ctx.newPage()
  const posted = []
  const server = { routes: [], tasks: [], appointments: [] }

  await page.route('**/api/auth/login', json(200, { token: 'tok', user: REP }))
  await page.route('**/api/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: REP,
        properties,
        routes: server.routes,
        appointments: server.appointments,
        tasks: server.tasks,
        activity: [],
        dailyStats: [],
        serverTime: Date.now(),
      }),
    })
  })
  await page.route('**/api/mutations', async (route) => {
    if (blockMutations) return route.abort('connectionrefused')
    const body = JSON.parse(route.request().postData() || '{}')
    posted.push(...(body.mutations ?? []))
    for (const m of body.mutations ?? []) {
      if (m.kind === 'route.create') {
        server.routes = [...server.routes.filter((r) => r.id !== m.payload.id), m.payload]
      }
      if (m.kind === 'task.create') server.tasks.push(m.payload)
      if (m.kind === 'appointment.create') server.appointments.push(m.payload)
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: (body.mutations ?? []).map((m) => ({ id: m.id, status: 'applied' })),
        serverTime: Date.now(),
      }),
    })
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(REP.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  /*
    This gate is the first day, so the first-run tour is not an intruder here —
    it is part of the thing being tested. A rep who has never opened the app
    meets it before they meet the route. Dismissed the way they would, so the
    rest of the day can be checked.
  */
  await dismissTour(page)
  return { page, posted, server }
}

const ctxOpts = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
}

/* ========== leads assigned, no route planned ============================= */
{
  const ctx = await browser.newContext(ctxOpts)
  const { page, posted } = await signIn(ctx, leads(5))

  const body = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  ok(!(await body()).includes('Route complete'), 'a rep with no route is NOT told their route is complete')
  ok(!(await body()).includes('Nice work'), 'no congratulations for work that has not happened')
  ok((await body()).includes('Ready to plan your day'), 'the rep is offered a plan for the day')
  ok((await body()).includes('5 leads waiting'), 'the offer states how much work is available')

  // The map used to show nothing at all here.
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  /*
    The count moved out of its own pill and into the search field's placeholder
    when search took that space — so it is read as an attribute now rather than
    as page text. The assertion is unchanged in substance: this was written after
    a real bug where a new rep's map showed nothing at all, and "does not say
    zero" is the part that must keep holding.
  */
  const hint =
    (await page
      .getByRole('searchbox', { name: /Search leads and addresses/i })
      .getAttribute('placeholder')) ?? ''
  ok(!/Search 0 leads/.test(hint), 'the map does not claim zero leads when five are assigned')
  ok(/Search 5 leads/.test(hint), `the map shows the assigned leads ("${hint}")`)
  /*
    Asked of the control, not of the page's text.

    `innerText` was the old way and it was about to become a gate that passes
    without testing anything: the filters moved into a sheet, and text inside a
    closed sheet is not in `innerText` — so this would have read as green
    whether or not the rule still held. Counting the button keeps it honest, and
    the count must be exactly zero rather than merely falsy.
  */
  ok(
    (await page.getByRole('button', { name: /^My route$/ }).count()) === 0,
    'the "My route" filter is hidden while there is no route',
  )

  /* ---- plan the day ---------------------------------------------------- */
  await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /^Plan 5 doors$/ }).click()
  await page.waitForTimeout(1500)

  // innerText reflects CSS text-transform, so the label renders uppercase.
  const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/next stop/i.test(after), 'planning the day produces a next stop')
  ok(/0 \/ 5/.test(after), `route progress reads zero of five (${after.match(/\d+ \/ \d+/)?.[0]})`)
  ok(after.includes('100 Cedar Bend Dr'), 'the nearest lead is the first stop')

  const routeMutation = posted.find((m) => m.kind === 'route.create')
  ok(!!routeMutation, 'the new route is queued for the server')
  ok(routeMutation?.payload?.stops?.length === 5, `all five leads became stops (${routeMutation?.payload?.stops?.length})`)
  ok(
    routeMutation?.payload?.stops?.filter((s) => s.status === 'active').length === 1,
    'exactly one stop is active in what gets sent',
  )
  ok(
    routeMutation?.payload?.stops?.every((s, i) => s.order === i),
    'stop order is preserved on the wire',
  )

  /*
    A full page load re-boots the app and pulls a fresh bootstrap. Once the
    mutation has landed the server knows about the route, so this is the ordinary
    case — but it is also the one that proves the route was really persisted
    rather than living in React state.
  */
  await page.goto(`${BASE}/route`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1400)
  const routeText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(routeText.includes('Cedar Bend Dr'), 'the route is named after the street being walked')
  ok(!routeText.includes('No route planned yet'), 'the route survives a reload once the server has it')

  await ctx.close()
}

/* ========== the route is planned while the phone can't reach the server == */
//
// This is the case that matters, and the one that was broken: the rep plans a
// day on no signal, the route.create sits in the outbox, and then something
// triggers a refresh. A refresh that treats the server's answer as complete
// deletes the day — silently, seconds after they planned it. The same hole
// swallows tasks, appointments and leads added in the field.
{
  const ctx = await browser.newContext(ctxOpts)
  const { page } = await signIn(ctx, leads(5), { blockMutations: true })

  await page.getByRole('button', { name: /^Plan 5 doors$/ }).click()
  await page.waitForTimeout(1400)
  ok(/next stop/i.test(await page.locator('body').innerText()), 'the day is planned even with no server')

  const state = () =>
    page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('allstar-field')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const tx = db.transaction(['routes', 'outbox'], 'readonly')
      const get = (n) =>
        new Promise((res) => {
          const r = tx.objectStore(n).getAll()
          r.onsuccess = () => res(r.result)
        })
      return { routes: (await get('routes')).length, outbox: (await get('outbox')).length }
    })

  const queued = await state()
  ok(queued.routes === 1, 'the route is written to the device immediately')
  ok(queued.outbox > 0, 'the route is queued for the server')

  // Reload: boot pulls a bootstrap that cannot contain the route.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  const afterReload = await state()
  ok(
    afterReload.routes === 1,
    `an unsynced route survives a refresh (${afterReload.routes} route(s) on device)`,
  )
  ok(
    /cedar bend/i.test(await page.locator('body').innerText()),
    'the rep still sees their day after the refresh',
  )
  /*
    The specific failure this pins:

    `initSync()` drains the outbox on start-up. It used to run *before* the
    session was read, so `isDemo()` answered "yes" — nobody was signed in yet —
    and the demo simulator marked every queued mutation applied and deleted it.
    On a live account that means a rep queues a morning of visits with no signal,
    closes the app, reopens it, and the work is gone. Never sent, no error, no
    trace. The offline suite could not catch it because that suite runs in demo
    mode, where answering "demo" is correct.

    So: the rows must still be here, and the server must still not have been
    asked — because it is unreachable, which is the whole point.
  */
  ok(
    afterReload.outbox > 0,
    `queued work survives a cold start on a live account (${afterReload.outbox} row(s))`,
  )
  const rows = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('allstar-field')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('outbox', 'readonly')
    return new Promise((res) => {
      const r = tx.objectStore('outbox').getAll()
      r.onsuccess = () => res(r.result)
    })
  })
  ok(
    rows.some((m) => m.kind === 'route.create'),
    'the route mutation specifically is still waiting to be sent',
  )
  ok(
    rows.every((m) => m.status !== 'failed' && m.attempts === 0),
    'an unreachable server did not burn the retry budget on a cold start',
  )

  await ctx.close()
}

/* ========== no leads at all — a genuinely empty account ================== */
{
  const ctx = await browser.newContext(ctxOpts)
  const { page } = await signIn(ctx, [])
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  ok(text.includes('No doors to walk yet'), 'an empty account says so plainly')
  ok(!text.includes('Route complete'), 'an empty account is not told its route is complete')
  ok(
    /assigned to you/.test(text),
    'the rep is told why it is empty rather than left to guess',
  )
  ok(
    (await page.getByRole('button', { name: /Add a lead/ }).count()) > 0,
    'the rep is given something they can actually do',
  )
  await ctx.close()
}

/* ========== a route that really is finished ============================== */
{
  const ctx = await browser.newContext(ctxOpts)

  /*
    "Knocked earlier today" has to mean today at every hour of the day.

    This fixture used to say `Date.now() - 3_600_000`, which is yesterday
    between midnight and 1am — and the app is right to call a lead knocked
    yesterday routable, so the screen correctly offered a plan and the gate
    correctly failed. It failed for an hour a day while saying nothing at all
    about the app, which is worse than not existing: it taught me to read a red
    line as noise, and I went on to wave through a genuine access-control
    failure on the same reasoning.

    So: an hour ago, or this morning, whichever is later. Midnight is read from
    the browser rather than from Node so that this keeps holding if the context
    is ever given a `timezoneId` of its own.
  */
  const probe = await ctx.newPage()
  const startOfToday = await probe.evaluate(() => new Date().setHours(0, 0, 0, 0))
  await probe.close()

  // Every lead knocked earlier today: nothing routable, but the day happened.
  const worked = leads(3).map((p) => ({
    ...p,
    status: 'contacted',
    lastVisitAt: Math.max(startOfToday, Date.now() - 3_600_000),
  }))
  const { page } = await signIn(ctx, worked)
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(
    text.includes('No doors to walk yet'),
    'with every door already knocked today there is nothing left to plan',
  )
  ok(!text.includes('Nice work'), 'the finished-route congratulation is reserved for an actual route')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} first-day check(s) failed` : '\na live rep’s first day works')
process.exit(fails.length ? 1 : 0)
