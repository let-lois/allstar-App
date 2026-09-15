import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The onboarding state machine, end to end, against a real Worker.
 *
 * A rep the admin added with a first name and a title accepts their invitation
 * and is walked through every step — profile, setup, walkthrough, badge,
 * checklist — the way the phone will drive it. What is pinned is less the happy
 * path than the shape of the machine:
 *
 *   the server holds the place: a second session opens at the same step
 *   steps go in order: skipping ahead is refused, redoing an earlier one is not
 *   only what is missing is asked for: the admin's title and first name arrive
 *   prefilled, and finishing the profile needs only the last name
 *   the badge is minted once, and never before there is a name to print on it
 *   confirming is its own act, and completing needs it
 *   a denied location does not block completion; a missing photo does
 *   an admin's reset keeps everything entered and re-opens the flow
 *   renew keeps the id and clears confirmation; regenerate changes the id
 *   a rep cannot renew a badge that has not expired, nor reset anyone
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8891)
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/onboarding-steps-state')
const SETUP_TOKEN = 'local-setup-token'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const wrangler = resolve(api, 'node_modules/.bin/wrangler')
function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const path = resolve(api, '.wrangler/onboarding-steps.toml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return path
}
let child = null
let log = ''
async function start(config) {
  child = spawn(
    wrangler,
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'info', '--var', `SETUP_TOKEN:${SETUP_TOKEN}`, '--var', 'SESSION_PEPPER:local-steps-pepper'],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  for (let i = 0; i < 90; i++) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return await res.json() } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}
async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null
}
const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } })
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
const form = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
const login = (email, password) => call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig()
  execFileSync(wrangler, ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'], { cwd: api, stdio: 'ignore' })
  await start(config)
  await form(`${BASE}/setup`, { token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Nadia Petrov', email: ADMIN.email, password: ADMIN.password })
  const admin = await (await login(ADMIN.email, ADMIN.password)).json()
  const A = admin.token

  /* ===== 0. the founder is onboarded by definition ============================ */
  let r = await j(await call('/api/me/onboarding', {}, A))
  ok(r.status === 200 && r.body.status === 'complete' && !!r.body.completedAt, 'the administrator who set the company up is not walked through a rep’s setup', `${r.body.status} / ${r.body.completedAt}`)

  /* ===== 1. a rep, added with a first name and a title, accepts =============== */
  const REP = `jordan-${Date.now()}@example.com`
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: REP, role: 'field_rep', firstName: 'Jordan', jobTitle: 'Sales Representative' }) }, A))
  const team = await (await call('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Austin' }) }, A)).json()
  await call(`/api/users/${r.body.userId}/team`, { method: 'POST', body: JSON.stringify({ teamId: team.id }) }, A)
  await form(r.body.url, { password: 'jordans-password-1234' })
  const rep = await (await login(REP, 'jordans-password-1234')).json()
  const R = rep.token
  const repId = rep.user.id
  ok(rep.user.onboarding.status === 'not_started', 'the login payload says onboarding has not started')

  /* ===== 2. what the profile step is told ===================================== */
  r = await j(await call('/api/me/onboarding', {}, R))
  const v = r.body
  ok(v.step === 'profile', 'the flow opens at profile', v.step)
  ok(v.profile.firstName === 'Jordan' && v.profile.jobTitle === 'Sales Representative' && v.profile.teamName === 'Austin', 'with what the admin typed already filled in', `${v.profile.firstName} / ${v.profile.jobTitle} / ${v.profile.teamName}`)
  ok(v.missing.join(',') === 'lastName,photo', 'and asks only for what is missing', v.missing.join(','))
  ok(v.profile.editable.join(',') === 'firstName,lastName,phone,jobTitle', 'the rep may change name, phone and title')
  ok(v.profile.locked.join(',') === 'email,role,team', 'and not email, role or team — those are the admin’s')
  ok(Array.isArray(v.checklist) && v.checklist.length === 8 && v.canComplete === false, 'the checklist is there from the start and is not yet completable')

  /* ===== 3. order is enforced ================================================= */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'setup', data: { locationStatus: 'granted' } }) }, R))
  ok(r.status === 409 && /Finish "profile" first/.test(r.body.error), 'skipping ahead to setup is refused', `${r.status} ${r.body.error}`)
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'nonsense' }) }, R))
  ok(r.status === 400, 'an unknown step is refused')

  /* ===== 4. the profile: last name is enough ================================== */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'profile', data: {} }) }, R))
  ok(r.status === 400 && r.body.missing?.join(',') === 'lastName', 'continuing with no last name is refused and says which field', `${r.status} missing=${r.body.missing}`)
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'profile', data: { lastName: 'Vale', phone: '512 555 0134' } }) }, R))
  ok(r.status === 200 && r.body.step === 'setup', 'a last name completes the profile and moves to setup', `${r.status} → ${r.body.step}`)
  ok(r.body.status === 'in_progress', 'and onboarding is now in progress')
  let me = (await (await call('/api/me', {}, R)).json()).user
  ok(me.name === 'Jordan Vale' && me.firstName === 'Jordan' && me.lastName === 'Vale', 'the display name is rebuilt from both halves', me.name)
  ok(me.jobTitle === 'Sales Representative', 'and the admin’s title survived — the rep did not send one, so it was not touched')
  const roster = (await (await call('/api/users', {}, A)).json()).users
  ok(roster.find((u) => u.id === repId)?.onboarding === 'in_progress', 'the console sees in progress')

  /* ===== 5. a badge cannot be minted before a name — proved on someone else ===== */
  {
    const NONAME = `noname-${Date.now()}@example.com`
    const inv = await (await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: NONAME, role: 'field_rep' }) }, A)).json()
    await form(inv.url, { password: 'noname-password-1234' })
    const n = await (await login(NONAME, 'noname-password-1234')).json()
    r = await j(await call('/api/me/badge', { method: 'POST' }, n.token))
    ok(r.status === 409 && r.body.missing?.includes('firstName'), 'minting a badge with no name is refused, naming the fields', `${r.status} ${r.body.error}`)
    r = await j(await call('/api/me/badge/confirm', { method: 'POST' }, n.token))
    ok(r.status === 409, 'and there is nothing to confirm')
  }

  /* ===== 6. setup: denied location is recorded and does not block ============= */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'setup', data: { locationStatus: 'bogus' } }) }, R))
  ok(r.status === 400, 'an unknown location status is refused')
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'setup', data: { locationStatus: 'denied', notificationStatus: 'maybe' } }) }, R))
  ok(r.status === 400, 'an unknown notification status is refused too')
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'setup', data: { locationStatus: 'denied', notificationStatus: 'granted' } }) }, R))
  ok(r.status === 200 && r.body.step === 'walkthrough' && r.body.setup.locationStatus === 'denied', 'setup records a denied location and moves on', `→ ${r.body.step}`)
  ok(r.body.setup.notificationStatus === 'granted', 'and the notification answer', r.body.setup.notificationStatus)
  const loc = r.body.checklist.find((i) => i.key === 'location_enabled')
  ok(loc.done === false && loc.required === false, 'the checklist shows location not done and not required')
  const notif = r.body.checklist.find((i) => i.key === 'notifications_enabled')
  ok(notif && notif.done === true && notif.required === false, 'and notifications done and recommended, not required', JSON.stringify(notif))

  /* ===== 7. the walkthrough ================================================ */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'walkthrough' }) }, R))
  ok(r.status === 200 && r.body.step === 'badge' && typeof r.body.walkthrough.completedAt === 'number', 'the walkthrough is recorded and moves to the badge', `→ ${r.body.step}`)
  const firstWalk = r.body.walkthrough.completedAt

  /* ===== 8. a second phone opens where the first left off ======================= */
  const phone2 = await (await login(REP, 'jordans-password-1234')).json()
  r = await j(await call('/api/me/onboarding', {}, phone2.token))
  ok(r.body.step === 'badge' && r.body.status === 'in_progress', 'another device resumes at the badge step — the server held the place', r.body.step)

  /* ===== 9. the badge: minted once ============================================ */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'badge' }) }, R))
  ok(r.status === 409 && /Create your badge first/.test(r.body.error), 'finishing the badge step with no badge is refused', r.body.error)
  r = await j(await call('/api/me/badge', { method: 'POST' }, R))
  ok(r.status === 200 && /^[1-9]\d{7}$/.test(r.body.badge?.id ?? ''), 'a badge is minted with an eight-digit id', r.body.badge?.id)
  const badge = r.body.badge
  ok(badge.status === 'awaiting_confirmation' && !badge.confirmedAt, 'awaiting confirmation')
  const days = (badge.expiresAt - badge.issuedAt) / 86_400_000
  ok(Math.abs(days - 365) < 0.01, 'and expires one year from issue', `${days.toFixed(2)} days`)
  r = await j(await call('/api/me/badge', { method: 'POST' }, R))
  ok(r.body.badge?.id === badge.id && r.body.badge?.issuedAt === badge.issuedAt, 'asking again returns the same badge — viewing never regenerates the id')
  r = await j(await call('/api/me/badge', { method: 'POST' }, phone2.token))
  ok(r.body.badge?.id === badge.id, 'from another device too')
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'badge' }) }, R))
  ok(r.status === 409 && /Confirm your badge first/.test(r.body.error), 'finishing the badge step before confirming is refused', r.body.error)
  r = await j(await call('/api/me/badge/renew', { method: 'POST' }, R))
  ok(r.status === 409 && /has not expired/.test(r.body.error), 'a rep cannot renew a badge that has not expired')

  /* ===== 10. confirm, once ================================================== */
  r = await j(await call('/api/me/badge/confirm', { method: 'POST' }, R))
  ok(r.status === 200 && r.body.badge.status === 'active' && typeof r.body.badge.confirmedAt === 'number', 'confirming makes the badge active with a timestamp')
  const confirmedAt = r.body.badge.confirmedAt
  await new Promise((res) => setTimeout(res, 30))
  r = await j(await call('/api/me/badge/confirm', { method: 'POST' }, R))
  ok(r.body.badge.confirmedAt === confirmedAt, 'confirming again keeps the first timestamp')
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'badge' }) }, R))
  ok(r.status === 200 && r.body.step === 'checklist', 'and the badge step can now be finished', `→ ${r.body.step}`)

  /* ===== 11. the checklist: photo is required, location is not ================= */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'checklist' }) }, R))
  ok(r.status === 409 && r.body.missing?.join(',') === 'photo_added', 'completing without a photo is refused, and the photo is the only thing named', `${r.status} missing=${r.body.missing}`)
  // The photo arrives the way the phone sends it: through the outbox.
  r = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id: `m-${Date.now()}`, kind: 'user.avatar', payload: { userId: repId, dataUrl: PNG }, createdAt: Date.now() }] }) }, R))
  ok(r.status === 200 && r.body.results?.[0]?.status === 'applied', 'the profile photo is set through the same mutation the More screen uses')
  r = await j(await call('/api/me/onboarding', {}, R))
  ok(r.body.canComplete === true && r.body.missing.length === 0, 'with the photo, everything required is done and nothing is missing')
  ok(r.body.checklist.filter((i) => !i.done).map((i) => i.key).join(',') === 'location_enabled', 'the only line not done is the recommended one')
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'checklist' }) }, R))
  ok(r.status === 200 && r.body.status === 'complete', 'completing works', r.body.status)
  ok(r.body.version === 1 && typeof r.body.completedAt === 'number', 'at version 1, with a timestamp')
  me = (await (await call('/api/me', {}, R)).json()).user
  ok(me.onboarding.status === 'complete' && me.badge?.status === 'active', 'the login-shaped payload agrees')
  const row = (await (await call('/api/users', {}, A)).json()).users.find((u) => u.id === repId)
  ok(row.onboarding === 'complete' && row.badge === 'active', 'and so does the roster', `${row.onboarding} / ${row.badge}`)

  /* ===== 12. redoing an earlier step after completion changes data, not place ==== */
  r = await j(await call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: 'walkthrough' }) }, R))
  ok(r.status === 200 && r.body.status === 'complete' && r.body.walkthrough.completedAt === firstWalk, 'watching the walkthrough again neither un-completes anything nor moves the first completion')
  r = await j(await call('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ jobTitle: 'Senior Sales Representative', firstName: '' }) }, R))
  ok(r.status === 200 && r.body.user.jobTitle === 'Senior Sales Representative' && r.body.user.firstName === 'Jordan', 'a rep edits their own title later; an empty first name is "no change", not a blank badge')
  r = await j(await call('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ phone: '' }) }, R))
  ok(r.status === 200 && r.body.user.phone === undefined, 'but a phone can be cleared')

  /* ===== 13. the admin: reset, renew, regenerate; the rep: none of them ========== */
  ok((await call(`/api/users/${admin.user.id}/onboarding-reset`, { method: 'POST' }, R)).status === 403, 'a rep cannot reset anyone’s onboarding')
  ok((await call(`/api/users/${repId}/badge-regenerate`, { method: 'POST' }, R)).status === 403, 'nor regenerate a badge, even their own, through the admin route')

  r = await j(await call(`/api/users/${repId}/badge-renew`, { method: 'POST' }, A))
  ok(r.status === 200 && r.body.badge.id === badge.id && r.body.badge.expiresAt > badge.expiresAt && !r.body.badge.confirmedAt, 'an admin renews: same id, later expiry, confirmation cleared', r.body.badge.id)
  r = await j(await call(`/api/users/${repId}/badge-regenerate`, { method: 'POST' }, A))
  ok(r.status === 200 && r.body.badge.id !== badge.id && /^[1-9]\d{7}$/.test(r.body.badge.id), 'an admin regenerates: a different id', `${badge.id} → ${r.body.badge.id}`)
  const newBadge = r.body.badge.id
  r = await j(await call('/api/me/onboarding', {}, R))
  ok(r.body.badge.id === newBadge && r.body.status === 'complete' && r.body.canComplete === false, 'the rep now carries the new, unconfirmed badge — onboarding stays complete, but the checklist honestly shows confirmation undone')

  r = await j(await call(`/api/users/${repId}/onboarding-reset`, { method: 'POST' }, A))
  ok(r.status === 200, 'an admin resets onboarding')
  ok((await call('/api/me/onboarding', {}, R)).status === 401, 'which signs the rep out, so it takes effect on the phone in their hand')
  const again = await (await login(REP, 'jordans-password-1234')).json()
  r = await j(await call('/api/me/onboarding', {}, again.token))
  ok(r.body.status === 'not_started' && r.body.step === 'profile', 'and on their next sign-in the flow opens at the top', `${r.body.status} / ${r.body.step}`)
  ok(r.body.profile.firstName === 'Jordan' && r.body.profile.lastName === 'Vale' && r.body.profile.hasPhoto && r.body.badge?.id === newBadge, 'with everything they entered still there — a reset asks again, it does not erase')
  ok(r.body.missing.length === 0, 'so the profile step has nothing to ask')

  /* ===== 13b. a stranger checks the badge: public, honest, rate-limited ========== */
  const pub = async (id) => j(await fetch(`${BASE}/api/verify?badge=${encodeURIComponent(id)}`))
  r = await pub(newBadge)
  ok(r.status === 200 && r.body.status === 'pending' && r.body.person.name === 'Jordan Vale' && r.body.company.name === 'Summit Exteriors', 'with no session at all, the regenerated badge reads as pending — issued, not yet confirmed', `${r.status} ${r.body.status}`)
  ok(!('email' in r.body.person) && !('role' in r.body.person) && !('id' in r.body.person), 'and the answer carries no email, role or user id — only what a homeowner needs')
  r = await j(await call('/api/me/badge/confirm', { method: 'POST' }, again.token))
  r = await pub(newBadge)
  ok(r.status === 200 && r.body.status === 'active' && typeof r.body.person.photoUrl === 'string' && r.body.person.title === 'Senior Sales Representative', 'once confirmed it reads as active, with the photo and the title the rep chose to compare at the door', r.body.status)
  r = await pub(badge.id)
  ok(r.status === 404, 'the id that was regenerated away belongs to nobody now', `${r.status}`)
  r = await pub('abc')
  ok(r.status === 404, 'a malformed number is a miss, not an error', `${r.status}`)
  await call(`/api/users/${repId}/active`, { method: 'POST', body: JSON.stringify({ active: false }) }, A)
  r = await pub(newBadge)
  ok(r.status === 200 && r.body.status === 'inactive' && r.body.person.name === 'Jordan Vale' && !r.body.person.photoUrl, 'a removed team member’s badge reads as no longer valid — the name, and no photo of someone who has left', r.body.status)
  await call(`/api/users/${repId}/active`, { method: 'POST', body: JSON.stringify({ active: true }) }, A)
  r = await pub(newBadge)
  ok(r.status === 200 && r.body.status === 'active', 'and restoring access restores the badge — nothing about it was changed', r.body.status)
  let limited = null
  for (let i = 0; i < 12 && !limited; i++) {
    const miss = await fetch(`${BASE}/api/verify?badge=${10000000 + i}`)
    if (miss.status === 429) limited = miss
  }
  ok(!!limited && Number(limited.headers.get('retry-after')) > 0, 'a run of misses from one caller is refused with a retry-after, like a wrong password', limited ? `429 after misses, retry-after ${limited.headers.get('retry-after')}s` : 'never limited')
  r = await pub(newBadge)
  ok(r.status === 429, 'and the limit is per caller, not per badge — the same phone cannot keep guessing by mixing in a real number', `${r.status}`)

  /* ===== 14. the audit trail ================================================== */
  const { entries } = await (await call('/api/audit?limit=100', {}, A)).json()
  const actions = new Set(entries.map((e) => e.action))
  for (const a of ['user.profile_updated', 'badge.issued', 'badge.confirmed', 'user.onboarding_completed', 'badge.renewed', 'badge.regenerated', 'user.onboarding_reset']) {
    ok(actions.has(a), `${a} was recorded`)
  }
} catch (err) {
  ok(false, `the run completed: ${err instanceof Error ? err.message : String(err)}`)
  if (log) console.log('\n--- worker log ---\n' + log.slice(-3000))
} finally {
  await stop().catch(() => {})
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\n=== the server holds the place, and the badge is minted once ===')
process.exit(fails.length ? 1 : 0)
