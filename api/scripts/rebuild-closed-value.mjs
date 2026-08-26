import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Rebuild the money figure on every existing daily_stats row.
 *
 * `pipeline_value` was written by a query with no date bound on it: "what has
 * this rep won, ever", stamped onto a row that is scoped to one day. Every
 * day's row therefore held the rep's career total, and the console sums that
 * column across a window — turning one $10k sale into roughly $10k times
 * days-worked. It was also wrapped in a check on the triggering visit's
 * outcome, so a day whose last logged door went badly stored 0 instead. Not a
 * cumulative series with a known correction; noise that skewed high.
 *
 * This is a recompute, not a guess. `visits` was never touched by the bug and
 * is the real record of what happened, so the correct figure for every past day
 * is derivable exactly. Nothing here invents a number.
 *
 *   node scripts/rebuild-closed-value.mjs --local          # the dev database
 *   node scripts/rebuild-closed-value.mjs --local --apply
 *   node scripts/rebuild-closed-value.mjs                  # production, dry run
 *   node scripts/rebuild-closed-value.mjs --apply
 *
 * **Dry by default.** It prints what would change and writes nothing until
 * `--apply`. A one-off script that rewrites a production column on the strength
 * of being run is a script somebody runs by accident.
 *
 * One caveat worth knowing before you run it. `opportunity_value` lives on the
 * property and is editable, so a recompute uses today's value rather than the
 * value at the time of sale. On old rows that is a small distortion, and the
 * honest fix — stamping the amount onto the visit when the sale is logged — is
 * a schema change that has to happen before it can help history. What this
 * cannot do is be more wrong than a lifetime total summed across thirty days.
 *
 * Take a backup first. `npm run backup` exists and `npm run verify:restore`
 * proves it works.
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
  const flags = [
    'd1', 'execute', DB,
    local ? '--local' : '--remote',
    '--json',
    '--command', command,
  ]
  if (persistTo) flags.push('--persist-to', persistTo)
  const out = execFileSync(wrangler, flags, {
    cwd: api,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // wrangler prints a banner before the JSON.
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  return parsed[0]?.results ?? []
}

/*
  The correct figure for a row, expressed once.

  The day boundary is UTC because that is how the rows were bucketed when they
  were written — `dayKey` in the Worker uses getUTC*. Recomputing on any other
  boundary would move money between days that every other column in the row
  still counts the old way, which would be a second bug dressed as a fix. When
  the day boundary itself is corrected, every column re-buckets together.
*/
const CORRECT = `
  SELECT COALESCE(SUM(p.opportunity_value), 0)
    FROM visits v
    JOIN properties p ON p.id = v.property_id
   WHERE v.rep_id = d.rep_id
     AND v.outcome = 'sold'
     AND v.ended_at >= CAST(strftime('%s', d.day || ' 00:00:00') AS INTEGER) * 1000
     AND v.ended_at <  CAST(strftime('%s', d.day || ' 00:00:00') AS INTEGER) * 1000 + 86400000
`

console.log(`${local ? 'local' : 'PRODUCTION'} database, ${apply ? 'APPLYING' : 'dry run'}\n`)

const rows = sql(`
  SELECT d.id, d.rep_id, d.day, d.sold, d.pipeline_value AS was, (${CORRECT}) AS should
    FROM daily_stats d
   ORDER BY d.day
`)

if (rows.length === 0) {
  console.log('No daily_stats rows. Nothing to do.')
  process.exit(0)
}

const changed = rows.filter((r) => Number(r.was) !== Number(r.should))
const money = (n) => `$${Number(n).toLocaleString('en-US')}`

console.log(`${rows.length} row(s), ${changed.length} would change\n`)

for (const r of changed.slice(0, 20)) {
  console.log(
    `  ${r.day}  ${String(r.rep_id).padEnd(14)} ${String(r.sold)} sold   ` +
      `${money(r.was).padStart(12)} -> ${money(r.should).padStart(12)}`,
  )
}
if (changed.length > 20) console.log(`  … and ${changed.length - 20} more`)

/*
  The headline, because it is the number on the console that was wrong. Summing
  the column across every row is exactly what `useRangeTotals` does, so this is
  the figure a manager was being shown against the figure they should have been.
*/
const wasTotal = rows.reduce((s, r) => s + Number(r.was), 0)
const shouldTotal = rows.reduce((s, r) => s + Number(r.should), 0)
console.log(
  `\n  summed across every row: ${money(wasTotal)} -> ${money(shouldTotal)}` +
    (wasTotal > 0 ? `  (${(wasTotal / Math.max(shouldTotal, 1)).toFixed(1)}x overstated)` : ''),
)

if (!apply) {
  console.log('\nDry run. Nothing was written. Re-run with --apply to write it.')
  process.exit(0)
}

if (changed.length === 0) {
  console.log('\nAlready correct. Nothing written.')
  process.exit(0)
}

/*
  One statement rather than a row at a time. The correlated subquery is the same
  expression the dry run reported, so what gets written is what was shown —
  rather than a second implementation that could disagree with it.
*/
sql(`UPDATE daily_stats AS d SET pipeline_value = (${CORRECT})`)

const after = sql(`
  SELECT COUNT(*) AS n FROM daily_stats d WHERE d.pipeline_value <> (${CORRECT})
`)
const left = Number(after[0]?.n ?? -1)
console.log(`\nWrote ${changed.length} row(s). ${left} row(s) still disagree.`)
process.exit(left === 0 ? 0 : 1)
