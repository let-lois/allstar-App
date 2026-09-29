import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A lead added from the map lands in the right territory, on a real Worker
 * over a real D1, and the office can move leads between territories.
 *
 * A rep taps a house and saves it. That create used to arrive with no
 * territory, so the console filed it under Unassigned even in the middle of a
 * drawn patch, and the other reps on the patch never saw it. What is pinned:
 *
 *   a lead added inside a territory is in that territory, and still the
 *     adding rep's own lead
 *   inside two overlapping territories, it goes to the smaller one
 *   outside every territory it has none, and stays the adding rep's
 *   the other reps on the territory see it; reps elsewhere do not
 *   the office sees it with its territory without anybody reloading data
 *   one rep on two territories stays on both
 *   the office moves selected leads into a territory and out of every one;
 *     the rep working them keeps them; a rep may not; a stranger id is refused
 *   the same create sent twice is one lead
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8860)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/manual-leads-state')

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
     '--var', 'SESSION_PEPPER:local-manual-pepper'],
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
const OWNER = { email: `manual-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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

let seq = 0
const mutate = async (token, kind, payload, id = `m_${stamp}_${++seq}`) => {
  const r = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id, kind, at: Date.now(), payload }] }) }, token))
  const res = (r.body.results ?? []).find((x) => x.id === id) ?? {}
  return { http: r.status, id, status: res.status, error: res.error }
}
const bootstrap = async (token) => (await call('/api/bootstrap', {}, token)).json()
const box = (s, w, n, e) => [{ lat: s, lng: w }, { lat: s, lng: e }, { lat: n, lng: e }, { lat: n, lng: w }]
/** What the phone sends when a rep saves a house from the map. */
const addFromMap = (token, id, address1, lat, lng) =>
  mutate(token, 'property.status', { id, created: true, address1, city: 'Round Rock', state: 'TX', zip: '78664', lat, lng, contacts: [] })
// The local D1 JSON output writes a SQL NULL as the string "null"; read it back as null.
const unnull = (v) => (v === 'null' ? null : v)
const row = async (id) => {
  const r = (await query(`SELECT territory_id, assigned_rep_id FROM properties WHERE id='${id}'`))[0] ?? {}
  return { territory_id: unnull(r.territory_id), assigned_rep_id: unnull(r.assigned_rep_id) }
}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('manual-leads-smoke.toml')
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
  const [ann, ben, cara] = await Promise.all([mintRep(manager, 'Ann'), mintRep(manager, 'Ben'), mintRep(manager, 'Cara')])

  const made = async (name, boundary, repIds) => {
    const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name, boundary, repIds }) }, manager))
    ok(r.status === 201, `territory ${name} is drawn`, `${r.status}`)
    return r.body.territory.id
  }
  const BIG = await made('Big', box(30.50, -97.70, 30.54, -97.66), [ann.id])
  const SMALL = await made('Small', box(30.51, -97.69, 30.52, -97.68), [ben.id])
  const FAR = await made('Far', box(30.60, -97.60, 30.61, -97.59), [cara.id])

  /* ===== 1. inside one territory ============================================= */
  const inBig = `p_${stamp}_big`
  {
    const r = await addFromMap(ann.token, inBig, '1 Big Rd', 30.53, -97.67)
    ok(r.status === 'applied', 'a rep saves a house tapped on the map', JSON.stringify(r))
    const x = await row(inBig)
    ok(x.territory_id === BIG, 'it lands in the territory it stands in', JSON.stringify(x))
    ok(x.assigned_rep_id === ann.id, 'and is still the adding rep’s own lead')
  }

  /* ===== 2. inside two overlapping territories =============================== */
  const inSmall = `p_${stamp}_small`
  {
    await addFromMap(ann.token, inSmall, '2 Small Rd', 30.515, -97.685)
    const x = await row(inSmall)
    ok(x.territory_id === SMALL, 'inside two patches, it goes to the smaller one', JSON.stringify(x))
    ok(x.assigned_rep_id === ann.id, 'still Ann’s, who added it')
    const benSees = (await bootstrap(ben.token)).properties.some((p) => p.id === inSmall)
    ok(benSees, 'the rep on that territory sees it on his phone')
    const caraSees = (await bootstrap(cara.token)).properties.some((p) => p.id === inSmall)
    ok(!caraSees, 'a rep on another territory does not')
  }

  /* ===== 3. outside every territory ========================================== */
  const outside = `p_${stamp}_out`
  {
    await addFromMap(ann.token, outside, '3 Nowhere Rd', 30.80, -97.40)
    const x = await row(outside)
    ok(x.territory_id == null, 'outside every territory it has none, rather than the nearest', JSON.stringify(x))
    ok(x.assigned_rep_id === ann.id, 'and stays the adding rep’s')
    ok((await bootstrap(ann.token)).properties.some((p) => p.id === outside), 'which she still sees')
    ok(!(await bootstrap(ben.token)).properties.some((p) => p.id === outside), 'and another rep does not')
  }

  /* ===== 4. the office sees it, with its territory =========================== */
  {
    const office = await bootstrap(manager)
    const p = office.properties.find((q) => q.id === inBig)
    ok(p?.territoryId === BIG && p?.assignedRepId === ann.id, 'the console reads the new lead with its territory and rep', JSON.stringify({ t: p?.territoryId, r: p?.assignedRepId }))
    ok(p?.address1 === '1 Big Rd', 'and its address')
  }

  /* ===== 5. the same create twice ============================================= */
  {
    await addFromMap(ann.token, inBig, '1 Big Rd', 30.53, -97.67)
    ok(n(await query(`SELECT COUNT(*) FROM properties WHERE id='${inBig}'`)) === 1, 'the same create sent twice is one lead')
  }

  /* ===== 6. one rep, several territories ===================================== */
  {
    const r = await j(await call('/api/territories/assign', { method: 'POST', body: JSON.stringify({ territoryId: FAR, repId: ann.id, action: 'add' }) }, manager))
    ok(r.status === 200, 'Ann is added to a second territory', `${r.status}`)
    const mine = await query(`SELECT territory_id FROM territory_reps WHERE user_id='${ann.id}' ORDER BY territory_id`)
    ok(mine.length === 2 && mine.some((m) => m.territory_id === BIG) && mine.some((m) => m.territory_id === FAR), 'and is on both, not moved', JSON.stringify(mine))
    const farReps = await query(`SELECT user_id FROM territory_reps WHERE territory_id='${FAR}'`)
    ok(farReps.length === 2, 'the second territory keeps its first rep beside her', JSON.stringify(farReps))
  }

  /* ===== 7. the office moves leads between territories ======================= */
  {
    const moveJ = async (token, propertyIds, territoryId) => j(await call('/api/properties/territory', { method: 'POST', body: JSON.stringify({ propertyIds, territoryId }) }, token))
    const r1 = await moveJ(manager, [outside, inBig], FAR)
    ok(r1.status === 200 && r1.body.moved === 2, 'two selected leads are moved into a territory', JSON.stringify(r1))
    ok((await row(outside)).territory_id === FAR && (await row(inBig)).territory_id === FAR, 'both are in it')
    ok((await row(outside)).assigned_rep_id === ann.id, 'the rep working them keeps them')
    ok((await bootstrap(cara.token)).properties.some((p) => p.id === outside), 'the territory’s rep now sees them')
    const r2 = await moveJ(manager, [outside], null)
    ok(r2.status === 200 && (await row(outside)).territory_id == null, 'a lead is taken out of every territory', JSON.stringify(r2))
    const r3 = await moveJ(ann.token, [inSmall], BIG)
    ok(r3.status === 403 && (await row(inSmall)).territory_id === SMALL, 'a rep may not move leads between territories', `${r3.status}`)
    const r4 = await moveJ(manager, [inSmall], 'terr_not_ours')
    ok(r4.status === 400 && (await row(inSmall)).territory_id === SMALL, 'a territory from nowhere is refused, and nothing moves', `${r4.status}`)
    const r5 = await moveJ(manager, [], BIG)
    ok(r5.status === 400, 'an empty selection is refused')
    const audit = await query(`SELECT COUNT(*) FROM audit_log WHERE action='territory.leads_moved'`)
    ok(n(audit) === 2, 'each move is in the audit log', `${n(audit)}`)
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await stop()
}

console.log(fails.length ? `\n${fails.length} failed` : '\nevery check passed')
process.exit(fails.length ? 1 : 0)
