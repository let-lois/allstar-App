import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { button } from './lib/app.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Sign-in verification.
 *
 * Covers the two doors and the failure between them:
 *
 *   1. the demo path still works with no account and no server — the pitch must
 *      never depend on the backend being up
 *   2. real credentials reach the API, and a live account lands in a populated
 *      app rather than an empty one
 *   3. a session that dies mid-shift drops the rep back to sign-in *without*
 *      discarding the work sitting in their outbox
 *
 * The API is mocked at the network layer rather than pointed at the deployed
 * Worker on purpose. This suite has to be able to fail for exactly one reason —
 * the client mishandled a response — and a test that also depends on a live
 * deployment, a valid password and cellular latency cannot tell you that.
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

function newContext() {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5115, longitude: -97.6755 },
  })
}

const TENANT_USER = {
  id: 'u_live_rep',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'rep@ridgeline.test',
  name: 'Marcus Vance',
  role: 'field_rep',
}

const LIVE_PROPERTY = {
  id: 'p_live_1',
  address1: '1420 Cedar Bend Dr',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  lat: 30.5115,
  lng: -97.6755,
  status: 'new',
  score: 71,
  assignedRepId: TENANT_USER.id,
  contacts: [],
}

const bootstrapBody = {
  user: TENANT_USER,
  properties: [LIVE_PROPERTY],
  routes: [],
  appointments: [],
  tasks: [],
  activity: [],
  dailyStats: [],
  serverTime: Date.now(),
}

const jsonRoute = (status, body) => (route) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  })

/* ========== 1. the form itself ========================================== */
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })

  const emailBox = page.locator('input[type="email"]')
  ok(await emailBox.isVisible(), 'email field is present on first load')
  ok(
    await page.locator('input[autocomplete="current-password"]').isVisible(),
    'password field is present on first load',
  )

  // The demo used to be the whole login screen. It must still be reachable, but
  // it is no longer what a real rep sees first.
  ok(
    (await page.getByRole('button', { name: /Try the demo/ }).count()) === 1,
    'the demo is offered alongside real sign-in',
  )
  ok(
    (await page.getByRole('button', { name: /Dana Whitfield/ }).count()) === 0,
    'demo identities are not shown until the demo is chosen',
  )

  // Every target on the first screen a rep touches at 6am, one-handed.
  const small = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('button, input')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.height < 44) bad.push(`${el.tagName}:${(el.textContent || el.type).trim()} ${Math.round(r.height)}px`)
    }
    return bad
  })
  ok(small.length === 0, `all sign-in targets are at least 44px${small.length ? ` — ${small.join(', ')}` : ''}`)

  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(200)
  ok(
    (await page.locator('text=/Enter your email and password/').count()) > 0,
    'an empty submit is caught locally instead of round-tripping',
  )

  // A wrong password: the server's deliberately-ambiguous message reaches the
  // rep verbatim rather than being replaced with something friendlier and less
  // true.
  await page.route('**/api/auth/login', jsonRoute(401, { error: 'Incorrect email or password.' }))
  await emailBox.fill('rep@ridgeline.test')
  await page.locator('input[autocomplete="current-password"]').fill('wrong-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(400)
  ok(
    (await page.locator('text=/Incorrect email or password/').count()) > 0,
    'a rejected credential shows the server’s reason',
  )
  ok(await emailBox.isVisible(), 'a failed sign-in stays on the sign-in screen')

  // Unreachable server. This is the distinction that matters in the field: the
  // rep needs to know whether it's them or the signal.
  await page.unroute('**/api/auth/login')
  await page.route('**/api/auth/login', (route) => route.abort('connectionrefused'))
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(600)
  const unreachable = await page.locator('text=/reach the server|You’re offline|You\'re offline/').count()
  ok(unreachable > 0, 'an unreachable server is reported as a connection problem, not a bad password')

  await ctx.close()
}

/* ========== 2. the demo path still works with no server ================= */
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  // Nothing may reach the API. The pitch has to survive a dead backend.
  await page.route('**/api/**', (route) => route.abort('connectionrefused'))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1500)

  ok((await page.locator('text=/Next stop/').count()) > 0, 'demo sign-in reaches a populated Today screen')

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  ok(
    (await page.locator('text=/Demo — sample data/').count()) > 0,
    'the demo says so on the account card',
  )
  // Collapsed panels don't render their children, so open it before looking.
  await page.getByRole('button', { name: /Field testing/ }).click()
  await page.waitForTimeout(300)
  ok(
    (await page.locator('text=/Reset demo data/').count()) > 0,
    'demo reset is offered in demo mode',
  )
  await ctx.close()
}

/* ========== 3. a live account lands in its own tenant's data ============ */
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  await page.route('**/api/auth/login', jsonRoute(200, { token: 'tok_live_1', user: TENANT_USER }))
  await page.route('**/api/bootstrap', jsonRoute(200, bootstrapBody))
  await page.route('**/api/mutations', jsonRoute(200, { results: [], serverTime: Date.now() }))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill('rep@ridgeline.test')
  await page.locator('input[autocomplete="current-password"]').fill('correct-horse-battery')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)

  ok((await page.locator('input[type="email"]').count()) === 0, 'a valid credential signs in')
  // A real sign-in is a first run, and the first run opens the tour.
  await dismissTour(page)

  await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  ok(
    (await page.locator('text=/1420 Cedar Bend/').count()) > 0,
    'the server’s properties are what the rep sees',
  )
  // The seeded demo territory must not be sitting underneath a real account.
  ok(
    (await page.locator('text=/Cattleman/').count()) === 0,
    'no demo data leaks into a live account',
  )

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  ok(
    (await page.locator('text=/syncing to server/').count()) > 0,
    'a live account says it is syncing to the server',
  )
  await page.getByRole('button', { name: /Field testing/ }).click()
  await page.waitForTimeout(300)
  ok(
    (await page.locator('text=/Reset demo data/').count()) === 0,
    'demo reset is hidden on a live account — it would only delete real work',
  )

  /* ---- the session dies mid-shift ------------------------------------- */
  //
  // The rep's queued work is the thing at risk. A naive implementation signs
  // them out and clears local state, which on this app means throwing away
  // knocks that never reached the server.
  //
  // Order matters: the work has to be *queued and still unsent* when the token
  // dies. Flipping to 401 first would sign the rep out on the very first
  // mutation, before there was anything to lose.
  await page.unroute('**/api/mutations')
  await page.route('**/api/mutations', (route) => route.abort('connectionrefused'))

  await page.goto(`${BASE}/property/${LIVE_PROPERTY.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  /*
    A hard navigation straight to a deep link, so the app boots and bootstraps
    from scratch before this screen can have anything on it. When that does not
    happen the useful information is what the screen says instead — see
    lib/app.mjs.
  */
  ;(await button(page, /Start visit/, { why: 'a deep link into a property after a cold boot' })).click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /Interested/ }).first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /Complete visit/ }).click()
  await page.waitForTimeout(1200)

  const readOutbox = () =>
    page.evaluate(async () => {
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

  const queued = await readOutbox()
  ok(queued.length > 0, `a completed visit queues work on a live account (${queued.length} rows)`)

  // Now the token dies, and the queue tries to drain.
  await page.unroute('**/api/mutations')
  await page.route('**/api/mutations', jsonRoute(401, { error: 'Not signed in.' }))
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(1600)

  const afterExpiry = await readOutbox()
  ok(
    afterExpiry.length === queued.length,
    `queued work survives an expired session (${afterExpiry.length} of ${queued.length} rows kept)`,
  )
  ok(
    afterExpiry.every((m) => m.status !== 'failed'),
    'expired-session rows are not marked failed — there is nothing wrong with them',
  )
  ok(
    afterExpiry.every((m) => m.attempts === 0),
    'an expired session does not burn the retry budget',
  )
  ok(
    (await page.locator('input[type="email"]').count()) === 1,
    'an expired session returns the rep to sign-in',
  )
  ok(
    (await page.locator('text=/still saved on this phone/').count()) > 0,
    'the rep is told their work is safe rather than left guessing',
  )
  await ctx.close()
}

/* ========== 4. signing out doesn't leave data on a shared phone ========= */
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  await page.route('**/api/auth/login', jsonRoute(200, { token: 'tok_live_2', user: TENANT_USER }))
  await page.route('**/api/bootstrap', jsonRoute(200, bootstrapBody))
  await page.route('**/api/auth/logout', jsonRoute(200, { ok: true }))
  await page.route('**/api/mutations', jsonRoute(200, { results: [], serverTime: Date.now() }))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill('rep@ridgeline.test')
  await page.locator('input[autocomplete="current-password"]').fill('correct-horse-battery')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await dismissTour(page)

  /*
    From the foot of More, and through the confirmation: it clears photos that
    have not uploaded, so it asks first wherever it sits.
  */
  await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  // Through the dock, as a person would: an in-app move, which also works offline.
  await page.locator('a[href="/more"]:visible').first().click()
  await page.waitForTimeout(900)
  await page.getByTestId('sign-out').click()
  await page.waitForTimeout(700)
  await page
    .locator('[role="dialog"], .fixed')
    .getByRole('button', { name: /^Sign out$/ })
    .last()
    .click()
  await page.waitForTimeout(1200)

  ok((await page.locator('input[type="email"]').count()) === 1, 'sign out returns to the sign-in screen')

  const leftBehind = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('allstar-field')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('properties', 'readonly')
    return new Promise((res) => {
      const r = tx.objectStore('properties').getAll()
      r.onsuccess = () => res(r.result.length)
    })
  })
  ok(leftBehind === 0, `the previous account's leads are gone from the device (${leftBehind} rows)`)

  await ctx.close()
}

/* ========== forgot password ============================================ */
//
// The button that was deliberately absent for a year. What it must do: send
// the address from the form, say a link is on its way *if* the address has an
// account — never more than that — and, on a deployment with no email, say so
// instead of promising a link that cannot arrive.
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  const asked = []
  await page.route('**/api/auth/forgot', (route) => {
    asked.push(route.request().postDataJSON())
    return jsonRoute(200, { ok: true })(route)
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const open = page.getByTestId('forgot-open')
  ok((await open.count()) === 1 && /Forgot password\?/.test(await open.innerText()), 'the sign-in screen offers Forgot password?')
  await open.click()
  await page.getByTestId('forgot-submit').click()
  await page.waitForTimeout(300)
  ok((await page.getByTestId('forgot-error').count()) === 1 && asked.length === 0, 'with no email typed it asks for one and sends nothing')
  await page.locator('input[type="email"]').fill('rep@ridgeline.test')
  await page.getByTestId('forgot-submit').click()
  await page.waitForTimeout(800)
  ok(asked.length === 1 && asked[0]?.email === 'rep@ridgeline.test', 'the address from the sign-in form is what is sent', JSON.stringify(asked[0]))
  const sent = page.getByTestId('forgot-sent')
  const sentText = (await sent.count()) ? await sent.innerText() : '(nothing)'
  ok(/rep@ridgeline\.test/.test(sentText) && /^If /.test(sentText.trim()), 'and the screen says a link is on its way — if that address has an account', sentText.slice(0, 60))
  ok(!/no account|not found|does not exist/i.test(sentText), 'without claiming to know whether it does')
  ok((await page.locator('input[autocomplete="current-password"]').count()) === 1, 'the sign-in form is still there for when it arrives')
  await ctx.close()
}
{
  const ctx = await newContext()
  const page = await ctx.newPage()
  await page.route(
    '**/api/auth/forgot',
    jsonRoute(501, {
      error: 'Email is not set up for this app, so a reset link cannot be sent from here. Ask your administrator for one — they can create it from Team → Manage.',
      code: 'mail_not_configured',
    }),
  )
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.locator('input[type="email"]').fill('rep@ridgeline.test')
  await page.getByTestId('forgot-open').click()
  await page.getByTestId('forgot-submit').click()
  await page.waitForTimeout(800)
  const err = page.getByTestId('forgot-error')
  ok(
    (await err.count()) === 1 && /not set up/.test(await err.innerText()) && (await page.getByTestId('forgot-sent').count()) === 0,
    'with no email configured the person is told to ask their admin, not that a link is coming',
  )
  await page.unroute('**/api/auth/forgot')
  await page.route('**/api/auth/forgot', jsonRoute(429, { error: 'Too many requests for this address. Wait a few minutes and try again.', code: 'rate_limited' }))
  await page.getByTestId('forgot-submit').click()
  await page.waitForTimeout(800)
  ok(/Too many/.test(await page.getByTestId('forgot-error').innerText()), 'and a rate limit is reported as one')
  await ctx.close()
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} sign-in check(s) failed`)
  process.exit(1)
}
console.log('\nsign-in works in both modes')
