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

/** The lng/lat box one tile covers — the inverse of tileFor. */
export function tileBounds(x, y, z = TILE_ZOOM) {
  const n = 2 ** z
  const lng = (i) => (i / n) * 360 - 180
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI
  return { xmin: lng(x), xmax: lng(x + 1), ymin: lat(y + 1), ymax: lat(y) }
}

/**
 * Widen a box to the whole tiles it touches. A build keeps every row inside
 * this, not the box as typed: a tile written from a box that cut through it
 * would hold half its houses, and the next build over the neighbouring box
 * would overwrite it with the other half.
 */
export function snapBoxToTiles(box, z = TILE_ZOOM) {
  const nw = tileFor(box.xmin, box.ymax, z)
  const se = tileFor(box.xmax, box.ymin, z)
  const a = tileBounds(nw.x, nw.y, z)
  const b = tileBounds(se.x, se.y, z)
  return { xmin: a.xmin, ymin: b.ymin, xmax: b.xmax, ymax: a.ymax, tiles: { x0: nw.x, y0: nw.y, x1: se.x, y1: se.y } }
}

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
 * Where a county's address file keeps each part, as `--fields` names them:
 * "number=ADDNUM,street=STREETNAME,unit=UNIT,city=CITY,zip=ZIP". Or one
 * `address` field holding "123 Main St" whole, split at the first space.
 */
export function parseFieldMap(text) {
  const map = {}
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=').map((s) => s?.trim())
    if (!k || !v) throw new Error(`--fields wants key=FIELD pairs, got "${part}"`)
    if (!['number', 'street', 'unit', 'city', 'state', 'zip', 'address'].includes(k)) throw new Error(`--fields does not know "${k}"`)
    map[k] = v
  }
  if (!map.address && !(map.number && map.street)) throw new Error('--fields needs number= and street=, or address=')
  return map
}

/** The point a feature stands for: a Point as is, a polygon (a parcel) by its first ring's average. */
function pointOf(geometry) {
  if (!geometry) return null
  if (geometry.type === 'Point') return geometry.coordinates
  const ring = geometry.type === 'Polygon' ? geometry.coordinates?.[0] : geometry.type === 'MultiPolygon' ? geometry.coordinates?.[0]?.[0] : null
  if (!Array.isArray(ring) || !ring.length) return null
  const pts = ring.slice(0, ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined)
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
}

/**
 * A GeoJSON feature from a county's address file as a tile row, or null when
 * it has no number, street or point. Coordinates must be WGS84 lng/lat (an
 * ArcGIS query with f=geojson returns that).
 */
export function featureToTileRow(feature, map, defaults = {}) {
  const pr = feature?.properties ?? {}
  const get = (k) => (map[k] ? str(pr[map[k]]) : '')
  let number = get('number'), street = get('street')
  if (map.address) {
    const m = /^\s*(\d+[a-z]?(?:-\d+)?)\s+(.+)$/i.exec(get('address'))
    if (m) { number = m[1]; street = m[2] }
  }
  if (!number || !street || number === '0') return null
  const c = pointOf(feature.geometry)
  if (!c) return null
  const lng = Number(c[0]), lat = Number(c[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return [number, street, get('unit') || null, get('city') || str(defaults.city), get('state') || str(defaults.state), get('zip') || str(defaults.zip), round(lng), round(lat)]
}

/*
  A street name in one canonical spelling, for telling whether two sources
  name the same door. Overture writes "Northeast 78th Street"; a county file
  writes "NE 78TH ST". Compared as written, the two were two rows — and two
  leads for one house once a territory was drawn over them.
*/
const DIRS = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' }
const TYPES = {
  street: 'st', str: 'st', avenue: 'ave', av: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', circle: 'cir',
  boulevard: 'blvd', place: 'pl', trail: 'trl', parkway: 'pkwy', terrace: 'ter', highway: 'hwy', way: 'way',
  loop: 'loop', square: 'sq', crossing: 'xing', point: 'pt', ridge: 'rdg', heights: 'hts', run: 'run', path: 'path',
}
export function canonStreet(street) {
  return String(street ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => DIRS[w] ?? TYPES[w] ?? w)
    .join(' ')
}

/**
 * Sort rows into tiles. Rows are de-duplicated on number+street+unit+zip
 * within a tile, since the same door can appear from two sources; the street
 * is compared in its canonical spelling (`canonStreet`), and the first source
 * added — Overture, in a build — is the row that is kept.
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
    const dedupe = `${tileRow[0]}|${canonStreet(tileRow[1])}|${tileRow[2] ?? ''}|${String(tileRow[5] ?? '').slice(0, 5)}`.toLowerCase()
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

/* --- rooftops ------------------------------------------------------------- */

/**
 * Building tiles sit beside the address tiles under their own prefix:
 * `b1/14/{x}/{y}.json`, each an array of `[lng, lat, kind]`.
 *
 *   'r'  a house or other home (Overture subtype residential, or a home class)
 *   'u'  unclassified, house-sized: most American houses in the data
 *   'n'  not a home: commercial, industrial, civic, a church, a school, or an
 *        unclassified footprint too big to be one house
 *
 * Sheds, garages and other outbuildings are dropped at build time.
 */
export const buildingKey = (x, y, z = TILE_ZOOM) => `b1/${z}/${x}/${y}.json`

const HOME_CLASSES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'apartments', 'bungalow', 'dormitory', 'farm', 'houseboat', 'static_caravan', 'cabin', 'trullo', 'stilt_house', 'ger'])
const OUTBUILDINGS = new Set(['garage', 'garages', 'shed', 'carport', 'hut', 'outbuilding', 'barn', 'greenhouse', 'roof', 'boathouse', 'storage_tank', 'silo', 'kiosk', 'toilets', 'service', 'transformer_tower', 'bunker'])
/** Smallest footprint that is a dwelling rather than a shed, and largest that is one house. */
const MIN_HOME_M2 = 30
const MAX_HOUSE_M2 = 2500

/** An Overture building row as [lng, lat, kind], or null for an outbuilding or a row with no box. */
export function buildingRow(row) {
  const b = row?.bbox
  if (!b || ![b.xmin, b.xmax, b.ymin, b.ymax].every((v) => Number.isFinite(Number(v)))) return null
  const subtype = row.subtype ? String(row.subtype) : ''
  const cls = row.class ? String(row.class) : ''
  if (subtype === 'outbuilding' || OUTBUILDINGS.has(cls)) return null
  const lng = (Number(b.xmin) + Number(b.xmax)) / 2
  const lat = (Number(b.ymin) + Number(b.ymax)) / 2
  const w = (Number(b.xmax) - Number(b.xmin)) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const h = (Number(b.ymax) - Number(b.ymin)) * 110_540
  const area = Math.abs(w * h)
  let kind
  if (subtype === 'residential' || HOME_CLASSES.has(cls)) kind = area < MIN_HOME_M2 ? null : 'r'
  else if (subtype || cls) kind = 'n'
  else kind = area < MIN_HOME_M2 ? null : area > MAX_HOUSE_M2 ? 'n' : 'u'
  if (!kind) return null
  return [round(lng), round(lat), kind]
}

/** The United States as boxes: the lower 48, Alaska, Hawaii, Puerto Rico and the Virgin Islands. */
export const US_BOXES = [
  { xmin: -125.0, ymin: 24.3, xmax: -66.9, ymax: 49.5 },
  { xmin: -179.3, ymin: 51.1, xmax: -129.9, ymax: 71.6 },
  { xmin: -160.4, ymin: 18.8, xmax: -154.7, ymax: 22.4 },
  { xmin: -67.4, ymin: 17.8, xmax: -64.5, ymax: 18.6 },
]
export const inUS = (lng, lat) => US_BOXES.some((b) => lng >= b.xmin && lng <= b.xmax && lat >= b.ymin && lat <= b.ymax)
export const US_COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'AS', 'MP'])

/* --- Census TIGER street ranges ---------------------------------------------- */

/**
 * Street segments with house-number ranges, from the Census Bureau's TIGER/Line
 * ADDRFEAT files (public domain; free to keep, use commercially and
 * redistribute). Tiles `r1/14/{x}/{y}.json`, each row
 *
 *   [street, leftFrom, leftTo, rightFrom, rightTo, zipLeft, zipRight, state, [lng, lat, lng, lat, ...]]
 *
 * These are *potential* ranges — the numbers a block could hold, not the
 * houses that exist — so an address made from one is marked INTERPOLATED and
 * is only ever put on a real rooftop.
 */
export const rangeKey = (x, y, z = TILE_ZOOM) => `r1/${z}/${x}/${y}.json`

const STATE_BY_FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI' }
export const stateForFips = (fips) => STATE_BY_FIPS[String(fips).slice(0, 2)] ?? ''

const num = (v) => {
  const t = String(v ?? '').trim()
  return /^\d{1,6}$/.test(t) ? Number(t) : null
}

/**
 * One ADDRFEAT feature as a range row, or null when it has no street name or
 * no numeric range on either side. Multi-part lines become their first part:
 * ADDRFEAT edges are single lines in practice.
 */
export function rangeRow(feature, countyFips) {
  const p = feature?.properties ?? {}
  const name = String(p.FULLNAME ?? '').trim()
  if (!name) return null
  const lf = num(p.LFROMHN), lt = num(p.LTOHN), rf = num(p.RFROMHN), rt = num(p.RTOHN)
  if ((lf === null || lt === null) && (rf === null || rt === null)) return null
  const g = feature.geometry
  const line = g?.type === 'LineString' ? g.coordinates : g?.type === 'MultiLineString' ? g.coordinates?.[0] : null
  if (!Array.isArray(line) || line.length < 2) return null
  const flat = []
  for (const c of line) { flat.push(round(Number(c[0])), round(Number(c[1]))) }
  if (flat.some((v) => !Number.isFinite(v))) return null
  return [name, lf, lt, rf, rt, String(p.ZIPL ?? '').trim(), String(p.ZIPR ?? '').trim(), stateForFips(countyFips), flat]
}

/** The z14 tiles a range row's bounding box touches (a street can cross a tile edge). */
export function tilesForRange(row) {
  const pts = row[8]
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]) }
  const nw = tileFor(x0, y1), se = tileFor(x1, y0)
  const out = []
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ x, y })
  return out
}
