/**
 * What day a moment belongs to, for a company.
 *
 * The reporting table is bucketed by day, and until now the server cut those
 * days in UTC while every phone cut them in its own local time. For a crew in
 * Texas that put every door knocked after 6 or 7pm into *tomorrow's* row: the
 * rep's own board counted the evening as today, the manager's console counted
 * it as tomorrow, and the two disagreed about the same evening's work. Nobody
 * saw an error, because there wasn't one — just two answers to "which day is
 * this".
 *
 * A day is now a property of the company rather than of a server in Virginia or
 * a phone in a truck. Every client carries an IANA timezone, and everything
 * that buckets by day asks for it.
 *
 * **Why not the device's timezone.** It is right for the rep and wrong for the
 * company: a manager in one place looking at a rep in another needs both of
 * them counted the same way, and a rep who drives across a state line should
 * not start a new reporting day at lunchtime.
 *
 * **Why not UTC.** It is defensible only if nobody works evenings, which is the
 * opposite of this business.
 */

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in the zone and reading the wall-clock
 * numbers back — there is no direct API for it. Works on Workers and in a
 * browser; both carry full ICU.
 */
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

/**
 * An unknown or malformed zone must not take reporting down.
 *
 * A bad value can only get in by hand, and the cost of throwing is that one
 * customer's typo stops every visit in the account from being counted. UTC is
 * the old behaviour — wrong for evenings, but a known wrong rather than an
 * outage — so it is what a bad zone falls back to.
 */
export function isValidZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return true
  } catch {
    return false
  }
}

export const DEFAULT_TZ = 'UTC'

function safe(tz: string | null | undefined): string {
  return tz && isValidZone(tz) ? tz : DEFAULT_TZ
}

/** `YYYY-MM-DD` for the instant, as the company's calendar reads it. */
export function dayKeyIn(ts: number, tz: string | null | undefined): string {
  const zone = safe(tz)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts))
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${at('year')}-${at('month')}-${at('day')}`
}

/**
 * The instant a `YYYY-MM-DD` begins in the company's timezone.
 *
 * Two passes, and the second is not optional. The first guess uses the offset
 * in force at UTC midnight, which is the wrong offset whenever the zone's
 * clocks changed between then and local midnight — a day that would land an
 * hour out twice a year, quietly, in whichever direction DST moved.
 *
 * On the spring-forward day local midnight exists everywhere DST is observed at
 * 2am, so the ordinary case is safe. A zone that shifts *at* midnight has an
 * hour that does not exist; this lands on the instant the day actually starts,
 * which is the useful answer even if it is not literally 00:00.
 */
export function startOfDayIn(day: string, tz: string | null | undefined): number {
  const zone = safe(tz)
  const guess = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(guess)) throw new Error(`not a day: ${day}`)
  const first = guess - offsetMs(guess, zone)
  return guess - offsetMs(first, zone)
}

/**
 * The half-open range `[start, end)` covering a day in the company's timezone.
 *
 * Computed from the next day's start rather than by adding 24 hours, because a
 * day with a DST change in it is 23 or 25 hours long. Adding a fixed day would
 * drop an hour of work on one date a year and double-count an hour on another.
 */
export function dayRangeIn(day: string, tz: string | null | undefined): [number, number] {
  const start = startOfDayIn(day, tz)
  const next = dayKeyIn(start + 36 * 3_600_000, tz)
  return [start, startOfDayIn(next, tz)]
}
