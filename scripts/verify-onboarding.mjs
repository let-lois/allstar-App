import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'

/**
 * Onboarding on a phone — both ways in, driven end to end.
 *
 * Flow A: an admin added the rep with a first name and a title; the rep signs
 * in and is walked through profile → setup → walkthrough → badge → checklist
 * → ready → the map. Flow B: nobody invited them; they type the company code
 * on the sign-in screen and land in the same flow with nothing prefilled.
 *
 * The API is a stateful mock that applies the server's own rules — order,
 * prefill, minted-once, required vs recommended — so a failure here means the
 * *screens* are wrong, not that a Worker was down. The server's half of every
 * rule is pinned in api/scripts/smoke-onboarding-steps.mjs.
 *
 * What is asserted is what the brief asked for and what would silently break:
 *   the shell replaces the app until the server says complete
 *   only missing fields are asked for; prefilled ones are shown and editable
 *   admin-owned fields are shown and locked
 *   the checklist is the server's, and a required line disables Complete
 *   another device — and a reload — reopen at the server's step
 *   a denied location is recorded and does not block
 *   finishing lands on the map and the 22-step tour does not pile on
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const body = (page) => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

const STEPS = ['profile', 'setup', 'walkthrough', 'badge', 'checklist']
const DAY = 86_400_000

/** A person, and the server's rules about them. */
function makeState(over = {}) {
  return {
    id: 'u_rep', clientName: 'Ridgeline Roofing', email: 'marcus@ridgeline.test', role: 'field_rep',
    firstName: 'Marcus', lastName: null, phone: null, jobTitle: 'Sales Representative', teamName: 'Austin',
    hasPhoto: false, location: null, setupAt: null, walkAt: null, badge: null,
    step: 'profile', started: false, completedAt: null, version: 0,
    posts: [], mints: 0, mutations: 0, joinPosted: null,
    ...over,
  }
}
const nameOf = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email.split('@')[0]
const badgeStatus = (s) => (!s.badge ? 'none' : s.badge.confirmedAt ? 'active' : 'awaiting_confirmation')
function checklist(s) {
  return [
    { key: 'profile_complete', label: 'Profile complete', done: !!(s.firstName && s.lastName), required: true },
    { key: 'photo_added', label: 'Profile photo added', done: s.hasPhoto, required: true, detail: s.hasPhoto ? undefined : 'Your badge shows your face, not your initials.' },
    { key: 'role_assigned', label: 'Team / role assigned', done: true, required: true, detail: s.teamName ?? undefined },
    { key: 'location_enabled', label: 'Location enabled', done: s.location === 'granted', required: false, detail: s.location === 'granted' ? undefined : 'Recommended. Without it the map cannot find the nearest door for you.' },
    { key: 'walkthrough_completed', label: 'App walkthrough completed', done: !!s.walkAt, required: true },
    { key: 'badge_created', label: 'Team member badge created', done: !!s.badge, required: true },
    { key: 'badge_confirmed', label: 'Badge information confirmed', done: badgeStatus(s) === 'active', required: true },
  ]
}
const canComplete = (items) => items.every((i) => i.done || !i.required)
function view(s) {
  const items = checklist(s)
  const missing = []
  if (!s.firstName) missing.push('firstName')
  if (!s.lastName) missing.push('lastName')
  if (!s.hasPhoto) missing.push('photo')
  return {
    status: s.completedAt ? 'complete' : s.started ? 'in_progress' : 'not_started',
    step: STEPS.includes(s.step) ? s.step : 'profile',
    steps: STEPS, version: s.version, requiredVersion: 1, completedAt: s.completedAt ?? undefined,
    profile: { firstName: s.firstName ?? undefined, lastName: s.lastName ?? undefined, email: s.email, phone: s.phone ?? undefined, jobTitle: s.jobTitle ?? undefined, teamName: s.teamName ?? undefined, hasPhoto: s.hasPhoto, editable: ['firstName', 'lastName', 'phone', 'jobTitle'], locked: ['email', 'role', 'team'] },
    missing,
    setup: { completedAt: s.setupAt ?? undefined, locationStatus: s.location ?? undefined },
    walkthrough: { completedAt: s.walkAt ?? undefined },
    badge: s.badge ? { ...s.badge, status: badgeStatus(s) } : null,
    checklist: items, canComplete: canComplete(items),
  }
}
function userOf(s) {
  const v = view(s)
  return {
    id: s.id, clientId: 'c_live', clientName: s.clientName, email: s.email, name: nameOf(s), role: s.role,
    firstName: s.firstName ?? undefined, lastName: s.lastName ?? undefined, jobTitle: s.jobTitle ?? undefined, teamName: s.teamName ?? undefined,
    onboarding: { status: v.status, step: v.step, version: s.version, completedAt: s.completedAt ?? undefined },
    badge: v.badge, company: { name: s.clientName, timezone: 'America/Chicago' },
  }
}
const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) })

/** Install the mock API for one person on one page. */
async function mockApi(page, s) {
  await page.route('**/api/auth/login', (r) => r.fulfill(json(200, { token: 'tok', user: userOf(s) })))
  await page.route('**/api/join', async (r) => {
    s.joinPosted = JSON.parse(r.request().postData() || '{}')
    s.firstName = s.joinPosted.firstName ?? null
    s.lastName = s.joinPosted.lastName ?? null
    s.email = s.joinPosted.email
    s.jobTitle = null
    s.teamName = null
    await r.fulfill(json(201, { token: 'tok', user: userOf(s), claimedInvite: false }))
  })
  await page.route('**/api/bootstrap', (r) =>
    r.fulfill(json(200, {
      user: userOf(s),
      properties: [{ id: 'p1', address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5115, lng: -97.6755, status: 'new', score: 60, assignedRepId: s.id, contacts: [] }],
      routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], serverTime: Date.now(),
    })),
  )
  await page.route('**/api/me', (r) => r.fulfill(json(200, { user: userOf(s) })))
  await page.route('**/api/me/onboarding', (r) => r.fulfill(json(200, view(s))))
  await page.route('**/api/me/onboarding/step', async (r) => {
    const { step, data = {} } = JSON.parse(r.request().postData() || '{}')
    s.posts.push({ step, data })
    const current = STEPS.includes(s.step) ? s.step : 'profile'
    if (!s.completedAt && STEPS.indexOf(step) > STEPS.indexOf(current)) return r.fulfill(json(409, { error: `Finish "${current}" first.` }))
    s.started = true
    if (step === 'profile') {
      if (data.firstName) s.firstName = data.firstName
      if (data.lastName) s.lastName = data.lastName
      if ('phone' in data) s.phone = data.phone || null
      if ('jobTitle' in data) s.jobTitle = data.jobTitle || null
      if (!s.firstName || !s.lastName) return r.fulfill(json(400, { error: 'First and last name are needed to continue.', missing: ['lastName'] }))
    }
    if (step === 'setup') { s.location = data.locationStatus ?? 'skipped'; s.setupAt = Date.now() }
    if (step === 'walkthrough') s.walkAt = s.walkAt ?? Date.now()
    if (step === 'badge' && badgeStatus(s) !== 'active') return r.fulfill(json(409, { error: s.badge ? 'Confirm your badge first.' : 'Create your badge first.' }))
    if (step === 'checklist') {
      const items = checklist(s)
      if (!canComplete(items)) return r.fulfill(json(409, { error: 'Some required items are not done yet.', missing: items.filter((i) => i.required && !i.done).map((i) => i.key) }))
      s.completedAt = Date.now(); s.version = 1; s.step = null
      return r.fulfill(json(200, view(s)))
    }
    if (!s.completedAt && step === current) s.step = STEPS[STEPS.indexOf(step) + 1] ?? null
    await r.fulfill(json(200, view(s)))
  })
  await page.route('**/api/me/badge', (r) => {
    if (!s.badge) { s.mints += 1; s.badge = { id: '32143567', issuedAt: Date.now(), expiresAt: Date.now() + 365 * DAY } }
    else s.mints += 1
    return r.fulfill(json(200, { badge: { ...s.badge, status: badgeStatus(s) } }))
  })
  await page.route('**/api/me/badge/confirm', (r) => {
    if (s.badge && !s.badge.confirmedAt) s.badge.confirmedAt = Date.now()
    return r.fulfill(json(200, { badge: { ...s.badge, status: badgeStatus(s) } }))
  })
  await page.route('**/api/mutations', async (r) => {
    const { mutations = [] } = JSON.parse(r.request().postData() || '{}')
    for (const m of mutations) if (m.kind === 'user.avatar') { s.hasPhoto = true; s.mutations += 1 }
    await r.fulfill(json(200, { results: mutations.map((m) => ({ id: m.id, status: 'applied' })), serverTime: Date.now() }))
  })
  await page.route('**/api/users', (r) => r.fulfill(json(403, { error: 'Not permitted.' })))
  await page.route('**/api/teams', (r) => r.fulfill(json(200, { teams: [] })))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
}

const phone = (extra = {}) =>
  browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...extra })

async function signIn(page, email) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.locator('input[type="email"]').first().fill(email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
}

/** Every button on screen is thumb-sized. */
async function targets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href]')]
      .filter((el) => el.getBoundingClientRect().width > 0 && !el.hasAttribute('aria-hidden'))
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => `${el.tagName}:${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)} ${Math.round(el.getBoundingClientRect().height)}px`),
  )
}

/* ========================================================================== */
/* Flow A — invited, prefilled, walked through to the map                     */
/* ========================================================================== */
{
  const s = makeState()
  const ctx = await phone({ permissions: ['geolocation'], geolocation: { latitude: 30.5115, longitude: -97.6755 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, s)
  await signIn(page, s.email)

  const shell = page.getByTestId('onboarding')
  ok((await shell.count()) === 1, 'signing in as someone who has not onboarded opens onboarding, not the app')
  ok((await shell.getAttribute('data-step')) === 'profile', 'at the profile step', await shell.getAttribute('data-step'))
  ok(/Step 1 of 5/.test(await body(page)), 'and says step 1 of 5')
  ok((await page.locator('nav').count()) === 0, 'with no app navigation underneath — there is nothing else to do yet')
  ok((await targets(page)).length === 0, `every target on the profile step is at least 44px${(await targets(page)).length ? ' — ' + (await targets(page)).join(', ') : ''}`)

  /* --- profile: prefilled, locked, and only the missing asked for -------- */
  ok((await page.getByTestId('profile-first').inputValue()) === 'Marcus', 'the first name the admin typed is filled in')
  ok((await page.getByTestId('profile-last').inputValue()) === '', 'and the last name, which nobody typed, is empty')
  const locked = await page.getByTestId('profile-locked').innerText()
  ok(/marcus@ridgeline\.test/.test(locked) && /Field Rep/.test(locked) && /Austin/.test(locked), 'email, role and team are shown', locked.replace(/\s+/g, ' '))
  ok(/Set by your admin/.test(await body(page)), 'and marked as the admin’s to change')
  ok((await page.getByTestId('profile-locked').locator('input').count()) === 0, 'with no input behind them')
  ok(/Sales Representative/.test(await page.locator('input[placeholder="Sales Representative"]').inputValue()), 'the title the admin typed is filled in and editable')

  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(300)
  ok(/first and last name/i.test(await body(page)), 'continuing without a last name is caught on the phone')
  ok(s.posts.length === 0, 'and nothing was sent')

  await page.getByTestId('profile-last').fill('Vance')
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(700)
  const p = s.posts[0]
  ok(p?.step === 'profile' && p.data.firstName === 'Marcus' && p.data.lastName === 'Vance', 'the profile step posts both names', JSON.stringify(p?.data))
  ok(p?.data.jobTitle === 'Sales Representative', 'and the prefilled title, untouched')
  ok((await shell.getAttribute('data-step')) === 'setup' && /Step 2 of 5/.test(await body(page)), 'and the shell shows the step the server answered with', await shell.getAttribute('data-step'))

  /* --- setup: location already granted is read, never re-asked ----------- */
  const locCard = page.getByTestId('setup-location')
  await page.waitForTimeout(400)
  ok((await locCard.getAttribute('data-state')) === 'granted', 'a location permission already granted reads as on without prompting', await locCard.getAttribute('data-state'))
  ok((await locCard.getByRole('button').count()) === 0, 'and offers no button — asking for a permission you hold teaches the browser to distrust you')
  ok(/Camera and photos/.test(await body(page)) && /asks the first time you take a photo/i.test(await body(page)), 'camera says it is asked on use, and has no switch to flip')
  ok((await page.getByTestId('setup-camera').getByRole('button').count()) === 0, 'because there is nothing to grant ahead of time')
  ok((await targets(page)).length === 0, 'every target on the setup step is at least 44px')
  await page.getByTestId('setup-continue').click()
  await page.waitForTimeout(700)
  ok(s.posts[1]?.step === 'setup' && s.posts[1].data.locationStatus === 'granted', 'setup posts the granted status', JSON.stringify(s.posts[1]?.data))
  ok((await shell.getAttribute('data-step')) === 'walkthrough', 'and moves to the walkthrough')

  /* --- walkthrough: five cards in the brief's order ------------------------ */
  const seen = []
  for (let i = 0; i < 5; i++) {
    const card = page.getByTestId('walkthrough-card')
    seen.push(await card.getAttribute('data-key'))
    if (i < 4) {
      ok((await page.getByTestId('walkthrough-done').count()) === 0, `card ${i + 1} offers Next, not Continue`)
      await page.getByTestId('walkthrough-next').click()
      await page.waitForTimeout(150)
    }
  }
  ok(seen.join(' → ') === 'map → knock → log → leads → performance', 'the five cards run map, knock, log, leads, performance', seen.join(' → '))
  ok(/Track performance/.test(await body(page)), 'the last card is on screen')
  ok((await targets(page)).length === 0, 'every target on the walkthrough is at least 44px')
  await page.getByTestId('walkthrough-done').click()
  await page.waitForTimeout(700)
  ok(s.posts[2]?.step === 'walkthrough' && (await shell.getAttribute('data-step')) === 'badge', 'finishing the last card posts the walkthrough and opens the badge')

  /* --- badge: minted once, read, confirmed -------------------------------- */
  await page.waitForTimeout(500)
  ok(s.mints === 1, 'opening the badge step minted exactly once', `${s.mints}`)
  ok(/#32143567/.test(await page.getByTestId('badge-id').innerText()), 'the badge shows its id', await page.getByTestId('badge-id').innerText())
  ok((await page.getByTestId('badge-name').innerText()) === 'Marcus Vance', 'the name from both halves')
  ok(/sales representative/i.test(await page.getByTestId('badge-title').innerText()), 'and the title')
  ok(/Ridgeline Roofing/.test(await page.getByTestId('badge-preview').innerText()), 'and the company')
  await page.getByTestId('badge-confirm').click()
  await page.waitForTimeout(800)
  ok(s.badge?.confirmedAt != null, 'confirming records the confirmation')
  ok(s.posts[3]?.step === 'badge' && (await shell.getAttribute('data-step')) === 'checklist', 'and completes the step')
  ok(s.mints === 1, 'still one mint after confirming and moving on', `${s.mints}`)

  /* --- checklist: the server's lines, and a required one blocks ---------- */
  const items = page.getByTestId('checklist-item')
  ok((await items.count()) === 8, 'seven server lines plus this phone’s own install line', `${await items.count()}`)
  const photo = items.filter({ has: page.locator('[data-key="photo_added"]') }).first()
  const photoLine = page.locator('[data-testid="checklist-item"][data-key="photo_added"]')
  ok((await photoLine.getAttribute('data-done')) === 'false', 'the photo line is not done')
  ok(await page.getByTestId('checklist-complete').isDisabled(), 'and Complete setup is disabled because a required line is not done')
  ok(/5 of 6 required/.test(await body(page)), 'the summary counts the required lines', (await body(page)).match(/\d of \d required[^.]*/)?.[0])
  const locLine = await page.locator('[data-testid="checklist-item"][data-key="location_enabled"]').innerText()
  ok(/recommended/i.test(locLine) && (await page.locator('[data-testid="checklist-item"][data-key="location_enabled"]').getAttribute('data-required')) === 'false', 'location is marked recommended, not required', locLine.replace(/\s+/g, ' '))
  ok(/recommended/i.test(await page.locator('[data-testid="checklist-item"][data-key="installed"]').innerText()), 'and so is installing')
  void photo

  // Fix the photo: back to the profile, through the real picker and the real outbox.
  await photoLine.getByRole('button', { name: /^Fix$/ }).click()
  await page.waitForTimeout(400)
  ok((await shell.getAttribute('data-step')) === 'profile', 'Fix on the photo line goes back to the profile')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const mutation = page.waitForRequest((r) => r.url().includes('/api/mutations'), { timeout: 8000 }).catch(() => null)
  await page.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
  ok((await mutation) !== null, 'picking a photo sends it through the outbox, the same road More uses')
  await page.waitForTimeout(300)
  ok(s.hasPhoto === true && s.mutations === 1, 'and the server records the photo')
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(700)
  ok((await shell.getAttribute('data-step')) === 'checklist', 'continuing from a redone profile returns to where the server holds the place — the checklist')
  ok((await page.locator('[data-testid="checklist-item"][data-key="photo_added"]').getAttribute('data-done')) === 'true', 'the photo line is done now')
  ok(!(await page.getByTestId('checklist-complete').isDisabled()), 'and Complete setup is enabled')
  ok(/Everything needed is in place/.test(await body(page)), 'the summary agrees')
  ok((await page.locator('[data-testid="checklist-item"][data-key="location_enabled"]').getAttribute('data-done')) === 'true', 'location reads done — it was granted')

  /* --- ready → the map, with no tour piling on ---------------------------- */
  await page.getByTestId('checklist-complete').click()
  await page.waitForTimeout(800)
  ok(s.completedAt != null && s.posts.at(-1)?.step === 'checklist', 'Complete setup posts the checklist and the server marks completion')
  ok((await shell.getAttribute('data-step')) === 'ready' && /ready to sell, Marcus/i.test(await body(page)), 'the ready screen greets them by name', (await body(page)).match(/ready to sell[^.]*/i)?.[0])
  ok((await targets(page)).length === 0, 'every target on the ready screen is at least 44px')
  await page.getByTestId('start-knocking').click()
  await page.waitForTimeout(1800)
  ok(/\/map$/.test(page.url()), 'Start knocking lands a rep on the map', page.url())
  ok((await page.getByTestId('onboarding').count()) === 0, 'and onboarding is gone')
  ok((await page.locator('nav').count()) > 0, 'the app’s navigation is back')
  ok((await page.locator('[data-tour-card]').count()) === 0, 'the 22-step tour does not pile onto somebody who just finished the walkthrough')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

/* ========================================================================== */
/* Resumability — another device, and a reload, reopen at the server's step   */
/* ========================================================================== */
{
  const s = makeState({ firstName: 'Marcus', lastName: 'Vance', step: 'walkthrough', started: true, location: 'granted', setupAt: Date.now() })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  const shell = page.getByTestId('onboarding')
  ok((await shell.getAttribute('data-step')) === 'walkthrough' && /Step 3 of 5/.test(await body(page)), 'a second device opens at the step the server holds — the walkthrough', await shell.getAttribute('data-step'))
  await page.getByTestId('walkthrough-next').click()
  await page.getByTestId('walkthrough-next').click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  ok((await page.getByTestId('onboarding').getAttribute('data-step')) === 'walkthrough' && /Step 3 of 5/.test(await body(page)), 'closing the app mid-flow and reopening lands on the same step')
  await ctx.close()
}

/* ========================================================================== */
/* Denied location — recorded, explained, never blocking                      */
/* ========================================================================== */
{
  const s = makeState({ firstName: 'Marcus', lastName: 'Vance', step: 'setup', started: true })
  const ctx = await phone({ permissions: [] })
  const page = await ctx.newPage()
  /*
    Playwright reports an un-granted permission as "denied" outright; a real
    phone that has never been asked reports "prompt" until the person answers.
    Stub the two browser calls to behave like that phone: not yet asked, then
    a refusal when the button asks. What is under test is the screen's
    handling of each answer, not Chromium's permission model.
  */
  await page.addInitScript(() => {
    let state = 'prompt'
    let queried = 0
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => { queried += 1; return { state } } },
      configurable: true,
    })
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        // The app reads the position on sign-in and again when the map mounts;
        // neither is the person answering a prompt. Only the ask button's
        // call — armed by the gate just before the click — counts as a refusal.
        getCurrentPosition: (_ok, err) => {
          if (window.__armDeny) state = 'denied'
          err && err({ code: 1, message: 'denied' })
        },
        watchPosition: () => 1,
        clearWatch: () => {},
      },
      configurable: true,
    })
    window.__geoQueries = () => queried
  })
  await mockApi(page, s)
  await signIn(page, s.email)
  const card = page.getByTestId('setup-location')
  await page.waitForTimeout(500)
  ok((await card.getAttribute('data-state')) === 'prompt', 'a permission never asked for reads as not yet asked, and nothing prompts by itself', await card.getAttribute('data-state'))
  ok((await page.getByTestId('setup-location-ask').count()) === 1, 'with the one button that asks')
  await page.evaluate(() => { window.__armDeny = true })
  await page.getByTestId('setup-location-ask').click()
  await page.waitForTimeout(1500)
  ok((await card.getAttribute('data-state')) === 'denied', 'a refusal reads as off', await card.getAttribute('data-state'))
  ok(/cannot find the nearest door/i.test(await card.innerText()) && /settings/i.test(await card.innerText()), 'and says what is lost and where to turn it on')
  ok(/Continue anyway/.test(await page.getByTestId('setup-continue').innerText()), 'the button is honest that they are continuing without it')
  await page.getByTestId('setup-continue').click()
  await page.waitForTimeout(700)
  ok(s.posts.at(-1)?.data.locationStatus === 'denied', 'setup posts denied', JSON.stringify(s.posts.at(-1)?.data))
  ok((await page.getByTestId('onboarding').getAttribute('data-step')) === 'walkthrough', 'and the flow moves on — a denied location never blocks')
  await ctx.close()
}

/* --- and a phone that already said no: no button, the same honest copy ---- */
{
  const s = makeState({ firstName: 'Marcus', lastName: 'Vance', step: 'setup', started: true })
  const ctx = await phone({ permissions: [] })
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  const card = page.getByTestId('setup-location')
  await page.waitForTimeout(500)
  ok((await card.getAttribute('data-state')) === 'denied', 'a permission already refused reads as off on arrival', await card.getAttribute('data-state'))
  ok((await card.getByRole('button').count()) === 0, 'and offers no button — there is no prompt left to raise')
  ok(/settings/i.test(await card.innerText()), 'but says where to turn it on')
  await ctx.close()
}

/* ========================================================================== */
/* Flow B — nobody invited them; the company code on the sign-in screen       */
/* ========================================================================== */
{
  const s = makeState({ firstName: null, jobTitle: null, teamName: null })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  ok((await page.getByTestId('join-form').count()) === 0, 'the sign-in screen does not open on the create-account form')
  ok((await page.getByTestId('create-account').count()) === 1, 'but offers it')
  ok((await page.getByRole('button', { name: /Try the demo/ }).count()) === 1, 'alongside the demo')
  await page.getByTestId('create-account').click()
  await page.waitForTimeout(300)
  await page.getByTestId('join-submit').click()
  await page.waitForTimeout(300)
  ok(/company code/i.test(await body(page)) && s.joinPosted === null, 'an empty code is caught on the phone')
  await page.getByTestId('join-code').fill('abcd 2345')
  ok((await page.getByTestId('join-code').inputValue()) === 'ABCD 2345', 'the code is shown upper-case as typed')
  await page.getByTestId('join-email').fill('casey@ridgeline.test')
  await page.getByTestId('join-password').fill('short')
  await page.getByTestId('join-submit').click()
  await page.waitForTimeout(300)
  ok(/at least 10 characters/i.test(await body(page)) && s.joinPosted === null, 'a short password is caught on the phone')
  await page.getByTestId('join-password').fill('caseys-password-1234')
  await page.getByTestId('join-submit').click()
  await page.waitForTimeout(1800)
  ok(s.joinPosted?.code === 'ABCD 2345' && s.joinPosted?.email === 'casey@ridgeline.test', 'the code and email reach the server as typed — the server normalises', JSON.stringify(s.joinPosted))
  ok(!('firstName' in (s.joinPosted ?? {})) || s.joinPosted.firstName === undefined, 'names were optional and none were invented')
  const shell = page.getByTestId('onboarding')
  ok((await shell.count()) === 1 && (await shell.getAttribute('data-step')) === 'profile', 'joining opens onboarding at the profile', await shell.getAttribute('data-step'))
  ok((await page.getByTestId('profile-first').inputValue()) === '' && (await page.getByTestId('profile-last').inputValue()) === '', 'with both name fields empty — nobody typed them')
  ok(!/Team \/ office/.test(await page.getByTestId('profile-locked').innerText()), 'and no team row, since there is no team')
  await ctx.close()

  // The link form: /join/CODE opens the panel with the code in.
  const ctx2 = await phone()
  const page2 = await ctx2.newPage()
  await mockApi(page2, makeState())
  await page2.goto(`${BASE}/join/wxyz7788`, { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(900)
  ok((await page2.getByTestId('join-form').count()) === 1 && (await page2.getByTestId('join-code').inputValue()) === 'WXYZ7788', 'a /join/CODE link opens the create-account form with the code filled in', await page2.getByTestId('join-code').inputValue())
  await ctx2.close()
}

/* ========================================================================== */
/* Somebody who has finished sees the app, not the flow                        */
/* ========================================================================== */
{
  const s = makeState({ firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - DAY, version: 1, step: null, started: true })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  ok((await page.getByTestId('onboarding').count()) === 0, 'a complete account goes straight into the app')
  ok(/\/today$/.test(page.url()), 'on Today', page.url())
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== onboarding walks a new rep to the map, both ways in ===')
process.exit(fails.length ? 1 : 0)
