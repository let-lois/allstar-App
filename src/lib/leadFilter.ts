import { startOfDayIn, rangeStart, startOfToday } from './day'
import { isOpenStatus } from '../data/outcomes'
import type { LeadStatus, Property } from '../types'

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

/* ==========================================================================
 * What the map is showing
 * ======================================================================= */

/**
 * The field map's filter, as one value.
 *
 * It replaces a pair of single-select rails that between them held fourteen
 * chips, of which three fitted on a 320px screen. The rails were also mixing
 * four different kinds of question in one scroller — a scope (my route), a
 * visit-recency question (not knocked), a status-subset shorthand (open leads)
 * and four of the nine statuses — which is why they could not be shortened by
 * deleting anything: every chip was the only way to ask something.
 *
 * Worse, the two rails could contradict each other. "Not knocked" is
 * `!lastVisitAt` and it sat one divider away from "Today", which is
 * `lastVisitAt >= this morning`; picking both gave a permanently empty map and
 * a search box reading "Search 0 leads", with nothing on screen saying why. The
 * shape below makes that unsayable — the recency question is asked once, in one
 * place, and "never knocked" is one of its answers.
 *
 * Each field is a different axis and they compose with AND, which is what the
 * old rails did and the one part of them worth keeping: "my route, not knocked
 * in a month" is a real request a rep makes on a Tuesday afternoon.
 */
export interface MapFilter {
  /**
   * Today's planned stops, or everything this rep is allowed to see.
   *
   * Not a status and not in the sheet: it is the question a rep answers when
   * they open the map, so it stays on screen as its own control. It also drives
   * whether the route line is drawn at all, which is why it cannot simply
   * become another status chip.
   */
  scope: 'route' | 'all'
  /**
   * Where the lead stands — three different kinds of answer, so three shapes.
   *
   * `open` is a *rule*, not a set: it means `isOpenStatus`, so a status added
   * to the app later is open until somebody decides otherwise. Spelling it as
   * the six current members instead would silently exclude any tenth status
   * from every rep's default map, which is the failure that is hardest to
   * notice — work disappearing rather than appearing.
   *
   * `any` is the honest "show me everything", closed leads included. The first
   * draft of this had no way to say it: an empty set meant "open only", so a
   * rep whose every lead was won or lost saw an empty map with no way to widen
   * it. That is not hypothetical — it is exactly the fixture `verify:pin-noanswer`
   * builds.
   *
   * `some` is the compound question the old single-select rail could not ask at
   * all: "appointments and quotes", "follow-ups on my route". It never holds an
   * empty list; emptying it returns to `open`.
   */
  status: { kind: 'any' } | { kind: 'open' } | { kind: 'some'; set: LeadStatus[] }
  /** When it was last knocked. One question, one answer, six answers to choose from. */
  visited: VisitedWindow
  /**
   * Only doors where the last knock went unanswered.
   *
   * Its own flag rather than a status, because `no_answer` is the one outcome
   * that deliberately maps to no status — a miss does not change where a lead
   * stands — so it is invisible to any filter written over statuses alone.
   */
  noAnswerOnly: boolean
}

/**
 * No constraint at all — every lead this rep is allowed to see.
 *
 * One constant, used by the "All" chip, by Clear's scope-including cousin and
 * by the widening that runs after a lead is saved. The screen previously had
 * two disagreeing ideas of "unfiltered" — a chip called All and a hand-written
 * list of filter keys in the save path, which had already drifted into testing
 * a key no chip could produce.
 */
export const UNFILTERED_MAP: MapFilter = {
  scope: 'all',
  status: { kind: 'any' },
  visited: 'any',
  noAnswerOnly: false,
}

/**
 * Where the map opens: this rep's open work, on today's route if they have one.
 *
 * `open` rather than `any` because a rep's map is a work queue and won, lost
 * and Do Not Contact are not work — the last of those especially, which must
 * never arrive on a rep's screen except by name.
 */
export const DEFAULT_MAP_FILTER: MapFilter = {
  scope: 'all',
  status: { kind: 'open' },
  visited: 'any',
  noAnswerOnly: false,
}

/**
 * How many narrowing choices are switched on — the number on the Filters button.
 *
 * It counts *questions answered*, not values chosen: picking four statuses is
 * one filter, not four, because it is one answer to "which statuses". A rep
 * reading "Filters (2)" wants to know how many things they have to undo to see
 * everything again, and four is the wrong answer to that question.
 *
 * `scope` is deliberately not counted. It has its own control in plain sight
 * with its state written on it, and counting it would put a "1" on the button
 * for a rep who has changed nothing — the default on a day with a route is
 * "My route", and a badge on an untouched screen teaches people to ignore it.
 */
/**
 * The narrowest widening that will show a lead the current filter is hiding.
 *
 * For the map's own use after a rep saves a house: their pin must not vanish
 * behind the filter that was on when they added it. The obvious move is to
 * reset everything, and it is wrong — `UNFILTERED_MAP` means "any status",
 * which would put every Do Not Contact lead in the territory on a rep's map as
 * a side effect of adding one house. Do Not Contact arrives by name or not at
 * all, and "I added a lead" is not that name.
 *
 * So: back to the default, plus the one status needed if the saved lead is
 * already a closed one. Never `any`.
 */
export function widenToShow(property: Pick<Property, 'status'>): MapFilter {
  return isOpenStatus(property.status)
    ? DEFAULT_MAP_FILTER
    : { ...DEFAULT_MAP_FILTER, status: { kind: 'some', set: [property.status] } }
}

export function activeFilterCount(f: MapFilter): number {
  return (
    (f.status.kind === 'some' ? 1 : 0) + (f.visited !== 'any' ? 1 : 0) + (f.noAnswerOnly ? 1 : 0)
  )
}

/**
 * Does this lead belong on the map right now?
 *
 * `onRoute` is passed in rather than read here because route membership is a
 * property of the day's plan, not of the lead — the map holds the stop ids and
 * this module has no business knowing about routes.
 *
 * The closed rule is the one piece of behaviour worth stating twice, since it
 * is the only place this is not a plain intersection:
 *
 *   Under `open` — the default — leads that are finished stay off the map. That
 *   is what the old "Open leads" chip did, and it was the default for a rep
 *   without a route.
 *
 *   Choosing statuses shows exactly those, closed ones included. Asking for
 *   "Do Not Contact" and being shown nothing would be a worse answer than the
 *   question deserves, and the office needs to see them to fix them.
 *
 * Do Not Contact is therefore never on the map by accident, only by name.
 */
export function matchesMapFilter(
  property: Pick<Property, 'status' | 'lastOutcome' | 'lastVisitAt'>,
  filter: MapFilter,
  opts: { onRoute: boolean; timezone?: string; now?: number },
): boolean {
  if (filter.scope === 'route' && !opts.onRoute) return false
  if (!matchesVisited(property, filter.visited, opts.timezone, opts.now)) return false
  if (filter.noAnswerOnly && property.lastOutcome !== 'no_answer') return false

  if (filter.status.kind === 'any') return true
  if (filter.status.kind === 'some') return filter.status.set.includes(property.status)
  return isOpenStatus(property.status)
}
