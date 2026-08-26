import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The money figure on the console — against a real Worker and a real database.
 *
 * The bug this pins: `pipeline_value` was written by a query with no date bound
 * on it, so every day's row held the rep's *career* total. The console sums
 * that column across a window, which turned one sale into that sale times
 * days-worked. Two sales on two days is the smallest arrangement that tells the
 * difference between "money closed that day" and "everything ever won", and it
 * is the shape this file is built around.
 *
 * A live Worker rather than a unit test, because the thing being asserted is
 * SQL against real rows — the aggregate, the join to properties, and the day
 * boundary. None of that survives being mocked.
 *
 * It also runs the backfill script end to end, since a recompute that is never
 * exercised is a recovery procedure nobody has tested.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8803)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-money-pepper'
const STATE = resolve(api, '.wrangler/money-smoke-state')
const CONFIG = resolve(api, '.wrangler/money-smoke.toml')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

/* --- lifecycle ------------------------------------------------------------- */

let child = null

function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  mkdirSync(dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return CONFIG
}

async function start() {
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev', '-c', CONFIG,
      '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
      '--persist-to', STATE, '--log-level', 'warn',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
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
  throw new Error(`something is still listening on ${BASE}`)
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

/**
 * Talk to the same database the Worker is using.
 *
 * Only ever with the server stopped — reads included.
 *
 * Two processes holding the same SQLite file take the Worker down mid-request,
 * and it surfaces as an opaque "other side closed" on a mutation that was
 * perfectly well formed. That happened twice while writing this file: once on a
 * write, and again on what was only a read.
 *
 * So everything that can be read through the API is, which is better anyway —
 * `/api/bootstrap` is the path the client actually uses, so asserting on it
 * covers the read mapping as well as the stored value.
 */
function d1(command) {
  const out = execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '-c', CONFIG,
     '--command', command],
    { cwd: api, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? []
}

function applySchema() {
  execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE,
     '--file', './schema.sql', '-c', CONFIG, '-y'],
    { cwd: api, stdio: 'ignore' },
  )
}

/* --- two sales, two days --------------------------------------------------- */

const stamp = Date.now()
const OWNER = { email: `money-${stamp}@example.com`, password: 'correct-horse-battery-77' }

/*
  Two recent days, at UTC noon.

  Noon so the day a visit lands on is never in doubt whatever the clock says on
  the machine running this. Recent because /api/bootstrap only returns the last
  stretch of reporting history — the first version of this file used fixed dates
  in July, the rows were written correctly and the bootstrap returned an empty
  list, and six assertions failed for a reason that had nothing to do with money.
*/
const utcMidnight = Math.floor(Date.now() / 86_400_000) * 86_400_000
const DAY_A = utcMidnight - 3 * 86_400_000 + 12 * 3_600_000
const DAY_B = utcMidnight - 1 * 86_400_000 + 12 * 3_600_000
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

const VALUE_A = 12_000
const VALUE_B = 8_000

try {
  rmSync(STATE, { recursive: true, force: true })
  writeConfig()

  await start()
  applySchema()
  await stop()
  const health = await start()
  ok(health.config?.migrations?.state !== 'failed', 'the database is ready')

  const setup = await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner',
      email: OWNER.email, password: OWNER.password,
    }),
  })
  const setupHtml = await setup.text()
  ok(!/error|incorrect|at least/i.test(setupHtml), 'first-run setup raised no error')

  const login = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  const session = login.token
  ok(!!session, 'the owner can sign in')

  // From the sign-in response rather than the database — no reason to reach
  // past the API for something it just told us.
  const clientId = login.user?.clientId
  const repId = login.user?.id
  ok(!!clientId && !!repId, `there is an account to work against (${repId})`)

  /*
    Two properties, each carrying the money a sale on it is worth. The value
    lives on the property rather than the visit, which is why the fixed query
    has to join — and why getting that join wrong is silent rather than loud.

    Written with the server stopped. See the note on d1().
  */
  await stop()
  for (const [id, value] of [['p_a', VALUE_A], ['p_b', VALUE_B]]) {
    d1(`INSERT INTO properties (id, client_id, address1, lat, lng, status, score,
          opportunity_value, assigned_rep_id, updated_at)
        VALUES ('${id}','${clientId}','${id} Cedar Bend Dr',30.51,-97.67,'working',60,
          ${value},'${repId}',${stamp})`)
  }
  await start()

  const sell = async (propertyId, at, n) => {
    const visitId = `v_${propertyId}_${n}`
    await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [
          { id: `m_start_${visitId}`, kind: 'visit.start', createdAt: at,
            payload: { id: visitId, propertyId, startedAt: at } },
          { id: `m_done_${visitId}`, kind: 'visit.complete', createdAt: at,
            payload: { id: visitId, propertyId, startedAt: at, endedAt: at, outcome: 'sold' } },
        ],
      }),
    }, session)
  }

  await sell('p_a', DAY_A, 1)
  await sell('p_b', DAY_B, 2)

  /** The reporting rows as the client receives them. */
  const stats = async () => {
    const boot = await (await call('/api/bootstrap', {}, session)).json()
    return (boot.dailyStats ?? []).slice().sort((a, b) => a.day.localeCompare(b.day))
  }

  const rows = (await stats()).map((r) => ({ day: r.day, sold: r.sold, v: r.closedValue }))
  console.log('  rows:', JSON.stringify(rows))

  const rowA = rows.find((r) => r.day === dayKey(DAY_A))
  const rowB = rows.find((r) => r.day === dayKey(DAY_B))
  ok(!!rowA && !!rowB, `both days have a row (${rows.length})`)

  /* --- the assertion the whole file exists for --------------------------- */
  //
  // The old query answered "everything this rep has ever won" on both rows, so
  // the second day read 20,000 and the sum across the window read 32,000 for
  // 20,000 of actual business.
  ok(Number(rowA?.v) === VALUE_A, `the first day holds that day's money (${rowA?.v} vs ${VALUE_A})`)
  ok(
    Number(rowB?.v) === VALUE_B,
    `and the second holds its own, not the running total (${rowB?.v} vs ${VALUE_B}, not ${VALUE_A + VALUE_B})`,
  )

  const summed = rows.reduce((s, r) => s + Number(r.v), 0)
  ok(
    summed === VALUE_A + VALUE_B,
    `so summing the column across the window is the real figure (${summed} vs ${VALUE_A + VALUE_B})`,
  )

  /* --- a bad day does not zero the money --------------------------------- */
  //
  // The other half of the old bug: the write was gated on the triggering
  // visit's outcome and the last write of the day won, so a day that ended on a
  // no-answer stored 0 for money that had genuinely been closed.
  await call('/api/mutations', {
    method: 'POST',
    body: JSON.stringify({
      mutations: [
        { id: `m_start_miss`, kind: 'visit.start', createdAt: DAY_A + 3_600_000,
          payload: { id: 'v_miss', propertyId: 'p_a', startedAt: DAY_A + 3_600_000 } },
        { id: `m_done_miss`, kind: 'visit.complete', createdAt: DAY_A + 3_600_000,
          payload: { id: 'v_miss', propertyId: 'p_a', startedAt: DAY_A + 3_600_000,
                     endedAt: DAY_A + 3_600_000, outcome: 'no_answer' } },
      ],
    }),
  }, session)

  const afterMiss = (await stats()).find((r) => r.day === dayKey(DAY_A))
  ok(
    Number(afterMiss?.closedValue) === VALUE_A,
    `a door that went badly does not erase the day's money (${afterMiss?.closedValue})`,
  )
  ok(Number(afterMiss?.knocks) === 2, `though it is still counted as a knock (${afterMiss?.knocks})`)

  /* --- the backfill ------------------------------------------------------- */
  //
  // Run against rows deliberately corrupted the way the old code corrupted
  // them: the career total on every row. A recompute that is never exercised is
  // a recovery procedure nobody has tested.
  {
    const lifetime = VALUE_A + VALUE_B
    // Everything in this block writes — the corruption, and the script itself.
    await stop()
    d1(`UPDATE daily_stats SET pipeline_value = ${lifetime}`)
    const broken = d1(`SELECT SUM(pipeline_value) AS s FROM daily_stats`)
    ok(Number(broken[0]?.s) === lifetime * 2, `rows corrupted the old way (${broken[0]?.s})`)

    const run = (extra) =>
      execFileSync(
        process.execPath,
        [resolve(api, 'scripts/rebuild-closed-value.mjs'), '--local',
         '--persist-to', STATE, ...extra],
        { cwd: api, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )

    const dry = run([])
    ok(/dry run/i.test(dry), 'the backfill is a dry run by default')
    ok(/Nothing was written/i.test(dry), 'and says so plainly')
    const stillBroken = d1(`SELECT SUM(pipeline_value) AS s FROM daily_stats`)
    ok(Number(stillBroken[0]?.s) === lifetime * 2, 'a dry run really does write nothing')
    ok(/2\.0x overstated|overstated/.test(dry), 'it reports how far off the figure was')

    const applied = run(['--apply'])
    ok(/0 row\(s\) still disagree/.test(applied), 'applying it leaves nothing disagreeing')

    const fixed = d1(`SELECT day, pipeline_value AS v FROM daily_stats ORDER BY day`)
    ok(
      Number(fixed.find((r) => r.day === dayKey(DAY_A))?.v) === VALUE_A &&
        Number(fixed.find((r) => r.day === dayKey(DAY_B))?.v) === VALUE_B,
      `history is rebuilt to the real per-day figures (${JSON.stringify(fixed.map((r) => r.v))})`,
    )

    // Idempotent: running it again is a no-op, not a second correction.
    const again = run(['--apply'])
    ok(/Already correct/.test(again), 'and running it twice changes nothing further')
    await start()
  }

  /* --- what the client is told -------------------------------------------- */
  {
    const boot = await (await call('/api/bootstrap', {}, session)).json()
    const stat = boot.dailyStats?.find((s) => s.day === dayKey(DAY_B))
    ok(stat?.closedValue === VALUE_B, `the wire calls it closedValue (${stat?.closedValue})`)
    ok(
      !JSON.stringify(boot.dailyStats ?? []).includes('pipelineValue'),
      'and no longer calls it pipelineValue, which it never was',
    )
    ok(
      boot.dailyStats?.every((r) => typeof r.closedValue === 'number'),
      'on every row, so the console never reads undefined',
    )
  }
} finally {
  await stop().catch(() => {})
  rmSync(CONFIG, { force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} money check(s) failed` : '\n=== closed value OK ===')
process.exit(fails.length ? 1 : 0)
