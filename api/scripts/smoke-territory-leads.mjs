import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The houses inside a territory become leads, on a real Worker over a real D1
 * and a real (local) R2.
 *
 * `verify:addresses` proves the arithmetic and the rules against stand-ins.
 * This proves the plumbing nobody can fake: the ADDRESSES binding, a tile put
 * into the bucket the way `addresses:build --upload` puts it, the route, and
 * what a rep's phone then receives. Own port, own database, own bucket.
 *
 * What is pinned:
 *   /api/health says whether address data is there
 *   drawing a territory with the box ticked makes a lead of every house inside
 *   the leads land in the territory, with its sole rep, on that rep's phone
 *   pressing Find addresses again creates nothing and says why
 *   a house that was already a lead is counted, not duplicated
 *   an erased homeowner stays erased through a redraw
 *   with the binding removed, the same request is a 501 that says so
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8853)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/territory-leads-state')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const ADDR_OFF = '# [[r2_buckets]]\n# binding = "ADDRESSES"\n# bucket_name = "allstar-addresses"'
const ADDR_ON = '[[r2_buckets]]\nbinding = "ADDRESSES"\nbucket_name = "allstar-addresses"'
function writeConfig(name, withAddresses = true) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  if (!source.includes(ADDR_OFF)) throw new Error('wrangler.toml no longer carries the commented ADDRESSES binding this smoke switches on')
  const body = source
    .replace('main = "src/index.ts"', 'main = "../src/index.ts"')
    .replace(ADDR_OFF, withAddresses ? ADDR_ON : ADDR_OFF)
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
     '--var', 'SESSION_PEPPER:local-tleads-pepper'],
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
const OWNER = { email: `tleads-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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



// A box in Round Rock, and the houses on the ground inside it — one tile,
// written the way the build script writes them.
const BOX = [
  { lat: 30.500, lng: -97.680 },
  { lat: 30.520, lng: -97.680 },
  { lat: 30.520, lng: -97.660 },
  { lat: 30.500, lng: -97.660 },
]
const HOUSES = [
  ['10', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.675, 30.505],
  ['12', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.670, 30.510],
  ['14', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.665, 30.515],
  ['16', 'Inside St', 'B', 'Round Rock', 'TX', '78664', -97.662, 30.518],
  ['1', 'Outside Ave', null, 'Round Rock', 'TX', '78664', -97.600, 30.600],
]
/** Same arithmetic as src/addresses.ts and the tiler; z14. */
function tileFor(lng, lat) {
  const n = 2 ** 14
  const x = Math.floor(((lng + 180) / 360) * n)
  const r = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
  return { x, y }
}
async function putTile(config) {
  const byTile = new Map()
  for (const h of HOUSES) {
    const { x, y } = tileFor(h[6], h[7])
    const k = `v1/14/${x}/${y}.json`
    byTile.set(k, [...(byTile.get(k) ?? []), h])
  }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  for (const [key, rows] of byTile) {
    const file = resolve(api, '.wrangler', `tleads-${key.replace(/\//g, '_')}`)
    writeFileSync(file, JSON.stringify(rows))
    await run(resolve(api, 'node_modules/.bin/wrangler'),
      ['r2', 'object', 'put', `allstar-addresses/${key}`, '--file', file, '--content-type', 'application/json', '--local', '--persist-to', STATE, '-c', config],
      { cwd: api })
  }
  return byTile.size
}

const ownersOf = async (managerToken) => {
  const b = await (await call('/api/bootstrap', {}, managerToken)).json()
  return (b.properties ?? []).map((p) => ({ id: p.id, address1: p.address1, territoryId: p.territoryId ?? null, rep: p.assignedRepId ?? null, provider: p.geoProvider ?? null }))
}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('territory-leads-smoke.toml', true)
  await start(config)
  await applySchema(config)
  await stop()
  const tiles = await putTile(config)
  ok(tiles >= 1, 'address tiles are put into the local bucket the way addresses:build --upload does', `${tiles}`)
  const health = await start(config)
  ok(health.config?.addresses === true, '/api/health reports address data as present')

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'a manager is signed in')
  const curtis = await mintRep(manager, 'Curtis')

  // One house is a lead already, under a different spelling — a rep added it.
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: [
    { ref: 'old', address1: '12 Inside Street', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51003, lng: -97.67004 },
  ] }) }, manager)).json()
  ok(imported.created === 1, 'one of the houses is already a lead, spelt differently and pinned a few metres off')

  /* ===== 1. draw with the box ticked ====================================== */
  let T = null
  {
    const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory A', repIds: [curtis.id], boundary: BOX, generate: true }) }, manager))
    ok(r.status === 201, 'a manager draws Territory A and asks for the houses inside', `${r.status} ${r.body.error ?? ''}`)
    T = r.body.territory
    const g = r.body.generated
    ok(g && !('error' in g), 'the look-up ran', JSON.stringify(g))
    ok(g?.found === 4 && g?.created === 3 && g?.existed === 1, 'four houses inside; three become leads, the one that already was is counted', JSON.stringify(g))
    ok(r.body.assigned === 1, 'and the existing lead joined the patch through the ordinary claim', `${r.body.assigned}`)
    const own = await ownersOf(manager)
    const inA = own.filter((p) => p.territoryId === T.id)
    ok(inA.length === 4, 'the office sees four leads in Territory A', `${inA.length}`)
    const fromData = n(await query(`SELECT COUNT(*) FROM properties WHERE territory_id='${T.id}' AND geo_provider='overture' AND geo_precision='rooftop'`))
    ok(fromData === 3, 'three of them from the address data, pinned on the parcel', `${fromData}`)
    ok(inA.every((p) => p.rep === curtis.id), 'all handed to its sole rep')
    ok(!own.some((p) => p.address1.startsWith('1 Outside')), 'the house outside the shape was not made a lead')
    const c = await phone(curtis.token)
    ok(c.leads.size === 4, 'and Curtis has all four on his phone', `${c.leads.size}`)
  }

  /* ===== 2. pressing it again ============================================ */
  {
    const r = await j(await call(`/api/territories/${T.id}/leads`, { method: 'POST' }, manager))
    ok(r.status === 200 && r.body.created === 0 && r.body.existed === 4, 'Find addresses a second time creates nothing and says every house is already there', JSON.stringify(r.body))
    const rep = await j(await call(`/api/territories/${T.id}/leads`, { method: 'POST' }, curtis.token))
    ok(rep.status === 403, 'a rep cannot', `${rep.status}`)
  }

  /* ===== 3. an erased homeowner stays erased ============================== */
  {
    const own = await ownersOf(manager)
    const ten = own.find((p) => p.address1 === '10 Inside St')
    const e = await j(await call('/api/leads/erase', { method: 'DELETE', body: JSON.stringify({ propertyId: ten.id, reason: 'asked' }) }, manager))
    ok(e.status === 200, '10 Inside St is erased at the homeowner’s request', `${e.status} ${e.body.error ?? ''}`)
    const r = await j(await call(`/api/territories/${T.id}/leads`, { method: 'POST' }, manager))
    ok(r.status === 200 && r.body.created === 0 && r.body.erased === 1, 'a redraw does not bring them back — counted as erased, not created', JSON.stringify(r.body))
  }

  /* ===== 4. with no address data ========================================== */
  {
    await stop()
    const off = writeConfig('territory-leads-off.toml', false)
    const h = await start(off)
    ok(h.config?.addresses === false, 'with the binding removed, /api/health says so')
    const { token: again } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
    const r = await j(await call(`/api/territories/${T.id}/leads`, { method: 'POST' }, again))
    ok(r.status === 501 && r.body.code === 'addresses_not_configured' && /not set up/.test(r.body.error ?? ''), 'and Find addresses is a 501 that says the data is not set up, not an empty result', `${r.status} ${r.body.error ?? ''}`)
    const d = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory B', boundary: BOX, generate: true }) }, again))
    ok(d.status === 201 && d.body.generated?.code === 'addresses_not_configured', 'drawing with the box ticked still creates the territory, with the refusal in words beside it', `${d.status} ${JSON.stringify(d.body.generated)}`)
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== fifty houses drawn round become fifty leads ===')
