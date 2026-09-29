import type { Bucket, FoundAddress } from './addresses'
import type { Rooftop } from './rooftops'

/**
 * A street address for a rooftop, estimated from Census TIGER street ranges.
 *
 * Where no published address point exists (most of South Carolina, Detroit,
 * Philadelphia …) the house is still on the map as an Overture rooftop, and
 * the street in front of it is in TIGER with the numbers its block can hold on
 * each side. The rooftop's position along the block and which side it is on
 * give an estimated house number — the same method geocoders call "range
 * interpolation". The street name, side and ZIP come straight from the data;
 * the number is an estimate, often within a few doors, sometimes further where
 * a block's range is wider than its houses. So every one is stored as
 * INTERPOLATED, pinned on the real roof, and the rep confirms it at the door.
 *
 * TIGER is public domain: kept, used commercially and redistributed freely.
 * Tiles `r1/14/{x}/{y}.json`, built by `scripts/national-build.mjs --theme
 * tiger`; rows [street, lFrom, lTo, rFrom, rTo, zipL, zipR, state, [lng, lat…]].
 */

type RangeRow = [string, number | null, number | null, number | null, number | null, string, string, string, number[]]

export const rangeKey = (x: number, y: number, z = 14) => `r1/${z}/${x}/${y}.json`
/** A street further from the roof than this is not the one the house faces. */
export const MAX_RANGE_METRES = 80

export async function rangesIn(bucket: Bucket, cells: { x: number; y: number }[]): Promise<{ rows: RangeRow[]; tilesWithData: number }> {
  const rows: RangeRow[] = []
  const seen = new Set<string>()
  let tilesWithData = 0
  for (let i = 0; i < cells.length; i += 8) {
    const batch = await Promise.all(cells.slice(i, i + 8).map(async (t) => {
      const obj = await bucket.get(rangeKey(t.x, t.y))
      if (!obj) return null
      const parsed: unknown = await obj.json()
      return Array.isArray(parsed) ? (parsed as RangeRow[]) : []
    }))
    for (const b of batch) {
      if (!b) continue
      tilesWithData++
      for (const r of b) {
        // A street crossing a tile edge is in both tiles; keep it once.
        const k = `${r[0]}|${r[8]?.slice(0, 4).join(',')}`
        if (seen.has(k)) continue
        seen.add(k)
        rows.push(r)
      }
    }
  }
  return { rows, tilesWithData }
}

/** Metres per degree near a latitude, for flat-earth geometry at street scale. */
const mx = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)
const my = 110_540

export interface Estimate extends FoundAddress {
  provider: 'census_tiger'
  confidence: 'INTERPOLATED'
  /** How far the roof is from the street it was named from. */
  metres: number
}

/**
 * The street a rooftop faces and the number its place on the block implies,
 * or null when no numbered street is near enough, or the side it is on has no
 * numbers.
 */
export function estimate(roof: Rooftop, rows: RangeRow[]): Estimate | null {
  let best: { row: RangeRow; d: number; along: number; total: number; left: boolean } | null = null
  const kx = mx(roof.lat)
  for (const row of rows) {
    const pts = row[8]
    if (!Array.isArray(pts) || pts.length < 4) continue
    let cum = 0
    let rowBest: { d: number; along: number; left: boolean } | null = null
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = (pts[i]! - roof.lng) * kx, ay = (pts[i + 1]! - roof.lat) * my
      const bx = (pts[i + 2]! - roof.lng) * kx, by = (pts[i + 3]! - roof.lat) * my
      const dx = bx - ax, dy = by - ay
      const len2 = dx * dx + dy * dy
      const len = Math.sqrt(len2)
      if (!len) continue
      // The roof is at the origin: project it onto the piece a→b.
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
      const px = ax + t * dx, py = ay + t * dy
      const d = Math.hypot(px, py)
      if (!rowBest || d < rowBest.d) {
        // Left of the direction of travel a→b is a positive cross product.
        rowBest = { d, along: cum + t * len, left: dx * (0 - ay) - dy * (0 - ax) > 0 }
      }
      cum += len
    }
    if (rowBest && rowBest.d <= MAX_RANGE_METRES && (!best || rowBest.d < best.d)) best = { row, ...rowBest, total: cum }
  }
  if (!best) return null
  const [street, lf, lt, rf, rt, zl, zr, state] = best.row
  const from = best.left ? lf : rf, to = best.left ? lt : rt
  if (from == null || to == null) return null
  const f = best.total ? best.along / best.total : 0.5
  // Step in twos from the start of the range, so the number keeps the side's
  // parity (odd on one side, even on the other) and is the nearest such
  // number to the roof's place on the block.
  let n = from + 2 * Math.round((f * (to - from)) / 2)
  const lo = Math.min(from, to), hi = Math.max(from, to)
  n = Math.max(lo, Math.min(hi, n))
  if (n <= 0) return null
  return {
    address1: `${n} ${street}`,
    city: '',
    state,
    zip: best.left ? zl : zr,
    lat: roof.lat,
    lng: roof.lng,
    unit: false,
    provider: 'census_tiger',
    confidence: 'INTERPOLATED',
    metres: Math.round(best.d),
  }
}

/** Another number on the same side of the same block: the next even or odd one along. */
export function nudge(e: Estimate, step: number): Estimate {
  const m = /^(\d+) (.*)$/.exec(e.address1)
  if (!m) return e
  return { ...e, address1: `${Number(m[1]) + step} ${m[2]}` }
}
