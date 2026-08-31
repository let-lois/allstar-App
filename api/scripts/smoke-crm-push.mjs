import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What a rep does reaches the customer's CRM — against a real Worker, a real
 * database, and a GoHighLevel stand-in that records every byte we send it.
 *
 * The queue and the drain are separate halves and each fails differently, so
 * both are exercised end to end rather than unit-tested apart:
 *
 *   - a visit queues work, and a company with no CRM connected queues none
 *   - the drain sends it, with the auth and Version headers GHL requires
 *   - the id GHL returns is linked, so a retry updates rather than duplicating
 *   - a burst of corrections costs the customer's quota once
 *   - **a rep's sync succeeds even when GoHighLevel is down**
 *   - a blip retries with backoff; a refused request does not
 *   - a bad credential marks the connection broken; a refused *shape* does not
 *   - an address-only lead is dropped with a reason rather than retried forever
 *   - Do Not Contact travels outward, so the office CRM stops calling too
 *
 * The fifth is the one worth breaking the build over. `queueForCrm` is called
 * from inside `applyOne`, and `applyMutations` treats a throw from there as the
 * mutation being rejected — so a mistake in this area does not lose a CRM
 * update, it tells a rep on a doorstep that their visit did not save.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8811)
const GHL_PORT = Number(process.env.GHL_PORT || 8812)
const BASE = `http://127.0.0.1:${PORT}`
const GHL_BASE = `http://127.0.0.1:${GHL_PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-push-pepper'
const KEY = 'local-push-key-do-not-reuse'
const STATE = resolve(api, '.wrangler/crm-push-state')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

/* --- the stand-in for GoHighLevel ----------------------------------------- */

const GOOD_TOKEN = 'pit-good-token-value'
const LOCATION = 'loc_summit_001'

/** Set per-phase to make the mock misbehave on purpose. */
let mockMode = 'ok'
/** Everything we sent it, so assertions can be about the request, not the reply. */
const seen = []

const ghl = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = undefined
    }
    seen.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization ?? '',
      version: req.headers.version ?? '',
      body,
    })

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (req.url?.startsWith('/locations/')) {
      if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) return send(401, { message: 'Invalid token' })
      return send(200, { location: { id: LOCATION, name: 'Summit Exteriors' } })
    }

    if (mockMode === 'down') return send(500, { message: 'upstream exploded' })
    if (mockMode === 'refuse-shape') return send(400, { message: 'phone must be a string' })
    if (mockMode === 'bad-token') return send(401, { message: 'Invalid token' })

    if (req.url === '/contacts/upsert') return send(200, { contact: { id: 'ghl_contact_9001' } })
    send(404, { message: 'no such endpoint' })
  })
})
await new Promise((r) => ghl.listen(GHL_PORT, '127.0.0.1', r))

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
    [
      'dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
      '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
      '--var', `INTEGRATION_KEY:${KEY}`,
      '--var', `GHL_BASE_URL:${GHL_BASE}`,
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
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

async function applySchema(config) {
  await new Promise((done, fail) => {
    const p = spawn(
      resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE,
       '--file', './schema.sql', '-c', config, '-y'],
      { cwd: api, stdio: 'ignore' },
    )
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`d1 execute exited ${code}`))))
  })
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

async function query(sql) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '--command', sql],
    { cwd: api, maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')))
  return parsed[0]?.results ?? []
}

const stamp = Date.now()
const OWNER = { email: `push-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const q = (s) => String(s).replace(/'/g, "''")

let n = 0
const visitMutation = (propertyId, outcome) => ({
  id: `m_${stamp}_${++n}`,
  kind: 'visit.complete',
  createdAt: Date.now(),
  payload: {
    id: `v_${stamp}_${n}`,
    propertyId,
    outcome,
    endedAt: Date.now(),
    startedAt: Date.now() - 60_000,
  },
})

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('crm-push-smoke.toml')
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

  /* --- two leads: one contactable, one address-only ---------------------- */
  const P1 = `p_push_${stamp}_a`
  const P2 = `p_push_${stamp}_b`
  await query(
    `INSERT INTO properties (id, client_id, address1, city, state, zip, lat, lng, status, score, updated_at)
     VALUES ('${P1}','${q(clientId)}','4417 Sundapple Ter','Round Rock','TX','78664',30.5,-97.6,'new',50,${Date.now()}),
            ('${P2}','${q(clientId)}','19 Hollowmere Rd','Round Rock','TX','78664',30.5,-97.6,'new',50,${Date.now()})`,
  )
  await query(
    `INSERT INTO contacts (id, property_id, name, phone, email, is_primary)
     VALUES ('c_${stamp}_a','${P1}','Marguerite Adeyemi','512-555-0148','m@example.com',1)`,
  )

  /* ===== 1. no CRM connected: nothing is queued ========================== */
  //
  // First, because a queue that fills for every customer regardless would make
  // every assertion below pass for the wrong reason.
  {
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitMutation(P1, 'not_interested')] }),
    }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'applied', 'a visit applies with no CRM connected')
    const rows = await query(`SELECT COUNT(*) AS n FROM integration_outbox`)
    ok(Number(rows[0]?.n ?? -1) === 0, 'and queues nothing for a company that has no CRM', `${rows[0]?.n} rows`)
  }

  /* ===== 2. connect, then a visit queues ================================= */
  {
    const res = await call('/api/integrations/ghl', {
      method: 'POST',
      body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }),
    }, session)
    ok(res.ok, `the CRM connects (${res.status})`)

    await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitMutation(P1, 'interested')] }),
    }, session)

    const rows = await query(
      `SELECT event, status, payload FROM integration_outbox WHERE client_id = '${q(clientId)}'`,
    )
    ok(rows.length === 1, 'a visit now queues exactly one event', `${rows.length}`)
    ok(rows[0]?.event === 'contact.upsert', 'and it is a contact upsert', rows[0]?.event)
    ok(String(rows[0]?.payload ?? '').includes(P1), 'carrying the property it is about')
  }

  /* ===== 3. a burst of corrections collapses ============================= */
  {
    await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [visitMutation(P1, 'follow_up'), visitMutation(P1, 'appointment')],
      }),
    }, session)
    const rows = await query(
      `SELECT COUNT(*) AS n FROM integration_outbox
        WHERE client_id = '${q(clientId)}' AND status = 'pending'`,
    )
    ok(Number(rows[0]?.n) === 1, 'three corrections to one lead stay one pending send', `${rows[0]?.n} pending`)
  }

  /* ===== 4. the drain sends it, correctly =============================== */
  {
    seen.length = 0
    const res = await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    const report = await res.json()
    ok(res.ok && report.sent === 1, 'the drain sends the queued lead', JSON.stringify(report))

    const upsert = seen.find((s) => s.url === '/contacts/upsert')
    ok(!!upsert, 'GoHighLevel received a contact upsert')
    ok(upsert?.auth === `Bearer ${GOOD_TOKEN}`, 'with the customer bearer token')
    ok(upsert?.version === '2021-07-28', 'and the Version header GHL requires', upsert?.version)
    ok(upsert?.body?.locationId === LOCATION, 'against their own sub-account')
    ok(upsert?.body?.address1 === '4417 Sundapple Ter', 'carrying the address')
    ok(upsert?.body?.phone === '512-555-0148', 'and the phone it will match on')
    // Read at send time, not snapshotted when the rep acted: the outcome sent is
    // the last correction, not the first.
    ok(
      JSON.stringify(upsert?.body?.tags ?? []).includes('appointment'),
      'and the lead state as it stands now, not as it was at the first edit',
      JSON.stringify(upsert?.body?.tags),
    )

    const links = await query(
      `SELECT remote_id FROM integration_links WHERE local_id = '${P1}' AND kind = 'contact'`,
    )
    ok(links[0]?.remote_id === 'ghl_contact_9001', 'the id GHL returned is linked, so a retry updates rather than duplicating')
  }

  /* ===== 5. Do Not Contact travels outward ============================== */
  //
  // The office autodialler is the thing this protects. A household that told a
  // rep to stop is only actually stopped if the CRM hears about it too.
  {
    seen.length = 0
    await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitMutation(P1, 'do_not_contact')] }),
    }, session)
    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    const upsert = seen.find((s) => s.url === '/contacts/upsert')
    const tags = JSON.stringify(upsert?.body?.tags ?? [])
    ok(tags.includes('dnc') || tags.includes('do_not_contact'), 'a Do Not Contact outcome reaches the CRM', tags)
  }

  /*
    A helper, because the first version of these phases did not have one and the
    500 was never exercised: it queued the address-only lead, which is dropped
    before any HTTP happens, so "survives a 500" and "a 500 does not mark the
    connection broken" both passed without a single request leaving the Worker.
    Every phase below now queues a *sendable* lead and asserts the stand-in
    actually saw it.
  */
  const requeue = async (propertyId, outcome) => {
    await query(`DELETE FROM integration_outbox WHERE client_id = '${q(clientId)}'`)
    seen.length = 0
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitMutation(propertyId, outcome)] }),
    }, session)
    const { results } = await res.json()
    return results?.[0]?.status
  }
  const upsertsSeen = () => seen.filter((x) => x.url === '/contacts/upsert').length

  /* ===== 6. GoHighLevel is down ========================================= */
  //
  // The assertion that matters most here is the first one.
  {
    mockMode = 'down'
    const status = await requeue(P1, 'interested')
    ok(status === 'applied', "a rep's visit still saves while the CRM is down")

    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    ok(upsertsSeen() === 1, 'the drain really did try to send — the 500 was reached', `${upsertsSeen()} request(s)`)

    const rows = await query(
      `SELECT status, attempts, next_attempt_at FROM integration_outbox
        WHERE client_id = '${q(clientId)}'`,
    )
    ok(rows[0]?.status === 'pending', 'the queued work survives a 500 rather than being dropped', rows[0]?.status)
    ok(Number(rows[0]?.attempts) >= 1, 'the attempt is counted', `attempts=${rows[0]?.attempts}`)
    ok(
      Number(rows[0]?.next_attempt_at) > Date.now() + 30_000,
      'and the retry is pushed into the future rather than hammering them',
    )
    const conn = await query(`SELECT status FROM client_integrations WHERE client_id = '${q(clientId)}'`)
    ok(conn[0]?.status === 'active', 'a 500 does not mark the customer connection broken', conn[0]?.status)
    mockMode = 'ok'
  }

  /* ===== 7. a refused shape is permanent, and is ours not theirs ========= */
  {
    mockMode = 'refuse-shape'
    await requeue(P1, 'follow_up')
    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    ok(upsertsSeen() === 1, 'the request was sent and refused', `${upsertsSeen()} request(s)`)

    const rows = await query(
      `SELECT status FROM integration_outbox WHERE client_id = '${q(clientId)}'`,
    )
    ok(rows[0]?.status === 'failed', 'a 400 fails the row permanently instead of retrying forever', rows[0]?.status)
    const conn = await query(`SELECT status FROM client_integrations WHERE client_id = '${q(clientId)}'`)
    ok(
      conn[0]?.status === 'active',
      'and does not tell the customer their connection is broken — it is our request that was wrong',
      conn[0]?.status,
    )
    mockMode = 'ok'
  }

  /* ===== 8. an address-only lead is dropped before it is sent =========== */
  //
  // The ordinary case for a door-to-door list, not an edge one. GHL matches an
  // upsert on phone or email; with neither, every retry would create a fresh
  // duplicate contact over there. So it must be dropped *without* being sent —
  // which is why the request count is asserted and not just the row status.
  {
    await requeue(P2, 'no_answer')
    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    ok(upsertsSeen() === 0, 'nothing is sent for a lead with no phone or email', `${upsertsSeen()} request(s)`)

    const rows = await query(
      `SELECT status, last_error FROM integration_outbox WHERE client_id = '${q(clientId)}'`,
    )
    ok(rows[0]?.status === 'failed', 'and the row is not left retrying forever', rows[0]?.status)
    ok(
      /nothing to match on|no phone/i.test(rows[0]?.last_error ?? ''),
      'and says why, in words an admin can act on',
      rows[0]?.last_error,
    )
  }

  /* ===== 9. two leads that share a phone number ========================= */
  //
  // Not exotic: GHL matches an upsert on phone or email, so a landlord with
  // several houses — or the same household twice in a purchased list — comes
  // back as one contact for two of our properties. `integration_links` is unique
  // in both directions on purpose, so the second link collides.
  //
  // The send still succeeded, and this must not become a row that retries five
  // times against a condition waiting cannot change and then fails in front of
  // an admin with a raw D1 constraint error. Which is exactly what it did before
  // the collision was handled.
  {
    const P3 = `p_push_${stamp}_c`
    await query(
      `INSERT INTO properties (id, client_id, address1, city, state, zip, lat, lng, status, score, updated_at)
       VALUES ('${P3}','${q(clientId)}','8 Kettleridge Way','Round Rock','TX','78664',30.5,-97.6,'new',50,${Date.now()})`,
    )
    // The same number as P1's contact — which is what makes GHL return one id.
    await query(
      `INSERT INTO contacts (id, property_id, name, phone, is_primary)
       VALUES ('c_${stamp}_c','${P3}','Marguerite Adeyemi','512-555-0148',1)`,
    )

    await requeue(P3, 'interested')
    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    ok(upsertsSeen() === 1, 'the shared-contact lead is sent', `${upsertsSeen()} request(s)`)

    const rows = await query(
      `SELECT status, last_error FROM integration_outbox WHERE client_id = '${q(clientId)}'`,
    )
    ok(rows[0]?.status === 'sent', 'and counts as sent, because it reached their CRM', rows[0]?.status)
    ok(
      !/UNIQUE constraint|D1_ERROR/i.test(rows[0]?.last_error ?? ''),
      'without a raw database error reaching the admin',
      rows[0]?.last_error,
    )
    ok(
      /share a phone or email/i.test(rows[0]?.last_error ?? ''),
      'and says what happened, in words',
      rows[0]?.last_error,
    )
    const links = await query(
      `SELECT local_id FROM integration_links
        WHERE client_id = '${q(clientId)}' AND kind = 'contact' AND remote_id = 'ghl_contact_9001'`,
    )
    ok(links.length === 1 && links[0]?.local_id === P1, 'and the link stays with the lead that claimed it first')
  }

  /* ===== 10. a dead credential marks the connection broken ============== */
  {
    mockMode = 'bad-token'
    await requeue(P1, 'quote_requested')
    await call('/api/integrations/ghl/drain', { method: 'POST' }, session)
    ok(upsertsSeen() === 1, 'the request was sent and rejected', `${upsertsSeen()} request(s)`)

    const conn = await query(
      `SELECT status, last_error FROM client_integrations WHERE client_id = '${q(clientId)}'`,
    )
    ok(conn[0]?.status === 'broken', 'a 401 marks the connection broken so an admin is told', conn[0]?.status)
    ok(!String(conn[0]?.last_error ?? '').includes(GOOD_TOKEN), 'and the recorded error never contains the token')
    mockMode = 'ok'
  }
} finally {
  await stop().catch(() => {})
  ghl.close()
  rmSync(STATE, { recursive: true, force: true })
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== what reps do reaches the CRM, and never at the rep\'s expense ===')
