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
const PORT = Number(process.env.PORT || 8854)
const GEO_PORT = 8864
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
  // Production binds ADDRESSES; the smoke also needs a Worker without it, to
  // pin the 501 a deployment with no address data answers.
  if (!source.includes(ADDR_ON)) throw new Error('wrangler.toml no longer binds ADDRESSES the way this smoke expects')
  const body = source
    .replace('main = "src/index.ts"', 'main = "../src/index.ts"')
    .replace(ADDR_ON, withAddresses ? ADDR_ON : ADDR_OFF)
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

let child = null
async function start(config, vars = []) {
  child = spawn(resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
     '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:local-tleads-pepper',
     ...vars.flatMap((v) => ['--var', v])],
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
    { ref: 'old', address1: '12 Insde St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51003, lng: -97.67004 },
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

  /* ===== 3b. rooftops where the data has no addresses (Powdersville) ====== */
  //
  // Upstate South Carolina: Overture has rooftops and no addresses. A stand-in
  // Geocodio names them; the Worker is pointed at it with GEOCODIO_URL.
  {
    const { createServer } = await import('node:http')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    let mode = 'ok'
    const seen = []
    const geo = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        seen.push({ url: req.url, body: JSON.parse(body || '[]') })
        if (mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"Service unavailable"}'); return }
        const results = JSON.parse(body).map((q, i) => {
          const [lat, lng] = q.split(',').map(Number)
          return { query: q, response: { results: [{ address_components: { number: String(100 + i * 2), formatted_street: 'Cypress Ridge Dr', city: 'Powdersville', state: 'SC', zip: '29642', country: 'US' }, location: { lat, lng }, accuracy_type: 'rooftop' }] } }
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results }))
      })
    })
    await new Promise((r) => geo.listen(GEO_PORT, '127.0.0.1', r))
    try {
      const P = [{ lat: 34.780, lng: -82.500 }, { lat: 34.790, lng: -82.500 }, { lat: 34.790, lng: -82.490 }, { lat: 34.780, lng: -82.490 }]
      const ROOFS = [[-82.4980, 34.7820, 'u'], [-82.4960, 34.7840, 'r'], [-82.4940, 34.7860, 'u'], [-82.4920, 34.7880, 'n']]
      const { x, y } = tileFor(-82.495, 34.785)
      const inTile = ROOFS.filter((r) => { const t = tileFor(r[0], r[1]); return t.x === x && t.y === y })
      await stop()
      const file = resolve(api, '.wrangler', 'tleads-roofs.json')
      writeFileSync(file, JSON.stringify(inTile))
      await run(resolve(api, 'node_modules/.bin/wrangler'),
        ['r2', 'object', 'put', `allstar-addresses/b1/14/${x}/${y}.json`, '--file', file, '--content-type', 'application/json', '--local', '--persist-to', STATE, '-c', config],
        { cwd: api })
      const h = await start(config, ['GEOCODIO_API_KEY:smoke-key', `GEOCODIO_URL:http://127.0.0.1:${GEO_PORT}/v1.9`])
      ok(h.config?.geocodio === true, '/api/health reports the Geocodio key as present (never its value)')
      const { token: m2 } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
      const homes = inTile.filter((r) => r[2] !== 'n').length

      const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Powdersville', repIds: [curtis.id], boundary: P, generate: true }) }, m2))
      const g = r.body.generated
      ok(r.status === 201 && g?.coverage === 'rooftops', 'a territory where Overture has rooftops but no addresses is created, and says where the houses came from', `${r.status} ${JSON.stringify(g)}`)
      ok(g?.withoutAddress === homes && g?.resolved === homes && g?.created === homes, `each of its ${homes} home rooftops is named and becomes a lead; the commercial one does not`, JSON.stringify(g))
      ok(seen.length === 1 && seen[0].body.length === homes && /\/v1\.9\/reverse\?api_key=smoke-key/.test(seen[0].url), 'in one batched reverse look-up', JSON.stringify(seen.map((c) => c.body.length)))
      const rows = await query(`SELECT address1, state, geo_provider AS p, assigned_rep_id AS rep FROM properties WHERE territory_id='${r.body.territory.id}'`)
      ok(rows.length === homes && rows.every((x) => x.p === 'geocodio' && x.state === 'SC' && x.rep === curtis.id), 'stored as Geocodio’s, in SC, handed to the territory’s one rep', JSON.stringify(rows))

      const again = await j(await call(`/api/territories/${r.body.territory.id}/leads`, { method: 'POST' }, m2))
      ok(again.status === 200 && again.body.created === 0 && seen.length === 1, 'pressing Find addresses again makes no duplicates and does not pay for the look-up twice', JSON.stringify(again.body))

      mode = 'down'
      const P2 = P.map((p) => ({ lat: p.lat, lng: p.lng + 0.00001 }))
      await query(`DELETE FROM properties WHERE territory_id='${r.body.territory.id}'`)
      const d = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Powdersville 2', boundary: P2, generate: true }) }, m2))
      ok(d.status === 201 && d.body.generated?.lookupFailed === homes && /503/.test(d.body.generated?.lookupError ?? '') && d.body.generated?.created === 0, 'with Geocodio down the territory is still saved, and the failure is counted and named', JSON.stringify(d.body.generated))
    } finally {
      geo.close()
    }
  }

  /* ===== 3c. free: Census street ranges name the roofs, no key at all ======= */
  {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    // A block in Anderson County with no published address points: rooftops
    // from Overture, the street and its number range from Census TIGER.
    const Q = [{ lat: 34.7700, lng: -82.5200 }, { lat: 34.7760, lng: -82.5200 }, { lat: 34.7760, lng: -82.5100 }, { lat: 34.7700, lng: -82.5100 }]
    const { x, y } = tileFor(-82.515, 34.773)
    const put = async (key, rows, name) => {
      const file = resolve(api, '.wrangler', name)
      writeFileSync(file, JSON.stringify(rows))
      await run(resolve(api, 'node_modules/.bin/wrangler'), ['r2', 'object', 'put', `allstar-addresses/${key}`, '--file', file, '--content-type', 'application/json', '--local', '--persist-to', STATE, '-c', config], { cwd: api })
    }
    await stop()
    await put(`r1/14/${x}/${y}.json`, [['Hood Rd', 200, 298, 201, 299, '29642', '29642', 'SC', [-82.5190, 34.7730, -82.5110, 34.7730]]], 'tleads-range.json')
    await put(`b1/14/${x}/${y}.json`, [[-82.5170, 34.7732, 'r'], [-82.5130, 34.7732, 'u'], [-82.5150, 34.7728, 'u']], 'tleads-roofs2.json')
    // The ZIP → town table (GeoNames), for the town the Census range does not carry.
    await put('meta/zip-city.json', { 29642: 'Easley' }, 'tleads-zipcity.json')
    await start(config) // no Geocodio key
    const { token: m3 } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
    const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Hood Rd', repIds: [curtis.id], boundary: Q, generate: true }) }, m3))
    const g = r.body.generated
    ok(r.status === 201 && g?.created === 3 && g?.bySource?.census_tiger === 3 && g?.geocoder === 'off', 'with no key and no address points, three roofs become leads from the Census street range', JSON.stringify(g))
    ok(g?.coverageStatus === 'LIMITED' && g?.pointCoverage === 0, 'and the area is reported LIMITED, 0% address points', `${g?.coverageStatus} ${g?.pointCoverage}`)
    const rows = await query(`SELECT address1, zip, address_confidence AS c, address_source AS s, residential_status AS rs FROM properties WHERE territory_id='${r.body.territory.id}' ORDER BY address1`)
    ok(rows.length === 3 && rows.every((x) => x.c === 'INTERPOLATED' && x.s === 'census_tiger' && x.zip === '29642' && /Hood Rd$/.test(x.address1)), 'stored as INTERPOLATED from census_tiger, with the ZIP from the range', JSON.stringify(rows))
    const towns = await query(`SELECT DISTINCT city FROM properties WHERE territory_id='${r.body.territory.id}'`)
    ok(towns.length === 1 && towns[0].city === 'Easley', 'each estimated lead has its town, from the ZIP, not a blank', JSON.stringify(towns))
    ok(rows.filter((x) => Number(x.address1.split(' ')[0]) % 2 === 0).length === 2 && rows.filter((x) => Number(x.address1.split(' ')[0]) % 2 === 1).length === 1, 'the two roofs north of the road are even, the one south is odd')
    const b = await (await call('/api/bootstrap', {}, curtis.token)).json()
    const mine = (b.properties ?? []).filter((p) => p.territoryId === r.body.territory.id)
    ok(mine.length === 3 && mine.every((p) => p.addressConfidence === 'INTERPOLATED'), 'the rep’s phone is told each house number is an estimate')
    const fix = await j(await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id: `m_fix_${stamp}`, kind: 'property.update', at: Date.now(), payload: { id: mine[0].id, address1: '211 Hood Rd' } }] }) }, curtis.token))
    const after = await query(`SELECT address_confidence AS c, address_source AS s FROM properties WHERE id='${mine[0].id}'`)
    ok(fix.status === 200 && after[0]?.c === 'MANUAL' && after[0]?.s === 'manual', 'once the rep corrects it at the door it is MANUAL, no longer an estimate', JSON.stringify(after))
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
