/**
 * Cutting address points into the tiles the Worker reads.
 *
 * Pure, so `verify:addresses` can drive it. The Worker has its own copy of
 * `tileFor` in `src/addresses.ts`; the two are held equal by the same gate.
 * One tile is one JSON array of compact rows for one z14 Web-Mercator cell:
 *
 *   [number, street, unit | null, city, state, zip, lng, lat]
 *
 * Arrays rather than objects because a busy suburb tile holds a few thousand
 * rows, and the key names would be most of the bytes.
 */

export const TILE_ZOOM = 14

/** Web-Mercator tile holding this point. */
export function tileFor(lng, lat, z = TILE_ZOOM) {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) }
}

export const tileKey = (x, y, z = TILE_ZOOM) => `v1/${z}/${x}/${y}.json`

/**
 * An Overture address row as a tile row, or null when it has no street or
 * number. `address_levels` is `[{ value: 'TX' }, ...]` — the state first.
 */
export function toTileRow(row) {
  const number = str(row.number)
  const street = str(row.street)
  if (!number || !street) return null
  const coords = row.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) return null
  const lng = Number(coords[0]), lat = Number(coords[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  const levels = Array.isArray(row.address_levels) ? row.address_levels : []
  const state = str(levels[0]?.value)
  return [number, street, str(row.unit) || null, str(row.postal_city), state, str(row.postcode), round(lng), round(lat)]
}

const str = (v) => (v == null ? '' : String(v).trim())
/** Six decimals is a tenth of a metre; the rest is noise that costs bytes. */
const round = (n) => Math.round(n * 1e6) / 1e6

/**
 * Sort rows into tiles. Rows are de-duplicated on number+street+unit+zip
 * within a tile, since the same door can appear from two sources.
 */
export class Tiler {
  constructor() {
    this.tiles = new Map()
    this.count = 0
  }
  add(tileRow) {
    const { x, y } = tileFor(tileRow[6], tileRow[7])
    const key = `${x}/${y}`
    let t = this.tiles.get(key)
    if (!t) {
      t = { x, y, rows: [], seen: new Set() }
      this.tiles.set(key, t)
    }
    const dedupe = `${tileRow[0]}|${tileRow[1]}|${tileRow[2] ?? ''}|${tileRow[5]}`.toLowerCase()
    if (t.seen.has(dedupe)) return false
    t.seen.add(dedupe)
    t.rows.push(tileRow)
    this.count++
    return true
  }
  /** Tiles with their rows in street order, so a file reads like a block. */
  *entries() {
    for (const t of this.tiles.values()) {
      const rows = [...t.rows].sort((a, b) => a[1].localeCompare(b[1]) || Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
      yield { x: t.x, y: t.y, key: tileKey(t.x, t.y), rows }
    }
  }
}

/** Does a row group's bbox statistics overlap the wanted box? */
export function groupOverlaps(stats, box) {
  const xmin = stats['bbox.xmin']?.min_value, xmax = stats['bbox.xmax']?.max_value
  const ymin = stats['bbox.ymin']?.min_value, ymax = stats['bbox.ymax']?.max_value
  if ([xmin, xmax, ymin, ymax].some((v) => typeof v !== 'number')) return true // no stats: read it
  return xmin <= box.xmax && xmax >= box.xmin && ymin <= box.ymax && ymax >= box.ymin
}

export function parseBbox(text) {
  const parts = String(text).split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error('--bbox wants minLng,minLat,maxLng,maxLat')
  }
  const [xmin, ymin, xmax, ymax] = parts
  if (xmin >= xmax || ymin >= ymax) throw new Error('--bbox min must be less than max on both axes')
  return { xmin, ymin, xmax, ymax }
}
