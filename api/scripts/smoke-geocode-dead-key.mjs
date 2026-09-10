import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A paid geocoding key that has stopped working says so.
 *
 * The geocoding chain is built to degrade rather than fail: ask Google, and
 * whatever it cannot place falls through to the free Census service. That is
 * the right design — an expired card must not turn an import into a page of red
 * rows — and it has a blind spot that `geocode()` has documented from the day it
 * was written. A key that rejects *everything* looks exactly like a provider
 * that had nothing to add. The import succeeds, every pin quietly drops from a
 * rooftop to a block, and the first person who could notice is a rep knocking on
 * the wrong door.
 *
 * `geocode()` could always report which providers were asked and what they said.
 * Only the selftest endpoint ever asked for it, so on the path that actually
 * runs — in volume, against a customer's list — the report was never collected.
 * This gate is about that path.
 *
 * The same shape as the Cloudflare build token that stopped deploying this
 * Worker for nine days while every check but one stayed green. A credential that
 * fails loudly gets fixed the same day; one that fails quietly gets found by a
 * customer.
 *
 * What it asserts:
 *
 *   a refusing Google still yields placed leads — the fallback works
 *   the response says Google was asked and rejected every one of them
 *   in Google's own words, so a bad key reads as a bad key
 *   and the Worker logs it, because the operator is not always watching
 *   a *healthy* Google reports no errors — the signal is not always on
 *   the key itself is never echoed back or logged
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8841)
const GOOGLE_PORT = Number(process.env.GOOGLE_PORT || 8842)
const CENSUS_PORT = Number(process.env.CENSUS_PORT || 8843)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-deadkey-pepper'
const STATE = resolve(api, '.wrangler/deadkey-state')

/* A value that must never appear in a response or a log line. */
const GOOGLE_KEY = 'AIza-not-a-real-key-deadbeef'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- the stand-ins --------------------------------------------------------- */

/** 'denied' answers every request the way a revoked key does; 'ok' resolves. */
let googleMode = 'denied'
let googleAsked = 0

const google = createServer((req, res) => {
  googleAsked += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  if (googleMode === 'denied') {
    /*
      Google's own shape for this: HTTP 200 with a status in the body. Worth
      copying exactly — a refusal that arrived as a 403 would be caught by the
      transport check, and this one is not, which is precisely why it went
      unnoticed.
    */
    return res.end(
      JSON.stringify({
        status: 'REQUEST_DENIED',
        error_message: 'This API project is not authorized to use this API.',
      }),
    )
  }
  res.end(
    JSON.stringify({
      status: 'OK',
      results: [
        {
          formatted_address: '120 Alder St, Springfield, OR 97477, USA',
          geometry: { location: { lat: 44.0462, lng: -123.0221 }, location_type: 'ROOFTOP' },
          types: ['street_address'],
          address_components: [],
        },
      ],
    }),
  )
})
await new Promise((r) => google.listen(GOOGLE_PORT, '127.0.0.1', r))

/**
 * A stand-in Census that places everything on a block.
 *
 * Present so the fallback has something to succeed with. Without it "Google
 * refused" and "nothing got placed" would be the same observation, and the
 * assertion that matters — a lead still lands, merely coarser — could not be
 * made.
 */
const census = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    /*
      The uploaded CSV is `id,address,city,state,zip` per line, inside a
      multipart body — and every field is quoted, so the id is `"r1"` rather
      than `r1`. Every id it can find comes back matched.
    */
    const ids = [...body.matchAll(/^"?(r\d+)"?,/gm)].map((m) => m[1])
    const lines = ids.map(
      (id) =>
        `"${id}","120 Alder St, Springfield, OR, 97477","Match","Non_Exact",` +
        `"120 ALDER ST, SPRINGFIELD, OR, 97477","-123.0225,44.0459","123456","L"`,
    )
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${lines.join('\n')}\n`)
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
let log = ''

async function start(config) {
  log = ''
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
      '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'info',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
      '--var', `GOOGLE_MAPS_API_KEY:${GOOGLE_KEY}`,
      '--var', `GOOGLE_GEOCODE_BASE_URL:http://127.0.0.1:${GOOGLE_PORT}/geocode/json`,
      '--var', `CENSUS_BASE_URL:http://127.0.0.1:${CENSUS_PORT}/addressbatch`,
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
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
  throw new Error(`something is still listening on ${BASE} after stop()`)
}

function applySchema(config) {
  execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE,
     '--file', './schema.sql', '-c', config, '-y'],
    { cwd: api, stdio: 'ignore' },
  )
}

const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })

const ROWS = [
  { ref: 'r1', address1: '120 Alder St', city: 'Springfield', state: 'OR', zip: '97477' },
  { ref: 'r2', address1: '122 Alder St', city: 'Springfield', state: 'OR', zip: '97477' },
]

const stamp = Date.now()
const OWNER = { email: `deadkey-${stamp}@example.com`, password: 'correct-horse-battery-99' }

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('deadkey-smoke.toml')

  await start(config)
  applySchema(config)
  await stop()
  const health = await start(config)
  ok(health.config?.googleGeocoding === true, 'a Google key is configured for this run')

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner',
      email: OWNER.email, password: OWNER.password,
    }),
  })
  const login = await (
    await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
  ).json()
  const token = login.token
  ok(!!token, 'signed in as an operator who can import')

  /* ===== 1. a refusing key still places leads, and says it refused ======== */
  const before = log.length
  const res = await call('/api/import/geocode', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, token)
  const body = await res.json()

  ok(res.ok, 'the import lookup still succeeds', `HTTP ${res.status}`)
  ok(googleAsked >= ROWS.length, 'Google really was asked', `${googleAsked} request(s)`)
  ok(
    body.matches?.filter((m) => m.status === 'match').length === ROWS.length,
    'every address is still placed, by the free service underneath',
    `${body.matches?.filter((m) => m.status === 'match').length} of ${ROWS.length}`,
  )
  ok(
    body.matches?.every((m) => m.provider === 'census'),
    'and the leads are marked as coming from the free one, not from Google',
  )

  const attempts = body.attempts ?? []
  const g = attempts.find((a) => a.provider === 'google')
  ok(!!g, 'the response reports that Google was asked at all', JSON.stringify(attempts))
  ok(
    g?.errors === g?.asked && g?.asked === ROWS.length,
    'and that it rejected every single address',
    g ? `${g.errors} errors of ${g.asked} asked` : 'no google attempt',
  )
  ok(
    /not authorized/i.test(g?.firstError ?? ''),
    "in Google's own words, so a bad key reads as a bad key",
    g?.firstError,
  )

  /* ===== 2. it reaches the log, for the operator who is not watching ====== */
  let logged = ''
  for (let i = 0; i < 30; i++) {
    logged = log.slice(before)
    if (/geocode: google rejected all/i.test(logged)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ok(
    /geocode: google rejected all/i.test(logged),
    'the Worker logs it too, so it is diagnosable a week later',
    logged.match(/geocode: google rejected all[^\n]*/i)?.[0]?.slice(0, 110),
  )

  /* ===== 3. the key is never echoed anywhere ============================== */
  ok(
    !JSON.stringify(body).includes(GOOGLE_KEY),
    'the API key is not in the response',
  )
  ok(!log.includes(GOOGLE_KEY), 'nor anywhere in the log')

  /* ===== 4. a healthy provider reports no errors ========================== */
  //
  // Without this the gate would pass on a build that reported every provider as
  // broken, all the time — a warning that is always on is one nobody reads, and
  // it would train operators to ignore the real thing.
  googleMode = 'ok'
  const healthy = await (
    await call('/api/import/geocode', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, token)
  ).json()
  const g2 = (healthy.attempts ?? []).find((a) => a.provider === 'google')
  ok(g2?.errors === 0, 'a working key reports no errors', g2 ? JSON.stringify(g2) : 'no attempt')
  ok(
    healthy.matches?.every((m) => m.provider === 'google'),
    'and its rooftops are used instead of the free fallback',
  )
} finally {
  await stop().catch(() => {})
  google.close()
  census.close()
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  console.log(`\n--- what the Worker said ---\n${log.split('\n').slice(-30).join('\n')}`)
  process.exit(1)
}
console.log('\n=== a dead geocoding key is visible, not silent ===')
