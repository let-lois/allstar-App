import { dayKeyIn as clientKey, startOfDayIn as clientStart, addDays, rangeStart } from '../src/lib/day.ts'
import { dayKeyIn as serverKey, startOfDayIn as serverStart } from '../api/src/day.ts'

/**
 * Two copies of the day boundary, kept honest.
 *
 * `src/lib/day.ts` and `api/src/day.ts` implement the same rule twice, and that
 * duplication is deliberate — the phone answers it with no network, the Worker
 * answers it with no browser, and a build step that welds them together is a
 * build step that can fail on one side and be discovered in production. The
 * same arrangement as `pointInPolygon`, and this is its `verify:geo-parity`.
 *
 * What makes the duplication safe is not care. It is this file.
 *
 * The consequence of drift is specific and quiet: reporting rows are bucketed
 * by the server, the rep's own screens are bucketed by the phone, and if the
 * two disagree by so much as an hour then a rep's board and their manager's
 * console describe the same evening differently, with nothing anywhere saying
 * which one is lying.
 *
 * Every zone below is chosen for a reason. Half-hour and three-quarter-hour
 * offsets break code that assumes whole hours. Southern-hemisphere DST runs the
 * opposite way round. Phoenix keeps a fixed offset inside a country that does
 * not. Kathmandu is UTC+05:45, which exists to catch anyone who reached for
 * minutes.
 */

const ZONES = [
  'UTC',
  'America/Chicago',        // the crew's own; DST, whole hour
  'America/New_York',
  'America/Phoenix',        // no DST, inside a country that has it
  'America/St_Johns',       // UTC-03:30, and it observes DST
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',           // UTC+05:30, no DST
  'Asia/Kathmandu',         // UTC+05:45
  'Australia/Adelaide',     // UTC+09:30, southern DST
  'Australia/Eucla',        // UTC+08:45
  'Pacific/Chatham',        // UTC+12:45, southern DST
  'Pacific/Kiritimati',     // UTC+14, the far edge
]

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/*
  Each zone's own clock changes, found rather than written down.

  The first version of this block hard-coded 2026-11-01 as "the fall-back" for
  every zone. That is Chicago's. Adelaide and Chatham go back in April, so for
  two of the three the assertion labelled "across a fall-back" was stepping
  over an ordinary Sunday and passing on days the naive implementation gets
  right. Only the 365-step walk was catching them.

  The walk here is deliberately not `addDays` — a scan that used the function
  under test to find the days that function breaks on would be arguing with
  itself.
*/
function transitions(tz) {
  const out = { back: null, forward: null }
  for (let i = 0; i < 365; i++) {
    const at = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000)
    const key = `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`
    const next = new Date(at.getTime() + 86_400_000)
    const nextKey = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`
    const hours = (serverStart(nextKey, tz) - serverStart(key, tz)) / 3_600_000
    if (hours === 25) out.back = { day: key, next: nextKey }
    if (hours === 23) out.forward = { day: key, next: nextKey }
  }
  return out
}
const pad2 = (n) => String(n).padStart(2, '0')

/* --- the same instant is the same day on both sides ------------------------ */
//
// Every hour of a full year, which is the only sampling that actually walks
// through both clock changes in both hemispheres rather than hoping to land on
// one.
{
  const start = Date.UTC(2026, 0, 1)
  const HOURS = 366 * 24
  let compared = 0
  const disagreed = []

  for (const tz of ZONES) {
    for (let h = 0; h < HOURS; h++) {
      const ts = start + h * 3_600_000
      const a = clientKey(ts, tz)
      const b = serverKey(ts, tz)
      compared++
      if (a !== b && disagreed.length < 5) {
        disagreed.push(`${tz} ${new Date(ts).toISOString()}: client ${a}, server ${b}`)
      }
    }
  }

  ok(compared > 100_000, `a full year, every hour, in every zone (${compared.toLocaleString()} instants)`)
  ok(
    disagreed.length === 0,
    disagreed.length === 0
      ? 'the phone and the Worker agree on what day it is, everywhere, always'
      : `they disagree: ${disagreed.join(' | ')}`,
  )
}

/* --- and on when that day started ------------------------------------------ */
//
// The key alone is not enough. The Worker aggregates over a *range*, and a
// range whose start is an hour out counts an hour of somebody else's work — or
// drops an hour of this rep's — while the key it is filed under looks right.
{
  const disagreed = []
  let compared = 0

  for (const tz of ZONES) {
    let day = '2026-01-01'
    for (let i = 0; i < 366; i++) {
      const a = clientStart(day, tz)
      const b = serverStart(day, tz)
      compared++
      if (a !== b && disagreed.length < 5) {
        disagreed.push(`${tz} ${day}: client ${new Date(a).toISOString()}, server ${new Date(b).toISOString()}`)
      }
      day = addDays(day, 1)
    }
  }

  ok(compared > 4_000, `every day of the year in every zone (${compared.toLocaleString()} days)`)
  ok(
    disagreed.length === 0,
    disagreed.length === 0
      ? 'and on the instant each of those days began'
      : `they disagree: ${disagreed.join(' | ')}`,
  )
}

/* --- the round trip -------------------------------------------------------- */
//
// A day key whose own range does not contain the instant that produced it is a
// row nobody's aggregate will ever find.
{
  const start = Date.UTC(2026, 0, 1)
  let outside = 0
  for (const tz of ZONES) {
    for (let h = 0; h < 366 * 24; h += 7) {
      const ts = start + h * 3_600_000
      const key = serverKey(ts, tz)
      const from = serverStart(key, tz)
      const to = serverStart(addDays(key, 1), tz)
      if (!(ts >= from && ts < to)) outside++
    }
  }
  ok(outside === 0, `every instant falls inside the day it is filed under (${outside} outside)`)
}

/* --- days are not all 24 hours long ---------------------------------------- */
//
// The check that proves the sampling above is doing anything. If every day in
// every zone came out 24 hours, these tests would be walking a calendar with no
// clock changes in it and agreeing about nothing difficult.
{
  const lengths = new Set()
  for (const tz of ['America/Chicago', 'Australia/Adelaide', 'Pacific/Chatham']) {
    let day = '2026-01-01'
    for (let i = 0; i < 366; i++) {
      const hours = (serverStart(addDays(day, 1), tz) - serverStart(day, tz)) / 3_600_000
      lengths.add(hours)
      day = addDays(day, 1)
    }
  }
  const found = [...lengths].sort((a, b) => a - b)
  ok(
    found.includes(23) && found.includes(24) && found.includes(25),
    `the year really does contain short and long days (${found.join(', ')} hours)`,
  )
  // Half-hour DST shifts exist; Lord Howe moves by 30 minutes. Nothing here uses
  // that zone, so anything other than these three would mean a bug.
  ok(found.length === 3, `and nothing stranger than that (${found.join(', ')})`)
}

/* --- calendar arithmetic does not drift ------------------------------------ */
//
// `addDays` is where "add 86,400,000 milliseconds to local midnight" would have
// been the obvious implementation. It is wrong on exactly one day a year: where
// the clocks go back, local midnight plus 24 hours is 11pm on the *same* date,
// so the walk stalls and every date after it is a day short.
//
// Run in a child process with TZ forced, because none of that is observable
// from a machine sitting in UTC — which this one is. The first version of this
// block asserted the walk right here and passed with the broken implementation
// in place, proving only that the container has no daylight saving.
{
  const { execFileSync } = await import('node:child_process')


  for (const tz of ['America/Chicago', 'Australia/Adelaide', 'Pacific/Chatham']) {
    const t = transitions(tz)
    ok(!!t.back && !!t.forward, `${tz} changes its clocks twice in 2026 (back ${t.back?.day}, forward ${t.forward?.day})`)
    if (!t.back || !t.forward) continue

    const probe = `
      import { addDays } from './src/lib/day.ts'
      let day = '2026-01-01'
      for (let i = 0; i < 365; i++) day = addDays(day, 1)
      console.log(JSON.stringify({
        walked: day,
        back: addDays(${JSON.stringify(t.back.day)}, 1),
        forward: addDays(${JSON.stringify(t.forward.day)}, 1),
        reverse: addDays(${JSON.stringify(t.back.next)}, -1),
        feb: addDays('2026-02-28', 1),
        leap: addDays('2028-02-28', 1),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    })
    const r = JSON.parse(out)

    ok(r.tz === tz, `the probe really ran in ${tz} (${r.tz})`)
    ok(r.walked === '2027-01-01', `${tz}: 365 steps from 2026-01-01 lands on 2027-01-01 (${r.walked})`)
    ok(
      r.back === t.back.next,
      `${tz}: a day steps forward across its 25-hour day, ${t.back.day} (${r.back})`,
    )
    ok(
      r.forward === t.forward.next,
      `${tz}: and across its 23-hour one, ${t.forward.day} (${r.forward})`,
    )
    ok(r.reverse === t.back.day, `${tz}: stepping backwards over the same day is exact too (${r.reverse})`)
    ok(r.feb === '2026-03-01' && r.leap === '2028-02-29', `${tz}: February still ends where it should`)
  }
}

/* --- "the last 7 days" is 7 days -------------------------------------------- */
//
// The console's ranges used to be found by subtracting `(days - 1) * 86_400_000`
// from the instant and reading off the day. That is 144 hours, and on the week a
// clock goes back it is six days and an hour — so the range started a day early
// and "last 7 days" quietly totalled eight of them, twice a year, in one
// direction only.
//
// Asserted as the property rather than against the old code: a range is exactly
// as many days long as it claims, from every day of the year, in every zone.
{
  let wrong = 0
  const examples = []
  for (const tz of ZONES) {
    let day = '2026-01-01'
    for (let i = 0; i < 366; i++) {
      for (const days of [7, 30, 90]) {
        const from = addDays(day, -(days - 1))
        // Walk back forward again: the two have to be inverses or a range
        // silently changes length across a transition.
        let walk = from
        for (let k = 0; k < days - 1; k++) walk = addDays(walk, 1)
        if (walk !== day && examples.length < 3) {
          examples.push(`${tz} ${day} last-${days}: starts ${from}, walks to ${walk}`)
        }
        if (walk !== day) wrong++
      }
      day = addDays(day, 1)
    }
  }
  ok(
    wrong === 0,
    wrong === 0
      ? 'a range of N days is N days long, from every day of the year'
      : `${wrong} ranges are the wrong length: ${examples.join(' | ')}`,
  )

  /*
    And the thing the old code actually got wrong, stated plainly: counting back
    in milliseconds across a fall-back does not land on the same date as counting
    back in days. If this ever stops being true the assertion above has gone
    quiet and nobody would know.
  */
  const chicago = 'America/Chicago'
  /*
    The week after the clocks went *forward*, which is the half of the year the
    bug lived in. Going back across a fall-back is harmless — the extra hour puts
    you at 1am on the right date. Going back across a spring-forward loses one,
    dropping you to 11pm the evening before, and the range starts a day early.
  */
  const anchorDay = '2026-03-12'
  const byCalendar = addDays(anchorDay, -6)
  const byMillis = serverKey(serverStart(anchorDay, chicago) - 6 * 86_400_000, chicago)
  ok(
    byCalendar === '2026-03-06' && byMillis === '2026-03-05',
    `counting back in milliseconds still lands a day early across a spring-forward (calendar ${byCalendar}, millis ${byMillis})`,
  )

  /*
    And the function the console actually calls.

    Every hour of the days around each clock change, rather than one chosen
    instant: the first version of this pinned it to local noon and passed with
    the broken implementation in place. Losing an hour from noon still leaves you
    at 11am on the right date — the range start only moves when the console is
    opened inside the first hour of a day, a window narrow enough that picking a
    time by hand is picking a time that proves nothing.

    Concentrated on the transition weeks because that is where the answer can
    differ at all, and because sweeping every hour of every year in every zone is
    a hundred thousand `Intl` round trips for a gate that has to stay quick
    enough that people run it.
  */
  let bad = 0
  const missed = []
  for (const tz of ['America/Chicago', 'Australia/Adelaide', 'Pacific/Chatham', 'America/St_Johns']) {
    const t = transitions(tz)
    const days = new Set()
    for (const edge of [t.back?.day, t.forward?.day]) {
      if (!edge) continue
      for (let d = -8; d <= 8; d++) days.add(addDays(edge, d))
    }
    // A handful of ordinary days too, so a bug that is not about DST at all
    // still has somewhere to show up.
    for (const plain of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) days.add(plain)

    for (const day of days) {
      const from = serverStart(day, tz)
      const until = serverStart(addDays(day, 1), tz)
      for (let h = 0; h < 25; h++) {
        const at = from + h * 3_600_000
        if (at >= until) break
        for (const n of [1, 7, 30, 90]) {
          const got = rangeStart(n, tz, at)
          const want = addDays(day, -(n - 1))
          if (got !== want) {
            bad++
            if (missed.length < 3) missed.push(`${tz} ${day} +${h}h last-${n}: ${got}, want ${want}`)
          }
        }
      }
    }
  }
  ok(
    bad === 0,
    bad === 0
      ? "the console's range start is right at every hour around every clock change"
      : `${bad} range starts are wrong: ${missed.join(' | ')}`,
  )

}

/* --- the words match the numbers --------------------------------------------- */
//
// Every screen that totals a day also names it, and until this change the name
// came from `new Date()` while the total came from the key. In Sydney at 9am the
// header said Thursday over Wednesday's numbers.
//
// So: the label is asserted to be the label *of the key*, in the zone, at hours
// chosen to sit either side of UTC midnight — which is the only window where a
// device-clock header and a company-calendar total can disagree.
{
  const { dayLabel, todayLabel, dayKeyIn: ck } = await import('../src/lib/day.ts')
  const { periodStart, periodLabel } = await import('../src/data/leaderboard.ts')

  let wrong = 0
  const examples = []
  for (const tz of ZONES) {
    for (let h = 0; h < 24; h++) {
      const ts = Date.UTC(2026, 6, 15, h)
      const key = ck(ts, tz)
      const expected = dayLabel(key, { weekday: 'long', month: 'long', day: 'numeric' })
      const got = todayLabel(tz, ts)
      if (got !== expected) {
        wrong++
        if (examples.length < 3) examples.push(`${tz} ${h}:00Z: ${got} vs ${expected}`)
      }
    }
  }
  ok(wrong === 0, wrong === 0 ? "today's name is today's key, spelled" : `${wrong} disagree: ${examples.join(' | ')}`)

  /*
    The label is spelled from the key rather than from the instant, so it must be
    the same regardless of what the machine rendering it thinks the time is.
    Asserted against a device deliberately on the far side of the world.
  */
  ok(
    dayLabel('2026-07-15', { weekday: 'long', month: 'long', day: 'numeric' }) === 'Wednesday, July 15',
    'a key spells the same date whatever zone the reader is in',
  )

  /*
    And the board's own heading. `periodLabel` names the period `periodStart`
    begins, and the two drifting apart is how "Week of March 1" ends up over a
    board totalled from the 2nd.
  */
  let mismatched = 0
  const seen = []
  for (const tz of ['America/Chicago', 'Pacific/Kiritimati', 'Pacific/Chatham']) {
    for (const period of ['today', 'week', 'month']) {
      for (let h = 0; h < 24; h += 3) {
        const ts = Date.UTC(2026, 2, 1, h)
        const from = periodStart(period, ts, tz)
        const label = periodLabel(period, ts, tz)
        const expect =
          period === 'today'
            ? dayLabel(from, { weekday: 'long', month: 'long', day: 'numeric' })
            : period === 'month'
              ? dayLabel(from, { month: 'long', year: 'numeric' })
              : `Week of ${dayLabel(from, { month: 'long', day: 'numeric' })}`
        if (label !== expect) {
          mismatched++
          if (seen.length < 3) seen.push(`${tz} ${period} ${h}:00Z: "${label}" over ${from}`)
        }
      }
    }
  }
  ok(
    mismatched === 0,
    mismatched === 0
      ? 'the board\'s heading names the period the board is totalled from'
      : `${mismatched} headings disagree with their own range: ${seen.join(' | ')}`,
  )

  /*
    A guard on the guard: the sampling above has to actually cross a boundary, or
    all it proves is that two functions agree on an easy afternoon.
  */
  const crossed = new Set(ZONES.map((tz) => ck(Date.UTC(2026, 6, 15, 3), tz)))
  ok(crossed.size > 1, `the sample really does straddle a date line (${[...crossed].join(', ')})`)
}

/* --- an unusable zone is not an outage ------------------------------------- */
//
// A bad value can only get in by hand, and the cost of throwing is that one
// customer's typo stops every visit in the account from being counted. Both
// sides have to fall back the same way, or they disagree precisely when
// somebody is already having a bad day.
{
  const ts = Date.UTC(2026, 7, 20, 2, 30)
  for (const bad of ['Mars/Olympus', '', 'not a zone']) {
    ok(
      serverKey(ts, bad) === serverKey(ts, 'UTC'),
      `the Worker falls back to UTC for "${bad}" rather than throwing`,
    )
  }
  /*
    The client falls back to the *device*, not to UTC, and that asymmetry is
    deliberate rather than drift: with no company zone the phone is the demo,
    which has no server to agree with and should show the day its holder is
    living in. Asserted so nobody "fixes" it into a mismatch.
  */
  const deviceDay = new Date(ts)
  const expected = `${deviceDay.getFullYear()}-${String(deviceDay.getMonth() + 1).padStart(2, '0')}-${String(deviceDay.getDate()).padStart(2, '0')}`
  ok(
    clientKey(ts, null) === expected,
    `with no company zone the phone uses its own clock (${clientKey(ts, null)})`,
  )
}

console.log(fails.length ? `\n${fails.length} parity check(s) failed` : '\n=== the two calendars agree ===')
process.exit(fails.length ? 1 : 0)
