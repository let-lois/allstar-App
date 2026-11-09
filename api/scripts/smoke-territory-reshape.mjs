import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reshaping a territory, on a real Worker over a real D1.
 *
 * Moving a territory's line is a correction to a map, not a decision about who
 * owns which houses, so it has its own rule and this pins it against the
 * database itself:
 *
 *   the new outline is stored and comes back in bootstrap (it survives a reload)
 *   leads already in the territory stay in it, even ones the new line leaves out
 *   leads in another territory are never taken
 *   leads in no territory that the new line takes in join it, and the patch's
 *   one rep is handed them only if nobody is working them already
 *   a rep may not reshape; an unknown territory is 404; a bad outline is 400
 *   the name is untouched, and renaming still works through the same PATCH
 *   every reshape is in the audit log, with what it did
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8857)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/territory-reshape-state')

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
     '--var', 'SESSION_PEPPER:local-reshape-pepper'],
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
const OWNER = { email: `reshape-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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

// Territory A: a box. Territory B: a box to its east.
const BOX_A = [
  { lat: 30.500, lng: -97.680 }, { lat: 30.520, lng: -97.680 },
  { lat: 30.520, lng: -97.660 }, { lat: 30.500, lng: -97.660 },
]
const BOX_B = [
  { lat: 30.500, lng: -97.650 }, { lat: 30.520, lng: -97.650 },
  { lat: 30.520, lng: -97.630 }, { lat: 30.500, lng: -97.630 },
]
// A's new line: drops its south-west corner and reaches east into B and into
// open ground north of it.
const RESHAPED = [
  { lat: 30.508, lng: -97.680 }, { lat: 30.530, lng: -97.680 },
  { lat: 30.530, lng: -97.640 }, { lat: 30.508, lng: -97.640 },
]
const ROWS = [
  { ref: 'a1', address1: '10 Alder St', lat: 30.515, lng: -97.675 },   // in A, stays inside
  { ref: 'a2', address1: '12 Alder St', lat: 30.510, lng: -97.665 },   // in A, stays inside
  { ref: 'a3', address1: '14 Alder St', lat: 30.503, lng: -97.677 },   // in A, the new line leaves it out
  { ref: 'b1', address1: '20 Birch St', lat: 30.512, lng: -97.645 },   // in B, the new line takes in its point
  { ref: 'b2', address1: '22 Birch St', lat: 30.505, lng: -97.635 },   // in B, outside both new lines
  { ref: 'o1', address1: '30 Open Rd', lat: 30.525, lng: -97.670 },    // in nothing, new line takes it in
  { ref: 'o2', address1: '32 Open Rd', lat: 30.526, lng: -97.655 },    // in nothing, worked by Sarah, new line takes it in
  { ref: 'o3', address1: '34 Open Rd', lat: 30.600, lng: -97.600 },    // in nothing, far away
].map((r) => ({ ...r, city: 'Round Rock', state: 'TX', zip: '78664' }))

// COALESCE: the local CLI's JSON renders SQL NULL as the string "null".
const lead = async (id) =>
  (await query(`SELECT COALESCE(territory_id, '') AS t, COALESCE(assigned_rep_id, '') AS rep FROM properties WHERE id='${id}'`))[0] ?? {}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('territory-reshape-smoke.toml')
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
  const [curtis, sarah] = await Promise.all([mintRep(manager, 'Curtis'), mintRep(manager, 'Sarah')])
  ok(!!curtis.token && !!sarah.token, 'two reps exist')

  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === ROWS.length, 'the houses are imported', `${imported.created}`)
  const id = Object.fromEntries(ROWS.map((r, i) => [r.ref, imported.ids[i]]))

  // Sarah is already working o2 (the per-lead control), before any line moves.
  const assigned = await j(await call('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: [id.o2], repId: sarah.id }) }, manager))
  ok(assigned.status === 200, 'Sarah is assigned one house in open ground', `${assigned.status}`)

  const A = (await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory A', repIds: [curtis.id], boundary: BOX_A }) }, manager))).body
  const B = (await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory B', repIds: [], boundary: BOX_B }) }, manager))).body
  ok(A.assigned === 3 && B.assigned === 2, 'Territory A holds three houses and B two', `A=${A.assigned} B=${B.assigned}`)
  const aId = A.territory.id
  const bId = B.territory.id

  /* --- who may, and what is refused ----------------------------------------- */
  {
    const asRep = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ boundary: RESHAPED }) }, curtis.token))
    ok(asRep.status === 403, 'a rep may not reshape a territory', `${asRep.status}`)
    const missing = await j(await call('/api/territories/t_nope', { method: 'PATCH', body: JSON.stringify({ boundary: RESHAPED }) }, manager))
    ok(missing.status === 404, 'an unknown territory is not found', `${missing.status}`)
    const thin = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ boundary: RESHAPED.slice(0, 2) }) }, manager))
    ok(thin.status === 400 && /three points/.test(thin.body.error ?? ''), 'two points are refused, in words', `${thin.status} ${thin.body.error}`)
    const offEarth = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ boundary: [{ lat: 95, lng: 0 }, { lat: 1, lng: 1 }, { lat: 2, lng: 3 }] }) }, manager))
    ok(offEarth.status === 400, 'an outline off the Earth is refused', `${offEarth.status}`)
    const stored = (await query(`SELECT boundary FROM territories WHERE id='${aId}'`))[0]?.boundary
    ok(JSON.parse(stored).length === 4 && JSON.parse(stored)[0].lat === 30.5, 'and none of those touched the stored outline')
  }

  /* --- the reshape ----------------------------------------------------------- */
  const r = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ boundary: RESHAPED }) }, manager))
  ok(r.status === 200, 'a manager reshapes Territory A', `${r.status} ${r.body.error ?? ''}`)
  ok(r.body.joined === 2, 'it says two houses in no territory joined', `${r.body.joined}`)
  ok(r.body.outside === 1, 'and that one of its own now sits outside the line', `${r.body.outside}`)

  const stored = JSON.parse((await query(`SELECT boundary FROM territories WHERE id='${aId}'`))[0]?.boundary ?? '[]')
  ok(stored.length === 4 && stored[1].lat === 30.53, 'the new outline is stored')
  ok((await query(`SELECT name FROM territories WHERE id='${aId}'`))[0]?.name === 'Territory A', 'the name is untouched')

  const [a1, a2, a3, b1, b2, o1, o2, o3] = await Promise.all(['a1', 'a2', 'a3', 'b1', 'b2', 'o1', 'o2', 'o3'].map((k) => lead(id[k])))
  ok(a1.t === aId && a2.t === aId, 'its houses still inside stay in it')
  ok(a3.t === aId && a3.rep === curtis.id, 'the house the new line leaves out stays in it too, still Curtis’s — nothing is dropped')
  ok(b1.t === bId && b2.t === bId, 'Territory B’s houses stay in B, even the one under A’s new line')
  ok(o1.t === aId && o1.rep === curtis.id, 'a house in no territory that the line takes in joins it, and goes to its one rep')
  ok(o2.t === aId && o2.rep === sarah.id, 'one already being worked joins the territory but stays Sarah’s')
  ok(!o3.t, 'and a house far away is left alone')

  const audit = await query("SELECT detail FROM audit_log WHERE action='territory.reshaped'")
  const detail = audit[0] ? JSON.parse(audit[0].detail) : {}
  ok(audit.length === 1 && detail.joined === 2 && detail.outside === 1 && detail.points === 4, 'the reshape is in the audit log with what it did', JSON.stringify(detail))

  /* --- it survives a reload, and rename still works --------------------------- */
  const boot = await (await call('/api/bootstrap', {}, manager)).json()
  const t = (boot.territories ?? []).find((x) => x.id === aId)
  ok(t?.boundary?.length === 4 && t.boundary[1].lat === 30.53, 'bootstrap hands every phone the new outline')
  const renamed = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Territory A North' }) }, manager))
  ok(renamed.status === 200 && (await query(`SELECT name FROM territories WHERE id='${aId}'`))[0]?.name === 'Territory A North', 'renaming through the same PATCH still works')
  const after = JSON.parse((await query(`SELECT boundary FROM territories WHERE id='${aId}'`))[0]?.boundary ?? '[]')
  ok(after.length === 4 && after[1].lat === 30.53, 'and a rename leaves the outline where it was')

  /* --- reshaping again changes nothing that is already settled ----------------- */
  const again = await j(await call(`/api/territories/${aId}`, { method: 'PATCH', body: JSON.stringify({ boundary: RESHAPED }) }, manager))
  ok(again.status === 200 && again.body.joined === 0 && again.body.outside === 1, 'saving the same line again joins nobody new', `${again.body.joined} joined, ${again.body.outside} outside`)
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== a territory is reshaped without losing or taking a house ===')
