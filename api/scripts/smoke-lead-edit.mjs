import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixing a lead by hand, from the phone, on a real Worker over a real D1.
 *
 * A rep who marked the wrong door Not interested fixes it without a visit
 * that never happened; a rep who forgot a tag adds it. Both are ordinary
 * queued writes. What is pinned is the rules the server applies to them:
 *
 *   a rep may set a status on a lead they can see, and it is recorded as a
 *     status change in the lead's history — not as a visit
 *   a rep may not set a status on a lead they cannot see (the tenant-only
 *     check this branch used to have would have let them)
 *   a Do Not Contact stays one unless the office lifts it
 *   tags round-trip through bootstrap; an empty list clears them
 *   a status that is not a lead status is rejected
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8855)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/lead-edit-state')

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
     '--var', 'SESSION_PEPPER:local-ledit-pepper'],
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
const OWNER = { email: `ledit-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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

/** A rep's phone, as bootstrap would fill it. */
const phone = async (token) => {
  const b = await (await call('/api/bootstrap', {}, token)).json()
  return {
    leads: new Set((b.properties ?? []).map((p) => p.id)),
    lists: b.leadLists ?? [],
  }
}



const ROWS = [
  { ref: 'mine', address1: '10 Mine St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.505, lng: -97.675 },
  { ref: 'theirs', address1: '12 Theirs St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.510, lng: -97.670 },
]
let seq = 0
const mutate = async (token, kind, payload) => {
  const id = `m_${stamp}_${++seq}`
  const r = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id, kind, at: Date.now(), payload }] }) }, token))
  const res = (r.body.results ?? []).find((x) => x.id === id) ?? {}
  return { http: r.status, id, status: res.status, error: res.error }
}
const leadOf = async (token, id) => {
  const b = await (await call('/api/bootstrap', {}, token)).json()
  return (b.properties ?? []).find((p) => p.id === id) ?? null
}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('lead-edit-smoke.toml')
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
  const [curtis, matthew] = await Promise.all([mintRep(manager, 'Curtis'), mintRep(manager, 'Matthew')])
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 2, 'two leads imported')
  const [mine, theirs] = imported.ids
  await call('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: [mine], repId: curtis.id }) }, manager)
  await call('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: [theirs], repId: matthew.id }) }, manager)

  /* ===== 1. a rep fixes their own lead ===================================== */
  {
    const first = await mutate(curtis.token, 'property.status', { id: mine, status: 'follow_up' })
    ok(first.http === 200 && first.status === 'applied', 'a rep sets a status on their own lead', JSON.stringify(first))
    const applied = await mutate(curtis.token, 'property.status', { id: mine, status: 'working' })
    ok(applied.status === 'applied', 'and changes it again', JSON.stringify(applied))
    const lead = await leadOf(curtis.token, mine)
    ok(lead?.status === 'working', 'and the lead carries it', lead?.status)
    const rows = await query(`SELECT type, summary FROM activity WHERE property_id='${mine}' AND type='status' ORDER BY at`)
    ok(rows.length === 2 && /Status set to Working \(was Follow-up\)/.test(rows[1].summary), 'each change is a status line in the lead’s history, not a visit', rows.map((x) => x.summary).join(' | '))
    const visits = n(await query(`SELECT COUNT(*) FROM visits WHERE property_id='${mine}'`))
    ok(visits === 0, 'and no visit was invented')
  }

  /* ===== 2. not on a lead they cannot see ================================== */
  {
    const r = await mutate(curtis.token, 'property.status', { id: theirs, status: 'lost' })
    ok(r.http === 200 && r.status === 'rejected' && /not your lead/.test(r.error ?? ''), 'a rep cannot set a status on somebody else’s lead', JSON.stringify(r))
    const lead = await leadOf(manager, theirs)
    ok(lead?.status === 'new', 'which stays as it was', lead?.status)
  }

  /* ===== 3. Do Not Contact needs the office ================================= */
  {
    const set = await mutate(curtis.token, 'property.status', { id: mine, status: 'dnc' })
    ok(set.status === 'applied', 'a rep can mark their lead Do Not Contact — the homeowner asked')
    const lift = await mutate(curtis.token, 'property.status', { id: mine, status: 'new' })
    ok(lift.status === 'rejected' && /Do Not Contact/.test(lift.error ?? ''), 'but cannot lift it', JSON.stringify(lift))
    const office = await mutate(manager, 'property.status', { id: mine, status: 'new' })
    ok(office.status === 'applied' && (await leadOf(manager, mine))?.status === 'new', 'the office can')
    const junk = await mutate(manager, 'property.status', { id: mine, status: 'sold_maybe' })
    ok(junk.status === 'rejected', 'a word that is not a status is rejected', JSON.stringify(junk))
  }

  /* ===== 4. tags ============================================================= */
  {
    const r = await mutate(curtis.token, 'property.update', { id: mine, tags: ['dog', 'gate_code', 'dog'] })
    ok(r.status === 'applied', 'a rep tags their lead')
    const lead = await leadOf(curtis.token, mine)
    ok(Array.isArray(lead?.tags) && lead.tags.join() === 'dog,gate_code', 'the tags come back on the phone, once each', JSON.stringify(lead?.tags))
    const untouched = await mutate(curtis.token, 'property.update', { id: mine, city: 'Round Rock' })
    ok(untouched.status === 'applied' && (await leadOf(curtis.token, mine))?.tags?.join() === 'dog,gate_code', 'a details write with no tags leaves them alone')
    const cleared = await mutate(curtis.token, 'property.update', { id: mine, tags: [] })
    ok(cleared.status === 'applied' && ((await leadOf(curtis.token, mine))?.tags ?? []).length === 0, 'and an empty list clears them')
  }

  /* ===== 5. a colliding id cannot replace another line of history =========== */
  {
    const visitId = `v_${stamp}_coll`
    const v = await mutate(curtis.token, 'visit.complete', { id: visitId, propertyId: mine, outcome: 'interested', endedAt: Date.now() })
    ok(v.status === 'applied' && n(await query(`SELECT COUNT(*) FROM activity WHERE id='ev_${visitId}' AND type='visit'`)) === 1, 'a visit writes its own line')
    // The phone chooses mutation ids; the status line is keyed by them.
    const r = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id: `ev_${visitId}`, kind: 'property.status', at: Date.now(), payload: { id: mine, status: 'follow_up' } }] }) }, curtis.token))
    const res = (r.body.results ?? []).find((x) => x.id === `ev_${visitId}`) ?? {}
    ok(r.status === 200 && res.status === 'applied', 'a status write whose id happens to be that line’s id is accepted', JSON.stringify(res))
    const row = (await query(`SELECT type FROM activity WHERE id='ev_${visitId}'`))[0]
    ok(row?.type === 'visit', 'and the visit line is still the visit — never replaced', row?.type)
    ok((await leadOf(curtis.token, mine))?.status === 'follow_up', 'while the status itself changed')
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== a wrong outcome is fixed at the door, and only there ===')
