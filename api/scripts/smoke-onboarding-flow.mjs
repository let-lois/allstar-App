import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

/**
 * Two ways onto the team, one account each — against a real Worker.
 *
 * The brief's duplicate cases, every one of them driven for real:
 *
 *   the admin presses Send twice            → one working link, not two
 *   the admin invites a working account     → linked, nothing minted, told so
 *   a rep joins by code before the invite   → the later invite links, no dup
 *   a rep is invited, then joins by code    → the join IS the acceptance
 *   an old link is opened after all that    → refused; the password is theirs
 *   an expired or revoked link is opened    → a plain page, and sign-in works
 *
 * And the two things that make the join code safe to write on a whiteboard:
 * it only ever makes a field rep, and guessing it is rate-limited on the same
 * buckets as guessing a password.
 *
 * Its own Worker, because one assertion needs a *second company* seeded by
 * hand: the same email address at two companies must be able to sign in to
 * both, and before this step `login()` returned whichever row SQLite handed
 * back first.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8871)
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/onboarding-flow-state')
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-flow-pepper'
const APP_URL = 'https://app.example.test'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const wrangler = resolve(api, 'node_modules/.bin/wrangler')
function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const path = resolve(api, '.wrangler/onboarding-flow.toml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return path
}
const d1 = (config, args) =>
  execFileSync(wrangler, ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '-c', config, '-y', ...args], { cwd: api, stdio: ['ignore', 'pipe', 'ignore'] })

let child = null
let log = ''
async function start(config) {
  child = spawn(
    wrangler,
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'info',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`, '--var', `SESSION_PEPPER:${PEPPER}`, '--var', `APP_URL:${APP_URL}`],
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

async function hashPassword(password, salt, pepper) {
  const enc = new TextEncoder()
  const key = await webcrypto.subtle.importKey('raw', enc.encode(`${password}${pepper}`), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256)
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
const form = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' })
const login = (email, password) => call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
const roster = async (token) => (await (await call('/api/users', {}, token)).json()).users
const rowFor = async (token, email) => (await roster(token)).find((u) => u.email.toLowerCase() === email.toLowerCase())
const page = async (url) => (await fetch(url)).text()

const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery' }
/* An address that exists at another company before this one has heard of it. */
const DUAL = { email: 'dual@example.com', otherPassword: 'their-other-company-pw', herePassword: 'their-password-here-1' }

let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig()
  d1(config, ['--file', './schema.sql'])
  const otherHash = await hashPassword(DUAL.otherPassword, 'othersalt', PEPPER)
  const seed = resolve(api, '.wrangler/onboarding-flow-seed.sql')
  writeFileSync(seed, `
    INSERT INTO clients (id, name, created_at) VALUES ('c_other', 'Other Contractor', 1700000000000);
    INSERT INTO users (id, client_id, email, name, role, password_hash, password_salt, active, created_at)
      VALUES ('u_dual_other', 'c_other', '${DUAL.email}', 'Dual Person', 'field_rep', '${otherHash}', 'othersalt', 1, 1700000000000);
  `)
  d1(config, ['--file', seed])

  await start(config)

  /* ===== the company, and its administrator ================================ */
  //
  // /setup refuses when any user exists, and one was seeded for the other
  // company above — so this company's first admin is made by hand the same way,
  // which is also what a second customer on a shared database looks like.
  const adminHash = await hashPassword(ADMIN.password, 'adminsalt', PEPPER)
  await stop()
  const seed2 = resolve(api, '.wrangler/onboarding-flow-seed2.sql')
  writeFileSync(seed2, `
    INSERT INTO clients (id, name, created_at) VALUES ('c_here', 'Summit Exteriors', 1700000100000);
    INSERT INTO users (id, client_id, email, name, role, password_hash, password_salt, active, created_at)
      VALUES ('u_owner', 'c_here', '${ADMIN.email}', 'Owner Person', 'client_admin', '${adminHash}', 'adminsalt', 1, 1700000100000);
  `)
  d1(config, ['--file', seed2])
  await start(config)

  const admin = await (await login(ADMIN.email, ADMIN.password)).json()
  const A = admin.token
  ok(!!A, 'the administrator signs in')

  /* ===== 1. invite by email alone ============================================ */
  const ONE = `sam.ortiz-${Date.now()}@example.com`
  let r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: ONE, role: 'field_rep', jobTitle: 'Sales Representative' }) }, A))
  ok(r.status === 200 && r.body.alreadyMember === false && /\/invite\//.test(r.body.url), 'an invitation needs only an address', `${r.status}`)
  ok(r.body.resent === false, 'and the first one is not a resend')
  const firstLink = r.body.url
  let row = await rowFor(A, ONE)
  ok(row?.name === ONE.slice(0, ONE.indexOf('@')), 'with no name given, the roster shows the part before the @ rather than a blank', row?.name)
  ok(row?.invitation === 'pending' && row?.pending === true && row?.jobTitle === 'Sales Representative', 'pending, with the title the admin typed', `${row?.invitation} / ${row?.jobTitle}`)

  /* ===== 2. Send pressed twice: one working link ============================= */
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: ONE, role: 'field_rep', firstName: 'Sam', lastName: 'Ortiz' }) }, A))
  ok(r.status === 200 && r.body.resent === true, 'inviting the same address again replaces the link and says so', `resent=${r.body.resent}`)
  const secondLink = r.body.url
  ok(secondLink !== firstLink, 'the new link is different')
  ok(/This link has expired/.test(await page(firstLink)), 'and the first link no longer opens a password form')
  ok(/Set your password|Welcome/.test(await page(secondLink)), 'while the new one does')
  row = await rowFor(A, ONE)
  ok(row?.name === 'Sam Ortiz' && row?.firstName === 'Sam', 'the re-invite corrected the name', row?.name)
  ok(row?.invitation === 'opened' && typeof row?.openedAt === 'number', 'and the roster reads one invitation — opened, since the new link was just looked at — not two', `${row?.invitation} / ${row?.openedAt}`)
  ok((await roster(A)).filter((u) => u.email === ONE).length === 1, 'one row for the address, however many times Send was pressed')

  /* ===== 3. revoke, then resend ============================================== */
  r = await j(await call(`/api/invites/${row.id}/revoke`, { method: 'POST' }, A))
  ok(r.status === 200 && r.body.revoked === 1, 'an admin cancels the invitation', `${r.status} revoked=${r.body.revoked}`)
  ok(/This link has expired/.test(await page(secondLink)), 'and the link stops working at once')
  ok((await rowFor(A, ONE))?.invitation === 'revoked', 'the roster reads revoked — a decision, not a calendar')
  r = await j(await call(`/api/invites/${row.id}/resend`, { method: 'POST' }, A))
  ok(r.status === 200 && /\/invite\//.test(r.body.url), 'an admin resends')
  const thirdLink = r.body.url
  ok((await rowFor(A, ONE))?.invitation === 'pending', 'and it is pending again — a fresh link nobody has opened')

  /* ===== 4. accept, then the earlier links ==================================== */
  const ONE_PW = 'sams-own-password-123'
  ok(/You're in|You&#39;re in/.test(await (await form(thirdLink, { password: ONE_PW, confirm: ONE_PW })).text()), 'the rep sets their password through the live link')
  ok((await login(ONE, ONE_PW)).ok, 'and signs in')
  ok((await rowFor(A, ONE))?.invitation === 'accepted', 'the roster reads accepted')
  const hijack = await form(secondLink, { password: 'somebody-elses-choice-1', confirm: 'somebody-elses-choice-1' })
  ok(!/You're in|You&#39;re in/.test(await hijack.text()), 'a revoked link opened afterwards sets nothing')
  ok((await login(ONE, ONE_PW)).ok && !(await login(ONE, 'somebody-elses-choice-1')).ok, 'the password stays the one the rep chose')
  r = await j(await call(`/api/invites/${row.id}/resend`, { method: 'POST' }, A))
  ok(r.status === 409, 'resending to someone who has a password is refused with a reason', `${r.status}`)

  /* ===== 5. inviting a working account links, never duplicates ============== */
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: ONE.toUpperCase(), role: 'manager', jobTitle: 'Team Lead' }) }, A))
  ok(r.status === 200 && r.body.alreadyMember === true && !r.body.url, 'inviting an address that can already sign in mints nothing and says so', `${r.status} alreadyMember=${r.body.alreadyMember}`)
  ok(/already has an account/i.test(r.body.message ?? ''), 'in words an admin can act on', r.body.message)
  row = await rowFor(A, ONE)
  ok((await roster(A)).filter((u) => u.email.toLowerCase() === ONE.toLowerCase()).length === 1, 'still one row — case in the address makes no difference')
  ok(row?.role === 'field_rep', 'and their role was NOT changed by the invite — that is Manage, with its own guards', row?.role)
  ok(row?.jobTitle === 'Sales Representative', 'nor their title, which they already had', row?.jobTitle)

  /* ===== 6. the join code =================================================== */
  r = await j(await call('/api/join-link', {}, A))
  ok(r.status === 200 && r.body.code === null, 'a company starts with self sign-up switched off', JSON.stringify(r.body))
  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: 'ABCD2345', email: 'x@example.com', password: 'long-enough-password' }) }))
  ok(r.status === 404, 'with no code issued, every code is wrong', `${r.status}`)

  r = await j(await call('/api/join-link', { method: 'POST' }, A))
  ok(r.status === 200 && /^[A-Z2-9]{8}$/.test(r.body.code ?? ''), 'an admin issues a code: eight unambiguous characters', r.body.code)
  ok(r.body.url === `${APP_URL}/join/${r.body.code}`, 'with a link into the app', r.body.url)
  const CODE = r.body.code
  ok(!/[01OIL]/.test(CODE), 'and no 0/O or 1/I/L to misread from a whiteboard')

  const repSession = await (await login(ONE, ONE_PW)).json()
  ok((await call('/api/join-link', {}, repSession.token)).status === 403, 'a rep cannot read the code')
  ok((await call('/api/join-link', { method: 'POST' }, repSession.token)).status === 403, 'nor issue one')
  ok((await call(`/api/invites/${row.id}/revoke`, { method: 'POST' }, repSession.token)).status === 403, 'nor cancel invitations')

  /* ===== 7. a rep joins first; the invite comes later ======================== */
  const TWO = `casey-${Date.now()}@example.com`
  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: ` ${CODE.toLowerCase()} `, email: TWO, password: 'caseys-password-1234', firstName: 'Casey', lastName: 'Lin' }) }))
  ok(r.status === 201 && !!r.body.token, 'a rep joins with the code, typed in lower case with spaces, and is signed in', `${r.status}`)
  ok(r.body.user?.role === 'field_rep', 'as a field rep — the code never grants more', r.body.user?.role)
  ok(r.body.user?.clientName === 'Summit Exteriors', 'in the right company', r.body.user?.clientName)
  ok(r.body.user?.onboarding?.status === 'not_started' && r.body.claimedInvite === false, 'with onboarding ahead of them and no invitation claimed')
  ok(r.body.user?.name === 'Casey Lin', 'named as they typed', r.body.user?.name)
  row = await rowFor(A, TWO)
  ok(row?.invitation === 'not_sent' && row?.pending === false, 'the roster shows them as never invited and not pending', `${row?.invitation} / ${row?.pending}`)

  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: CODE, email: TWO, password: 'trying-again-12345' }) }))
  ok(r.status === 409, 'joining again with the same address is refused — sign in instead', `${r.status}`)
  ok((await login(TWO, 'caseys-password-1234')).ok && !(await login(TWO, 'trying-again-12345')).ok, 'and did not change their password')

  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: TWO, role: 'field_rep', jobTitle: 'Canvasser' }) }, A))
  ok(r.status === 200 && r.body.alreadyMember === true, 'an admin who then invites that address is told they are already a member')
  row = await rowFor(A, TWO)
  ok(row?.jobTitle === 'Canvasser', 'but the title they had not set was filled in from the invite', row?.jobTitle)
  ok((await roster(A)).filter((u) => u.email === TWO).length === 1, 'one row')

  /* ===== 8. invited first; joins by code ===================================== */
  const THREE = `riley-${Date.now()}@example.com`
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: THREE, role: 'field_rep', firstName: 'Riley', jobTitle: 'Field Rep' }) }, A))
  const rileyLink = r.body.url
  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: CODE, email: THREE, password: 'rileys-password-1234', lastName: 'Park' }) }))
  ok(r.status === 201 && r.body.claimedInvite === true, 'joining with an invited address claims the invitation', `${r.status} claimed=${r.body.claimedInvite}`)
  ok(r.body.user?.name === 'Riley Park' && r.body.user?.jobTitle === 'Field Rep', 'the admin’s first name and title meet the rep’s last name on one row', `${r.body.user?.name} / ${r.body.user?.jobTitle}`)
  row = await rowFor(A, THREE)
  ok(row?.invitation === 'accepted' && row?.pending === false, 'the invitation reads accepted', `${row?.invitation}`)
  // Joining marked the invitation accepted, so the link is spent: the page
  // must offer no password form and point at signing in — whichever of the two
  // spent-link pages it is.
  const spent = await page(rileyLink)
  ok(!/name="password"/.test(spent) && /sign in/i.test(spent), 'the link in their inbox now shows no password form and points at signing in')
  const late = await form(rileyLink, { password: 'a-forwarded-email-1234' })
  ok(!/You're in|You&#39;re in/.test(await late.text()), 'and posting to it sets nothing')
  ok((await login(THREE, 'rileys-password-1234')).ok && !(await login(THREE, 'a-forwarded-email-1234')).ok, 'the password they chose when joining is the one that works')

  /* ===== 8b. a live invite link, after the admin set a password ============== */
  //
  // The one case where nothing but `acceptInvite`'s own refusal protects the
  // password: the link is neither revoked nor accepted, and the account now has
  // a password because an admin set one under Manage while the link was still
  // in an inbox. Opening it must not offer to replace what the admin set.
  {
    const FOUR = `quinn-${Date.now()}@example.com`
    r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: FOUR, role: 'field_rep', firstName: 'Quinn' }) }, A))
    const quinnLink = r.body.url
    const quinn = await rowFor(A, FOUR)
    r = await j(await call(`/api/users/${quinn.id}/password`, { method: 'POST', body: JSON.stringify({ password: 'set-by-the-admin-123', confirm: 'set-by-the-admin-123' }) }, A))
    ok(r.status === 200, 'an admin sets a password for someone who never opened their link', `${r.status}`)
    const live = await page(quinnLink)
    ok(/already set up|already has a password/i.test(live) && !/name="password"/.test(live), 'the still-live invitation link now says they are already set up, with no password form')
    // Typed twice, as the page asks: a real attempt, refused for the right reason.
    const forged = await form(quinnLink, { password: 'from-a-forwarded-email', confirm: 'from-a-forwarded-email' })
    ok(!/You're in|You&#39;re in/.test(await forged.text()), 'posting a password to it is refused')
    ok((await login(FOUR, 'set-by-the-admin-123')).ok && !(await login(FOUR, 'from-a-forwarded-email')).ok, 'and the password the admin set is the one that works — the link could not replace it')
    ok(/This link has expired/.test(await page(quinnLink)), 'the refusal spent the token, so it cannot be tried again')
  }

  /* ===== 9. guessing the code is bounded ===================================== */
  {
    const GUESSER = `guesser-${Date.now()}@example.com`
    let limited = null
    for (let i = 0; i < 10; i++) {
      const res = await call('/api/join', { method: 'POST', body: JSON.stringify({ code: 'ZZZZ9999', email: GUESSER, password: 'long-enough-password' }) })
      if (res.status === 429) { limited = i + 1; break }
    }
    ok(limited !== null && limited <= 9, 'repeated wrong codes for one address are refused with 429', `after ${limited} attempts`)
  }

  /* ===== 10. rotate and disable ============================================= */
  r = await j(await call('/api/join-link', { method: 'POST' }, A))
  const CODE2 = r.body.code
  ok(CODE2 && CODE2 !== CODE, 'rotating issues a different code')
  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: CODE, email: `late-${Date.now()}@example.com`, password: 'long-enough-password' }) }))
  ok(r.status === 404, 'and the old code stops working at once', `${r.status}`)
  r = await j(await call('/api/join-link', { method: 'DELETE' }, A))
  ok(r.status === 200, 'an admin switches self sign-up off')
  r = await j(await call('/api/join', { method: 'POST', body: JSON.stringify({ code: CODE2, email: `later-${Date.now()}@example.com`, password: 'long-enough-password' }) }))
  ok(r.status === 404, 'after which the current code stops working too')
  ok((await (await call('/api/join-link', {}, A)).json()).code === null, 'and the console reads no code')

  /* ===== 11. one address at two companies signs in to both ================== */
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: DUAL.email, role: 'field_rep' }) }, A))
  ok(r.status === 200 && r.body.alreadyMember === false, 'an address that exists at ANOTHER company is new here — email is unique per company')
  ok(/You're in|You&#39;re in/.test(await (await form(r.body.url, { password: DUAL.herePassword, confirm: DUAL.herePassword })).text()), 'and they set a password here')
  const here = await j(await login(DUAL.email, DUAL.herePassword))
  ok(here.status === 200 && here.body.user?.clientName === 'Summit Exteriors', 'signing in with this company’s password lands in this company', here.body.user?.clientName)
  const other = await j(await login(DUAL.email, DUAL.otherPassword))
  ok(other.status === 200 && other.body.user?.clientName === 'Other Contractor', 'and with the other company’s password lands in the other company — not whichever row came first', other.body.user?.clientName)
  ok((await login(DUAL.email, 'neither-of-those-passwords')).status === 401, 'while a password that matches neither is refused')

  /* ===== 12. a reset link still replaces a password ========================== */
  //
  // The rule that an *invitation* must not overwrite a password must not have
  // broken the thing that is meant to: a reset link, for exactly that person.
  r = await j(await call(`/api/users/${(await rowFor(A, ONE)).id}/reset-link`, { method: 'POST' }, A))
  ok(r.status === 200, 'an admin makes a reset link for someone with a password')
  // Worded as a reset since forgot-password shipped: "Reset your password",
  // then "Password changed" — not the invitation's "Welcome" / "You're in".
  ok(/Reset your password/.test(await page(r.body.url)), 'which opens a password form — it is a reset, not an invitation')
  ok(/Password changed/.test(await (await form(r.body.url, { password: 'sams-new-password-456', confirm: 'sams-new-password-456' })).text()), 'and sets the new password')
  ok((await login(ONE, 'sams-new-password-456')).ok && !(await login(ONE, ONE_PW)).ok, 'which is now the one that works')
  ok((await rowFor(A, ONE))?.invitation === 'accepted', 'and the roster’s invitation status ignores reset links entirely', (await rowFor(A, ONE))?.invitation)

  /* ===== 13. the audit trail ================================================ */
  {
    const { entries } = await (await call('/api/audit?limit=100', {}, A)).json()
    const actions = new Set(entries.map((e) => e.action))
    for (const a of ['user.invited', 'user.invite_resent', 'user.invite_revoked', 'user.joined', 'company.join_code_rotated', 'company.join_code_disabled']) {
      ok(actions.has(a), `${a} was recorded`)
    }
  }
} catch (err) {
  ok(false, `the run completed: ${err instanceof Error ? err.message : String(err)}`)
  if (log) console.log('\n--- worker log ---\n' + log.slice(-4000))
} finally {
  await stop().catch(() => {})
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\n=== two ways onto the team, one account each ===')
process.exit(fails.length ? 1 : 0)
