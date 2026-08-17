import { useMemo } from 'react'
import { useAppStore } from './useAppStore'
import { FIELD_REPS } from '../data/seed'
import type { ActivityEvent, Property, Route } from '../types'

/**
 * Per-rep performance for the manager and admin views.
 *
 * Previously these screens rendered the signed-in rep's route progress next to
 * every teammate's name, so a five-person team showed five identical bars — the
 * kind of detail a prospect notices. Everything here is derived from that rep's
 * own route and activity.
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
  lastActivityAt?: number
}

const GOOD = new Set(['interested', 'appointment', 'quote_requested', 'sold'])

function statsFor(
  repId: string,
  routes: Route[],
  activity: ActivityEvent[],
  properties: Record<string, Property>,
  since: number,
): RepStats {
  const meta = FIELD_REPS.find((r) => r.id === repId)
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

  return {
    id: repId,
    name: meta?.name ?? repId,
    initials: meta?.initials ?? '??',
    phone: meta?.phone ?? '',
    routeName: route?.name ?? meta?.routeName ?? '—',
    done,
    total,
    remaining: Math.max(0, total - done - skipped),
    pct: total ? Math.round((done / total) * 100) : 0,
    knocks: mine.length,
    conversations,
    contactRate: mine.length ? Math.round((conversations / mine.length) * 100) : 0,
    pipelineToday,
    lastActivityAt: mine[0]?.at,
  }
}

/** All reps, best day first — the shape a manager actually scans. */
export function useTeamStats(): RepStats[] {
  const routes = useAppStore((s) => s.routes)
  const activity = useAppStore((s) => s.activity)
  const properties = useAppStore((s) => s.properties)

  return useMemo(() => {
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    return FIELD_REPS.map((r) =>
      statsFor(r.id, routes, activity, properties, since.getTime()),
    ).sort((a, b) => b.conversations - a.conversations || b.done - a.done)
  }, [routes, activity, properties])
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
