import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The console's side of onboarding: the roster's statuses, the per-person
 * actions, and Settings → Company.
 *
 * Every status the roster shows is the server's — this mock hands back the
 * derived words the Worker computes (see api/src/onboarding.ts), and what is
 * pinned is that the console *shows* them in the right column, filters by
 * them, and that each admin action calls the right endpoint with the right
 * body and leaves the sheet in a usable state. The server's half of each
 * action is pinned in api/scripts/smoke-onboarding-steps.mjs and
 * smoke-onboarding-flow.mjs.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const DAY = 86_400_000
const NOW = Date.now()

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) })
const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim())

/* ---- the company, as the server would hand it back ------------------------- */
function makeWorld() {
  const teams = [
    { id: 't_austin', name: 'Austin', memberCount: 1, createdAt: NOW - 90 * DAY },
    { id: 't_dallas', name: 'Dallas', memberCount: 0, createdAt: NOW - 60 * DAY },
  ]
  const company = { name: 'Ridgeline Roofing', timezone: 'America/Chicago', website: undefined, logoUrl: undefined }
  const people = [
    { id: 'u_admin', name: 'Nadia Petrov', firstName: 'Nadia', lastName: 'Petrov', email: 'nadia@ridgeline.test', role: 'super_admin', active: true, pending: false, invitation: 'not_sent', onboarding: 'complete', badge: 'active', badgeExpiresAt: NOW + 300 * DAY, createdAt: NOW - 100 * DAY, lastSeenAt: NOW - 60_000 },
    { id: 'u_marcus', name: 'Marcus Vance', firstName: 'Marcus', lastName: 'Vance', email: 'marcus@ridgeline.test', role: 'field_rep', jobTitle: 'Sales Representative', teamId: 't_austin', teamName: 'Austin', active: true, pending: false, invitation: 'accepted', invitedAt: NOW - 30 * DAY, onboarding: 'complete', badge: 'active', badgeExpiresAt: NOW + 335 * DAY, createdAt: NOW - 30 * DAY, lastSeenAt: NOW - 2 * 3_600_000 },
    { id: 'u_dana', name: 'Dana Whitfield', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@ridgeline.test', role: 'field_rep', active: false, pending: true, invitation: 'pending', invitedAt: NOW - 8 * DAY, resentAt: NOW - DAY, onboarding: 'not_started', badge: 'none', createdAt: NOW - 8 * DAY },
    { id: 'u_lee', name: 'Lee Tran', firstName: 'Lee', lastName: 'Tran', email: 'lee@ridgeline.test', role: 'field_rep', active: false, pending: true, invitation: 'expired', invitedAt: NOW - 20 * DAY, onboarding: 'not_started', badge: 'none', createdAt: NOW - 20 * DAY },
    { id: 'u_priya', name: 'Priya Natarajan', firstName: 'Priya', lastName: 'Natarajan', email: 'priya@ridgeline.test', role: 'manager', active: true, pending: false, invitation: 'accepted', invitedAt: NOW - 3 * DAY, onboarding: 'in_progress', onboardingStep: 'walkthrough', badge: 'awaiting_confirmation', badgeExpiresAt: NOW + 362 * DAY, createdAt: NOW - 3 * DAY, lastSeenAt: NOW - 20 * 60_000 },
    { id: 'u_sam', name: 'Sam Okafor', firstName: 'Sam', lastName: 'Okafor', email: 'sam@ridgeline.test', role: 'field_rep', active: false, pending: false, invitation: 'accepted', invitedAt: NOW - 400 * DAY, onboarding: 'complete', badge: 'expired', badgeExpiresAt: NOW - 30 * DAY, createdAt: NOW - 400 * DAY, lastSeenAt: NOW - 60 * DAY },
  ]
  return { teams, company, people, join: { code: 'ABCD2345', createdAt: NOW - 10 * DAY }, calls: [], badgeSeq: 0 }
}
const joinUrl = (code) => `https://allstar.letlois.com/join/${code}`
const meOf = (w, id) => {
  const p = w.people.find((x) => x.id === id)
  return {
    id: p.id, clientId: 'c_live', clientName: w.company.name, email: p.email, name: p.name, role: p.role,
    firstName: p.firstName, lastName: p.lastName, jobTitle: p.jobTitle, teamName: p.teamName,
    onboarding: { status: 'complete', version: 1, completedAt: NOW - 90 * DAY },
    badge: { id: '87654321', status: 'active', issuedAt: NOW - 10 * DAY, expiresAt: NOW + 355 * DAY, confirmedAt: NOW - 10 * DAY },
    company: { ...w.company },
  }
}

async function mockApi(page, w, asId = 'u_admin') {
  const record = (r) => w.calls.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, body: r.request().postData() ? JSON.parse(r.request().postData()) : undefined })
  // Anything not modelled answers empty rather than hanging a screen.
  await page.route('**/api/**', (r) => r.fulfill(json(200, {})))
  await page.route('**/api/auth/login', (r) => r.fulfill(json(200, { token: 'tok', user: meOf(w, asId) })))
  await page.route('**/api/bootstrap', (r) =>
    r.fulfill(json(200, { user: meOf(w, asId), properties: [], routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], serverTime: Date.now() })),
  )
  await page.route('**/api/me', (r) => r.fulfill(json(200, { user: meOf(w, asId) })))
  await page.route('**/api/me/onboarding', (r) => r.fulfill(json(200, { status: 'complete', step: 'profile', steps: [], version: 1, requiredVersion: 1, profile: {}, missing: [], setup: {}, walkthrough: {}, badge: null, checklist: [], canComplete: false })))
  await page.route('**/api/users', (r) => r.fulfill(json(200, { users: w.people.map((p) => ({ ...p })) })))
  await page.route('**/api/teams', async (r) => {
    if (r.request().method() === 'POST') {
      record(r)
      const { name } = JSON.parse(r.request().postData())
      const t = { id: `t_${name.toLowerCase()}`, name, memberCount: 0, createdAt: Date.now() }
      w.teams.push(t)
      return r.fulfill(json(201, t))
    }
    return r.fulfill(json(200, { teams: w.teams }))
  })
  await page.route(/\/api\/teams\/([^/]+)$/, async (r) => {
    record(r)
    const id = new URL(r.request().url()).pathname.split('/').pop()
    const t = w.teams.find((x) => x.id === id)
    if (!t) return r.fulfill(json(404, { error: 'No such team.' }))
    if (r.request().method() === 'PATCH') {
      t.name = JSON.parse(r.request().postData()).name
      for (const p of w.people) if (p.teamId === id) p.teamName = t.name
      return r.fulfill(json(200, t))
    }
    w.teams = w.teams.filter((x) => x.id !== id)
    for (const p of w.people) if (p.teamId === id) { p.teamId = undefined; p.teamName = undefined }
    return r.fulfill(json(200, { ok: true, unassigned: 0 }))
  })
  await page.route(/\/api\/invites\/([^/]+)\/(resend|revoke)$/, async (r) => {
    record(r)
    const [, , id, action] = new URL(r.request().url()).pathname.split('/').slice(1)
    const p = w.people.find((x) => x.id === id)
    if (!p) return r.fulfill(json(404, { error: 'No such person on this team.' }))
    if (!p.pending) return r.fulfill(json(409, { error: 'They already have a password, so there is nothing to invite them to.' }))
    if (action === 'resend') {
      p.invitation = 'pending'; p.invitedAt = Date.now()
      return r.fulfill(json(200, { url: `https://allstar.letlois.com/invite/fresh-${id}`, email: p.email, expiresAt: Date.now() + 7 * DAY, revoked: 1, emailed: false, mailError: 'MAILCHANNELS_API_KEY is not set' }))
    }
    p.invitation = 'revoked'
    return r.fulfill(json(200, { ok: true, revoked: 1 }))
  })
  await page.route(/\/api\/users\/([^/]+)\/(team|title|onboarding-reset|badge-renew|badge-regenerate|role|active)$/, async (r) => {
    record(r)
    const [, , id, action] = new URL(r.request().url()).pathname.split('/').slice(1)
    const p = w.people.find((x) => x.id === id)
    const body = r.request().postData() ? JSON.parse(r.request().postData()) : {}
    if (action === 'team') { p.teamId = body.teamId ?? undefined; p.teamName = w.teams.find((t) => t.id === body.teamId)?.name; return r.fulfill(json(200, { ok: true })) }
    if (action === 'title') { p.jobTitle = body.jobTitle || undefined; return r.fulfill(json(200, { ok: true })) }
    if (action === 'onboarding-reset') { p.onboarding = 'not_started'; p.onboardingStep = 'profile'; return r.fulfill(json(200, { ok: true })) }
    if (action === 'badge-renew') { p.badge = 'awaiting_confirmation'; p.badgeExpiresAt = Date.now() + 365 * DAY; return r.fulfill(json(200, { badge: { id: '32143567', status: 'awaiting_confirmation', expiresAt: p.badgeExpiresAt } })) }
    if (action === 'badge-regenerate') { w.badgeSeq += 1; p.badge = 'awaiting_confirmation'; return r.fulfill(json(200, { badge: { id: `9000000${w.badgeSeq}`, status: 'awaiting_confirmation', expiresAt: Date.now() + 365 * DAY } })) }
    return r.fulfill(json(200, { ok: true }))
  })
  await page.route('**/api/join-link', async (r) => {
    record(r)
    const m = r.request().method()
    if (m === 'DELETE') { w.join = { code: null }; return r.fulfill(json(200, { ok: true })) }
    if (m === 'POST') { w.join = { code: w.join.code === 'ABCD2345' ? 'WXYZ7788' : 'MNPQ3456', createdAt: Date.now() } }
    return r.fulfill(json(200, w.join.code ? { code: w.join.code, createdAt: w.join.createdAt, url: joinUrl(w.join.code) } : { code: null }))
  })
  await page.route('**/api/company', async (r) => {
    record(r)
    const body = JSON.parse(r.request().postData())
    if ('website' in body) w.company.website = body.website ? `https://${String(body.website).replace(/^https?:\/\//, '')}` : undefined
    if ('logo' in body) w.company.logoUrl = body.logo ?? undefined
    return r.fulfill(json(200, { company: { ...w.company } }))
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
const desktop = () => browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const row = (page, name) => page.locator('tbody tr', { hasText: name })
const called = (w, method, path) => w.calls.filter((c) => c.method === method && c.path === path)

/* ========================================================================== */
/* The roster: People is the default, every status a column                    */
/* ========================================================================== */
{
  const w = makeWorld()
  const ctx = await desktop()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  const headers = await page.locator('thead th').allInnerTexts().then((h) => h.map((x) => x.trim()))
  ok(['Name', 'Role', 'Team / office', 'Invitation', 'Account', 'Onboarding', 'Badge', 'Last active', 'Date added'].every((h) => headers.includes(h)), 'the People view carries the brief’s columns', headers.join(' | '))
  ok((await page.getByTestId('roster-people').count()) === 1, 'and is the view the page opens on')

  const dana = row(page, 'Dana Whitfield')
  ok((await dana.getByTestId('col-invitation').getAttribute('data-value')) === 'Pending' && (await dana.getByTestId('col-account').getAttribute('data-value')) === 'Invite pending', 'an invited rep reads Pending / Invite pending')
  ok((await dana.getByTestId('col-onboarding').getAttribute('data-value')) === 'Not started' && (await dana.getByTestId('col-badge').getAttribute('data-value')) === 'Not created', 'with onboarding not started and no badge')
  const lee = row(page, 'Lee Tran')
  ok((await lee.getByTestId('col-invitation').getAttribute('data-value')) === 'Expired', 'a stale link reads Expired', await lee.getByTestId('col-invitation').getAttribute('data-value'))
  const priya = row(page, 'Priya Natarajan')
  ok((await priya.getByTestId('col-onboarding').getAttribute('data-value')) === 'In progress' && (await priya.getByTestId('col-badge').getAttribute('data-value')) === 'Awaiting confirmation', 'someone mid-flow reads In progress / Awaiting confirmation')
  const sam = row(page, 'Sam Okafor')
  ok((await sam.getByTestId('col-account').getAttribute('data-value')) === 'Deactivated' && (await sam.getByTestId('col-badge').getAttribute('data-value')) === 'Expired', 'a removed rep reads Deactivated, badge Expired')
  ok(/Austin/.test(await text(row(page, 'Marcus Vance'))) && /Sales Representative/.test(await text(row(page, 'Marcus Vance'))), 'team and title are on the row')
  ok(/Never/.test(await text(dana)), 'someone who has never signed in reads Never under Last active')

  /* --- attention filters ---------------------------------------------------- */
  await page.getByRole('button', { name: /^Still setting up/ }).click()
  await page.waitForTimeout(300)
  ok((await page.locator('tbody tr').count()) === 1 && (await priya.count()) === 1, 'Still setting up keeps only the person mid-flow', `${await page.locator('tbody tr').count()} rows`)
  await page.getByRole('button', { name: /^Invite open/ }).click()
  await page.waitForTimeout(300)
  ok((await page.locator('tbody tr').count()) === 2 && (await dana.count()) === 1 && (await lee.count()) === 1, 'Invite open keeps the pending and the expired invitation', `${await page.locator('tbody tr').count()} rows`)
  await page.getByRole('button', { name: /^Badge not active/ }).click()
  await page.waitForTimeout(300)
  ok((await page.locator('tbody tr').count()) === 1 && (await priya.count()) === 1, 'Badge not active is about working accounts — a deactivated rep’s expired badge is not a to-do', `${await page.locator('tbody tr').count()} rows`)
  await page.getByRole('button', { name: /^Removed from team/ }).click()
  await page.waitForTimeout(300)
  ok((await page.locator('tbody tr').count()) === 1 && (await sam.count()) === 1, 'Removed from team keeps the removed rep')
  await page.getByRole('button', { name: /^Everyone/ }).click()
  await page.locator('input[type="search"]').fill('austin')
  await page.waitForTimeout(300)
  ok((await page.locator('tbody tr').count()) === 1 && (await row(page, 'Marcus Vance').count()) === 1, 'search matches the team name too')
  await page.locator('input[type="search"]').fill('')

  /* --- the performance view is still there ----------------------------------- */
  await page.getByRole('button', { name: /^Performance$/ }).click()
  await page.waitForTimeout(300)
  const perfHeaders = await page.locator('thead th').allInnerTexts().then((h) => h.map((x) => x.trim()))
  ok(perfHeaders.includes('Contact rate') && perfHeaders.includes('Doors') && !perfHeaders.includes('Onboarding'), 'Performance shows the numbers and not the statuses', perfHeaders.join(' | '))
  ok(!/read-only/i.test(await text(page.locator('body'))), 'nothing on the page still claims role changes are read-only')
  await page.getByRole('button', { name: /^People$/ }).click()
  await page.waitForTimeout(300)

  /* --- manage an invited rep: re-send and revoke ----------------------------- */
  await dana.click()
  await page.waitForTimeout(700)
  const detail = page.getByTestId('member-detail')
  ok((await detail.count()) === 1 && /Pending/.test(await text(detail.getByTestId('member-statuses'))), 'the sheet opens with the person’s statuses stated')
  ok((await detail.getByTestId('manage-invitation').count()) === 1 && (await detail.getByTestId('manage-onboarding').count()) === 0 && (await detail.getByTestId('manage-badge').count()) === 0, 'an invited rep gets invitation actions, and no onboarding or badge ones — there is nothing there yet')
  const dates = await text(detail.getByTestId('manage-invite-dates'))
  ok(/^Invited \w{3} \d{1,2}, \d{4}/.test(dates) && /Resent \w{3} \d{1,2}, \d{4}$/.test(dates), 'the sheet says when they were first asked and when they were chased', dates)
  ok(!dates.includes(new Date(NOW).getFullYear() + '-'), 'as dates a person reads, not timestamps')
  await detail.getByRole('button', { name: /^Re-send invite$/ }).click()
  await page.waitForTimeout(800)
  ok(called(w, 'POST', '/api/invites/u_dana/resend').length === 1, 'Re-send calls the resend endpoint for that person')
  ok(/fresh-u_dana/.test(await text(detail.getByTestId('manage-invite-link'))) && /Nothing was emailed/.test(await text(detail)), 'shows the fresh link and is honest that nothing was emailed')
  ok((await detail.count()) === 1, 'and the sheet stays open')
  await detail.getByRole('button', { name: /^Revoke invite$/ }).click()
  await page.waitForTimeout(800)
  ok(called(w, 'POST', '/api/invites/u_dana/revoke').length === 1, 'Revoke calls the revoke endpoint')
  ok((await detail.getByRole('button', { name: /^Revoke invite$/ }).count()) === 0 && (await detail.getByRole('button', { name: /^Send invite$/ }).count()) === 1, 'after which the sheet reads the refreshed roster: no link to revoke, an invite to send')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  ok((await dana.getByTestId('col-invitation').getAttribute('data-value')) === 'Revoked', 'the roster row reads Revoked', await dana.getByTestId('col-invitation').getAttribute('data-value'))

  /* --- manage a working rep: team, title, onboarding, badge ------------------- */
  await row(page, 'Marcus Vance').click()
  await page.waitForTimeout(900)
  ok((await detail.getByTestId('manage-invitation').count()) === 0, 'someone with a password gets no invitation section')
  await detail.getByTestId('manage-team-select').selectOption('t_dallas')
  await page.waitForTimeout(700)
  const teamCall = called(w, 'POST', '/api/users/u_marcus/team')[0]
  ok(teamCall && teamCall.body.teamId === 't_dallas', 'picking a team posts it for that person', JSON.stringify(teamCall?.body))
  ok((await detail.getByTestId('manage-team-select').inputValue()) === 't_dallas', 'and the picker shows the refreshed value')
  await detail.getByTestId('manage-title').fill('Crew Lead')
  await detail.getByTestId('manage-title-save').click()
  await page.waitForTimeout(700)
  const titleCall = called(w, 'POST', '/api/users/u_marcus/title')[0]
  ok(titleCall && titleCall.body.jobTitle === 'Crew Lead', 'saving a title posts it', JSON.stringify(titleCall?.body))
  await detail.getByTestId('manage-onboarding-reset').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/users/u_marcus/onboarding-reset').length === 1, 'Reset onboarding calls the reset endpoint')
  ok(/Not started/.test(await text(detail.getByTestId('member-statuses'))), 'and the sheet reads the server’s new status')
  await detail.getByTestId('manage-badge-renew').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/users/u_marcus/badge-renew').length === 1 && /#32143567 renewed/.test(await text(detail)), 'Renew calls badge-renew and names the id kept')
  await detail.getByTestId('manage-badge-regenerate').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/users/u_marcus/badge-regenerate').length === 1 && /#90000001/.test(await text(detail)), 'Regenerate calls badge-regenerate and names the new id')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  ok(/Dallas/.test(await text(row(page, 'Marcus Vance'))) && /Crew Lead/.test(await text(row(page, 'Marcus Vance'))), 'the roster row carries the new team and title')

  /* --- yourself --------------------------------------------------------------- */
  await row(page, 'Nadia Petrov').click()
  await page.waitForTimeout(700)
  ok((await detail.getByTestId('manage-team').count()) === 1 && (await detail.getByTestId('manage-onboarding').count()) === 0 && (await detail.getByRole('button', { name: /^Remove from team$/ }).count()) === 0, 'on yourself: team and title, but no reset, no removal')
  await page.keyboard.press('Escape')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* Settings → Company: badge details, the join link, teams                      */
/* ========================================================================== */
{
  const w = makeWorld()
  const ctx = await desktop()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /^Company$/ }).click()
  await page.waitForTimeout(900)
  const panel = page.getByTestId('company-panel')
  ok((await panel.count()) === 1, 'Settings has a Company tab')

  /* --- website, and the sample's QR ------------------------------------------- */
  ok((await panel.getByTestId('badge-qr').count()) === 1 && /\/verify\/12345678$/.test((await panel.getByTestId('badge-qr').getAttribute('data-target')) ?? ''), 'the sample badge carries a QR code to its own check, website or not', await panel.getByTestId('badge-qr').getAttribute('data-target'))
  await panel.getByTestId('company-website').fill('ridgelineroofing.com')
  await panel.getByTestId('company-website-save').click()
  await page.waitForTimeout(800)
  const site = called(w, 'POST', '/api/company').find((c) => 'website' in c.body)
  ok(site && site.body.website === 'ridgelineroofing.com', 'Save posts the website as typed — the server normalises', JSON.stringify(site?.body))
  ok(w.company.website === 'https://ridgelineroofing.com' && (await panel.getByTestId('company-website').inputValue()) === 'https://ridgelineroofing.com', 'and the field reads back the saved, normalised URL', await panel.getByTestId('company-website').inputValue())

  /* --- logo ------------------------------------------------------------------- */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await panel.getByTestId('company-logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png })
  await page.waitForTimeout(1200)
  const logo = called(w, 'POST', '/api/company').find((c) => 'logo' in c.body)
  ok(logo && /^data:image\/(png|jpeg);base64,/.test(logo.body.logo) && logo.body.logo.length < 64 * 1024, 'picking a file posts a small data-URL logo', `${logo?.body?.logo?.length} chars`)
  ok((await panel.getByTestId('company-logo').count()) === 1 && (await panel.getByTestId('badge-logo').count()) === 1, 'and the logo heads both the settings and the sample badge')
  await panel.getByTestId('company-logo-remove').click()
  await page.waitForTimeout(800)
  const cleared = called(w, 'POST', '/api/company').find((c) => 'logo' in c.body && c.body.logo === null)
  ok(!!cleared && (await panel.getByTestId('badge-lockup').count()) === 1, 'Remove posts null and the sample falls back to the lockup')

  /* --- join link -------------------------------------------------------------- */
  const joinBox = panel.getByTestId('company-join')
  ok((await text(joinBox.getByTestId('join-code'))) === 'ABCD 2345' && /\/join\/ABCD2345/.test(await text(joinBox.getByTestId('join-url'))), 'the join code and its link are shown to the admin', await text(joinBox.getByTestId('join-code')))
  await joinBox.getByTestId('join-rotate').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/join-link').length === 1 && (await text(joinBox.getByTestId('join-code'))) === 'WXYZ 7788', 'Change code rotates it and shows the new one', await text(joinBox.getByTestId('join-code')))
  await joinBox.getByTestId('join-disable').click()
  await page.waitForTimeout(700)
  ok(called(w, 'DELETE', '/api/join-link').length === 1 && (await joinBox.getByTestId('join-off').count()) === 1 && (await joinBox.getByTestId('join-code').count()) === 0, 'Turn off deletes the code and says self sign-up is off')
  await joinBox.getByTestId('join-enable').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/join-link').length === 2 && (await joinBox.getByTestId('join-code').count()) === 1, 'Turn on mints a fresh code')

  /* --- teams ------------------------------------------------------------------ */
  const teamsBox = panel.getByTestId('company-teams')
  ok((await teamsBox.getByTestId('team-row').count()) === 2 && /1 person/.test(await text(teamsBox.locator('[data-team="Austin"]'))), 'teams are listed with how many people are on each')
  await teamsBox.getByTestId('team-new').fill('Houston')
  await teamsBox.getByTestId('team-add').click()
  await page.waitForTimeout(700)
  ok(called(w, 'POST', '/api/teams')[0]?.body.name === 'Houston' && (await teamsBox.locator('[data-team="Houston"]').count()) === 1, 'Add team posts the name and lists it')
  await teamsBox.locator('[data-team="Dallas"]').getByRole('button', { name: /^Rename$/ }).click()
  await teamsBox.getByTestId('team-rename-input').fill('Dallas – Fort Worth')
  await teamsBox.getByTestId('team-rename-save').click()
  await page.waitForTimeout(700)
  ok(called(w, 'PATCH', '/api/teams/t_dallas')[0]?.body.name === 'Dallas – Fort Worth' && (await teamsBox.locator('[data-team="Dallas – Fort Worth"]').count()) === 1, 'Rename patches the team')
  await teamsBox.locator('[data-team="Houston"]').getByRole('button', { name: /^Delete$/ }).click()
  await page.waitForTimeout(700)
  ok(called(w, 'DELETE', '/api/teams/t_houston').length === 1 && (await teamsBox.locator('[data-team="Houston"]').count()) === 0, 'Delete removes the team')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* A manager sees the roster but holds none of the admin's levers               */
/* ========================================================================== */
{
  const w = makeWorld()
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w, 'u_priya')
  await signIn(page, 'priya@ridgeline.test')
  await page.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  ok((await row(page, 'Dana Whitfield').getByTestId('col-invitation').count()) === 1, 'a manager reads the same statuses')
  await row(page, 'Dana Whitfield').click()
  await page.waitForTimeout(700)
  const detail = page.getByTestId('member-detail')
  ok((await detail.getByTestId('manage-invitation').count()) === 0 && (await detail.getByTestId('manage-team').count()) === 0 && (await detail.getByTestId('manage-badge').count()) === 0, 'but gets no invitation, team or badge controls — those are canInvite, and the server would refuse them anyway')
  await ctx.close()
}

await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== the console reads the server’s statuses and pulls the right levers ===')
