import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumPath } from '../../scripts/lib/browser.mjs'

/**
 * Account management from the office — the reset email and the sign-in email.
 *
 * Against a real Worker and a stand-in mail provider, for the reason
 * smoke-mail gives: the provider cannot be reached from a sandbox, and the
 * assertions are about the request anyway. What this pins:
 *
 *   Reset email
 *   - only an administrator may send one, never to a super admin from below,
 *     never to someone with no password yet or with access switched off;
 *   - the API answers with where it went and when it expires — never the
 *     link, never the token — and the token is never in the Worker's log;
 *   - the email names the admin who sent it and carries a working link;
 *   - a second press inside a minute, or two presses at once, sends one email;
 *   - the link is `/reset#token`: the token rides in the fragment, which no
 *     server or log ever sees, and is cleared from the address bar; the page
 *     (driven in a real browser) sets the password, the person is signed out
 *     everywhere, and the link dies; expired, made-up and invitation tokens
 *     are refused;
 *   - a provider that refuses leaves no live link behind and says why.
 *
 *   Sign-in email
 *   - malformed addresses and another teammate's address (in any case) are
 *     refused; the id, role, team and password survive a change; the new
 *     address signs in and the old one does not; both addresses are told;
 *   - links mailed to the old address stop working;
 *   - the audit log records both actions, with no token in either.
 *
 * Nothing here asserts that a real inbox received anything. Nothing can, from
 * here.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8886)
const MAIL_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/user-admin-state')
const SETUP_TOKEN = 'local-setup-token'
const APP_URL = 'https://app.example.test'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- the stand-in provider (Resend's shape) --------------------------------- */
let mode = 'accept' // or 'fail'
const received = []
const mail = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    // Held open briefly so two requests racing each other are really in flight
    // together, which is what a double click is.
    setTimeout(() => {
      if (mode === 'fail') {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'Verify a domain at resend.com/domains' }))
      }
      received.push(body ? JSON.parse(body) : null)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'stub-id' }))
    }, 150)
  })
})
await new Promise((r) => mail.listen(MAIL_PORT, '127.0.0.1', r))
const to = (m) => (m?.to?.[0] ?? '').toLowerCase()
const mailTo = (address) => received.filter((m) => to(m).includes(address.toLowerCase()))
const linkIn = (m) => /(http:\/\/127\.0\.0\.1:\d+\/reset#[A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1]
const tokenOf = (link) => link?.split('#')[1] ?? ''

/* --- the Worker ------------------------------------------------------------- */
const wrangler = resolve(api, 'node_modules/.bin/wrangler')
function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const path = resolve(api, '.wrangler/user-admin.toml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return path
}
// Asynchronous on purpose: a synchronous child process stalls this script's
// event loop, the dev server drops the idle keep-alive socket meanwhile, and
// the next request fails on a connection that is already closed.
const d1 = async (config, args) =>
  (await promisify(execFile)(wrangler, ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '-c', config, '-y', ...args], { cwd: api })).stdout
const rows = async (config, sql) => {
  const out = await d1(config, ['--command', sql, '--json'])
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? []
}

let child = null
let log = ''
async function start(config) {
  child = spawn(
    wrangler,
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'info',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`, '--var', 'SESSION_PEPPER:local-user-admin-pepper', '--var', `APP_URL:${APP_URL}`,
     '--var', 'RESEND_API_KEY:re_test_not_real', '--var', 'RESEND_FROM_EMAIL:Allstar <no-reply@example.test>',
     '--var', `RESEND_BASE_URL:http://127.0.0.1:${MAIL_PORT}`],
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
const j = async (res) => {
  const text = await res.text()
  let body = {}
  try { body = JSON.parse(text) } catch {}
  return { status: res.status, body, text }
}
const post = (path, body, token) => call(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, token).then(j)
const form = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
const login = async (email, password) => j(await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }))

const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery', name: 'Nadia Petrov' }
const stamp = Date.now()
const people = {
  ana: { email: `ana-${stamp}@example.com`, first: 'Ana', last: 'Lopez', password: 'anas-own-password-1' },
  ben: { email: `ben-${stamp}@example.com`, first: 'Ben', last: 'Cho', password: 'bens-own-password-1' },
  cal: { email: `cal-${stamp}@example.com`, first: 'Cal' }, // invited, never accepted
}

let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig()
  await d1(config, ['--file', './schema.sql'])
  const health = await start(config)
  ok(health.config?.mail === true && health.config?.mailProvider === 'resend', 'the Worker runs with email configured', `${health.config?.mailProvider}`)

  await form(`${BASE}/setup`, { token: SETUP_TOKEN, clientName: 'Ridgeline Roofing', name: ADMIN.name, email: ADMIN.email, password: ADMIN.password })
  const admin = (await login(ADMIN.email, ADMIN.password)).body
  const A = admin.token
  ok(!!A, 'the administrator signs in')

  const { body: teamBody } = await post('/api/teams', { name: 'Austin office' }, A)
  const teamId = teamBody.team?.id ?? teamBody.id
  for (const key of ['ana', 'ben', 'cal']) {
    const p = people[key]
    const inv = await post('/api/invites', { email: p.email, firstName: p.first, lastName: p.last, role: 'field_rep', teamId }, A)
    p.inviteUrl = inv.body.url
    if (p.password) await form(inv.body.url, { password: p.password, confirm: p.password })
  }
  const roster = async () => (await j(await call('/api/users', {}, A))).body.users
  const row = async (email) => (await roster()).find((u) => u.email.toLowerCase() === email.toLowerCase())
  for (const key of ['ana', 'ben', 'cal']) people[key].id = (await row(people[key].email)).id
  const anaSession = (await login(people.ana.email, people.ana.password)).body.token
  const benSession = (await login(people.ben.email, people.ben.password)).body.token
  ok(!!anaSession && !!benSession, 'two reps have accounts and are signed in')
  received.length = 0 // the invitations

  /* ===== who may send a reset email ========================================== */
  console.log('\n--- who may send a reset email ---')
  let r = await post(`/api/users/${people.ana.id}/reset-email`, {}, benSession)
  ok(r.status === 403, 'a field rep cannot send anybody a reset email', `${r.status}`)
  r = await post(`/api/users/${admin.user.id}/reset-email`, {}, A)
  ok(r.status === 400, 'an admin is pointed at their own password, not a reset email to themselves', `${r.status}`)
  r = await post(`/api/users/${people.cal.id}/reset-email`, {}, A)
  ok(r.status === 409 && r.body.code === 'pending', 'someone who never set a password is told to get their invitation instead', `${r.status} ${r.body.code}`)
  r = await post('/api/users/u_from_another_company/reset-email', {}, A)
  ok(r.status === 404, 'another company’s user reads as not found', `${r.status}`)
  r = await post(`/api/users/${people.ana.id}/password`, { password: 'admin-typed-this-1' }, A)
  ok(r.status === 403 && r.body.code === 'not_self', 'and typing a password for somebody else is refused outright', `${r.status} ${r.body.code}`)
  ok(received.length === 0, 'none of those sent anything', `${received.length}`)

  /* ===== the reset email ===================================================== */
  console.log('\n--- the reset email ---')
  r = await post(`/api/users/${people.ana.id}/reset-email`, {}, A)
  ok(r.status === 200 && r.body.ok === true, 'an admin sends a reset email', `${r.status}`)
  ok(r.body.email === people.ana.email && r.body.expiresAt > Date.now() + 47 * 3_600_000, 'the answer names the address and a two-day expiry')
  ok(!('url' in r.body) && !('token' in r.body) && !/\/invite\//.test(r.text), 'and carries no link and no token', Object.keys(r.body).join(','))
  const resetMail = mailTo(people.ana.email)
  ok(resetMail.length === 1, 'exactly one email went out, to the person', `${resetMail.length}`)
  ok(/Reset your Ridgeline Roofing password/.test(resetMail[0]?.subject ?? ''), 'it is a reset email for this company', resetMail[0]?.subject)
  ok(new RegExp(`${ADMIN.name}, an administrator at Ridgeline Roofing`).test(resetMail[0]?.text ?? ''), 'it names the admin who sent it')
  ok(/works once and expires/.test(resetMail[0]?.text ?? '') && !(resetMail[0]?.text ?? '').includes(people.ana.password), 'it says the link works once and expires, and contains no password')
  const link = linkIn(resetMail[0])
  ok(!!link && link.startsWith(`${BASE}/reset#`), 'the link opens this Worker’s reset page, token after the #', link?.replace(/#.*/, '#…'))
  const token = tokenOf(link)
  ok(token.length >= 32, 'the token is long', `${token.length} chars`)
  const stored = await rows(config, `SELECT token_hash FROM invites WHERE user_id = '${people.ana.id}' AND kind = 'reset'`)
  ok(stored.length === 1 && stored[0].token_hash === createHash('sha256').update(token).digest('hex'), 'the database holds only its hash')

  r = await post(`/api/users/${people.ana.id}/reset-email`, {}, A)
  ok(r.status === 429 && r.body.code === 'too_soon', 'a second press inside a minute is refused', `${r.status} ${r.body.code}`)
  ok(mailTo(people.ana.email).length === 1, 'and sends nothing')

  // Two at once: the cooldown is part of the INSERT, so only one can win.
  const both = await Promise.all([
    post(`/api/users/${people.ben.id}/reset-email`, {}, A),
    post(`/api/users/${people.ben.id}/reset-email`, {}, A),
  ])
  const statuses = both.map((b) => b.status).sort()
  ok(statuses[0] === 200 && statuses[1] === 429, 'two presses at the same moment send one email, not two', statuses.join('/'))
  ok(mailTo(people.ben.email).length === 1, 'and the provider was called once', `${mailTo(people.ben.email).length}`)

  /* ===== following the link =================================================== */
  console.log('\n--- following the link ---')
  ok((await login(people.ana.email, people.ana.password)).status === 200, 'until the link is used, the current password still works')
  const shellHtml = await (await fetch(`${BASE}/reset`)).text()
  ok(/Reset your password/.test(shellHtml) && /id="reset-form"/.test(shellHtml) && !shellHtml.includes(token), 'the page arrives without the token in it — the browser holds it')
  let check = await post('/api/reset/check', { token })
  ok(check.body.valid === true && check.body.email === people.ana.email && check.body.clientName === 'Ridgeline Roofing', 'the page’s check (a POST body, not a URL) finds the link live')
  check = await post('/api/reset/check', { token: people.cal.inviteUrl.split('/invite/')[1] })
  ok(check.body.valid === false, 'an invitation token is not a reset token here')
  check = await post('/api/reset/check', { token: 'made-up-token-that-was-never-issued' })
  ok(check.body.valid === false, 'nor is a made-up one')

  // The page itself, in a browser: it needs its script to read the fragment.
  const NEW = 'anas-chosen-password-2'
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
    page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
    await page.goto(link)
    await page.locator('#reset-form').waitFor({ state: 'visible', timeout: 10000 })
    ok(!page.url().includes('#') && !page.url().includes(token), 'the token is cleared from the address bar once read', page.url())
    ok((await page.locator('input[autocomplete="username"]').inputValue()) === people.ana.email, 'the form shows whose password this is')
    ok(/Ridgeline Roofing/.test(await page.locator('.sub').innerText()), 'and for which company')
    await page.locator('input[name="password"]').fill(NEW)
    await page.locator('input[name="confirm"]').fill('not-the-same-password')
    await page.getByRole('button', { name: 'Change password' }).click()
    await page.waitForLoadState('domcontentloaded')
    ok(/do not match/.test(await page.locator('body').innerText()) && !page.url().includes(token), 'two boxes that disagree are refused, and the retry keeps the token out of the URL')
    ok((await login(people.ana.email, people.ana.password)).status === 200, 'and the old password still works')
    await page.locator('input[name="password"]').fill(NEW)
    await page.locator('input[name="confirm"]').fill(NEW)
    await page.getByRole('button', { name: 'Change password' }).click()
    await page.waitForLoadState('domcontentloaded')
    const doneText = await page.locator('body').innerText()
    ok(/Password changed/.test(doneText), 'two that agree change it')
    ok((await page.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')) === APP_URL, 'and the page sends them to the app’s sign-in')
    // Fresh, as a second click from the email would be: /reset → /reset#… in
    // the same tab is a fragment change, which a browser does not reload.
    await page.goto('about:blank')
    await page.goto(link)
    await page.locator('#reset-dead').waitFor({ state: 'visible', timeout: 10000 })
    ok(/This link has expired/.test(await page.locator('h1').innerText()) && !(await page.locator('#reset-form').isVisible()), 'opening the link again says it has expired, with no form')
  } finally {
    await browser.close()
  }
  ok((await login(people.ana.email, NEW)).status === 200, 'the new password signs in')
  ok((await login(people.ana.email, people.ana.password)).status === 401, 'the old one does not')
  ok((await call('/api/bootstrap', {}, anaSession)).status === 401, 'and every session from before is signed out')
  const reuse = await (await form(`${BASE}/reset`, { token, password: 'third-password-here', confirm: 'third-password-here' })).text()
  ok(/This link has expired/.test(reuse) && (await login(people.ana.email, NEW)).status === 200, 'posting the spent token again changes nothing')

  const oldToken = `expired-${stamp}-abcdefghijklmnopqrstuvwxyz`
  await d1(config, ['--command', `INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at, kind) VALUES ('${createHash('sha256').update(oldToken).digest('hex')}', '${people.ana.id}', '${admin.user.id}', ${Date.now() - 3 * 86_400_000}, ${Date.now() - 86_400_000}, 'reset')`])
  ok((await post('/api/reset/check', { token: oldToken })).body.valid === false, 'an expired link is refused')
  const expired = await (await form(`${BASE}/reset`, { token: oldToken, password: 'sneaky-password-123', confirm: 'sneaky-password-123' })).text()
  ok(/This link has expired/.test(expired) && (await login(people.ana.email, 'sneaky-password-123')).status === 401, 'and posting to it sets nothing')
  ok(/This link has expired/.test(await (await fetch(`${BASE}/invite/${oldToken}`)).text()), 'by the older /invite/ road too')

  /* ===== access off, provider down ========================================== */
  console.log('\n--- access off, provider down ---')
  await d1(config, ['--command', `UPDATE invites SET created_at = created_at - 120000 WHERE user_id = '${people.ben.id}'`])
  const benLink = linkIn(mailTo(people.ben.email)[0])
  await post(`/api/users/${people.ben.id}/active`, { active: false }, A)
  r = await post(`/api/users/${people.ben.id}/reset-email`, {}, A)
  ok(r.status === 409 && r.body.code === 'inactive', 'someone whose access is off cannot be sent one', `${r.status} ${r.body.code}`)
  ok((await post('/api/reset/check', { token: tokenOf(benLink) })).body.valid === false, 'and switching access off killed the link already in their inbox')
  await post(`/api/users/${people.ben.id}/active`, { active: true }, A)
  // Switching access off ended Ben's sessions; he signs in again.
  const benAgain = (await login(people.ben.email, people.ben.password)).body.token

  mode = 'fail'
  const before = received.length
  r = await post(`/api/users/${people.ben.id}/reset-email`, {}, A)
  mode = 'accept'
  ok(r.status === 502 && r.body.code === 'mail_failed', 'a provider that refuses is reported as not sent', `${r.status} ${r.body.code}`)
  ok(/resend\.com\/domains/.test(r.body.error ?? ''), 'with the provider’s own reason, which is what someone fixes')
  ok(received.length === before, 'nothing was delivered')
  const live = await rows(config, `SELECT count(*) AS n FROM invites WHERE user_id = '${people.ben.id}' AND kind = 'reset' AND revoked_at IS NULL AND accepted_at IS NULL`)
  ok(Number(live[0]?.n) === 0, 'and the link nobody received is not left live', JSON.stringify(live))

  /* ===== the sign-in email ==================================================== */
  console.log('\n--- the sign-in email ---')
  r = await post(`/api/users/${people.ana.id}/email`, { email: 'new@example.com' }, benAgain)
  ok(r.status === 403, 'a field rep cannot change anybody’s email', `${r.status}`)
  for (const bad of ['', 'not-an-email', 'ana@example', 'ana @example.com', 'Ana <ana@example.com>', 'a@b.c', `${'x'.repeat(250)}@example.com`]) {
    r = await post(`/api/users/${people.ana.id}/email`, { email: bad }, A)
    ok(r.status === 400 && r.body.code === 'invalid_email', `“${bad.length > 30 ? bad.slice(0, 20) + '…' : bad}” is refused as not an email`, `${r.status} ${r.body.code}`)
  }
  r = await post(`/api/users/${people.ana.id}/email`, { email: people.ben.email.toUpperCase() }, A)
  ok(r.status === 409 && r.body.code === 'email_taken', 'a teammate’s address, in any case, is refused as taken', `${r.status} ${r.body.code}`)
  r = await post(`/api/users/${people.ana.id}/email`, { email: people.ana.email }, A)
  ok(r.status === 400 && r.body.code === 'unchanged', 'the same address is not a change', `${r.status} ${r.body.code}`)

  const beforeRow = await row(people.ana.email)
  const anaSession2 = (await login(people.ana.email, NEW)).body.token
  const sentBefore = received.length
  const NEW_EMAIL = `ana.lopez-${stamp}@example.org`
  r = await post(`/api/users/${people.ana.id}/email`, { email: `  ${NEW_EMAIL}  ` }, A)
  ok(r.status === 200 && r.body.email === NEW_EMAIL && r.body.previous === people.ana.email, 'an admin changes it, trimmed', `${r.status}`)
  const afterRow = await row(NEW_EMAIL)
  ok(afterRow?.id === beforeRow.id, 'it is the same account — same id, no new user', afterRow?.id)
  ok((await roster()).length === 4, 'and the roster has no extra row')
  ok(afterRow?.role === beforeRow.role && afterRow?.teamId === beforeRow.teamId && afterRow?.name === beforeRow.name, 'role, team and name are untouched')
  ok((await login(NEW_EMAIL, NEW)).status === 200, 'the new address signs in with the same password')
  ok((await login(people.ana.email, NEW)).status === 401, 'the old address no longer does')
  ok((await call('/api/bootstrap', {}, anaSession2)).status === 200, 'and nobody was signed out by it')
  const notices = received.slice(sentBefore)
  ok(notices.length === 2, 'two notices went out', `${notices.length}`)
  const toOld = notices.find((m) => to(m).includes(people.ana.email))
  const toNew = notices.find((m) => to(m).includes(NEW_EMAIL))
  ok(!!toOld && /was changed/.test(toOld.subject) && new RegExp(ADMIN.name).test(toOld.text) && /didn't expect this/.test(toOld.text), 'the old address is told who changed it, and what to do if it was not expected')
  ok(!!toNew && new RegExp(NEW_EMAIL.replace(/\./g, '\\.')).test(toNew.text) && /password has not changed/i.test(toNew.text), 'the new address is told it is now the sign-in, password unchanged')
  ok(!notices.some((m) => /\/invite\//.test(m.text)), 'neither notice carries a link that does anything')

  /* ===== a pending invitee's address ======================================== */
  console.log('\n--- a pending invitee’s address ---')
  const sentPending = received.length
  const CAL_EMAIL = `cal.correct-${stamp}@example.com`
  r = await post(`/api/users/${people.cal.id}/email`, { email: CAL_EMAIL }, A)
  ok(r.status === 200 && r.body.invitesRevoked === 1, 'a typo in an invitee’s address can be fixed, and their link is cancelled', `${r.status} revoked=${r.body.invitesRevoked}`)
  ok(/This link has expired/.test(await (await fetch(people.cal.inviteUrl)).text()), 'the invitation mailed to the wrong address no longer works')
  ok(received.length === sentPending, 'and no notice goes to an address that never had an account')
  r = await post(`/api/invites/${people.cal.id}/resend`, {}, A)
  ok(r.status === 200 && r.body.email === CAL_EMAIL && mailTo(CAL_EMAIL).length === 1, 'a fresh invitation goes to the corrected address', `${r.status} ${r.body.email}`)

  /* ===== the name ============================================================= */
  console.log('\n--- the name ---')
  r = await post(`/api/users/${people.ana.id}/name`, { firstName: '  Ana  María ', lastName: 'López' }, A)
  ok(r.status === 200 && r.body.name === 'Ana María López', 'an admin corrects a name, tidied', r.body.name)
  ok((await row(NEW_EMAIL))?.name === 'Ana María López' && (await row(NEW_EMAIL))?.email === NEW_EMAIL, 'the roster reads it, and the email is untouched')
  r = await post(`/api/users/${people.ana.id}/name`, { firstName: ' ', lastName: '' }, A)
  ok(r.status === 400, 'a name cannot be emptied — a badge needs one', `${r.status}`)
  r = await post(`/api/users/${people.ana.id}/name`, { firstName: 'Hijack' }, benAgain)
  ok(r.status === 403, 'and a field rep cannot rename anybody', `${r.status}`)

  /* ===== the record =========================================================== */
  console.log('\n--- the record ---')
  const { entries } = (await j(await call('/api/audit?limit=200', {}, A))).body
  const sentEntry = entries.find((e) => e.action === 'user.reset_email_sent' && e.detail?.to === people.ana.email)
  ok(!!sentEntry && sentEntry.actorName === ADMIN.name && sentEntry.targetLabel === 'Ana Lopez', 'the reset email is in the audit log: who, for whom, to where')
  const changed = entries.find((e) => e.action === 'user.email_changed' && e.detail?.to === NEW_EMAIL)
  ok(!!changed && changed.detail?.from === people.ana.email && changed.detail?.to === NEW_EMAIL, 'the email change is too, with both addresses')
  ok(!JSON.stringify(entries).includes(token) && !/\/(invite|reset)[/#]/.test(JSON.stringify(entries)), 'and no token or link is anywhere in the audit log')
  // The whole walk — sent, opened, retried, used, reused — and the Worker's
  // own request log (wrangler prints every path it serves) never saw it.
  ok(log.length > 0 && !log.includes(token) && !log.includes(tokenOf(benLink)), 'neither reset token ever appears in the Worker’s request log')
} catch (err) {
  ok(false, `the run completed: ${err instanceof Error ? err.stack + ' cause=' + String(err.cause?.stack ?? err.cause) : String(err)}`)
  if (log) console.log('\n--- worker log ---\n' + log.slice(-4000))
} finally {
  await stop().catch(() => {})
  mail.close()
  rmSync(STATE, { recursive: true, force: true })
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== account management: reset by email, email changed in place, nothing leaked ===')
process.exit(0)
