import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Rebuild the whole reporting table from the visits that produced it.
 *
 * Two reasons to reach for this, and they are the same operation:
 *
 *   **A company set its timezone.** Reporting days used to be cut in UTC.
 *   Existing rows were bucketed on that calendar and stay there — changing the
 *   setting deliberately does not rewrite history behind somebody's back. This
 *   is how they opt into having it rewritten, once, knowingly.
 *
 *   **The money column is wrong.** `rebuild-closed-value.mjs` fixes that column
 *   in place and leaves the day buckets alone, which is the right tool when the
 *   calendar has not moved. When it has, every column moves with it, and fixing
 *   one column against the old buckets would leave the row internally
 *   inconsistent.
 *
 * `visits` is the record of what actually happened and no bug has touched it,
 * so every row here is derivable exactly. Nothing is invented.
 *
 *   node scripts/rebuild-daily-stats.mjs --local
 *   node scripts/rebuild-daily-stats.mjs --local --apply
 *   node scripts/rebuild-daily-stats.mjs                  # production, dry run
 *   node scripts/rebuild-daily-stats.mjs --apply
 *
 * **Dry by default**, and this one deletes rows when applied, so read the
 * summary first. Take a backup: `npm run backup`, proved by `npm run
 * verify:restore`.
 *
 * A rep with no visits at all on a day gets no row, which is what the old
 * writer did too — the table has always been "days something happened".
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const wrangler = resolve(api, 'node_modules/.bin/wrangler')
const DB = 'allstar-db'

const args = process.argv.slice(2)
const local = args.includes('--local')
const apply = args.includes('--apply')
const persistIdx = args.indexOf('--persist-to')
const persistTo = persistIdx >= 0 ? args[persistIdx + 1] : null

function sql(command) {
  const flags = ['d1', 'execute', DB, local ? '--local' : '--remote', '--json', '--command', command]
  if (persistTo) flags.push('--persist-to', persistTo)
  const out = execFileSync(wrangler, flags, {
    cwd: api,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? []
}

/*
  Bucketing happens here in JS rather than in SQL.

  SQLite can shift a timestamp by a fixed offset, but a timezone is not a fixed
  offset — it is a rule with clock changes in it, and a query that pretends
  otherwise is wrong on two days a year in whichever direction DST moved. The
  same module the Worker uses does it properly, so the buckets this writes and
  the buckets the Worker writes tomorrow are the same buckets.
*/
const { dayKeyIn } = await import('../src/day.ts')

console.log(`${local ? 'local' : 'PRODUCTION'} database, ${apply ? 'APPLYING' : 'dry run'}\n`)

const clients = sql(`SELECT id, name, timezone FROM clients ORDER BY name`)
if (clients.length === 0) {
  console.log('No clients. Nothing to do.')
  process.exit(0)
}

const visits = sql(`
  SELECT v.client_id, v.rep_id, v.ended_at, v.outcome,
         COALESCE(p.opportunity_value, 0) AS value
    FROM visits v
    LEFT JOIN properties p ON p.id = v.property_id
   WHERE v.outcome IS NOT NULL AND v.ended_at IS NOT NULL
`)

const GOOD = new Set(['interested', 'appointment', 'quote_requested', 'sold'])
const tzOf = new Map(clients.map((c) => [c.id, c.timezone || 'UTC']))

/** rep:day -> the row it should be. */
const want = new Map()
for (const v of visits) {
  const day = dayKeyIn(Number(v.ended_at), tzOf.get(v.client_id))
  const key = `${v.rep_id}:${day}`
  let row = want.get(key)
  if (!row) {
    row = {
      id: key, client_id: v.client_id, rep_id: v.rep_id, day,
      knocks: 0, conversations: 0, appointments: 0, quotes: 0, sold: 0, value: 0,
    }
    want.set(key, row)
  }
  row.knocks += 1
  if (GOOD.has(v.outcome)) row.conversations += 1
  if (v.outcome === 'appointment') row.appointments += 1
  if (v.outcome === 'quote_requested') row.quotes += 1
  if (v.outcome === 'sold') {
    row.sold += 1
    row.value += Number(v.value)
  }
}

const existing = sql(`
  SELECT id, rep_id, day, knocks, conversations, appointments, quotes, sold,
         pipeline_value AS value
    FROM daily_stats
`)
const have = new Map(existing.map((r) => [r.id, r]))

const same = (a, b) =>
  a && b &&
  Number(a.knocks) === Number(b.knocks) &&
  Number(a.conversations) === Number(b.conversations) &&
  Number(a.appointments) === Number(b.appointments) &&
  Number(a.quotes) === Number(b.quotes) &&
  Number(a.sold) === Number(b.sold) &&
  Number(a.value) === Number(b.value)

const added = [...want.values()].filter((r) => !have.has(r.id))
const removed = existing.filter((r) => !want.has(r.id))
const altered = [...want.values()].filter((r) => have.has(r.id) && !same(r, have.get(r.id)))

for (const c of clients) {
  console.log(`  ${c.name}  —  ${c.timezone || 'UTC'}`)
}
console.log(
  `\n  ${visits.length} visit(s) -> ${want.size} row(s)` +
    `\n  ${existing.length} row(s) today: ${altered.length} changed, ${removed.length} to remove, ${added.length} to add`,
)

const money = (n) => `$${Number(n).toLocaleString('en-US')}`
for (const r of altered.slice(0, 15)) {
  const was = have.get(r.id)
  console.log(
    `    ${r.day}  ${String(r.rep_id).padEnd(14)}` +
      `  knocks ${was.knocks}->${r.knocks}` +
      `  money ${money(was.value)}->${money(r.value)}`,
  )
}
if (altered.length > 15) console.log(`    … and ${altered.length - 15} more`)
for (const r of removed.slice(0, 10)) {
  console.log(`    ${r.day}  ${String(r.rep_id).padEnd(14)}  REMOVED (no visits on that day)`)
}

if (!apply) {
  console.log('\nDry run. Nothing was written. Re-run with --apply to write it.')
  process.exit(0)
}
if (!altered.length && !removed.length && !added.length) {
  console.log('\nAlready correct. Nothing written.')
  process.exit(0)
}

/*
  Delete then insert, rather than upsert.

  Re-bucketing moves work between days, so a row that should no longer exist has
  to actually go — an upsert would leave yesterday's orphan sitting there
  claiming knocks that have been counted again under today.
*/
const esc = (v) => `'${String(v).replace(/'/g, "''")}'`
sql('DELETE FROM daily_stats')

const rows = [...want.values()]
for (let i = 0; i < rows.length; i += 200) {
  const chunk = rows.slice(i, i + 200)
  sql(
    `INSERT INTO daily_stats
       (id, client_id, rep_id, day, knocks, conversations, appointments, quotes, sold, pipeline_value)
     VALUES ` +
      chunk
        .map(
          (r) =>
            `(${esc(r.id)},${esc(r.client_id)},${esc(r.rep_id)},${esc(r.day)},` +
            `${r.knocks},${r.conversations},${r.appointments},${r.quotes},${r.sold},${r.value})`,
        )
        .join(','),
  )
}

const after = sql(`SELECT COUNT(*) AS n FROM daily_stats`)
console.log(`\nRebuilt ${rows.length} row(s). Table now holds ${after[0]?.n}.`)
process.exit(Number(after[0]?.n) === rows.length ? 0 : 1)
