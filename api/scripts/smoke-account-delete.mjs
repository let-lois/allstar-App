import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deleting your own account, and the public Privacy and Support pages, on a
 * real Worker over a real D1 — the App Store asks for all three.
 *
 */
const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8858)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/account-delete-state')

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

let child = null
async function start(config) {
  child = spawn(resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
     '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:local-delete-pepper',
     '--var', 'SUPPORT_EMAIL:help@example.com'],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return await r.json() } catch {}
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
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`) } catch { return }
    await new Promise((r) => setTimeout(r, 500))
  }
}
async function applySchema(config) {
  await new Promise((done, fail) => {
    const p = spawn(resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'],
      { cwd: api, stdio: 'ignore' })
    p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`d1 execute exited ${c}`))))
  })
}
const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
async function query(sql) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '--command', sql],
    { cwd: api, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0]?.results ?? []
}
const n = (rows) => Number(rows[0] ? Object.values(rows[0])[0] : -1)

const stamp = Date.now()
const OWNER = { email: `delete-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

/** Invite a rep and sign in as them — the production path, not a row insert. */
async function mintRep(adminToken, name) {
  const email = `${name.toLowerCase()}-${stamp}@example.com`
  const password = `${name}-password-1234`
  const invite = await (await call('/api/invites', {
    method: 'POST', body: JSON.stringify({ email, name, role: 'field_rep' }),
  }, adminToken)).json()
  await fetch(invite.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, confirm: password }),
  })
  const session = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).json()
  return { id: session.user.id, token: session.token, name }
}


const ROWS = [
  { ref: 'kept', address1: '40 Kept St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.505, lng: -97.675 },
]
const del = async (token, body) => j(await call('/api/me/delete', { method: 'POST', body: JSON.stringify(body) }, token))
const login = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).status

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('account-delete-smoke.toml')
  await start(config)
  await applySchema(config)
  await stop()
  await start(config)

  /* ===== the public pages ================================================== */
  {
    const p = await fetch(`${BASE}/privacy`)
    const text = await p.text()
    ok(p.status === 200 && /text\/html/.test(p.headers.get('content-type') ?? ''), 'the privacy policy is a public page, no sign-in')
    ok(/Delete your account/.test(text) && /Google Maps Platform/.test(text) && /help@example\.com/.test(text), 'it says how to delete an account, who data is shared with, and where to write')
    const s = await (await fetch(`${BASE}/support`)).text()
    ok(/mailto:help@example\.com/.test(s) && /Forgot password/.test(s), 'the support page gives the support address and the common answers')
  }

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const { token: owner } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!owner, 'the owner is signed in')

  /* ===== the last administrator cannot lock the company ==================== */
  {
    const r = await del(owner, { password: OWNER.password, confirm: 'DELETE' })
    ok(r.status === 400 && /last administrator/.test(r.body.error ?? ''), 'the last administrator is told to hand over first', JSON.stringify(r))
    ok((await login(OWNER.email, OWNER.password)) === 200, 'and can still sign in')
  }

  /* ===== a rep deletes their own account ===================================== */
  const rep = await mintRep(owner, 'Curtis')
  const email = `curtis-${stamp}@example.com`, password = 'Curtis-password-1234'
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, owner)).json()
  const lead = imported.ids[0]
  await call('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: [lead], repId: rep.id }) }, owner)
  {
    const noConfirm = await del(rep.token, { password })
    ok(noConfirm.status === 400 && /DELETE/.test(noConfirm.body.error ?? ''), 'without typing DELETE nothing happens')
    const wrong = await del(rep.token, { password: 'not-it', confirm: 'DELETE' })
    ok(wrong.status === 403, 'with the wrong password nothing happens', `${wrong.status}`)
    ok((await login(email, password)) === 200, 'the account is still there')

    const done = await del(rep.token, { password, confirm: 'DELETE' })
    ok(done.status === 200 && done.body.ok === true, 'with the password and DELETE, the account is deleted', JSON.stringify(done))
    ok((await login(email, password)) === 401, 'the person can no longer sign in')
    ok((await call('/api/bootstrap', {}, rep.token)).status === 401, 'and the session on their phone stops working')
    ok(n(await query(`SELECT COUNT(*) FROM users WHERE id='${rep.id}'`)) === 0, 'the user row is gone')
    const b = await (await call('/api/bootstrap', {}, owner)).json()
    const kept = (b.properties ?? []).find((p) => p.id === lead)
    ok(!!kept && !kept.assignedRepId, 'the lead they worked stays with the company, back in the unassigned bucket', JSON.stringify(kept && { id: kept.id, rep: kept.assignedRepId ?? null }))
    const audit = await query("SELECT actor_name, detail FROM audit_log WHERE action='user.deleted'")
    ok(audit.length === 1 && /"self":true/.test(audit[0].detail), 'the audit log records that they deleted their own account', JSON.stringify(audit))
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== an account can be deleted from the app, and the policy is public ===')
