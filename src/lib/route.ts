import type { Property, Route, RouteStop } from '../types'
import { distanceMiles } from './geo'
import { startOfToday } from './day'
import { dayKey } from './format'

/**
 * Building a day's route.
 *
 * A rep with two hundred assigned leads and no route has a list, not a plan.
 * This turns the list into a walking order.
 *
 * The algorithm is nearest-neighbour from wherever the rep is standing, and that
 * is a deliberate choice rather than a shortcut. The optimal tour is the
 * travelling-salesman problem; nearest-neighbour typically lands within about a
 * quarter of optimal, runs instantly on a phone with no network, and — the part
 * that actually matters — produces a route a human recognises as sensible:
 * finish this street, then the next one. A mathematically shorter route that
 * criss-crosses a neighbourhood gets abandoned by lunchtime, so the better tour
 * on paper is the worse tour in practice.
 *
 * Everything here is pure and synchronous. Route building happens in a truck at
 * 6am, frequently with no signal, and must never wait on a server.
 */

/** A day's work, not a database dump. Beyond this nobody finishes anyway. */
export const DEFAULT_ROUTE_SIZE = 40
export const MAX_ROUTE_SIZE = 120

/**
 * Leads worth knocking: not already closed out, and not already visited today.
 *
 * "Today" is the company's, not the phone's. Cut on the device it goes wrong in
 * both directions at once: a rep east of the company's zone gets doors they
 * knocked last night offered back to them before breakfast, and a rep west of it
 * loses the last hours of their evening's work out of the route the next
 * morning. Neither looks like a bug — it looks like the list being wrong.
 */
export function routableLeads(
  properties: Property[],
  now = Date.now(),
  tz?: string | null,
): Property[] {
  const cutoff = startOfToday(tz, now)
  return properties.filter((p) => {
    if (['won', 'lost', 'dnc'].includes(p.status)) return false
    // Knocking the same door twice in one day is how a rep annoys a prospect and
    // inflates their own numbers.
    if (p.lastVisitAt && p.lastVisitAt >= cutoff) return false
    // A lead with no coordinates can't be walked to.
    if (!p.lat || !p.lng) return false
    return true
  })
}

export interface BuildOptions {
  /** Where the rep is. Without it the route starts from the densest cluster. */
  from?: { lat: number; lng: number }
  size?: number
  now?: number
  /** The company's calendar. Without it the device's own clock cuts the day. */
  tz?: string | null
  repId: string
  name?: string
}

/**
 * Order leads into a walking route.
 *
 * Exported separately from `buildRoute` so the ordering can be tested on its own
 * — the interesting behaviour is the sequence, not the record it gets wrapped in.
 */
export function orderStops(
  leads: Property[],
  from: { lat: number; lng: number } | undefined,
  size: number,
): Property[] {
  if (leads.length === 0) return []
  const pool = [...leads]
  const ordered: Property[] = []

  // Without a GPS fix, start from the lead closest to the centre of the whole
  // set. Starting from an arbitrary first row can begin the day at the far edge
  // of the territory and walk inward, which is the worst possible order.
  let cursor = from
  if (!cursor) {
    const lat = pool.reduce((s, p) => s + p.lat, 0) / pool.length
    const lng = pool.reduce((s, p) => s + p.lng, 0) / pool.length
    cursor = { lat, lng }
  }

  while (ordered.length < size && pool.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < pool.length; i++) {
      const d = distanceMiles(cursor, pool[i])
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    const [next] = pool.splice(bestIdx, 1)
    ordered.push(next)
    cursor = { lat: next.lat, lng: next.lng }
  }

  return ordered
}

export function buildRoute(leads: Property[], opts: BuildOptions): Route | null {
  const size = Math.min(Math.max(1, opts.size ?? DEFAULT_ROUTE_SIZE), MAX_ROUTE_SIZE)
  const routable = routableLeads(leads, opts.now, opts.tz)
  const ordered = orderStops(routable, opts.from, size)
  if (ordered.length === 0) return null

  const stops: RouteStop[] = ordered.map((p, i) => ({
    propertyId: p.id,
    order: i,
    // Exactly one stop is active — the one the "Next" card points at.
    status: i === 0 ? 'active' : 'pending',
  }))

  const day = dayKey(opts.now, opts.tz)
  return {
    // Deterministic per rep per day: tapping "build" twice must replace today's
    // route, never leave two of them for the same day fighting over the screen.
    id: `route_${opts.repId}_${day}`,
    repId: opts.repId,
    date: day,
    name: opts.name ?? routeName(ordered),
    stops,
  }
}

/**
 * Name it after where the work is. "Cedar Bend + 2 streets" tells a rep what
 * their day looks like; "Route 7" tells them nothing.
 */
export function routeName(ordered: Property[]): string {
  const streets: string[] = []
  for (const p of ordered) {
    const street = streetOf(p.address1)
    if (street && !streets.includes(street)) streets.push(street)
  }
  if (streets.length === 0) return 'Today’s route'
  if (streets.length === 1) return streets[0]
  return `${streets[0]} + ${streets.length - 1} street${streets.length === 2 ? '' : 's'}`
}

/** "1420 Cedar Bend Dr" -> "Cedar Bend Dr". Drops the house number only. */
function streetOf(address1: string): string {
  return address1.replace(/^\s*[\d-]+\s+/, '').trim()
}

/** Total walking distance of a route, for the "about N miles" estimate. */
export function routeMiles(ordered: { lat: number; lng: number }[]): number {
  let total = 0
  for (let i = 1; i < ordered.length; i++) {
    total += distanceMiles(ordered[i - 1], ordered[i])
  }
  return total
}
