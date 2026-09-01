import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Leads arriving from GoHighLevel — against a real Worker and a real database.
 *
 * Push can be retried at leisure; this is them calling us once, and the two
 * things that go wrong here are both silent. A webhook that trusts its payload
 * writes a stranger's leads into a customer's account. A webhook that overwrites
 * instead of filling destroys a correction somebody made in the other system.
 *
 * So: the URL secret decides the tenant, the payload never does, and an inbound
 * change may only fill a blank.
 *
 * The free Census geocoder is a local stand-in here (`CENSUS_BASE_URL`), because
 * without one the only reachable outcome is "the geocoder was unreachable" —
 * which proves the fallback and nothing about the case that matters: a lead
 * arriving with a real pin and landing in the right territory.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8821)
const CENSUS_PORT = Number(process.env.CENSUS_PORT || 8823)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/crm-inbound-state')

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

/* --- a stand-in for the Census batch geocoder ----------------------------- */

let censusPlaces = true
const census = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    // The uploaded CSV carries the ref first; echo it back in their format.
    const refs = [...body.matchAll(/"([^"]+)","[^"]*"/g)].map((m) => m[1]).filter((r) => r !== 'ref')
    const rows = refs.map((r) =>
      censusPlaces
        ? `"${r}","in","Match","Exact","OUT","-97.68,30.51","x","L"`
        : `"${r}","in","No_Match"`,
    )
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(rows.join('\n'))
  })
})
await new Promise((r) => census.listen(CENSUS_PORT, '127.0.0.1', r))

/* --- server lifecycle ------------------------------------------------------ */

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
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
     '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:local-inbound-pepper',
     '--var', 'INTEGRATION_KEY:local-inbound-key-do-not-reuse',
     '--var', `GHL_BASE_URL:http://127.0.0.1:${CENSUS_PORT}`,
     '--var', `CENSUS_BASE_URL:http://127.0.0.1:${CENSUS_PORT}`],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch { /* not up */ }
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
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`d1 execute exited ${code}`))))
  })
}

const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })

async function query(sql) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '--command', sql],
    { cwd: api, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0]?.results ?? []
}

const stamp = Date.now()
const OWNER = { email: `in-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const q = (s) => String(s).replace(/'/g, "''")
const LOCATION = 'loc_summit_001'
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('crm-inbound-smoke.toml')
  await start(config)
  await applySchema(config)
  await stop()
  await start(config)

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner',
      email: OWNER.email, password: OWNER.password,
    }),
  })
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
  ok(login.ok, `the owner can sign in (${login.status})`)
  const { token: session, user } = await login.json()
  const clientId = user.clientId

  // Connect directly in the database: the connect endpoint verifies against
  // GoHighLevel, and this test's stand-in is a Census geocoder.
  await query(
    `INSERT INTO client_integrations (client_id, provider, auth_type, access_token, location_id, config, status, created_at, updated_at)
     VALUES ('${q(clientId)}','ghl','pit','v1:x:y','${LOCATION}','{}','active',${Date.now()},${Date.now()})`,
  )

  /* ===== 1. the URL is the credential ================================== */
  {
    const bad = await post(`${BASE}/api/webhooks/ghl/${'0'.repeat(64)}`, {
      id: 'ghl_1', address1: '10 Nowhere St', locationId: LOCATION,
    })
    ok(bad.status === 404, 'an unknown secret is refused', `${bad.status}`)
    const rows = await query(`SELECT COUNT(*) AS n FROM properties WHERE client_id = '${q(clientId)}'`)
    ok(Number(rows[0]?.n) === 0, 'and nothing was written', `${rows[0]?.n} properties`)
  }

  const hookRes = await call('/api/integrations/ghl/webhook', { method: 'POST', body: '{}' }, session)
  ok(hookRes.ok, `an admin can fetch the webhook URL (${hookRes.status})`)
  const { url: hookUrl } = await hookRes.json()
  ok(/\/api\/webhooks\/ghl\/[a-f0-9]{64}$/.test(hookUrl ?? ''), 'which carries a 64-character secret', hookUrl?.slice(-12))

  /* ===== 2. a new lead arrives, placed and in its territory ============ */
  {
    // A territory the geocoded point falls inside.
    await query(
      `INSERT INTO territories (id, client_id, name, boundary)
       VALUES ('t_${stamp}','${q(clientId)}','Round Rock North',
       '[{"lat":30.4,"lng":-97.8},{"lat":30.6,"lng":-97.8},{"lat":30.6,"lng":-97.5},{"lat":30.4,"lng":-97.5}]')`,
    )
    const res = await post(hookUrl, {
      type: 'ContactCreate', locationId: LOCATION, id: 'ghl_contact_1',
      firstName: 'Oleander', lastName: 'Bexley', phone: '512-555-0199',
      address1: '77 Willowfen Ct', city: 'Round Rock', state: 'TX', postalCode: '78664',
    })
    const out = await res.json()
    ok(res.ok && out.status === 'created', 'a new contact becomes a lead', JSON.stringify(out))

    const p = await query(
      `SELECT id, address1, lat, lng, territory_id FROM properties WHERE client_id = '${q(clientId)}'`,
    )
    ok(p.length === 1, 'exactly one lead exists', `${p.length}`)
    ok(p[0]?.address1 === '77 Willowfen Ct', 'with the address from the payload')
    ok(Math.abs(Number(p[0]?.lat) - 30.51) < 0.01, 'geocoded to a real pin', `lat=${p[0]?.lat}`)
    /*
      Named explicitly rather than "not null": the first version of this fixture
      stored the boundary as [lat,lng] pairs, which `parseBoundary` rejects — it
      wants {lat,lng} objects. The shape silently failed to parse, no territory
      was ever considered, and only asserting the exact id caught it.
    */
    ok(p[0]?.territory_id === `t_${stamp}`, 'and dropped into the territory it falls inside', String(p[0]?.territory_id))

    const c = await query(`SELECT name, phone FROM contacts WHERE property_id = '${p[0]?.id}'`)
    ok(c[0]?.name === 'Oleander Bexley', 'the contact came across', c[0]?.name)
    ok(c[0]?.phone === '512-555-0199', 'with the phone number')

    const link = await query(
      `SELECT local_id FROM integration_links WHERE client_id = '${q(clientId)}' AND remote_id = 'ghl_contact_1'`,
    )
    ok(link[0]?.local_id === p[0]?.id, 'and it is linked, so the next webhook updates rather than duplicating')
  }

  /* ===== 3. the same webhook again does not duplicate ================== */
  {
    await post(hookUrl, {
      locationId: LOCATION, id: 'ghl_contact_1', firstName: 'Oleander', lastName: 'Bexley',
      phone: '512-555-0199', address1: '77 Willowfen Ct', city: 'Round Rock', state: 'TX', postalCode: '78664',
    })
    const p = await query(`SELECT COUNT(*) AS n FROM properties WHERE client_id = '${q(clientId)}'`)
    ok(Number(p[0]?.n) === 1, 'a replayed webhook creates nothing new', `${p[0]?.n} properties`)
  }

  /* ===== 4. it fills blanks and never overwrites ======================= */
  //
  // The rule, end to end rather than as a pure function. Allstar has a phone and
  // no email; the payload disagrees about the phone and supplies an email.
  {
    const p = await query(`SELECT id FROM properties WHERE client_id = '${q(clientId)}'`)
    await post(hookUrl, {
      locationId: LOCATION, id: 'ghl_contact_1',
      phone: '999-999-9999', email: 'oleander@example.com', city: 'Austin',
    })
    const c = await query(`SELECT phone, email FROM contacts WHERE property_id = '${p[0]?.id}'`)
    ok(c[0]?.phone === '512-555-0199', 'a phone we already hold is not overwritten', c[0]?.phone)
    ok(c[0]?.email === 'oleander@example.com', 'and a blank email is filled', c[0]?.email)
    const prop = await query(`SELECT city FROM properties WHERE id = '${p[0]?.id}'`)
    ok(prop[0]?.city === 'Round Rock', 'a city we already hold is not overwritten either', prop[0]?.city)
  }

  /* ===== 5. a payload for someone else's sub-account is refused ======== */
  {
    const res = await post(hookUrl, {
      locationId: 'loc_someone_else', id: 'ghl_contact_2',
      address1: '1 Trespass Way', city: 'Austin', state: 'TX', postalCode: '78701',
    })
    const out = await res.json()
    ok(out.status === 'ignored', 'a payload naming a different sub-account is ignored', out.reason)
    const p = await query(`SELECT COUNT(*) AS n FROM properties WHERE client_id = '${q(clientId)}'`)
    ok(Number(p[0]?.n) === 1, 'and writes nothing', `${p[0]?.n} properties`)
  }

  /* ===== 6. a contact with no address is not a lead ==================== */
  {
    const res = await post(hookUrl, { locationId: LOCATION, id: 'ghl_contact_3', firstName: 'No', lastName: 'Address' })
    const out = await res.json()
    ok(out.status === 'ignored', 'a contact with no street address is ignored', out.reason)
    ok(/no door/i.test(out.reason ?? ''), 'and says why in words', out.reason)
  }

  /* ===== 7. the geocoder failing does not cost us the lead ============ */
  {
    censusPlaces = false
    const res = await post(hookUrl, {
      locationId: LOCATION, id: 'ghl_contact_4', firstName: 'Wilhelmina', lastName: 'Ackerbridge',
      phone: '512-555-0111', address1: '404 Unfindable Rd', city: 'Round Rock', state: 'TX', postalCode: '78664',
    })
    const out = await res.json()
    ok(out.status === 'created', 'a lead the geocoder cannot place is still created', JSON.stringify(out))
    ok(out.placed === false, 'and is honestly reported as unplaced', String(out.placed))
    const p = await query(
      `SELECT lat, lng FROM properties WHERE client_id = '${q(clientId)}' AND address1 = '404 Unfindable Rd'`,
    )
    ok(p.length === 1 && Number(p[0]?.lat) === 0, 'sitting unplaced rather than at a guessed pin', `lat=${p[0]?.lat}`)
    censusPlaces = true
  }

  /* ===== 8. rotating the secret revokes the old URL =================== */
  {
    const res = await call('/api/integrations/ghl/webhook', { method: 'POST', body: JSON.stringify({ rotate: true }) }, session)
    const { url: fresh } = await res.json()
    ok(fresh !== hookUrl, 'rotating produces a different URL')
    const old = await post(hookUrl, { locationId: LOCATION, id: 'ghl_contact_5', address1: '9 Stale St' })
    ok(old.status === 404, 'and the old one stops working', `${old.status}`)
  }
} finally {
  await stop().catch(() => {})
  census.close()
  rmSync(STATE, { recursive: true, force: true })
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== inbound leads are trusted by their URL, never by their payload ===')
