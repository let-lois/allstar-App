import { startOfDayIn, rangeStart, startOfToday } from './day'
import type { Property } from '../types'

/**
 * When a lead was last knocked, as a filter.
 *
 * One module for the three screens that ask it — the map, the rep's leads list
 * and the console — because the alternative is three implementations of "the
 * last 7 days" that drift. This codebase has already paid for that lesson twice
 * over: the day boundary and the point-in-polygon test are each duplicated
 * deliberately and each has a parity gate holding them together. A third
 * duplication with no gate is just a bug waiting for the clocks to change.
 *
 * ## The boundary is the company's, not the device's and not UTC
 *
 * "Visited today" has to mean the same day the rep's own numbers are counted
 * on. Cut in UTC, a crew in Texas knocking after six in the evening has those
 * doors land in tomorrow — so a rep filtering to "Today" at eight would see an
 * empty screen over a board that says fourteen. Cut on the device, two phones in
 * different zones disagree with each other and with the server. So every window
 * below is computed from the company's calendar, through the same helpers the
 * reporting uses.
 *
 * ## Why the windows are these windows
 *
 * They are the questions a door-to-door team actually asks, and no others:
 *
 *   - **Never** — virgin doors. The bulk of a new import.
 *   - **Today** — what has been done since this morning, which is the number a
 *     rep is working against.
 *   - **7 days** / **30 days** — recent enough that what was said still holds.
 *   - **Over 30 days** — going stale. The one window that is a *lower* bound,
 *     and the reason this is not simply a date picker: "not touched in a month"
 *     is a work queue, and no range of dates expresses it as a rep would say it.
 */

export type VisitedWindow = 'any' | 'never' | 'today' | 'd7' | 'd30' | 'stale'

export const VISITED_WINDOWS: { key: VisitedWindow; label: string }[] = [
  { key: 'any', label: 'Any time' },
  { key: 'never', label: 'Never knocked' },
  { key: 'today', label: 'Today' },
  { key: 'd7', label: 'Last 7 days' },
  { key: 'd30', label: 'Last 30 days' },
  { key: 'stale', label: 'Over 30 days ago' },
]

/**
 * Does this lead's last visit fall in the window?
 *
 * `now` is a parameter rather than read inside, so the gate can ask about a
 * fixed afternoon instead of whenever it happens to run — a test for "today"
 * that races midnight is a test that fails once a day for reasons nobody can
 * reproduce.
 */
export function matchesVisited(
  property: Pick<Property, 'lastVisitAt'>,
  window: VisitedWindow,
  tz?: string | null,
  now: number = Date.now(),
): boolean {
  if (window === 'any') return true
  const at = property.lastVisitAt
  // Never knocked is the one window that is about the absence, and every other
  // window has to exclude it: a door nobody has been to is not "over 30 days
  // ago", it is a different fact entirely.
  if (!at) return window === 'never'
  if (window === 'never') return false

  if (window === 'today') return at >= startOfToday(tz, now)
  if (window === 'd7') return at >= startOfDayIn(rangeStart(7, tz, now), tz)
  if (window === 'd30') return at >= startOfDayIn(rangeStart(30, tz, now), tz)
  // Stale is the complement of the 30-day window rather than its own
  // arithmetic, so the two can never overlap or leave a gap between them.
  return at < startOfDayIn(rangeStart(30, tz, now), tz)
}

/**
 * Assigned to whom.
 *
 * `unassigned` is a real answer and not the absence of one: a lead on nobody's
 * phone is invisible to every rep, which is a job for a manager rather than a
 * filter nobody can express. The console already had this; it is here so the
 * rep-facing list and the map ask it the same way.
 */
export type RepFilter = string // 'all' | 'unassigned' | a user id

export function matchesRep(property: Pick<Property, 'assignedRepId'>, rep: RepFilter): boolean {
  if (rep === 'all') return true
  if (rep === 'unassigned') return !property.assignedRepId
  return property.assignedRepId === rep
}
