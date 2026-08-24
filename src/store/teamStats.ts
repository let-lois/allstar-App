import { useMemo } from 'react'
import { useAppStore } from './useAppStore'
import { onBoard } from '../data/leaderboard'
import type { ActivityEvent, Property, Route, TeamMember } from '../types'

/**
 * Per-rep performance for the manager and admin views.
 *
 * Previously these screens rendered the signed-in rep's route progress next to
 * every teammate's name, so a five-person team showed five identical bars — the
 * kind of detail a prospect notices. Everything here is derived from that rep's
 * own route and activity.
 *
 * Names come from the store's roster, which is the real team on a live account
 * and the seeded one in the demo. Reading the seed directly — as this did — meant
 * a live company's reports listed five people who don't work there and none of
 * the ones who do.
 */

export interface RepStats {
  id: string
  name: string
  initials: string
  phone: string
  routeName: string
  done: number
  total: number
  remaining: number
  pct: number
  /** Doors knocked today. */
  knocks: number
  /** Knocks that reached a real conversation. */
  conversations: number
  contactRate: number
  /** Value of opportunities touched today. */
  pipelineToday: number
  /** Doors that said they were interested — the top of the funnel that matters. */
  interested: number
  /** Appointments booked today. */
  appointments: number
  /** Deals closed today. */
  sales: number
  /**
   * Value of what was *sold* today — not what was quoted.
   *
   * Deliberately narrower than `pipelineToday`, which counts quotes as well.
   * Both are useful and they are not the same claim: one is money committed, the
   * other is money in play, and a leaderboard column headed "revenue" has to
   * mean the first one.
   */
  revenue: number
  lastActivityAt?: number
  /** First logged door today — the start of the working window, not a clock-in. */
  firstActivityAt?: number
  /**
   * The door most recently worked, if any.
   *
   * This is how a manager sees where somebody is working, and it is deliberately
   * *this* rather than a device position: it is the last door they logged, which
   * the app already records because a visit needs to know which house it was.
   * Nothing new is collected, and it cannot report anything outside working
   * activity — see the note on the rep screen.
   */
  lastPropertyId?: string
  /** The territory most of today's doors belong to. */
  territoryId?: string
}

const GOOD = new Set(['interested', 'appointment', 'quote_requested', 'sold'])

function statsFor(
  meta: TeamMember,
  routes: Route[],
  activity: ActivityEvent[],
  properties: Record<string, Property>,
  since: number,
): RepStats {
  const repId = meta.id
  const route = routes.find((r) => r.repId === repId)
  const stops = route?.stops ?? []
  const done = stops.filter((s) => s.status === 'done').length
  const skipped = stops.filter((s) => s.status === 'skipped').length
  const total = stops.length

  const mine = activity.filter((a) => a.repId === repId && a.at >= since && a.type === 'visit')
  const conversations = mine.filter((a) => a.outcome && GOOD.has(a.outcome)).length
  const pipelineToday = mine.reduce((sum, ev) => {
    if (ev.outcome !== 'sold' && ev.outcome !== 'quote_requested') return sum
    const p = ev.propertyId ? properties[ev.propertyId] : undefined
    return sum + (p?.opportunityValue ?? 0)
  }, 0)
  const interested = mine.filter((a) => a.outcome === 'interested').length
  const appointments = mine.filter((a) => a.outcome === 'appointment').length

  /*
    The patch they are actually in, taken by majority of today's doors rather
    than from their route. A rep sent to one territory who spends the afternoon
    in another should show the one they are standing in — that difference is the
    entire reason a manager looks at this.
  */
  const territoryCount = new Map<string, number>()
  for (const ev of mine) {
    const t = ev.propertyId ? properties[ev.propertyId]?.territoryId : undefined
    if (t) territoryCount.set(t, (territoryCount.get(t) ?? 0) + 1)
  }
  const territoryId = [...territoryCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const sold = mine.filter((a) => a.outcome === 'sold')
  const revenue = sold.reduce((sum, ev) => {
    const p = ev.propertyId ? properties[ev.propertyId] : undefined
    return sum + (p?.opportunityValue ?? 0)
  }, 0)

  return {
    id: repId,
    name: meta.name,
    initials: meta.initials,
    phone: meta.phone ?? '',
    routeName: route?.name ?? '—',
    done,
    total,
    remaining: Math.max(0, total - done - skipped),
    pct: total ? Math.round((done / total) * 100) : 0,
    knocks: mine.length,
    conversations,
    contactRate: mine.length ? Math.round((conversations / mine.length) * 100) : 0,
    pipelineToday,
    interested,
    appointments,
    sales: sold.length,
    revenue,
    // `activity` arrives newest-first, so the first entry is the most recent.
    lastActivityAt: mine[0]?.at,
    firstActivityAt: mine[mine.length - 1]?.at,
    lastPropertyId: mine.find((a) => a.propertyId)?.propertyId,
    territoryId,
  }
}

/** Everyone knocking today, best day first — the shape a manager actually scans. */
export function useTeamStats(): RepStats[] {
  const routes = useAppStore((s) => s.routes)
  const activity = useAppStore((s) => s.activity)
  const properties = useAppStore((s) => s.properties)
  const team = useAppStore((s) => s.team)

  return useMemo(() => {
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    const from = since.getTime()
    return onBoard(team)
      .map((m) => statsFor(m, routes, activity, properties, from))
      .sort((a, b) => b.conversations - a.conversations || b.done - a.done)
  }, [team, routes, activity, properties])
}

/** Company roll-up, derived from the same per-rep numbers. */
export function useTeamTotals() {
  const reps = useTeamStats()
  return useMemo(() => {
    const knocks = reps.reduce((s, r) => s + r.knocks, 0)
    const conversations = reps.reduce((s, r) => s + r.conversations, 0)
    return {
      reps: reps.length,
      knocks,
      conversations,
      contactRate: knocks ? Math.round((conversations / knocks) * 100) : 0,
      pipelineToday: reps.reduce((s, r) => s + r.pipelineToday, 0),
      doorsRemaining: reps.reduce((s, r) => s + r.remaining, 0),
    }
  }, [reps])
}
