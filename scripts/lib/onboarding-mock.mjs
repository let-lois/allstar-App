/**
 * A stateful mock of the onboarding API, shared by the phone-side gates.
 *
 * One person, and the server's rules about them: order, prefill, minted-once,
 * required vs recommended, expiry outranking confirmation. The rules are the
 * ones api/src/onboarding.ts and onboardingFlow.ts enforce; the server's half
 * is pinned in api/scripts/smoke-onboarding-steps.mjs. A failure in a gate
 * built on this means the *screens* are wrong, not that a Worker was down.
 */
const STEPS = ['profile', 'setup', 'walkthrough', 'badge', 'checklist']
const DAY = 86_400_000
/** A one-pixel PNG: the smallest thing that is still a photo. */
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A person, and the server's rules about them. */
function makeState(over = {}) {
  return {
    id: 'u_rep', clientName: 'Ridgeline Roofing', email: 'marcus@ridgeline.test', role: 'field_rep',
    firstName: 'Marcus', lastName: null, phone: null, jobTitle: 'Sales Representative', teamName: 'Austin',
    hasPhoto: false, location: null, setupAt: null, walkAt: null, badge: null,
    step: 'profile', started: false, completedAt: null, version: 0,
    website: null, logoUrl: null, badgeQrUrl: null,
    posts: [], mints: 0, renews: 0, mutations: 0, joinPosted: null, profilePatches: [],
    ...over,
  }
}
const nameOf = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email.split('@')[0]
const badgeStatus = (s) => (!s.badge ? 'none' : s.badge.expiresAt <= Date.now() ? 'expired' : s.badge.confirmedAt ? 'active' : 'awaiting_confirmation')
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
    badge: v.badge, company: { name: s.clientName, timezone: 'America/Chicago', website: s.website ?? undefined, logoUrl: s.logoUrl ?? undefined, badgeQrUrl: s.badgeQrUrl ?? undefined },
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
      // The roster is how a face reaches a phone: the same road the Worker uses.
      team: [{ id: s.id, name: nameOf(s), role: s.role, active: true, avatarUrl: s.hasPhoto ? PHOTO : undefined }],
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
  await page.route('**/api/me/badge/renew', (r) => {
    if (!s.badge) return r.fulfill(json(409, { error: 'Create your badge first.' }))
    if (badgeStatus(s) !== 'expired') return r.fulfill(json(409, { error: 'Your badge has not expired.' }))
    s.renews += 1
    s.badge = { ...s.badge, expiresAt: Date.now() + 365 * DAY, confirmedAt: undefined }
    return r.fulfill(json(200, { badge: { ...s.badge, status: badgeStatus(s) } }))
  })
  await page.route('**/api/me/profile', async (r) => {
    const data = JSON.parse(r.request().postData() || '{}')
    s.profilePatches.push(data)
    if (data.firstName) s.firstName = data.firstName
    if (data.lastName) s.lastName = data.lastName
    if ('phone' in data) s.phone = data.phone || null
    if ('jobTitle' in data) s.jobTitle = data.jobTitle || null
    await r.fulfill(json(200, { user: userOf(s) }))
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

const phone = (browser, extra = {}) =>
  browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...extra })

async function signIn(page, BASE, email) {
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


const body = (page) => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

export { STEPS, DAY, PHOTO, makeState, nameOf, badgeStatus, checklist, canComplete, view, userOf, json, mockApi, phone, signIn, targets, body }
