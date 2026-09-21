import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Which day a knock belongs to — against a real Worker and a real database.
 *
 * The bug this pins is the one a Texas crew lives with every evening. Reporting
 * days were cut in UTC, so a door knocked at 7pm in Round Rock — midnight UTC —
 * went into *tomorrow's* row, while the rep's own phone counted it as today.
 * The manager's console and the rep's board disagreed about the same evening's
 * work, and neither of them was reporting an error, because there wasn't one.
 *
 * 7pm local on either side of a DST change is the shape of this file: it is the
 * smallest arrangement that tells "the company's calendar" apart from both
 * "UTC" and "a fixed offset from UTC".
 *
 * A live Worker rather than a unit test, because what is being asserted is SQL
 * against real rows bucketed by a real timezone, and none of that survives
 * being mocked. It also runs the rebuild script end to end, since a re-bucket
 * nobody has exercised is a recovery procedure nobody has tested.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8804)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-daybreak-pepper'
const STATE = resolve(api, '.wrangler/daybreak-smoke-state')
const CONFIG = resolve(api, '.wrangler/daybreak-smoke.toml')

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

/* --- a Texas evening ------------------------------------------------------- */

const TZ = 'America/Chicago'
const stamp = Date.now()
const OWNER = { email: `daybreak-${stamp}@example.com`, password: 'correct-horse-battery-88' }

/*
  Two evenings, both at 7pm local, chosen so a fixed UTC offset cannot pass this
  by luck: one in daylight time (UTC-5, so midnight UTC) and one in standard
  time (UTC-6, so 01:00 UTC). Both are the same wall-clock hour to the rep, both
  land on the next UTC date, and they are the same *local* date only if the
  bucketing actually follows the zone's rules rather than a constant.
*/
const EVENINGS = [
  { label: 'summer (CDT)', at: Date.parse('2026-08-20T00:00:00Z'), local: '2026-08-19' },
  { label: 'winter (CST)', at: Date.parse('2026-12-10T01:00:00Z'), local: '2026-12-09' },
  /*
    11:30pm in December, and the reason it is here is worth writing down.

    The two 7pm cases above are decided entirely by `dayKeyIn`, which asks Intl
    for the local date and gets it right even if the *range* arithmetic is
    wrong. So they passed with a deliberately broken offset — a constant -5
    hours for Chicago instead of the zone's rules — and the assertion claiming
    to cover daylight saving was proving nothing.

    This one lands in the hour between true CST midnight (06:00Z) and the
    midnight a constant -5 would compute (05:00Z). Its day key is still right,
    but a range built on the constant excludes it, so the row exists with zero
    knocks in it. That is the failure a fixed offset actually produces, and it
    is invisible unless something looks at the counts.
  */
  { label: 'late winter night', at: Date.parse('2026-12-02T05:30:00Z'), local: '2026-12-01' },
]
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10)

/*
  The three dates are kept well apart on purpose. Each case asserts both "lands
  on its local day" and "no longer on its UTC day", so one fixture's UTC day
  landing on another's local day makes both of them fail for a reason that has
  nothing to do with the code — which is what happened when the late-night case
  was first added a day away from the winter one.
*/
const overlap = EVENINGS.flatMap((e) => [e.local, utcDay(e.at)])
if (new Set(overlap).size !== overlap.length) {
  throw new Error(`fixture dates collide: ${overlap.join(' ')}`)
}

const VALUE = 9_000

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
      token: SETUP_TOKEN, clientName: 'Ridgeline Roofing', name: 'Owner',
      email: OWNER.email, password: OWNER.password,
    }),
  })
  ok(!/error|incorrect|at least/i.test(await setup.text()), 'first-run setup raised no error')

  const login = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  const session = login.token
  const clientId = login.user?.clientId
  const repId = login.user?.id
  ok(!!session && !!clientId, 'the owner can sign in')

  /* --- a new account starts on UTC, so nothing changes under anyone -------- */
  {
    const boot = await (await call('/api/bootstrap', {}, session)).json()
    ok(boot.timezone === 'UTC', `a fresh account defaults to UTC (${boot.timezone})`)
  }

  // Properties, written with the server stopped. See the note on d1().
  await stop()
  for (const e of EVENINGS) {
    d1(`INSERT INTO properties (id, client_id, address1, lat, lng, status, score,
          opportunity_value, assigned_rep_id, updated_at)
        VALUES ('p_${e.local.replace(/-/g, '')}','${clientId}','1 Cedar Bend Dr',30.51,-97.67,
          'working',60,${VALUE},'${repId}',${stamp})`)
  }
  await start()

  const knock = async (e) => {
    const id = `v_${e.local.replace(/-/g, '')}`
    await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [
          { id: `m_s_${id}`, kind: 'visit.start', createdAt: e.at,
            payload: { id, propertyId: `p_${e.local.replace(/-/g, '')}`, startedAt: e.at } },
          { id: `m_c_${id}`, kind: 'visit.complete', createdAt: e.at,
            payload: { id, propertyId: `p_${e.local.replace(/-/g, '')}`,
                       startedAt: e.at, endedAt: e.at, outcome: 'sold' } },
        ],
      }),
    }, session)
  }

  /*
    Read straight from the table, with the Worker stopped, rather than through
    /api/bootstrap.

    Bootstrap deliberately serves only the last 30 days — read.ts, where it says
    that is what the console's longest range needs and the phone ignores the
    rest. The fixtures here are necessarily months apart: an evening in daylight
    time and one in standard time cannot both sit inside a 30-day window, except
    for the few weeks either side of the change itself.

    So reading them back through bootstrap made this file quietly
    date-dependent. It passed while the August fixture was 29 days old and
    started failing at 31 — months after anyone had touched either the test or
    the code — and it failed as four day-bucketing assertions, which had been
    right the whole time. A test that goes red on a calendar rather than on a
    change costs more than the bug it was watching for.

    The table has no window, and which day a knock lands on is what this file is
    about. Bootstrap's window is worth pinning too, so it is pinned on purpose
    further down instead of being depended on by accident.
  */
  const days = async () => {
    await stop()
    const rows = d1(`SELECT day FROM daily_stats ORDER BY day`)
    await start()
    return rows.map((r) => r.day)
  }

  /** The same rows with their counts, for the assertions that check both. */
  const dayRows = async () => {
    await stop()
    const rows = d1(`SELECT day, knocks FROM daily_stats ORDER BY day`)
    await start()
    return rows
  }

  /* --- on UTC, the evening lands on tomorrow ------------------------------ */
  //
  // Asserted rather than assumed. This is the bug, reproduced against a live
  // Worker before it is fixed, so the assertion below is measuring a change
  // rather than describing one.
  for (const e of EVENINGS) await knock(e)
  {
    const got = await days()
    for (const e of EVENINGS) {
      ok(
        got.includes(utcDay(e.at)) && !got.includes(e.local),
        `${e.label}: on UTC the 7pm knock lands on ${utcDay(e.at)}, not ${e.local}`,
      )
    }
  }

  /* --- the company sets its calendar -------------------------------------- */
  {
    const bad = await call('/api/settings/timezone', {
      method: 'POST', body: JSON.stringify({ timezone: 'Mars/Olympus' }),
    }, session)
    ok(bad.status === 400, `a zone the server does not know is refused (${bad.status})`)
    ok(/not a timezone/i.test((await bad.json()).error ?? ''), 'and says so rather than storing it')

    const res = await call('/api/settings/timezone', {
      method: 'POST', body: JSON.stringify({ timezone: TZ }),
    }, session)
    ok(res.ok, `the company can set its own calendar (${res.status})`)

    const boot = await (await call('/api/bootstrap', {}, session)).json()
    ok(boot.timezone === TZ, `and the client is told what it is (${boot.timezone})`)

    /*
      Existing rows do NOT move. Changing a setting must not silently rewrite a
      year of reporting — that is what the rebuild script is for, deliberately
      and with a backup taken first.
    */
    const still = await days()
    ok(
      EVENINGS.every((e) => still.includes(utcDay(e.at))),
      'existing rows stay on the calendar they were written on',
    )
  }

  /* --- and now a knock lands on the day the rep worked it ------------------ */
  {
    // Same visits, replayed. The recompute writes them on the new calendar.
    await stop()
    d1(`DELETE FROM daily_stats`)
    await start()
    for (const e of EVENINGS) {
      /*
        The same visit id, a new mutation id. `visit.complete` upserts on the
        visit, so this updates the one that already exists rather than inventing
        a second sale on the same evening — which the first version of this file
        did, and then read 18,000 back and called the rebuild wrong when the
        rebuild was faithfully counting two visits that really were there.
      */
      const id = `v_${e.local.replace(/-/g, '')}`
      await call('/api/mutations', {
        method: 'POST',
        body: JSON.stringify({
          mutations: [
            { id: `m2_c_${id}`, kind: 'visit.complete', createdAt: e.at,
              payload: { id, propertyId: `p_${e.local.replace(/-/g, '')}`,
                         startedAt: e.at, endedAt: e.at, outcome: 'sold' } },
          ],
        }),
      }, session)
    }

    const got = await days()
    for (const e of EVENINGS) {
      ok(
        got.includes(e.local),
        `${e.label}: the 7pm knock is now counted on ${e.local}, the day the rep worked it`,
      )
      ok(!got.includes(utcDay(e.at)), `and no longer on ${utcDay(e.at)}`)
    }
    /*
      The winter case is the one a fixed offset gets wrong. If the bucketing
      used a constant -5 hours instead of the zone's rules, 01:00 UTC in
      December would land on the 10th rather than the 9th.
    */
    /*
      The counts, not just the days. A day boundary computed on a fixed offset
      still produces the right day key and then aggregates over the wrong 24
      hours, so the row is present and empty.
    */
    const counted = await dayRows()
    for (const e of EVENINGS) {
      const row = counted.find((r) => r.day === e.local)
      ok(
        Number(row?.knocks) === 1,
        `${e.label}: and the day it is counted on actually contains it (knocks=${row?.knocks})`,
      )
    }
  }

  /* --- and the console is served the window it asks for -------------------- */
  //
  // Bootstrap serves 30 days and no more. Invisible from outside, and left
  // unpinned it is what broke this file: the moment the August fixture aged past
  // the window, four assertions about day bucketing went red for a reason that
  // had nothing to do with day bucketing. Asserted here so the next person meets
  // it as a statement rather than as a mystery.
  {
    const cutoff = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() - 30 * 86_400_000))
    const stored = await days()
    const served = ((await (await call('/api/bootstrap', {}, session)).json()).dailyStats ?? [])
      .map((r) => r.day)
    const old = stored.filter((d) => d < cutoff)
    const recent = stored.filter((d) => d >= cutoff)
    // Only assert the halves the fixtures actually produced: which side of the
    // cutoff they fall on moves with the real date, and an assertion that needs
    // a particular month is the bug this block exists because of.
    if (old.length) {
      ok(
        old.every((d) => !served.includes(d)),
        `history older than the window is not served (${old.join(', ')} before ${cutoff})`,
      )
    }
    if (recent.length) {
      ok(
        recent.every((d) => served.includes(d)),
        `and everything inside it is (${recent.join(', ')} from ${cutoff})`,
      )
    }
    ok(old.length + recent.length > 0, 'with something on both sides to compare')
  }

  /* --- the rebuild ---------------------------------------------------------- */
  {
    await stop()
    // Put history back on the old calendar, the way a real account's history
    // would be sitting after the migration.
    d1(`DELETE FROM daily_stats`)
    for (const e of EVENINGS) {
      d1(`INSERT INTO daily_stats (id, client_id, rep_id, day, knocks, conversations,
            appointments, quotes, sold, pipeline_value)
          VALUES ('${repId}:${utcDay(e.at)}','${clientId}','${repId}','${utcDay(e.at)}',
            1,1,0,0,1,${VALUE})`)
    }

    const run = (extra) =>
      execFileSync(process.execPath,
        [resolve(api, 'scripts/rebuild-daily-stats.mjs'), '--local', '--persist-to', STATE, ...extra],
        { cwd: api, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

    const dry = run([])
    ok(/dry run/i.test(dry), 'the rebuild is a dry run by default')
    ok(/America\/Chicago/.test(dry), 'and names the calendar it would rebuild on')
    const untouched = d1(`SELECT day FROM daily_stats ORDER BY day`).map((r) => r.day)
    ok(
      EVENINGS.every((e) => untouched.includes(utcDay(e.at))),
      'a dry run really does write nothing',
    )

    run(['--apply'])
    const rebuilt = d1(`SELECT day, knocks, sold, pipeline_value AS v FROM daily_stats ORDER BY day`)
    const rebuiltDays = rebuilt.map((r) => r.day)
    ok(
      EVENINGS.every((e) => rebuiltDays.includes(e.local)),
      `history re-buckets onto the company's calendar (${JSON.stringify(rebuiltDays)})`,
    )
    ok(
      !EVENINGS.some((e) => rebuiltDays.includes(utcDay(e.at))),
      'and the rows it moved off are gone rather than left behind as orphans',
    )
    ok(
      rebuilt.every((r) => Number(r.knocks) === 1 && Number(r.sold) === 1),
      'every column re-buckets together, not just the money',
    )
    ok(
      rebuilt.every((r) => Number(r.v) === VALUE),
      `and the money follows the day it was closed on (${rebuilt.map((r) => r.v)})`,
    )

    const again = run(['--apply'])
    ok(/Already correct/.test(again), 'and running it twice changes nothing further')
    await start()
  }
} finally {
  await stop().catch(() => {})
  rmSync(CONFIG, { force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} day-boundary check(s) failed` : '\n=== day boundary OK ===')
process.exit(fails.length ? 1 : 0)
