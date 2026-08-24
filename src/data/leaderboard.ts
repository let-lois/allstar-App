import type { RepStats } from '../store/teamStats'

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

export interface Standing {
  rep: RepStats
  points: number
  /** 1-based. Ties share a rank, and the next rank skips accordingly. */
  rank: number
  /** True when somebody else shares this rank. */
  tied: boolean
}

export function scoreOf(rep: RepStats): number {
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
export function standings(reps: RepStats[]): Standing[] {
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
  glyph: string
  label: string
  /** Everyone who earned it. More than one name means a genuine tie. */
  winners: RepStats[]
  /** The figure that won it, already formatted by the caller's rules. */
  value: number
}

/**
 * Today's awards.
 *
 * Every one of these is "the highest non-zero value", and the non-zero part is
 * the important half: an award for most revenue on a day when nobody has sold
 * anything is a lie with a trophy on it.
 */
export function awards(reps: RepStats[]): Award[] {
  const best = (
    key: AwardKey,
    glyph: string,
    label: string,
    valueOf: (r: RepStats) => number,
  ): Award | null => {
    const top = Math.max(0, ...reps.map(valueOf))
    if (top <= 0) return null
    return { key, glyph, label, winners: reps.filter((r) => valueOf(r) === top), value: top }
  }

  return [
    best('top', '🏆', 'Top rep today', scoreOf),
    best('doors', '🔥', 'Most doors', (r) => r.knocks),
    best('revenue', '💰', 'Most revenue', (r) => r.revenue),
    best('appointments', '📅', 'Most appointments', (r) => r.appointments),
  ].filter((a): a is Award => a !== null)
}
