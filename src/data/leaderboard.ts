import type { GlyphName } from '../lib/glyphs'
import { addDays, dayKeyIn, dayLabel, keyOf, ymdIn } from '../lib/day'
import type { DailyStat, TeamMember } from '../types'

/**
 * The day's standings.
 *
 * Door-to-door runs on this. A rep who cannot see where they stand at 2pm has
 * no reason to knock the next street, and every sales manager in this industry
 * already keeps the board on a whiteboard — the app either holds it or the
 * whiteboard does.
 *
 * Three rules shape everything below, and they come from what a leaderboard does
 * to people rather than from what is easy to compute.
 *
 * **The scoring is visible.** A ranking nobody can explain breeds suspicion, not
 * effort: the rep in third place needs to know exactly what would move them to
 * second. So the weights are constants with names, they are shown on the screen,
 * and the score is a plain sum anybody can check on their fingers.
 *
 * **Effort counts, not just outcomes.** Ranking on sales alone hands the crown to
 * whoever caught one lucky door and tells the rep who knocked 140 doors for two
 * appointments that their day was worth nothing. It also rewards cherry-picking,
 * which is the behaviour that kills a patch. Doors are worth the least and worth
 * something.
 *
 * **Nobody wins nothing.** At 7am every number is zero, and a crown handed to
 * whoever sorts first alphabetically is worse than no crown — it is visibly
 * arbitrary, and the whole thing loses its authority on day one. Awards are
 * suppressed until there is something to award, and ties are shown as ties
 * rather than broken silently.
 */

/**
 * Who belongs on the board: everybody on the account who is active.
 *
 * This has now been narrowed twice and widened twice, which is worth recording
 * because each version was defensible and only one of them survived contact with
 * a real company.
 *
 * It started as `role === 'field_rep'`, on the reasoning that a column of idle
 * admin rows makes a working team look half-asleep. On a real account that
 * produced a leaderboard with one name on it — in a company this size the owner
 * and the managers knock doors too, and all of them were filtered off their own
 * board.
 *
 * Then it was "reps, plus anyone who knocked today", which fixed the symptom and
 * kept a subtler version of the same mistake: a manager who had not started yet
 * could not see themselves on the board they were being measured on, and a board
 * you appear on only after you perform is not a board, it is a receipt.
 *
 * So it is now everyone active, and the roster is the roster. If a desk admin
 * sits at zero all day, that is a true fact about the day, and it is the
 * company's business rather than the app's. The one-line filter is the place to
 * change it if a bigger client wants their back office off the board.
 */
export function onBoard(team: TeamMember[]): TeamMember[] {
  // Deactivated people are gone, not idle. Leaving a former employee on the
  // board at zero says something about them that is not true.
  return team.filter((m) => m.active)
}

/**
 * What each thing is worth.
 *
 * A sale is worth 25 doors. That ratio is a judgement, not a measurement, and it
 * is the one number here most worth arguing about with an actual sales manager —
 * which is why it is a named constant on its own line rather than a magic number
 * inside a sort.
 */
export const POINTS = {
  door: 1,
  conversation: 3,
  appointment: 10,
  sale: 25,
} as const

/**
 * What the board needs to know about somebody.
 *
 * Narrower than `RepStats` on purpose, and narrowed *after* the fact: scoring
 * and awards only ever read these nine fields, and asking for the whole of
 * `RepStats` meant a week's totals — which have no route, no percentage
 * complete and no last-known door — could not be ranked without inventing a
 * dozen values that mean nothing over a week. `RepStats` satisfies this
 * structurally, so today's path is unchanged.
 */
export interface Scorable {
  id: string
  name: string
  initials: string
  avatarUrl?: string
  knocks: number
  conversations: number
  appointments: number
  sales: number
  /** Money *committed*, not money in play. See the note in `teamStats`. */
  revenue: number
}

export interface Standing {
  rep: Scorable
  points: number
  /** 1-based. Ties share a rank, and the next rank skips accordingly. */
  rank: number
  /** True when somebody else shares this rank. */
  tied: boolean
}

export function scoreOf(rep: Scorable): number {
  return (
    rep.knocks * POINTS.door +
    rep.conversations * POINTS.conversation +
    rep.appointments * POINTS.appointment +
    rep.sales * POINTS.sale
  )
}

/**
 * The board, best first.
 *
 * Ties share a rank — two reps on 40 points are both second, and the next is
 * fourth. Standard competition ranking, and the alternative (breaking a tie on
 * something the rep cannot see) is the kind of detail that produces an argument
 * in a truck at 6pm.
 */
export function standings(reps: Scorable[]): Standing[] {
  const scored = reps
    .map((rep) => ({ rep, points: scoreOf(rep) }))
    // Name last, so the order is stable rather than dependent on roster order —
    // two reps on the same score should not swap places on every re-render.
    .sort((a, b) => b.points - a.points || a.rep.name.localeCompare(b.rep.name))

  return scored.map((row) => ({
    ...row,
    rank: scored.findIndex((r) => r.points === row.points) + 1,
    tied: scored.filter((r) => r.points === row.points).length > 1,
  }))
}

export type AwardKey = 'top' | 'doors' | 'revenue' | 'appointments'

export interface Award {
  key: AwardKey
  /** An icon name, resolved by `<Glyph>`. These were emoji; see that component. */
  icon: GlyphName
  label: string
  /** Everyone who earned it. More than one name means a genuine tie. */
  winners: Scorable[]
  /** The figure that won it, already formatted by the caller's rules. */
  value: number
}

/**
 * The awards for whatever period is on screen.
 *
 * Every one is "the highest non-zero value", and the non-zero half is the
 * important one: an award for most revenue on a day when nobody has sold
 * anything is a lie with a trophy on it. It is also what keeps the revenue
 * award off a week — the history table cannot answer that question, so the
 * figure is zero and the award correctly does not appear.
 *
 * The labels carry no period of their own. They used to say "today", which was
 * redundant under a heading that already said so and simply wrong the moment the
 * same board could show a week.
 */
export function awards(reps: Scorable[]): Award[] {
  const best = (
    key: AwardKey,
    icon: GlyphName,
    label: string,
    valueOf: (r: Scorable) => number,
  ): Award | null => {
    const top = Math.max(0, ...reps.map(valueOf))
    if (top <= 0) return null
    return { key, icon, label, winners: reps.filter((r) => valueOf(r) === top), value: top }
  }

  return [
    best('top', 'trophy', 'Top rep', scoreOf),
    best('doors', 'flame', 'Most doors', (r) => r.knocks),
    best('revenue', 'money', 'Most revenue', (r) => r.revenue),
    best('appointments', 'calendar', 'Most appointments', (r) => r.appointments),
  ].filter((a): a is Award => a !== null)
}

/* --- how far back the board looks ------------------------------------------ */

/**
 * Today, this week, or this month.
 *
 * Today was the only window for a long time, and it is still the default,
 * because at 2pm the question a rep is asking is about this afternoon. But a
 * board that only knows about today tells a rep who had a strong week and a slow
 * Tuesday that they are nowhere — and it gives somebody who joined last month no
 * window they can ever win, because everyone ahead of them had a good Tuesday
 * too. A week is a length of time a person can actually change.
 */
export type Period = 'today' | 'week' | 'month'

export const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
]

/**
 * The week starts on Sunday.
 *
 * A judgement, and the one line to change if a customer disagrees. US sales
 * weeks are conventionally Sunday-to-Saturday and the rest of the app formats
 * dates as `en-US`, so a Monday start would put "this week" out of step with
 * every calendar a rep looks at. Teams that knock Monday to Saturday will see
 * Sunday sitting at the front of their week rather than the end of it, which is
 * the cost.
 */
const WEEK_STARTS_ON = 0

/**
 * The first day a period includes, as a day key.
 *
 * On the company's calendar, deliberately. A rep's week ends when their Saturday
 * ends, not when Saturday ends in UTC — and a board that rolls over at 7pm
 * because that is midnight somewhere else is a board nobody trusts. Without a
 * company zone this is the device's clock, which is the demo's right answer.
 *
 * The arithmetic runs on the calendar date rather than on the timestamp. Once
 * the zone has told us what day it is, "the 1st of this month" and "back to
 * Sunday" are questions about a date, and doing them by subtracting
 * milliseconds is what lands a week boundary an hour out across a clock change.
 */
export function periodStart(
  period: Period,
  now: number | Date = Date.now(),
  tz?: string | null,
): string {
  const at = now instanceof Date ? now.getTime() : now
  const here = ymdIn(at, tz)
  if (period === 'today') return keyOf(here)
  if (period === 'month') return keyOf({ ...here, d: 1 })
  const back = (here.weekday - WEEK_STARTS_ON + 7) % 7
  return addDays(keyOf(here), -back)
}

/**
 * What the top bar says under the title.
 *
 * Rendered from the day key rather than from the instant, so the words match the
 * numbers underneath them. Formatting the raw `now` in the device's zone is the
 * version that says "Wednesday" over a board that has already been totalled as
 * Thursday — the one place a boundary bug is visible and still gets argued about
 * rather than believed.
 */
export function periodLabel(
  period: Period,
  now: number | Date = Date.now(),
  tz?: string | null,
): string {
  const at = now instanceof Date ? now.getTime() : now
  const from = periodStart(period, at, tz)
  if (period === 'today') return dayLabel(from, { weekday: 'long', month: 'long', day: 'numeric' })
  if (period === 'month') return dayLabel(from, { month: 'long', year: 'numeric' })
  return `Week of ${dayLabel(from, { month: 'long', day: 'numeric' })}`
}

/**
 * Roll the history up into a board for a period.
 *
 * `live` is today's numbers as the device knows them, and it always wins for
 * today. That is the whole reason this is not a plain sum over the history
 * table: `daily_stats` is written by the *server*, so a rep working a street
 * with no signal has a morning that exists only on their phone. Summing history
 * alone would show them a week with today missing — on the one screen whose
 * entire job is telling them where they stand right now.
 *
 * So history supplies the days *before* today and `live` supplies today, which
 * also means a synced today cannot be counted twice.
 *
 * Money used to be deliberately absent. The history table's money column was
 * not a daily figure — it held a running lifetime total of everything the rep
 * had ever won, stamped onto whichever day the write happened — so adding it up
 * over a week produced a number with no meaning. `revenue` was pinned to 0 for
 * anything but today and the revenue award suppressed itself, which was the
 * right call on a number that was wrong.
 *
 * The column now holds money closed on that day, so it can be summed like every
 * other column here, and a week can be won on revenue like it can on doors. The
 * award reappears on its own: `awards()` only ever asked for the highest
 * non-zero value, and the value is no longer always zero.
 */
export function boardFor(
  period: Period,
  input: { live: Scorable[]; history: DailyStat[]; now?: number | Date; tz?: string | null },
): Scorable[] {
  const now = input.now ?? Date.now()
  if (period === 'today') return input.live

  /*
    Both bounds on the company's calendar, because the rows being compared
    against them were bucketed on it by the server. Asking "is this row before
    today" with the device's idea of today is how a phone in another timezone
    drops a day out of a week — or counts it twice, once from history and once
    from `live`.
  */
  const from = periodStart(period, now, input.tz)
  const today = dayKeyIn(typeof now === 'number' ? now : now.getTime(), input.tz)

  const byRep = new Map<string, Scorable>()
  for (const rep of input.live) {
    byRep.set(rep.id, {
      ...rep,
      knocks: 0,
      conversations: 0,
      appointments: 0,
      sales: 0,
      revenue: 0,
    })
  }

  for (const row of input.history) {
    // Before today only — today comes from `live`, synced or not.
    if (row.day < from || row.day >= today) continue
    const rep = byRep.get(row.repId)
    // A history row for somebody no longer on the roster. Their work happened,
    // but a board is a list of people, and a deactivated rep is not one of them.
    if (!rep) continue
    rep.knocks += row.knocks
    rep.conversations += row.conversations
    rep.appointments += row.appointments
    rep.sales += row.sold
    rep.revenue += row.closedValue
  }

  for (const rep of input.live) {
    const acc = byRep.get(rep.id)
    if (!acc) continue
    acc.knocks += rep.knocks
    acc.conversations += rep.conversations
    acc.appointments += rep.appointments
    acc.sales += rep.sales
    acc.revenue += rep.revenue
  }

  return [...byRep.values()]
}
