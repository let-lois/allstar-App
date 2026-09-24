import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Forgot password, against a real Worker with a real database.
 *
 * `verify:reset` proves the page, the email and the rule in isolation. This
 * proves the road between them on the code that is deployed: a company is
 * set up, a rep is invited and sets a password, and then forgets it. What
 * has to hold, in order:
 *
 *   - "Forgot password?" answers a real address and a made-up one with the
 *     same body and the same status, and mints a reset row only for the real
 *     one — the difference is in the database, never on the wire;
 *   - an admin making a link afterwards leaves the rep exactly one live link;
 *   - the link's page is a reset, not a welcome; two boxes that disagree, or
 *     a short password, keep the old password; two that agree replace it;
 *   - the old password stops working, the new one works, and the link is dead;
 *   - with no email provider the route says so (501) rather than promising.
 *
 * The mail provider is configured with a key that cannot work, on purpose:
 * the Worker must treat a send that fails exactly like one that succeeds,
 * because the person on the other end is told the same thing either way.
 *
 * Driven over HTTP rather than a browser because nothing here is a screen;
 * the sign-in screen's half is in `verify:login`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const api = resolve(root, 'api')
const PORT = Number(process.env.RESET_API_PORT || 8859)
const API = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/reset-e2e-state')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

function writeConfig(name) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const body = source.replace('main = "src/index.ts"', 'main = "../src/index.ts"')
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

let worker = null
async function startWorker(config, mail) {
  const vars = [
    '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
    '--var', 'SESSION_PEPPER:local-reset-pepper',
    '--var', 'ALLOWED_ORIGINS:http://127.0.0.1:4173',
  ]
  // A provider that cannot deliver — the key is nonsense and the network is
  // not there — which is the point: the route must not care.
  if (mail) vars.push('--var', 'RESEND_API_KEY:re_not_a_real_key', '--var', 'RESEND_FROM_EMAIL:Allstar <no-reply@example.com>')
  worker = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn', ...vars],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  worker.stdout.on('data', () => {})
  worker.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${API}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}
async function stopWorker() {
  if (!worker) return
  const dead = new Promise((r) => worker.once('exit', r))
  try {
    process.kill(-worker.pid, 'SIGTERM')
  } catch {
    worker.kill('SIGTERM')
  }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  worker = null
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${API}/api/health`)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}
async function applySchema(config) {
  await new Promise((done, fail) => {
    const p = spawn(
      resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'],
      { cwd: api, stdio: 'ignore' },
    )
    p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`d1 execute exited ${c}`))))
  })
}
/** Rows from the local database — what the wire is not allowed to say. */
async function query(config, sql) {
  return new Promise((done, fail) => {
    let out = ''
    const p = spawn(
      resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--command', sql, '-c', config, '-y', '--json'],
      { cwd: api, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    p.stdout.on('data', (d) => (out += d))
    p.on('exit', (c) => {
      if (c !== 0) return fail(new Error(`d1 query exited ${c}`))
      try {
        const parsed = JSON.parse(out.slice(out.indexOf('[')))
        done(parsed[0]?.results ?? [])
      } catch (e) {
        fail(e)
      }
    })
  })
}

const call = (path, opts = {}, token) =>
  fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })
const form = (path, fields) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
const login = async (email, password) => {
  const r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const stamp = Date.now()
const OWNER = { email: `reset-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const REP = { email: `reset-rep-${stamp}@example.com`, first: 'Bea', last: 'Whitfield', password: 'Bea-password-1234', next: 'Bea-new-password-5678' }

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('reset-e2e.toml')
  await startWorker(config, true)
  await applySchema(config)
  await stopWorker()
  await startWorker(config, true)

  console.log('--- a company, and a rep with a password ---')
  const setup = await form('/setup', { token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Ray Okafor', email: OWNER.email, password: OWNER.password })
  ok(setup.ok, `the company is set up (${setup.status})`)
  const owner = await login(OWNER.email, OWNER.password)
  ok(owner.status === 200 && owner.body.token, 'the owner signs in')
  const invite = await (await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: REP.email, role: 'field_rep', firstName: REP.first, lastName: REP.last }) }, owner.body.token)).json()
  ok(typeof invite.url === 'string' && /\/invite\//.test(invite.url), 'the rep is invited', invite.url && invite.url.replace(/invite\/.*/, 'invite/…'))
  const accept = await form(new URL(invite.url).pathname, { password: REP.password, confirm: REP.password })
  ok(/You're in/.test(await accept.text()), 'and sets a password through the invitation, typed twice')
  const first = await login(REP.email, REP.password)
  ok(first.status === 200, 'the rep can sign in with it')
  const repId = first.body.user?.id
  ok(!!repId, 'and has an id', repId)

  console.log('\n--- forgot password: the same answer for everyone ---')
  const real = await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: REP.email }) })
  const realBody = await real.text()
  const fake = await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: `nobody-${stamp}@example.com` }) })
  const fakeBody = await fake.text()
  ok(real.status === 200 && fake.status === 200, 'a real address and a made-up one both get 200', `${real.status}/${fake.status}`)
  ok(realBody === fakeBody, 'with byte-identical bodies', realBody)
  const empty = await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({}) })
  ok(empty.status === 400, 'no address at all is refused', `${empty.status}`)
  const shouted = await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: REP.email.toUpperCase() }) })
  ok(shouted.status === 200, 'and the address is matched without regard to case', `${shouted.status}`)
  const rows = await query(config, `SELECT kind, (revoked_at IS NULL AND accepted_at IS NULL) AS live FROM invites WHERE user_id = '${repId}' AND kind = 'reset'`)
  ok(rows.length === 2 && rows.filter((r) => r.live).length === 1, 'two requests left the rep exactly one live reset link', JSON.stringify(rows))
  const strangers = await query(config, `SELECT count(*) AS n FROM invites WHERE kind = 'reset' AND user_id NOT IN ('${repId}')`)
  ok(Number(strangers[0]?.n) === 0, 'and nothing was minted for the address nobody has', JSON.stringify(strangers))

  console.log('\n--- an admin link replaces it, and the page is a reset ---')
  const made = await (await call(`/api/users/${repId}/reset-link`, { method: 'POST' }, owner.body.token)).json()
  ok(typeof made.url === 'string', 'the admin can still make a reset link', made.url && made.url.replace(/invite\/.*/, 'invite/…'))
  const after = await query(config, `SELECT count(*) AS n FROM invites WHERE user_id = '${repId}' AND kind = 'reset' AND revoked_at IS NULL AND accepted_at IS NULL`)
  ok(Number(after[0]?.n) === 1, 'which leaves the rep one live link, not two', JSON.stringify(after))
  const path = new URL(made.url).pathname
  const page = await (await fetch(`${API}${path}`)).text()
  ok(/<h1>Reset your password<\/h1>/.test(page) && /name="confirm"/.test(page) && !/Welcome/.test(page), 'the link opens a reset page with two boxes, not a welcome')

  console.log('\n--- wrong, short, right ---')
  const mismatch = await (await form(path, { password: REP.next, confirm: 'Bea-new-password-0000' })).text()
  ok(/do not match/.test(mismatch) && /name="password"/.test(mismatch), 'two boxes that disagree are refused, with the form still there')
  ok((await login(REP.email, REP.password)).status === 200, 'and the old password still works')
  const short = await (await form(path, { password: 'short', confirm: 'short' })).text()
  ok(/at least 10/.test(short), 'a short password is refused by length')
  const done = await (await form(path, { password: REP.next, confirm: REP.next })).text()
  ok(/Password changed/.test(done) && /old one no longer works/.test(done), 'two that agree change it, and the page says the old one is gone')
  ok((await login(REP.email, REP.password)).status === 401, 'the old password is refused')
  ok((await login(REP.email, REP.next)).status === 200, 'and the new one signs the rep in')
  const dead = await (await fetch(`${API}${path}`)).text()
  ok(/This link has expired/.test(dead), 'the link worked once and is dead')
  const again = await (await form(path, { password: 'Bea-third-password-9999', confirm: 'Bea-third-password-9999' })).text()
  ok(/expired|already been used/.test(again) && (await login(REP.email, REP.next)).status === 200, 'and posting to it again changes nothing')

  console.log('\n--- with no email provider ---')
  await stopWorker()
  await startWorker(config, false)
  const nomail = await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: REP.email }) })
  const nomailBody = await nomail.json().catch(() => ({}))
  ok(nomail.status === 501 && nomailBody.code === 'mail_not_configured', 'the route says a link cannot be sent from here, rather than promising one', `${nomail.status} ${nomailBody.code}`)
  ok(/administrator/.test(nomailBody.error ?? ''), 'and points at the admin, who can make one by hand')
} catch (err) {
  ok(false, `the walk did not finish: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await stopWorker()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== forgot password, end to end: one answer on the wire, one live link, one change ===')
