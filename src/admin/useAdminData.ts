import { useEffect, useMemo, useState } from 'react'
import * as db from '../lib/db'
import { dayKey } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import type { DailyStat, LeadStatus, OutcomeCode, Property } from '../types'

/**
 * Reporting data for the office console.
 *
 * Reads the rolled-up history rather than raw visits: reporting spans weeks,
 * and replaying every individual visit for that would be thousands of rows the
 * phone never needs. Today's row comes from live activity, so the console and
 * the rep's own screen never disagree about today.
 */

export type RangeKey = '7d' | '14d' | '30d'

export const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '14d', label: '14 days', days: 14 },
  { key: '30d', label: '30 days', days: 30 },
]

export function useDailyStats(): DailyStat[] {
  const [rows, setRows] = useState<DailyStat[]>([])
  // Re-read when the local dataset changes underneath us (reset, day rollover).
  const propertyCount = useAppStore((s) => Object.keys(s.properties).length)

  useEffect(() => {
    let live = true
    void db.all<DailyStat>('dailyStats').then((r) => {
      if (live) setRows(r.sort((a, b) => a.day.localeCompare(b.day)))
    })
    return () => {
      live = false
    }
  }, [propertyCount])

  return rows
}

export interface RangeSeries {
  days: string[]
  labels: string[]
  knocks: number[]
  conversations: number[]
}

/** Company-wide daily series for the trend chart. */
export function useRangeSeries(range: RangeKey, repId?: string): RangeSeries {
  const stats = useDailyStats()
  return useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days ?? 30
    const cutoff = dayKey(Date.now() - (days - 1) * 86_400_000)
    const inRange = stats.filter(
      (s) => s.day >= cutoff && (!repId || s.repId === repId),
    )

    const byDay = new Map<string, { knocks: number; conversations: number }>()
    for (const s of inRange) {
      const acc = byDay.get(s.day) ?? { knocks: 0, conversations: 0 }
      acc.knocks += s.knocks
      acc.conversations += s.conversations
      byDay.set(s.day, acc)
    }

    const ordered = [...byDay.keys()].sort()
    return {
      days: ordered,
      labels: ordered.map((d) => {
        const [, m, day] = d.split('-')
        return `${Number(m)}/${Number(day)}`
      }),
      knocks: ordered.map((d) => byDay.get(d)!.knocks),
      conversations: ordered.map((d) => byDay.get(d)!.conversations),
    }
  }, [stats, range, repId])
}

export interface RangeTotals {
  knocks: number
  conversations: number
  contactRate: number
  appointments: number
  quotes: number
  sold: number
  pipelineValue: number
  /**
   * Percentage change vs the immediately preceding window of equal length, or
   * `undefined` when there is no comparable window. Distinguishing those two
   * cases matters: history here is finite, so the 30-day view has nothing
   * before it, and reporting "+100%" for "we have no prior data" is a
   * fabricated number on the one screen that must not invent any.
   */
  knocksDelta?: number
  conversationsDelta?: number
  contactRateDelta?: number
  soldDelta?: number
  /** False when the preceding window holds no data at all. */
  hasComparison: boolean
}

const pctChange = (now: number, prev: number) =>
  prev === 0 ? (now === 0 ? 0 : undefined) : Math.round(((now - prev) / prev) * 100)

/**
 * Totals for the range, plus the change against the previous window of the same
 * length — a number without a comparison is trivia, not a metric.
 */
export function useRangeTotals(range: RangeKey, repId?: string): RangeTotals {
  const stats = useDailyStats()
  return useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days ?? 30
    const start = dayKey(Date.now() - (days - 1) * 86_400_000)
    const prevStart = dayKey(Date.now() - (days * 2 - 1) * 86_400_000)

    const scoped = repId ? stats.filter((s) => s.repId === repId) : stats
    const current = scoped.filter((s) => s.day >= start)
    const previous = scoped.filter((s) => s.day >= prevStart && s.day < start)

    const sum = (rows: DailyStat[], k: keyof DailyStat) =>
      rows.reduce((acc, r) => acc + (r[k] as number), 0)

    const knocks = sum(current, 'knocks')
    const conversations = sum(current, 'conversations')
    const pKnocks = sum(previous, 'knocks')
    const pConversations = sum(previous, 'conversations')

    const rate = knocks ? Math.round((conversations / knocks) * 100) : 0
    const pRate = pKnocks ? Math.round((pConversations / pKnocks) * 100) : 0
    const hasComparison = previous.length > 0

    return {
      hasComparison,
      knocks,
      conversations,
      contactRate: rate,
      appointments: sum(current, 'appointments'),
      quotes: sum(current, 'quotes'),
      sold: sum(current, 'sold'),
      pipelineValue: sum(current, 'pipelineValue'),
      knocksDelta: hasComparison ? pctChange(knocks, pKnocks) : undefined,
      conversationsDelta: hasComparison ? pctChange(conversations, pConversations) : undefined,
      contactRateDelta: hasComparison ? pctChange(rate, pRate) : undefined,
      soldDelta: hasComparison
        ? pctChange(sum(current, 'sold'), sum(previous, 'sold'))
        : undefined,
    }
  }, [stats, range, repId])
}

export interface RepRangeRow {
  id: string
  name: string
  initials: string
  knocks: number
  conversations: number
  contactRate: number
  appointments: number
  quotes: number
  sold: number
  pipelineValue: number
}

/** Per-rep leaderboard over the selected range. */
export function useRepRangeRows(range: RangeKey): RepRangeRow[] {
  const stats = useDailyStats()
  const team = useAppStore((s) => s.team)
  const reps = useMemo(() => team.filter((m) => m.role === 'field_rep'), [team])
  return useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days ?? 30
    const start = dayKey(Date.now() - (days - 1) * 86_400_000)
    const inRange = stats.filter((s) => s.day >= start)

    // The store's roster — real on a live account, seeded in the demo. Reading
    // the seed here meant a live company's leaderboard listed five people who
    // don't work there and none of the ones who do.
    return reps.map((rep) => {
      const mine = inRange.filter((s) => s.repId === rep.id)
      const knocks = mine.reduce((a, r) => a + r.knocks, 0)
      const conversations = mine.reduce((a, r) => a + r.conversations, 0)
      return {
        id: rep.id,
        name: rep.name,
        initials: rep.initials,
        knocks,
        conversations,
        contactRate: knocks ? Math.round((conversations / knocks) * 100) : 0,
        appointments: mine.reduce((a, r) => a + r.appointments, 0),
        quotes: mine.reduce((a, r) => a + r.quotes, 0),
        sold: mine.reduce((a, r) => a + r.sold, 0),
        pipelineValue: mine.reduce((a, r) => a + r.pipelineValue, 0),
      }
    }).sort((a, b) => b.sold - a.sold || b.conversations - a.conversations)
  }, [stats, range, reps])
}

/* --- property-derived views ----------------------------------------------- */

/** Open pipeline by stage. `won` is excluded — it's the outcome, not a stage. */
export const FUNNEL_STAGES: LeadStatus[] = [
  'new',
  'contacted',
  'working',
  'appointment',
  'quoted',
]

export function useFunnel(properties: Property[]) {
  return useMemo(() => {
    const counts = new Map<LeadStatus, { n: number; value: number }>()
    FUNNEL_STAGES.forEach((s) => counts.set(s, { n: 0, value: 0 }))
    let won = { n: 0, value: 0 }
    for (const p of properties) {
      if (p.status === 'won') {
        won = { n: won.n + 1, value: won.value + (p.opportunityValue ?? 0) }
        continue
      }
      const bucket = counts.get(p.status)
      if (!bucket) continue
      bucket.n += 1
      bucket.value += p.opportunityValue ?? 0
    }
    return { counts, won }
  }, [properties])
}

export function useOutcomeMix(): { code: OutcomeCode; n: number }[] {
  const activity = useAppStore((s) => s.activity)
  return useMemo(() => {
    const counts = new Map<OutcomeCode, number>()
    for (const ev of activity) {
      if (ev.type !== 'visit' || !ev.outcome) continue
      counts.set(ev.outcome, (counts.get(ev.outcome) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([code, n]) => ({ code, n }))
      .sort((a, b) => b.n - a.n)
  }, [activity])
}

/** Territory roll-up, derived from property assignments. */
export interface TerritoryRow {
  id: string
  repId?: string
  /** Leads in this patch are split across more than one rep. */
  mixed: boolean
  properties: number
  knocked: number
  coverage: number
  openValue: number
  wonValue: number
}

/**
 * The bucket for leads that belong to no territory.
 *
 * A sentinel rather than a real id, and exported so the table and the map agree
 * on it. They didn't: the table grouped on this string while the map filtered on
 * `territoryId === selected`, which is `undefined` for exactly these rows — so
 * the bucket could be selected and never matched anything, and every lead
 * imported without a territory name (the default) was invisible on the map.
 */
export const UNASSIGNED_TERRITORY = '__unassigned__'

/** Does this property belong to the territory the operator picked? */
export function inTerritory(p: Property, territoryId: string | null): boolean {
  if (territoryId === null) return true
  if (territoryId === UNASSIGNED_TERRITORY) return !p.territoryId
  return p.territoryId === territoryId
}

export function useTerritories(properties: Property[]): TerritoryRow[] {
  return useMemo(() => {
    const map = new Map<string, Property[]>()
    for (const p of properties) {
      const t = p.territoryId ?? UNASSIGNED_TERRITORY
      const arr = map.get(t)
      if (arr) arr.push(p)
      else map.set(t, [p])
    }

    return [...map.entries()]
      .map(([id, rows]) => {
        // Only claim an owner when every lead in the patch has the same one.
        // Reporting the first row's rep as the territory's would show a settled
        // answer for a split territory, and the dropdown would then silently
        // reassign the whole thing on the next change.
        const owners = new Set(rows.map((p) => p.assignedRepId ?? ''))
        const repId = owners.size === 1 ? (rows[0]?.assignedRepId ?? undefined) : undefined
        const mixed = owners.size > 1
        const knocked = rows.filter((p) => p.lastVisitAt).length
        return {
          id,
          repId,
          mixed,
          properties: rows.length,
          knocked,
          coverage: rows.length ? Math.round((knocked / rows.length) * 100) : 0,
          openValue: rows
            .filter((p) => !['won', 'lost', 'dnc'].includes(p.status))
            .reduce((a, p) => a + (p.opportunityValue ?? 0), 0),
          wonValue: rows
            .filter((p) => p.status === 'won')
            .reduce((a, p) => a + (p.opportunityValue ?? 0), 0),
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }, [properties])
}
