import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Connecting a company's own CRM — against a real Worker and a real database.
 *
 * The thing being tested is not "does the form submit". It is the handful of
 * behaviours that, when wrong, are wrong quietly:
 *
 *   - a stored credential never comes back out of any endpoint
 *   - the token is not sitting in plaintext in the database we back up nightly
 *   - a credential GoHighLevel refuses is not stored at all
 *   - a field rep cannot read or touch any of it
 *   - an id mapped once stays mapped, so a retry updates rather than duplicating
 *   - disconnecting drops queued work but keeps the mapping, so reconnecting
 *     resumes instead of re-sending a company's entire database
 *
 * GoHighLevel is a local mock rather than a stub, so this exercises real HTTP:
 * the Authorization header, the Version header, a 401, a 500. The Worker is
 * pointed at it with GHL_BASE_URL.
 *
 * It starts its own server because it needs two configurations — one with an
 * encryption key and one without — and refusing to store a credential when
 * there is nowhere safe to put it is one of the assertions.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8801)
const GHL_PORT = Number(process.env.GHL_PORT || 8802)
const BASE = `http://127.0.0.1:${PORT}`
const GHL_BASE = `http://127.0.0.1:${GHL_PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-integrations-pepper'
const KEY = 'local-integrations-key-do-not-reuse'
const STATE = resolve(api, '.wrangler/integrations-smoke-state')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

// A local dev server must not be sent through an outbound proxy, and `fetch`
// honours the proxy env here. Explicit rather than hopeful.
const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

/* --- the stand-in for GoHighLevel ----------------------------------------- */

const GOOD_TOKEN = 'pit-good-token-value'
const LOCATION = 'loc_summit_001'

/** Set per-phase to make the mock misbehave on purpose. */
let mockMode = 'ok'
const seen = []

const ghl = createServer((req, res) => {
  const auth = req.headers.authorization ?? ''
  const version = req.headers.version ?? ''
  seen.push({ url: req.url, auth, version })

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (mockMode === 'down') return send(500, { message: 'upstream exploded' })
  if (auth !== `Bearer ${GOOD_TOKEN}`) return send(401, { message: 'Invalid token' })

  const m = /^\/locations\/([^/?]+)/.exec(req.url ?? '')
  if (m) {
    // A token that is valid but scoped to a different sub-account. This is the
    // mistake that otherwise looks exactly like a working connection.
    if (decodeURIComponent(m[1]) !== LOCATION) return send(404, { message: 'Location not found' })
    return send(200, { location: { id: LOCATION, name: 'Summit Exteriors' } })
  }
  send(404, { message: 'no such endpoint' })
})
await new Promise((r) => ghl.listen(GHL_PORT, '127.0.0.1', r))

/* --- server lifecycle ------------------------------------------------------ */

function writeConfig(name) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  // The config lands one directory down, and `main` resolves relative to it.
  const body = source.replace('main = "src/index.ts"', 'main = "../src/index.ts"')
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

let child = null

async function start(config, { withKey }) {
  /*
    The local binary, in its own process group. `npx wrangler` is two processes
    and a SIGTERM to the outer one leaves the Worker holding the port — after
    which the next phase silently tests the previous configuration, which is
    exactly what one of these assertions is about.
  */
  const vars = [
    '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
    '--var', `SESSION_PEPPER:${PEPPER}`,
    '--var', `GHL_BASE_URL:${GHL_BASE}`,
  ]
  if (withKey) vars.push('--var', `INTEGRATION_KEY:${KEY}`)

  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '-c', config,
      '--port', String(PORT),
      '--ip', '127.0.0.1',
      '--local-protocol', 'http',
      '--persist-to', STATE,
      '--log-level', 'warn',
      ...vars,
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}

async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null
  // Wait for the port, not the process: a dead parent with a live listener is
  // the state that makes the next phase test the wrong server.
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/api/health`)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`something is still listening on ${BASE} after stop()`)
}

/**
 * A fresh state directory has no tables at all.
 *
 * The Worker migrates itself on the first request, but migrations bring an
 * existing database forward — they are not a substitute for the baseline an
 * operator applies once. Applying it here is the same thing a real deployment
 * does, and skipping it would test a Worker running against nothing.
 */
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

/** Read the database the Worker is actually using. */
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
const OWNER = { email: `int-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

try {
  rmSync(STATE, { recursive: true, force: true })

  /* ===== phase 1: a deployment with nowhere safe to put a credential ===== */
  //
  // First, because the alternative to refusing is storing the token in
  // plaintext "just for now" — which nobody notices until a dump leaks.
  {
    const config = writeConfig('integrations-smoke.toml')
    await start(config, { withKey: false })
    await applySchema(config)
    await stop()
    const health = await start(config, { withKey: false })
    ok(health.config?.migrations?.state !== 'failed', 'the database is ready')
    // How an operator tells "not configured yet" from "broken", from a browser.
    ok(health.config?.integrationKey === false, 'health reports the missing encryption key')

    const setup = await call('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: SETUP_TOKEN,
        clientName: 'Summit Exteriors',
        name: 'Owner',
        email: OWNER.email,
        password: OWNER.password,
      }),
    })
    /*
      The setup page answers 200 whether it succeeded or failed — the error is
      rendered into the HTML. Asserting on the status alone passes on every
      possible failure, which is how the first version of this file reported a
      created account against a database with no tables in it.
    */
    const setupHtml = await setup.text()
    ok(
      !/error|incorrect|at least/i.test(setupHtml),
      `first-run setup raised no error (${(/<p[^>]*class="err[^"]*"[^>]*>([^<]*)/i.exec(setupHtml) ?? ['', 'clean'])[1]})`,
    )

    const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
    ok(login.ok, `the owner can sign in (${login.status})`)
    const { token: session } = await login.json()

    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }) },
      session,
    )
    ok(res.status === 503, `a deployment with no INTEGRATION_KEY refuses to store a token (${res.status})`)

    const rows = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(rows[0]?.n ?? -1) === 0, `and stored nothing at all (${rows[0]?.n} rows)`)

    await stop()
  }

  /* ===== phase 2: the real thing ========================================= */
  const keyed = await start(writeConfig('integrations-smoke.toml'), { withKey: true })
  ok(keyed.config?.integrationKey === true, 'and reports it once the key is set')

  const session = (
    await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ).token
  ok(!!session, 'the owner signs in against the keyed deployment')

  /* --- nothing connected yet --------------------------------------------- */
  {
    const res = await call('/api/integrations', {}, session)
    ok(res.ok, 'the integrations endpoint answers')
    const body = await res.json()
    ok(body.integration?.connected === false, 'and reports nothing connected')
    ok(body.queue?.pending === 0, 'with an empty queue')
  }

  /* --- a credential GoHighLevel refuses ----------------------------------- */
  {
    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: 'pit-wrong', locationId: LOCATION }) },
      session,
    )
    ok(res.status === 400, `a token GoHighLevel rejects is refused (${res.status})`)
    const body = await res.json()
    ok(/token/i.test(body.error ?? ''), `and says why (${body.error})`)

    const rows = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(rows[0]?.n ?? -1) === 0, 'and nothing was written')
  }

  /* --- the right token against the wrong sub-account ---------------------- */
  //
  // The mistake worth catching. It is indistinguishable from a working
  // connection until somebody notices leads landing in another company's CRM.
  {
    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: 'loc_someone_else' }) },
      session,
    )
    /*
      A 400, specifically. This was a 502 until the gate printed the number:
      a valid token pointed at the wrong sub-account is the admin's typo, and
      reporting it as a gateway error tells the only person who can fix it that
      somebody else's system is down.
    */
    ok(res.status === 400, `a valid token for the wrong sub-account is refused (${res.status})`)
    const why = (await res.json()).error ?? ''
    ok(/location id/i.test(why), `and names the field to check (${why})`)
    const rows = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(rows[0]?.n ?? -1) === 0, 'and still nothing was written')
  }

  /* --- connecting properly ------------------------------------------------ */
  {
    const before = seen.length
    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }) },
      session,
    )
    ok(res.ok, `a good token connects (${res.status})`)
    const body = await res.json()
    ok(body.locationName === 'Summit Exteriors', `and names the sub-account it reached (${body.locationName})`)

    // The Version header is the one people forget, and omitting it produces
    // failures that read like malformed requests rather than like a missing
    // header. Asserted on the wire rather than by reading the source.
    const probe = seen.slice(before).find((r) => r.url?.startsWith('/locations/'))
    ok(probe?.version === '2021-07-28', `the Version header was sent (${probe?.version})`)
    ok(probe?.auth === `Bearer ${GOOD_TOKEN}`, 'and the token as a bearer credential')
  }

  /* --- the token is not readable, from either direction ------------------- */
  {
    const body = await (await call('/api/integrations', {}, session)).json()
    const text = JSON.stringify(body)
    ok(body.integration?.connected === true, 'the connection is reported as live')
    ok(!text.includes(GOOD_TOKEN), 'and the response does not contain the token')
    ok(
      body.integration?.tokenHint === `••••${GOOD_TOKEN.slice(-4)}`,
      `only a hint of it (${body.integration?.tokenHint})`,
    )

    /*
      The database is the other direction, and the one that matters for a
      backup. A dump of this table would otherwise hand over write access to
      every customer's CRM.
    */
    const rows = await query('SELECT access_token FROM client_integrations')
    const stored = String(rows[0]?.access_token ?? '')
    ok(!stored.includes(GOOD_TOKEN), 'the token is not sitting in the database in plaintext')
    ok(stored.startsWith('v1:'), `it is stored as a versioned sealed value (${stored.slice(0, 3)})`)

    // Also not in the audit log, which is exported and read by admins.
    const audit = await query(
      `SELECT detail FROM audit_log WHERE action = 'integration.connected'`,
    )
    ok(audit.length === 1, `connecting was recorded in the audit log (${audit.length})`)
    ok(
      !JSON.stringify(audit).includes(GOOD_TOKEN),
      'and the audit log does not contain the token either',
    )
  }

  /* --- a rep cannot see any of it ----------------------------------------- */
  {
    const invite = await (
      await call(
        '/api/invites',
        {
          method: 'POST',
          body: JSON.stringify({
            email: `int-rep-${stamp}@example.com`,
            name: 'Nosy Rep',
            role: 'field_rep',
          }),
        },
        session,
      )
    ).json()
    await fetch(invite.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'rep-password-1', confirm: 'rep-password-1' }),
    })
    const repSession = (
      await (
        await call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: `int-rep-${stamp}@example.com`, password: 'rep-password-1' }),
        })
      ).json()
    ).token
    ok(!!repSession, 'a field rep exists for this run')

    const read = await call('/api/integrations', {}, repSession)
    ok(read.status === 403, `a rep cannot read the integration (${read.status})`)

    const write = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }) },
      repSession,
    )
    ok(write.status === 403, `nor connect one (${write.status})`)

    const kill = await call('/api/integrations/ghl', { method: 'DELETE' }, repSession)
    ok(kill.status === 403, `nor disconnect the company's (${kill.status})`)

    const still = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(still[0]?.n) === 1, 'and the connection is untouched afterwards')
  }

  /* --- replacing a token keeps the connection, not a second row ----------- */
  {
    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }) },
      session,
    )
    ok(res.ok, 'reconnecting with a rotated token succeeds')
    const rows = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(rows[0]?.n) === 1, `and replaces the row rather than adding one (${rows[0]?.n})`)
  }

  /* --- the id map and the queue ------------------------------------------- */
  //
  // These have no HTTP surface of their own yet — the events that use them
  // arrive with the push direction. So the SQL below is the SQL `linkIds` and
  // `enqueue` issue, run against the same database, character for character.
  // That is deliberately not a stand-in: the behaviour worth pinning lives in
  // the ON CONFLICT clauses and the indexes they target, and a conflict clause
  // that does not match its index is an error at runtime rather than a silent
  // one. Testing hand-written INSERTs instead would assert nothing about either.
  {
    const client = (await query(`SELECT client_id FROM client_integrations LIMIT 1`))[0]?.client_id
    ok(!!client, 'the connection belongs to a client')

    const linkIds = (local, remote) =>
      query(
        `INSERT INTO integration_links
           (client_id, provider, kind, local_id, remote_id, created_at, updated_at)
         VALUES ('${client}','ghl','contact','${local}','${remote}',1,1)
         ON CONFLICT(client_id, provider, kind, local_id) DO UPDATE SET
           remote_id  = excluded.remote_id,
           updated_at = excluded.updated_at`,
      )

    await linkIds('p_1', 'ghl_1')
    ok(
      Number((await query(`SELECT COUNT(*) AS n FROM integration_links`))[0]?.n) === 1,
      'a lead can be linked to a GoHighLevel record',
    )

    /*
      The property that makes a retry safe. The send succeeded, the response was
      lost, the outbox tries again — and the second attempt must find the link
      the first one wrote rather than creating a second contact over there.
    */
    await linkIds('p_1', 'ghl_1')
    ok(
      Number((await query(`SELECT COUNT(*) AS n FROM integration_links`))[0]?.n) === 1,
      'and re-linking the same pair changes nothing',
    )

    await linkIds('p_1', 'ghl_1_moved')
    const moved = await query(`SELECT remote_id FROM integration_links WHERE local_id = 'p_1'`)
    ok(moved[0]?.remote_id === 'ghl_1_moved', 'a lead can be re-pointed at a different record')
    await linkIds('p_1', 'ghl_1')

    let claimed = false
    try {
      // A *second* lead claiming the same remote record. The upsert cannot help
      // here — it conflicts on the reverse index, which has no DO UPDATE — so
      // this must be an outright error. Without that index an inbound webhook
      // has no single answer to "which lead is this?".
      await linkIds('p_2', 'ghl_1')
    } catch {
      claimed = true
    }
    ok(claimed, 'but two leads cannot both claim one GoHighLevel record')

    /*
      The outbox, again with the SQL `enqueue` issues. Two edits to the same
      thing collapse into one pending send, and the newer payload is the one
      that survives — a rep who corrects an outcome three times in a minute
      should cost the customer's API quota once, and the last correction is the
      one that is true.
    */
    const enqueue = (id, key, payload) =>
      query(
        `INSERT INTO integration_outbox
           (id, client_id, provider, event, payload, dedupe_key, status, attempts, next_attempt_at, created_at)
         VALUES ('${id}','${client}','ghl','visit.complete','${payload}','${key}','pending',0,1,1)
         ON CONFLICT(client_id, provider, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending'
         DO UPDATE SET
           payload         = excluded.payload,
           event           = excluded.event,
           attempts        = 0,
           last_error      = NULL,
           next_attempt_at = excluded.next_attempt_at`,
      )

    await enqueue('io_1', 'visit:p_1', '{\"outcome\":\"no_answer\"}')
    await enqueue('io_2', 'visit:p_1', '{\"outcome\":\"sold\"}')
    const queued = await query(
      `SELECT id, payload FROM integration_outbox WHERE status = 'pending'`,
    )
    ok(queued.length === 1, `two edits to one lead collapse into one send (${queued.length})`)
    ok(
      String(queued[0]?.payload).includes('sold'),
      `and the newer correction is the one that survives (${queued[0]?.payload})`,
    )

    const depth = await (await call('/api/integrations', {}, session)).json()
    ok(depth.queue?.pending === 1, `the console can see what is waiting (${depth.queue?.pending})`)
  }

  /* --- disconnecting ------------------------------------------------------ */
  {
    const res = await call('/api/integrations/ghl', { method: 'DELETE' }, session)
    ok(res.ok, 'the company can disconnect')
    const body = await res.json()
    ok(body.dropped === 1, `and is told what was discarded (${body.dropped})`)

    const creds = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(creds[0]?.n) === 0, 'the credential is gone')

    const pending = await query(`SELECT COUNT(*) AS n FROM integration_outbox WHERE status = 'pending'`)
    ok(Number(pending[0]?.n) === 0, 'queued work is dropped rather than sent afterwards')

    /*
      The asymmetry that matters. A company that disconnects to rotate a token
      and reconnects an hour later must not have every lead treated as new —
      that would duplicate their entire database into their CRM.
    */
    const links = await query('SELECT COUNT(*) AS n FROM integration_links')
    ok(Number(links[0]?.n) === 1, 'but the id mapping survives, so reconnecting resumes')

    const after = await (await call('/api/integrations', {}, session)).json()
    ok(after.integration?.connected === false, 'and the console reports it disconnected')
  }

  /* --- GoHighLevel being down is not a stored failure --------------------- */
  {
    mockMode = 'down'
    const res = await call(
      '/api/integrations/ghl',
      { method: 'POST', body: JSON.stringify({ token: GOOD_TOKEN, locationId: LOCATION }) },
      session,
    )
    ok(res.status === 502, `an outage while connecting is a gateway error, not a bad token (${res.status})`)
    const rows = await query('SELECT COUNT(*) AS n FROM client_integrations')
    ok(Number(rows[0]?.n) === 0, 'and nothing half-connected was left behind')
    mockMode = 'ok'
  }
} finally {
  await stop().catch(() => {})
  await new Promise((r) => ghl.close(r))
  rmSync(resolve(api, '.wrangler/integrations-smoke.toml'), { force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(
  fails.length ? `\n${fails.length} integration check(s) failed` : '\n=== integrations OK ===',
)
process.exit(fails.length ? 1 : 0)
