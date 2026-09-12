/**
 * What day a moment belongs to, on the company's calendar.
 *
 * A deliberate duplicate of `api/src/day.ts`, kept in step by `verify:day-parity`
 * rather than by a shared package. The same arrangement as `pointInPolygon` in
 * `lib/geo.ts` and `api/src/geo.ts`, and for the same reason: the phone has to
 * answer this with no network, the Worker has to answer it with no browser, and
 * a build step that welds the two together is a build step that can fail on one
 * side and be discovered in production. Two copies and a test that they agree
 * is the cheaper honesty.
 *
 * The rule this exists to enforce: a reporting day belongs to the company, not
 * to the device holding the screen. A rep who drives across a state line should
 * not start a new day at lunchtime, and a manager comparing two reps needs both
 * counted the same way.
 *
 * **When there is no company zone**, every function here falls back to the
 * device's own clock. That is not a compromise — it is right for the demo,
 * which has no server and no company, and it keeps the seeded day looking like
 * today for whoever opens it.
 *
 * ---
 *
 * **Not everything with a date on it belongs here**, and the difference matters
 * enough to be worth stating, because the two look identical on screen.
 *
 * A *reporting day* is an accounting boundary. Which day a knock counts on, what
 * a board totals, what a header names. It belongs to the company, it has to
 * match what the Worker filed the same row under, and it goes through this
 * module. A rep who drives across a state line does not start a new day at
 * lunchtime.
 *
 * A *wall-clock instant* is a moment two people will both be standing in.
 * "Tomorrow, 10am" said at a door means 10am where the rep and the homeowner
 * are, not 10am at head office; an invite expiry is a deadline for whoever is
 * reading it. Those are rendered in the device's zone deliberately, and
 * `ScheduleNew`, `VisitMode`'s scheduling copy and `AddMemberDialog` are all
 * correct as they stand. Routing them through here would be a regression that
 * looks like a fix.
 *
 * The test is not "is there a date on it" but "would a manager add this up".
 */

/** How far ahead of UTC a zone is at an instant, in milliseconds. */
function offsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts))

  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // `hour12: false` yields 24 for midnight in some ICU versions rather than 0.
  const hour = at('hour') % 24
  const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'))
  return asUtc - Math.floor(ts / 1000) * 1000
}

export function isValidZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return true
  } catch {
    return false
  }
}

/** A usable zone, or null meaning "use this device's clock". */
function zoneOr(tz: string | null | undefined): string | null {
  return tz && isValidZone(tz) ? tz : null
}

export interface Ymd {
  y: number
  m: number
  d: number
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  weekday: number
}

/** The calendar date an instant falls on, as the company reads it. */
export function ymdIn(ts: number, tz?: string | null): Ymd {
  const zone = zoneOr(tz)
  if (!zone) {
    const d = new Date(ts)
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), weekday: d.getDay() }
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ts))
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    y: Number(at('year')),
    m: Number(at('month')),
    d: Number(at('day')),
    weekday: Math.max(0, DAYS.indexOf(at('weekday'))),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function keyOf({ y, m, d }: { y: number; m: number; d: number }): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** `YYYY-MM-DD` for the instant, on the company's calendar. */
export function dayKeyIn(ts: number, tz?: string | null): string {
  return keyOf(ymdIn(ts, tz))
}

/**
 * Step a day key by whole calendar days.
 *
 * Arithmetic on the date rather than on an instant, done in UTC where every day
 * is exactly 24 hours. Subtracting `n * 86_400_000` from a timestamp is the
 * obvious version and it is wrong twice a year: across a clock change it lands
 * an hour either side of midnight and can name the wrong day.
 */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/**
 * The instant a day begins on the company's calendar.
 *
 * Two passes. The offset in force at UTC midnight is the wrong one whenever the
 * clocks changed between then and local midnight, so a single pass lands an
 * hour out on those days, silently, in whichever direction DST moved.
 */
export function startOfDayIn(key: string, tz?: string | null): number {
  const zone = zoneOr(tz)
  if (!zone) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  }
  const guess = Date.parse(`${key}T00:00:00Z`)
  if (Number.isNaN(guess)) throw new Error(`not a day: ${key}`)
  const first = guess - offsetMs(guess, zone)
  return guess - offsetMs(first, zone)
}

/**
 * The half-open range covering a day.
 *
 * From the next day's start rather than by adding 24 hours: a day with a clock
 * change in it is 23 or 25 hours long, and a fixed day drops an hour of work on
 * one date a year and double-counts an hour on another.
 */
export function dayRangeIn(key: string, tz?: string | null): [number, number] {
  return [startOfDayIn(key, tz), startOfDayIn(addDays(key, 1), tz)]
}

/** The instant today began, which is what "since midnight" means to a rep. */
export function startOfToday(tz?: string | null, now: number = Date.now()): number {
  return startOfDayIn(dayKeyIn(now, tz), tz)
}

/**
 * A day key as words.
 *
 * Read back at UTC noon and formatted in UTC. The key is already the answer —
 * all this does is spell it — and routing through a local `Date` to get there is
 * how a date turns back into an instant and drifts a day west of Greenwich.
 * Noon rather than midnight for the same reason, with twelve hours of slack
 * either side of any rounding.
 *
 * This exists so the words on a screen come off the same key as the numbers
 * beside them. A header formatted from `new Date()` is the version that says
 * "Wednesday" over a total the server has already filed under Thursday, which
 * is the one place a boundary bug is visible — and it still gets argued about
 * rather than believed.
 */
export function dayLabel(key: string, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  )
}

/** What today is called, on the company's calendar. */
export function todayLabel(tz?: string | null, now: number = Date.now()): string {
  return dayLabel(dayKeyIn(now, tz), { weekday: 'long', month: 'long', day: 'numeric' })
}

/**
 * The first day key of a range that ends today and is `days` long.
 *
 * Counting today as one of them, so `rangeStart(7)` is six days back — which is
 * what a person means by "the last 7 days" and what the console's range buttons
 * say on the tin.
 *
 * The arithmetic is on the calendar, not on the clock. Subtracting
 * `(days - 1) * 86_400_000` from now is the version this replaced: 144 hours is
 * six days *and an hour* on the week the clocks go forward, which lands a day
 * early and quietly totals eight days under a button labelled seven. Once a
 * year, in one direction, on a figure nobody re-derives by hand.
 */
export function rangeStart(days: number, tz?: string | null, now: number = Date.now()): string {
  return addDays(dayKeyIn(now, tz), -(days - 1))
}
