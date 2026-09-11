import { ago, backupState, size, STALE_HOURS } from '../src/lib/backupState.ts'

/**
 * What the console says about backups, and when it says the alarming thing.
 *
 * The server half of this is gated in `smoke:backup`, against a real Worker with
 * a real R2: the endpoint reports what is in the bucket, and refuses everyone
 * but a super admin. This is the other half — the ranking of five situations
 * that all look like `backupKey: true` from `/api/health`, and one threshold.
 *
 * Both are the kind of thing that goes wrong without anybody noticing, which is
 * the failure this whole feature exists to end, so they are asserted directly
 * rather than inferred from a screenshot. No browser: the decision is a pure
 * function, deliberately, and a gate that had to boot Chromium to check a
 * threshold would be a gate nobody ran.
 *
 * `now` is passed in rather than read, so nothing here depends on the clock.
 */

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0)
const hoursAgo = (h) => NOW - h * 3_600_000
const evidence = (latest, extra = {}) => ({
  kind: 'evidence',
  data: { configured: true, seen: latest ? 1 : 0, scanCapped: false, latest, ...extra },
})

/* --- the happy path ------------------------------------------------------- */
{
  const s = backupState(evidence({ key: 'allstar-db-x.sql.enc', bytes: 2_200_000, uploadedAt: hoursAgo(9) }), NOW)
  ok(s.tone === 'good', 'a backup from this morning reads as good', s.tone)
  ok(/9 hours ago/.test(s.headline), 'and says how long ago, not just that it exists', s.headline)
  ok(/2\.1 MB/.test(s.detail), 'with a size, so a dump that collapses overnight is visible', s.detail)
  ok(/allstar-db-x/.test(s.detail), 'and the object name, so it can be found in the bucket')
}

/* --- the whole reason this exists ----------------------------------------- */
//
// Configured, and the bucket is empty. `/api/health` reports `backupKey: true`
// in exactly this state and has done for as long as it has existed. If this
// ranks below the happy path, or reads as anything other than bad, the feature
// has reproduced the bug it was built to fix.
{
  const s = backupState(evidence(undefined), NOW)
  ok(s.tone === 'bad', 'configured with an empty bucket is BAD, not "configured"', s.tone)
  ok(/bucket is empty/i.test(s.headline), 'and says so plainly', s.headline)
  ok(
    /not running|failing before the upload/i.test(s.detail),
    'and names the two things it can be, so somebody knows where to look',
  )
}

/* --- the threshold -------------------------------------------------------- */
//
// Checked on both sides of the line and at it. A nightly job is allowed to be
// a few hours late — a run at 07:17 read at 06:00 the next day is 22.7 hours
// old and fine. Past 36 hours it has missed a whole night.
{
  const at = (h) => backupState(evidence({ key: 'k', bytes: 1_000_000, uploadedAt: hoursAgo(h) }), NOW)

  /*
    Absolute hours, not `STALE_HOURS ± 1`.

    The first version of this block was written relative to the constant, which
    made it unfalsifiable: setting STALE_HOURS to 100000 moved the test cases
    with it and three of these still passed. An assertion expressed in terms of
    the thing it is pinning cannot pin it. So the numbers are written out, and
    the constant itself is bounded separately — 24 hours would alarm on a job
    that ran four hours late, and a week would stay quiet through six missed
    nights.
  */
  ok(STALE_HOURS > 24 && STALE_HOURS <= 48, 'the threshold is longer than a day and shorter than two', `${STALE_HOURS}h`)
  ok(at(23).tone === 'good', '23h old is good — the nightly job has not missed anything')
  ok(at(30).tone === 'good', '30h old is good — a late run is not a failure')
  ok(at(60).tone === 'warn', '60h old warns: a whole night went by with no backup')
  ok(at(24 * 7).tone === 'warn', 'and a week old certainly does')
  ok(
    /at least one night was missed/.test(at(48).headline),
    'and says what it means — a missed night, not "stale"',
    at(48).headline,
  )
  ok(at(24 * 19).tone === 'warn' && /19 days ago/.test(at(24 * 19).headline), 'nineteen days reads as days', at(24 * 19).headline)
}

/* --- not configured at all ------------------------------------------------ */
{
  const s = backupState(
    { kind: 'evidence', data: { configured: false, reason: 'No BACKUP_KEY is set.', seen: 0, scanCapped: false } },
    NOW,
  )
  ok(s.tone === 'bad', 'an unconfigured deployment is bad')
  ok(/No BACKUP_KEY is set\./.test(s.detail), "and repeats the server's own reason rather than guessing one", s.detail)
}

/* --- the two states that are nobody's fault ------------------------------- */
{
  const demo = backupState({ kind: 'demo' }, NOW)
  ok(demo.tone === 'mute', 'the demo is not an alarm — there is no server database to back up', demo.tone)
  ok(!/bucket is empty|No backups/i.test(demo.headline), 'and is not accused of having lost its backups')

  const none = backupState({ kind: 'no-session' }, NOW)
  ok(none.tone === 'mute', 'nor is "not signed in" reported as a broken backup', none.tone)

  const err = backupState({ kind: 'error', message: 'Network request failed.' }, NOW)
  ok(err.tone === 'bad', 'a bucket that cannot be read is bad — unknown is not good')
  ok(
    !/bucket is empty/i.test(err.headline),
    'but is not reported as an empty bucket, which is a different and worse claim',
    err.headline,
  )
}

/* --- the units ------------------------------------------------------------ */
{
  ok(ago(0.25) === '15 min ago', 'under an hour reads in minutes', ago(0.25))
  ok(ago(0.001) === '1 min ago', 'and never rounds down to "0 min ago"', ago(0.001))
  ok(ago(47) === '47 hours ago' && ago(49) === '2 days ago', 'hours give way to days at two days', `${ago(47)} / ${ago(49)}`)
  ok(size(2048) === '2 KB' && size(5_242_880) === '5.0 MB', 'sizes read in KB then MB', `${size(2048)} / ${size(5_242_880)}`)
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the console tells the truth about backups ===')
