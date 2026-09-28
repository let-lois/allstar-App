import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * "Send quote" leaves a record, on a real Worker over a real D1.
 *
 * A rep who picks Send quote at the door gets a to-do on Today. Ticking it
 * off used to mark the row done and leave nothing else behind — no one could
 * tell a quoted lead from one still waiting on its quote. What is pinned:
 *
 *   ticking off a Send-quote to-do writes one "Quote sent" line in the
 *     lead's history, at the time the phone says it was ticked
 *   a retried write is the same line, not a second one
 *   unticking takes the line back
 *   a follow-up ticked off writes nothing; so does a quote to-do with no lead
 *   the rep's phone and the office both read the line from bootstrap
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8856)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/quote-sent-state')

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
     '--var', 'SESSION_PEPPER:local-quote-pepper'],
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
const OWNER = { email: `quote-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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
  { ref: 'quoted', address1: '10 Quote St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.505, lng: -97.675 },
]
let seq = 0
const mutate = async (token, kind, payload) => {
  const id = `m_${stamp}_${++seq}`
  const r = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id, kind, at: Date.now(), payload }] }) }, token))
  const res = (r.body.results ?? []).find((x) => x.id === id) ?? {}
  return { http: r.status, id, status: res.status, error: res.error }
}
const bootstrap = async (token) => (await call('/api/bootstrap', {}, token)).json()
const quoteLines = (b, propertyId) => (b.activity ?? []).filter((a) => a.type === 'quote' && a.propertyId === propertyId)

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('quote-sent-smoke.toml')
  await start(config)
  await applySchema(config)
  await stop()
  await start(config)

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'a manager is signed in')
  const curtis = await mintRep(manager, 'Curtis')
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 1, 'a lead is imported')
  const [lead] = imported.ids
  await call('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: [lead], repId: curtis.id }) }, manager)

  /* ===== 1. the to-do the door makes, ticked off ============================ */
  const taskId = `t_${stamp}_quote`
  const ticked = stamp - 3 * 3_600_000 // three hours ago: the phone was offline
  {
    const made = await mutate(curtis.token, 'task.create', { id: taskId, propertyId: lead, title: 'Send quote — 10 Quote St', dueAt: stamp + 86_400_000, done: false, kind: 'quote' })
    ok(made.status === 'applied', 'Send quote at the door makes a to-do', JSON.stringify(made))
    ok(n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${lead}' AND type='quote'`)) === 0, 'which by itself says nothing was sent')

    const done = await mutate(curtis.token, 'task.complete', { id: taskId, done: true, at: ticked })
    ok(done.status === 'applied', 'ticking it off is accepted', JSON.stringify(done))
    const rows = await query(`SELECT id, rep_id, summary, at FROM activity WHERE property_id='${lead}' AND type='quote'`)
    ok(rows.length === 1 && rows[0].summary === 'Quote sent' && rows[0].rep_id === curtis.id, 'and writes one Quote sent line in the lead’s history, by the rep who ticked it', JSON.stringify(rows))
    ok(Number(rows[0]?.at) === ticked, 'at the time the phone says it was ticked — a day offline keeps its real time', `${rows[0]?.at}`)
    ok(rows[0]?.id === `quote:${taskId}`, 'one line per to-do, by id')
    ok(n(await query(`SELECT done FROM tasks WHERE id='${taskId}'`)) === 1, 'the to-do itself is done')
  }

  /* ===== 2. the same write again is the same line ============================ */
  {
    const again = await mutate(curtis.token, 'task.complete', { id: taskId, done: true, at: ticked })
    ok(again.status === 'applied', 'a retried write is accepted')
    ok(n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${lead}' AND type='quote'`)) === 1, 'and does not double the line')
  }

  /* ===== 3. both phones read it ============================================= */
  {
    const rep = await bootstrap(curtis.token)
    const mine = quoteLines(rep, lead)
    ok(mine.length === 1 && mine[0].summary === 'Quote sent' && mine[0].at === ticked, 'the rep’s phone reads the line from bootstrap', JSON.stringify(mine))
    ok((rep.tasks ?? []).find((t) => t.id === taskId)?.done === true, 'and the to-do as done')
    const office = await bootstrap(manager)
    ok(quoteLines(office, lead).length === 1, 'so does the office')
  }

  /* ===== 4. unticking takes it back ========================================== */
  {
    const undone = await mutate(curtis.token, 'task.complete', { id: taskId, done: false })
    ok(undone.status === 'applied', 'unticking is accepted')
    ok(n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${lead}' AND type='quote'`)) === 0, 'and the Quote sent line is gone')
    ok(n(await query(`SELECT done FROM tasks WHERE id='${taskId}'`)) === 0, 'the to-do is open again')
    const back = await mutate(curtis.token, 'task.complete', { id: taskId, done: true })
    const rows = await query(`SELECT at FROM activity WHERE id='quote:${taskId}'`)
    ok(back.status === 'applied' && rows.length === 1 && Math.abs(Number(rows[0].at) - Date.now()) < 60_000, 'ticked again without a time, it is now', `${rows[0]?.at}`)
  }

  /* ===== 5. only a quote, and only on a lead ================================== */
  {
    const followId = `t_${stamp}_follow`
    await mutate(curtis.token, 'task.create', { id: followId, propertyId: lead, title: 'Follow up — 10 Quote St', dueAt: stamp + 86_400_000, done: false, kind: 'follow_up' })
    const f = await mutate(curtis.token, 'task.complete', { id: followId, done: true, at: stamp })
    ok(f.status === 'applied' && n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${lead}' AND type='quote'`)) === 1, 'a follow-up ticked off writes no Quote sent line')
    const looseId = `t_${stamp}_loose`
    await mutate(curtis.token, 'task.create', { id: looseId, title: 'Send quote — someone', dueAt: stamp + 86_400_000, done: false, kind: 'quote' })
    const l = await mutate(curtis.token, 'task.complete', { id: looseId, done: true, at: stamp })
    ok(l.status === 'applied' && n(await query(`SELECT COUNT(*) FROM activity WHERE id='quote:${looseId}'`)) === 0, 'a quote to-do with no lead is ticked off and writes nothing')
    const missing = await mutate(curtis.token, 'task.complete', { id: 't_never_made', done: true })
    ok(missing.status === 'applied', 'a to-do the server never had is still a harmless write', JSON.stringify(missing))
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== a quote that went out is on the record ===')
