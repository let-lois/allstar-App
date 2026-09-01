import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Work that arrived days late onto a lead somebody had since moved.
 *
 * The conflict rule is not what is being tested. Allstar wins, the rep's answer
 * applies, and every case below asserts that it *did* — a flagging mechanism
 * that quietly changed an outcome would be worse than no mechanism at all.
 * What is being tested is whether anybody finds out.
 *
 * The three ways this could pass while doing nothing useful, each given its own
 * control:
 *
 *   - **Flagging everything.** A conflict on every sync is a screen nobody
 *     reads. A same-day mutation onto a lead edited minutes earlier must stay
 *     silent.
 *   - **Flagging lateness alone.** Late is not a collision. A four-day-old
 *     mutation onto a lead nobody touched must stay silent.
 *   - **Self-collision.** A rep's own first mutation bumps the lead's
 *     updated_at, so a naive comparison against the live row flags their second
 *     one — every rep who records two things about one address, accused of
 *     colliding with themselves. This is the failure the whole snapshot design
 *     exists for, and it is the case most likely to regress.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8834)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/stale-state')

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

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
     '--var', 'SESSION_PEPPER:local-stale-pepper',
     '--var', 'INTEGRATION_KEY:local-stale-key-do-not-reuse'],
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
const q = (s) => String(s).replace(/'/g, "''")
const OWNER = { email: `st-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

const DAY = 24 * 60 * 60 * 1000
const FOUR_DAYS_AGO = stamp - 4 * DAY
const FIVE_DAYS_AGO = stamp - 5 * DAY

/** How many conflicts are on file for one lead. */
const conflictsFor = async (p) => n(await query(`SELECT COUNT(*) FROM sync_conflicts WHERE property_id='${p}'`))

let seq = 0
const propertyStatus = (propertyId, createdAt, status) => ({
  id: `m_${stamp}_${seq++}`,
  kind: 'property.status',
  createdAt,
  payload: { id: propertyId, status },
})
const visitComplete = (propertyId, createdAt, outcome) => ({
  id: `m_${stamp}_${seq++}`,
  kind: 'visit.complete',
  createdAt,
  payload: {
    id: `v_${stamp}_${seq}`,
    propertyId,
    outcome,
    startedAt: createdAt,
    endedAt: createdAt,
  },
})

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('stale-smoke.toml')
  await start(config); await applySchema(config); await stop(); await start(config)

  await call('/setup', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
  ok(login.ok, `the owner can sign in (${login.status})`)
  const { token: session, user } = await login.json()
  const clientId = user.clientId

  // Four leads, created the way production creates them.
  const seedRes = await call('/api/import/properties', {
    method: 'POST',
    body: JSON.stringify({
      rows: [
        { ref: '1', address1: '12 Marbury Lane', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
        { ref: '2', address1: '14 Marbury Lane', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
        { ref: '3', address1: '16 Marbury Lane', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
        { ref: '4', address1: '18 Marbury Lane', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
      ],
    }),
  }, session)
  const seeded = await seedRes.json()
  const [COLLIDED, UNTOUCHED, PROMPT, SELF] = seeded.ids ?? []
  ok(seeded.created === 4 && !!SELF, 'four leads exist', `${seeded.created} created`)

  /* ===== 1. the case this was built for ================================= */
  //
  // Rep works the door Monday with no signal. The office moves the lead
  // Wednesday. The phone reconnects Friday.
  {
    // The rep's Monday. Set the lead's updated_at to *after* it, which is the
    // office's Wednesday edit.
    await query(`UPDATE properties SET status='appointment', updated_at=${stamp - 2 * DAY} WHERE id='${COLLIDED}'`)
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitComplete(COLLIDED, FOUR_DAYS_AGO, 'not_interested')] }),
    }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'applied', "the rep's late answer is applied, not held", JSON.stringify(results?.[0]))

    // Allstar wins. This is the assertion that would catch a "fix" that started
    // rejecting or reverting stale work.
    const status = (await query(`SELECT status FROM properties WHERE id='${COLLIDED}'`))[0]?.status
    ok(status === 'lost', 'and it won — the lead carries the rep\'s outcome', `status=${status}`)

    const flagged = await conflictsFor(COLLIDED)
    ok(flagged === 1, 'and somebody was told', `${flagged} conflict(s)`)

    const row = (await query(`SELECT kind, acted_at, changed_at, detail FROM sync_conflicts WHERE property_id='${COLLIDED}'`))[0]
    ok(row?.kind === 'visit.complete', 'the record names what arrived late', row?.kind)
    ok(Number(row?.changed_at) > Number(row?.acted_at),
      'and records that the lead moved after the rep acted',
      `changed_at ${Number(row?.changed_at) - Number(row?.acted_at)}ms after acted_at`)
  }

  /* ===== 2. late, but nothing collided ================================== */
  {
    // Five days old — well past the threshold — but the lead has sat untouched
    // since before the rep acted. Nobody needs telling.
    await query(`UPDATE properties SET updated_at=${stamp - 9 * DAY} WHERE id='${UNTOUCHED}'`)
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitComplete(UNTOUCHED, FIVE_DAYS_AGO, 'interested')] }),
    }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'applied', 'a lead nobody touched still takes the late answer', JSON.stringify(results?.[0]))
    const flagged = await conflictsFor(UNTOUCHED)
    ok(flagged === 0, 'and nothing is flagged — late is not a collision', `${flagged} conflict(s)`)
  }

  /* ===== 3. prompt, and it did collide ================================== */
  {
    // A manager reassigned this ten minutes ago and the rep is closing a visit
    // now. Real, constant, and not worth a manager's attention.
    await query(`UPDATE properties SET updated_at=${stamp - 60_000} WHERE id='${PROMPT}'`)
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [visitComplete(PROMPT, stamp - 600_000, 'sold')] }),
    }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'applied', 'a same-day visit applies', JSON.stringify(results?.[0]))
    const flagged = await conflictsFor(PROMPT)
    ok(flagged === 0, 'and is not flagged, however recently the lead moved', `${flagged} conflict(s)`)
  }

  /* ===== 4. a rep cannot collide with themselves ======================== */
  {
    /*
      Two mutations, one lead, one batch, both days old.

      Both are status changes, and that is not arbitrary. A visit writes the
      lead's updated_at from the rep's own clock, so a batch of visits can never
      look like interference however it is ordered — a version of this case
      built from two visits passes whatever the code does, which is the trap I
      first walked into here. A status change writes Date.now(): the server's
      clock, the one thing in a late batch that can stamp a days-old lead as
      moved-just-now. So after the first one lands, the second is a rep
      colliding with themselves — if you compare against the live row. Compared
      against the snapshot taken before the batch, it is what it actually is:
      one rep, one lead, one afternoon.
    */
    await query(`UPDATE properties SET updated_at=${stamp - 9 * DAY} WHERE id='${SELF}'`)
    const res = await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [
          propertyStatus(SELF, FIVE_DAYS_AGO, 'working'),
          propertyStatus(SELF, FOUR_DAYS_AGO, 'quoted'),
        ],
      }),
    }, session)
    const { results } = await res.json()
    ok(results?.length === 2 && results.every((r) => r.status === 'applied'),
      'both of the rep\'s own late mutations apply', JSON.stringify(results))

    // The control on the control: the first mutation really did stamp the lead
    // as moved-just-now, so a live-row comparison genuinely had something to
    // trip over. Without this, "0 conflicts" could mean the setup never
    // manufactured the trap.
    const moved = n(await query(`SELECT updated_at FROM properties WHERE id='${SELF}'`))
    ok(moved > FOUR_DAYS_AGO,
      "after the rep's own work the lead reads as moved long after they acted",
      `updated_at is ${Math.round((moved - FOUR_DAYS_AGO) / 3_600_000)}h after they acted`)

    const flagged = await conflictsFor(SELF)
    ok(flagged === 0, "and the rep is not accused of colliding with themselves", `${flagged} conflict(s)`)
  }

  /* ===== 5. who may read them =========================================== */
  {
    const anon = await call('/api/sync-conflicts')
    ok(anon.status === 401, 'the list needs a session', `${anon.status}`)

    await query(`UPDATE users SET role='field_rep' WHERE id='${q(user.id)}'`)
    const asRep = await call('/api/sync-conflicts', {}, session)
    ok(asRep.status === 403, 'a field rep may not read them', `${asRep.status}`)

    // A manager may — this is the point of the feature, and the case a
    // copy-pasted admin-only guard would break.
    await query(`UPDATE users SET role='manager' WHERE id='${q(user.id)}'`)
    const asManager = await call('/api/sync-conflicts', {}, session)
    ok(asManager.status === 200, 'a manager may', `${asManager.status}`)
    const { conflicts } = await asManager.json()
    ok(conflicts?.length === 1, 'and sees the one open collision', `${conflicts?.length}`)
    const c = conflicts?.[0]
    ok(c?.address === '12 Marbury Lane', 'named by house, not by id', c?.address)
    ok(c?.repName === 'Owner', 'and by rep, not by id', c?.repName)
    ok(c?.lateByHours >= 95 && c?.lateByHours <= 97, 'with how late it was', `${c?.lateByHours}h`)
  }

  /* ===== 6. another tenant's conflict is not reviewable ================= */
  {
    await query(`INSERT INTO clients (id,name,timezone,created_at) VALUES ('c_rival_${stamp}','Rival','UTC',${stamp})`)
    await query(`INSERT INTO properties (id,client_id,address1,lat,lng,status,score,updated_at)
       VALUES ('p_rival_${stamp}','c_rival_${stamp}','1 Rival Rd',30.5,-97.6,'new',50,${stamp})`)
    await query(`INSERT INTO sync_conflicts (id,client_id,property_id,rep_id,kind,acted_at,arrived_at,changed_at)
       VALUES ('sc_rival_${stamp}','c_rival_${stamp}','p_rival_${stamp}',NULL,'visit.complete',${FOUR_DAYS_AGO},${stamp},${stamp})`)

    const list = await call('/api/sync-conflicts', {}, session)
    const { conflicts } = await list.json()
    ok(!conflicts.some((c) => c.id === `sc_rival_${stamp}`), "another company's collision is not in our list", `${conflicts.length} listed`)

    const res = await call('/api/sync-conflicts/review', {
      method: 'POST', body: JSON.stringify({ id: `sc_rival_${stamp}` }),
    }, session)
    ok(res.status === 404, "and cannot be acknowledged from here", `${res.status}`)
    const theirs = n(await query(`SELECT COUNT(*) FROM sync_conflicts WHERE id='sc_rival_${stamp}' AND reviewed_at IS NULL`))
    ok(theirs === 1, 'with their row left open', `${theirs} still open`)
  }

  /* ===== 7. acknowledging is not deleting =============================== */
  {
    const before = await call('/api/sync-conflicts', {}, session)
    const id = (await before.json()).conflicts[0].id

    const res = await call('/api/sync-conflicts/review', { method: 'POST', body: JSON.stringify({ id }) }, session)
    ok(res.status === 200, 'a manager can mark one as looked at', `${res.status}`)

    const open = (await (await call('/api/sync-conflicts', {}, session)).json()).conflicts
    ok(open.length === 0, 'and it leaves the open list', `${open.length} open`)

    const all = (await (await call('/api/sync-conflicts?all=1', {}, session)).json()).conflicts
    ok(all.length === 1 && all[0].reviewedAt != null,
      'but the record survives, with when it was reviewed',
      `${all.length} on file, reviewedAt=${all[0]?.reviewedAt}`)

    const again = await call('/api/sync-conflicts/review', { method: 'POST', body: JSON.stringify({ id }) }, session)
    ok(again.status === 404, 'reviewing twice is refused rather than restamped', `${again.status}`)
  }

  /* ===== 8. the whole table, counted =================================== */
  //
  // Every case above asserted its own lead. This asserts nothing else got
  // written along the way — a rule that flagged something extra would pass all
  // four cases and still bury the manager.
  {
    const total = n(await query(`SELECT COUNT(*) FROM sync_conflicts WHERE client_id='${q(clientId)}'`))
    ok(total === 1, 'exactly one collision was recorded across the whole run', `${total}`)
  }
} finally {
  await stop()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} stale-sync check(s) failed`)
  process.exit(1)
}
console.log('late work that landed on a moved lead is applied, and recorded')
