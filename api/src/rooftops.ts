import type { LatLng } from './geo'
import { pointInPolygon } from './geo'
import type { Bucket, FoundAddress } from './addresses'
import type { Env } from './types'

/**
 * Rooftops, and addresses for the ones the address data does not name.
 *
 * Overture's addresses come from OpenAddresses, county by county: Austin has
 * every door, upstate South Carolina almost none. Overture's buildings are
 * everywhere — the footprints Microsoft, Google and OpenStreetMap traced from
 * imagery — so the same bucket holds them too, as tiles of rooftop points
 * (`b1/14/{x}/{y}.json`, rows `[lng, lat, kind]`, built by
 * `scripts/national-build.mjs --theme buildings`).
 *
 * They do two jobs:
 *
 *  - a house with no address point near it is a door the address data missed,
 *    and Geocodio turns its rooftop into a street address;
 *  - an address that sits on a building Overture calls commercial, civic,
 *    industrial and the like is not a home, and does not become a lead.
 *
 * Geocodio rather than Google: its terms let a result be kept, and a lead is a
 * kept result (LAUNCH.md, blocker 1, is about Google's). U.S. results only.
 */

export type RooftopKind = 'r' | 'u' | 'n'
export interface Rooftop { lng: number; lat: number; kind: RooftopKind }

export const rooftopKey = (x: number, y: number, z = 14) => `b1/${z}/${x}/${y}.json`

/** Rooftops inside the polygon, and whether any tile had rooftop data at all. */
export async function rooftopsInside(
  bucket: Bucket,
  polygon: LatLng[],
  tiles: { x: number; y: number }[],
): Promise<{ rooftops: Rooftop[]; tilesWithData: number }> {
  const rooftops: Rooftop[] = []
  let tilesWithData = 0
  for (let i = 0; i < tiles.length; i += 8) {
    const batch = await Promise.all(tiles.slice(i, i + 8).map(async (t) => {
      const obj = await bucket.get(rooftopKey(t.x, t.y))
      if (!obj) return null
      const parsed: unknown = await obj.json()
      return Array.isArray(parsed) ? (parsed as [number, number, string][]) : []
    }))
    for (const rows of batch) {
      if (!rows) continue
      tilesWithData++
      for (const r of rows) {
        const lng = Number(r[0]), lat = Number(r[1])
        const kind = r[2] === 'r' || r[2] === 'n' ? r[2] : 'u'
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
        if (!pointInPolygon({ lat, lng }, polygon)) continue
        rooftops.push({ lng, lat, kind })
      }
    }
  }
  return { rooftops, tilesWithData }
}

/**
 * Points on a coarse grid, for "is anything within N metres" without comparing
 * every pair: a territory can hold thousands of each.
 */
export class Near<T extends { lat: number; lng: number }> {
  private cells = new Map<string, T[]>()
  /** ~55 m per cell in latitude; checked with the neighbours, so any radius up to that is exact. */
  private static STEP = 0.0005
  private key(lat: number, lng: number) {
    return `${Math.floor(lat / Near.STEP)}:${Math.floor(lng / Near.STEP)}`
  }
  add(p: T) {
    const k = this.key(p.lat, p.lng)
    let a = this.cells.get(k)
    if (!a) { a = []; this.cells.set(k, a) }
    a.push(p)
  }
  /** The closest point within `metres`, or null. */
  nearest(at: LatLng, metres: number): T | null {
    const cy = Math.floor(at.lat / Near.STEP), cx = Math.floor(at.lng / Near.STEP)
    let best: T | null = null, bestD = Infinity
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const p of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
        const d = metres_(at, p)
        if (d <= metres && d < bestD) { best = p; bestD = d }
      }
    }
    return best
  }
}

function metres_(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x = dLng * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
  return Math.sqrt(x * x + dLat * dLat) * R
}

/* --- Geocodio ---------------------------------------------------------------- */

/** Per request; Geocodio takes up to 10,000, but a smaller batch fails smaller. */
const BATCH = 500
/** One batch that has not answered in this long is given up on, and says so. */
const TIMEOUT_MS = 25_000
/** A result further from the rooftop than this is another house, not this one. */
const MAX_OFFSET_M = 60
/** Accuracy good enough to knock on: a building, a parcel point, or a house-number range. */
const GOOD = new Set(['rooftop', 'point', 'nearest_rooftop_match', 'range_interpolation'])

export interface Resolved {
  addresses: (FoundAddress & { provider: 'geocodio' })[]
  /** Rooftops sent. */
  lookedUp: number
  /** Rooftops that came back with no usable U.S. street address. */
  unresolved: number
  /** Rooftops in a batch that failed or timed out. */
  failed: number
  /** The first failure, in words, for the console and the log. */
  error: string | null
}

interface GeocodioComponents {
  number?: string
  formatted_street?: string
  secondaryunit?: string
  secondarynumber?: string
  city?: string
  state?: string
  zip?: string
  country?: string
}
interface GeocodioResult {
  address_components?: GeocodioComponents
  location?: { lat?: number; lng?: number }
  accuracy_type?: string
}

/** Rooftops to street addresses, batched, each batch on its own clock. */
export async function reverseGeocode(
  env: Pick<Env, 'GEOCODIO_API_KEY' | 'GEOCODIO_URL'>,
  rooftops: Rooftop[],
  fetcher: typeof fetch = fetch,
): Promise<Resolved> {
  const out: Resolved = { addresses: [], lookedUp: 0, unresolved: 0, failed: 0, error: null }
  if (!env.GEOCODIO_API_KEY || !rooftops.length) return out
  const root = (env.GEOCODIO_URL || 'https://api.geocod.io/v1.9').replace(/\/+$/, '')
  for (let i = 0; i < rooftops.length; i += BATCH) {
    const batch = rooftops.slice(i, i + BATCH)
    out.lookedUp += batch.length
    let body: { results?: { response?: { results?: GeocodioResult[] } }[]; error?: string }
    try {
      const res = await fetcher(`${root}/reverse?api_key=${encodeURIComponent(env.GEOCODIO_API_KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch.map((r) => `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      body = (await res.json().catch(() => ({}))) as typeof body
      if (!res.ok) throw new Error(`Geocodio answered ${res.status}${body?.error ? `: ${body.error}` : ''}`)
    } catch (err) {
      const msg = err instanceof Error && err.name === 'TimeoutError'
        ? `Geocodio did not answer within ${TIMEOUT_MS / 1000}s`
        : err instanceof Error ? err.message : String(err)
      // Logged without the key: it is in the URL, and the URL is not printed.
      console.error(JSON.stringify({ event: 'geocodio.failed', rooftops: batch.length, error: msg }))
      out.failed += batch.length
      out.error ??= msg
      continue
    }
    const answers = Array.isArray(body.results) ? body.results : []
    batch.forEach((roof, n) => {
      const a = pick(answers[n]?.response?.results ?? [], roof)
      if (a) out.addresses.push(a)
      else out.unresolved++
    })
  }
  return out
}

/** The first result that is a U.S. street address on or next to this rooftop. */
function pick(results: GeocodioResult[], roof: Rooftop): (FoundAddress & { provider: 'geocodio' }) | null {
  for (const r of results) {
    const c = r.address_components ?? {}
    if (!c.number || !c.formatted_street) continue
    if (c.country && c.country !== 'US') continue
    if (r.accuracy_type && !GOOD.has(r.accuracy_type)) continue
    const lat = Number(r.location?.lat), lng = Number(r.location?.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng) && metres_({ lat, lng }, roof) > MAX_OFFSET_M) continue
    const unit = c.secondaryunit && c.secondarynumber ? ` ${c.secondaryunit} ${c.secondarynumber}` : ''
    return {
      address1: `${c.number} ${c.formatted_street}${unit}`,
      city: c.city ?? '',
      state: c.state ?? '',
      zip: c.zip ?? '',
      // The rooftop, not the result's point: the pin should be on the house.
      lat: roof.lat,
      lng: roof.lng,
      unit: !!unit,
      provider: 'geocodio',
    }
  }
  return null
}
