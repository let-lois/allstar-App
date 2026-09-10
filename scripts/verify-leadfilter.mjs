import {
  activeFilterCount,
  DEFAULT_MAP_FILTER,
  UNFILTERED_MAP,
  matchesMapFilter,
  matchesVisited,
  VISITED_WINDOWS,
} from '../src/lib/leadFilter.ts'
import { STATUS_LABEL } from '../src/data/outcomes.ts'
import { startOfDayIn, dayKeyIn, rangeStart } from '../src/lib/day.ts'

/**
 * "When was this door last knocked", as arithmetic.
 *
 * Pure, and deliberately not a browser test. What can go wrong here is not
 * whether a chip renders — it is whether "the last 7 days" is seven days, on
 * whose calendar, and whether the windows leave a gap between them. None of
 * that needs a DOM, and all of it is invisible in one: a rep filtering to
 * "Today" at eight in the evening and seeing an empty screen looks exactly like
 * a rep who has not knocked anything.
 *
 * The three failures this exists to catch, each of which has already happened
 * once in this codebase under a different name:
 *
 *   **The wrong calendar.** Cut in UTC, a Texas crew's evening doors land in
 *   tomorrow. Cut on the device, two phones disagree with each other and with
 *   the server. Both were real bugs here — `verify:day-parity` and the
 *   reporting-day work exist because of them — and this is the same boundary
 *   asked a third way.
 *
 *   **Subtracting hours instead of days.** `now - 6 * 86_400_000` is six days
 *   *and an hour* on the week the clocks go forward, which quietly totals eight
 *   days under a filter labelled seven. Once a year, in one direction.
 *
 *   **A gap or an overlap between windows.** If "last 30 days" and "over 30 days
 *   ago" are computed separately they will eventually disagree about one
 *   instant, and a lead will appear in both or in neither. Asserted as a
 *   property over a sweep of timestamps rather than at a couple of points.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const DAY = 86_400_000

/*
  Zones chosen for what each one breaks. Chicago is the crew's own and observes
  DST; Phoenix does not, inside a country that does; Kathmandu is UTC+05:45,
  which catches anyone who reached for whole hours; Chatham is UTC+12:45 and
  southern, so its DST runs the other way.
*/
const ZONES = ['UTC', 'America/Chicago', 'America/Phoenix', 'Asia/Kathmandu', 'Pacific/Chatham']

/** A fixed afternoon. A test for "today" that races midnight fails once a day. */
const NOW = Date.parse('2026-06-15T18:30:00Z')

const at = (ts) => ({ lastVisitAt: ts })

/* --- never is about the absence, and nothing else claims it -------------- */
{
  const nothing = { lastVisitAt: undefined }
  ok(matchesVisited(nothing, 'never'), 'a door never knocked matches "never"')
  ok(matchesVisited(nothing, 'any'), 'and matches "any time", which excludes nothing')
  const wrongly = VISITED_WINDOWS.filter(
    (w) => w.key !== 'never' && w.key !== 'any' && matchesVisited(nothing, w.key),
  ).map((w) => w.key)
  ok(
    wrongly.length === 0,
    'and no dated window claims it — an unknocked door is not "over 30 days ago"',
    wrongly.join(', ') || 'none',
  )
  ok(
    !matchesVisited(at(NOW - DAY), 'never'),
    'while a door that was knocked never matches "never"',
  )
}

/* --- today is the company's day, not this machine's and not UTC ---------- */
/*
  The decisive pair, and getting it right took two goes.

  At 22:00 Chicago time on the 15th, UTC has already rolled over to the 16th.
  So a door knocked that same Chicago morning is *today* on the company's
  calendar and *yesterday* in UTC — which is precisely the rep who has been
  knocking since breakfast, opens the filter after dinner, and is shown nothing.

  My first attempt at this used 02:00 UTC on the 16th and asserted it was
  yesterday in UTC. It is not: it is the early hours of the 16th, which is today
  in UTC as well, so both zones agreed and the assertion proved nothing about
  the zone. It failed for that reason and is written out here because the shape
  of the mistake — picking an instant that does not actually straddle the two
  boundaries — is the easy one to make twice.
*/
{
  // 07:00 in Chicago on the 15th; 12:00 UTC on the 15th.
  const morning = Date.parse('2026-06-15T12:00:00Z')
  // 22:00 in Chicago on the 15th, by which point UTC is on the 16th.
  const nowThen = Date.parse('2026-06-16T03:00:00Z')
  ok(
    matchesVisited(at(morning), 'today', 'America/Chicago', nowThen),
    'a door knocked this morning still counts as today at ten at night in Chicago',
  )
  ok(
    !matchesVisited(at(morning), 'today', 'UTC', nowThen),
    'and the same instant is already yesterday in UTC — so the zone is doing real work',
  )

  for (const tz of ZONES) {
    const start = startOfDayIn(dayKeyIn(NOW, tz), tz)
    ok(
      matchesVisited(at(start), 'today', tz, NOW) &&
        !matchesVisited(at(start - 1), 'today', tz, NOW),
      `${tz}: the boundary is exact to the millisecond`,
    )
  }
}

/* --- seven days means seven calendar days, counting today ---------------- */
{
  for (const tz of ZONES) {
    const start = startOfDayIn(rangeStart(7, tz, NOW), tz)
    ok(
      matchesVisited(at(start), 'd7', tz, NOW) && !matchesVisited(at(start - 1), 'd7', tz, NOW),
      `${tz}: the 7-day window starts where the 7th day back starts`,
    )
    // Six days back, not seven: "the last 7 days" includes today.
    const spanDays = Math.round((startOfDayIn(dayKeyIn(NOW, tz), tz) - start) / DAY)
    ok(spanDays === 6, `${tz}: which is six midnights back, so today is one of the seven`, `${spanDays}`)
  }
}

/* --- the week the clocks change is still seven days ---------------------- */
//
// The bug this catches is arithmetic in milliseconds. 8 March 2026 is the US
// spring-forward, so a 7-day window ending on the 10th spans 167 hours, not
// 168 — and subtracting 6 * 86_400_000 lands an hour into the wrong day.
{
  const tz = 'America/Chicago'
  const afterSpring = Date.parse('2026-03-10T18:00:00Z')
  const start = startOfDayIn(rangeStart(7, tz, afterSpring), tz)
  const hours = (startOfDayIn(dayKeyIn(afterSpring, tz), tz) - start) / 3_600_000
  ok(
    hours === 143,
    'across spring-forward the six midnights back are 143 hours, not 144 — and the window still lands on a midnight',
    `${hours}h`,
  )
  ok(
    matchesVisited(at(start), 'd7', tz, afterSpring) &&
      !matchesVisited(at(start - 1), 'd7', tz, afterSpring),
    'so a door knocked exactly seven days earlier is in, and a millisecond before is out',
  )
}

/* --- stale and d30 partition the knocked doors exactly ------------------- */
//
// Swept rather than sampled: every one of these instants must be in exactly one
// of the two. A separate calculation for each would eventually put some instant
// in both or in neither, and that lead would vanish from every screen.
{
  for (const tz of ZONES) {
    let both = 0
    let neither = 0
    for (let d = 0; d <= 90; d++) {
      for (const offset of [0, 1, DAY / 2, DAY - 1]) {
        const ts = NOW - d * DAY + offset
        if (ts > NOW) continue
        const recent = matchesVisited(at(ts), 'd30', tz, NOW)
        const stale = matchesVisited(at(ts), 'stale', tz, NOW)
        if (recent && stale) both += 1
        if (!recent && !stale) neither += 1
      }
    }
    ok(
      both === 0 && neither === 0,
      `${tz}: every knocked door is either inside 30 days or over 30 days — never both, never neither`,
      `both=${both} neither=${neither}`,
    )
  }
}

/* --- and a door knocked in the future is not "stale" -------------------- */
//
// A phone with a clock running fast queues a visit stamped ahead of the server.
// It must read as recent rather than falling out of both windows.
{
  const tomorrow = NOW + DAY
  ok(
    matchesVisited(at(tomorrow), 'd30', 'America/Chicago', NOW) &&
      !matchesVisited(at(tomorrow), 'stale', 'America/Chicago', NOW),
    'a visit stamped in the future reads as recent, not stale',
  )
}

/* ==========================================================================
 * What the map shows
 *
 * The other half of this module, and pure for the same reason: what can go
 * wrong is not whether a chip renders but whether Do Not Contact can reach a
 * rep's map without being asked for, and whether two answers can contradict
 * each other into a permanently empty screen. Neither needs a DOM and both are
 * invisible in one.
 * ======================================================================= */
console.log('\n--- the map filter ---')

const lead = (over = {}) => ({ status: 'new', lastVisitAt: undefined, lastOutcome: undefined, ...over })
const shows = (property, over = {}, opts = {}) =>
  matchesMapFilter(property, { ...DEFAULT_MAP_FILTER, ...over }, { onRoute: true, now: NOW, ...opts })

/* --- "everything" has to be sayable ------------------------------------- */
//
// The first draft of this model had no way to say it: an empty status set meant
// "open only", so a rep every one of whose leads was won or lost opened the map
// to nothing and had no control that would widen it. That is not a hypothetical
// — it is the fixture verify:pin-noanswer builds, and it would have failed for
// a real reason.
{
  const closed = ['won', 'lost', 'dnc'].filter(
    (s) => !matchesMapFilter(lead({ status: s }), UNFILTERED_MAP, { onRoute: false, now: NOW }),
  )
  ok(closed.length === 0, 'nothing at all is filtered out under "All"', closed.length ? closed.join(', ') : 'won, lost and dnc all shown')
  ok(activeFilterCount(UNFILTERED_MAP) === 0, 'and "All" reads as no filters on')
}

/* --- the default is open work, and nothing finished --------------------- */
{
  ok(shows(lead({ status: 'new' })), 'by default a new lead is on the map')
  ok(shows(lead({ status: 'follow_up' })), 'and one waiting on a follow-up')
  const closed = ['won', 'lost', 'dnc'].filter((s) => shows(lead({ status: s })))
  ok(closed.length === 0, 'and nothing already finished', closed.length ? closed.join(', ') : 'none of won/lost/dnc')
}

/* --- Do Not Contact only ever by name ----------------------------------- */
//
// The one that matters most. DNC leaking onto a rep's map through a default, a
// widening, or a filter nobody chose is the failure the in-app enforcement
// exists to prevent, and it must be reachable only by asking for it.
{
  ok(!shows(lead({ status: 'dnc' })), 'Do Not Contact is off the map by default')
  ok(
    !shows(lead({ status: 'dnc' }), { status: { kind: 'some', set: ['new', 'contacted'] } }),
    'and stays off under any other status',
  )
  ok(
    shows(lead({ status: 'dnc' }), { status: { kind: 'some', set: ['dnc'] } }),
    'and appears only when asked for by name',
  )
}

/* --- a chosen status is exactly that status ----------------------------- */
{
  const some = (...set) => ({ status: { kind: 'some', set } })
  ok(shows(lead({ status: 'quoted' }), some('quoted')), 'choosing a status shows it')
  ok(!shows(lead({ status: 'working' }), some('quoted')), 'and only it')
  ok(
    shows(lead({ status: 'working' }), some('quoted', 'working')),
    'choosing two shows either — the compound question the old rail could not ask',
  )
  const unreachable = Object.keys(STATUS_LABEL).filter((s) => !shows(lead({ status: s }), some(s)))
  ok(
    unreachable.length === 0,
    'every status the app has can be asked for',
    unreachable.length ? `unreachable: ${unreachable.join(', ')}` : `all ${Object.keys(STATUS_LABEL).length}`,
  )
}

/* --- no combination is empty by construction ---------------------------- */
//
// The bug this shape exists to make unsayable. "Not knocked" and "Today" were
// two chips a divider apart, and picking both asked for a door that had never
// been knocked and was knocked this morning — a guaranteed-empty map with
// nothing on screen saying why. There is now one recency question, so the
// contradiction cannot be expressed.
{
  /*
    Three doors that between them cover the whole timeline — never knocked,
    knocked this morning, knocked forty days ago. The first draft of this used
    only the first two, and `stale` matched neither: the assertion failed on the
    fixture rather than on the code, which is the more useful direction for it
    to fail in but not a claim worth keeping.
  */
  const probes = [lead(), lead({ lastVisitAt: NOW }), lead({ lastVisitAt: NOW - 40 * DAY })]
  const answers = VISITED_WINDOWS.map((w) => w.key)
  const empty = answers.filter((v) => !probes.some((p) => shows(p, { visited: v })))
  ok(
    empty.length === 0,
    'every answer to "when was it last knocked" can match something',
    empty.length ? `empty: ${empty.join(', ')}` : `all ${answers.length} windows`,
  )
  // And the contradiction itself, stated directly: there is no way to ask for a
  // door that has never been knocked *and* was knocked recently, because there
  // is only one place to answer that question.
  ok(
    !shows(lead(), { visited: 'today' }) && !shows(lead({ lastVisitAt: NOW }), { visited: 'never' }),
    'and "never knocked" and "knocked today" are answers to one question, not two filters to combine',
  )
}

/* --- nobody home is an outcome, not a status ---------------------------- */
{
  const missed = lead({ lastOutcome: 'no_answer', lastVisitAt: NOW - DAY })
  const answered = lead({ status: 'working', lastOutcome: 'interested', lastVisitAt: NOW - DAY })
  ok(shows(missed, { noAnswerOnly: true }), 'a door nobody answered is on the nobody-home list')
  ok(!shows(answered, { noAnswerOnly: true }), 'and one that answered is not')
  // The half that is easy to lose: a door that went unanswered and has since
  // been sold is finished, and handing it back as unfinished business is how a
  // rep ends up knocking on a customer's door.
  ok(
    !shows(lead({ status: 'won', lastOutcome: 'no_answer' }), { noAnswerOnly: true }),
    'but one that was missed and later sold is not unfinished business',
  )
}

/* --- the scope is the route, when asked ---------------------------------- */
{
  ok(!shows(lead(), { scope: 'route' }, { onRoute: false }), 'a lead off the route is hidden under "My route"')
  ok(shows(lead(), { scope: 'route' }, { onRoute: true }), 'and one on it is not')
  ok(shows(lead(), { scope: 'all' }, { onRoute: false }), 'while "All" ignores the route entirely')
}

/* --- the number on the button counts questions, not answers ------------- */
{
  ok(activeFilterCount(DEFAULT_MAP_FILTER) === 0, 'an untouched map says no filters are on')
  ok(
    activeFilterCount({
      ...DEFAULT_MAP_FILTER,
      status: { kind: 'some', set: ['new', 'contacted', 'quoted', 'won'] },
    }) === 1,
    'four statuses is one filter, not four — it is one answer to one question',
  )
  ok(
    activeFilterCount({
      ...DEFAULT_MAP_FILTER,
      status: { kind: 'some', set: ['new'] },
      visited: 'd7',
      noAnswerOnly: true,
    }) === 3,
    'three different questions answered is three',
  )
  // Switching scope is not narrowing anything, and a badge on a screen nobody
  // has touched is a badge people learn to ignore.
  ok(
    activeFilterCount({ ...DEFAULT_MAP_FILTER, scope: 'route' }) === 0,
    'and the route scope is not counted — it has its own control in plain sight',
  )
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the windows agree on the calendar, and the map filter cannot contradict itself ===')
