import { record } from './audit'
import { erasedAmong } from './erase'
import { pointInPolygon, type LatLng } from './geo'
import { addressKey, propertyIdFor } from './import'
import { repsOf } from './territory-reps'
import type { Env, SessionUser } from './types'

/**
 * The houses inside a territory, and making them leads.
 *
 * Drawing a shape on the map used to claim only the leads that already existed
 * inside it — a manager who outlined fifty houses and got two leads was seeing
 * the two rows a rep had added by hand. Nothing looked up what was on the
 * ground. This does.
 *
 * ## Where the addresses come from
 *
 * Overture Maps' `addresses` theme (OpenAddresses, open-licensed, no key, no
 * per-call bill), cut into map tiles ahead of time by
 * `api/scripts/addresses-build.mjs` and kept in an R2 bucket bound as
 * `ADDRESSES`. Each tile is one JSON array of compact rows for one z14
 * Web-Mercator cell, roughly 2 km across in the continental US, named
 * `v1/14/{x}/{y}.json`. A territory covers a handful of cells; the Worker
 * reads those and runs the same point-in-polygon test the map ran.
 *
 * The binding is optional in the same way PHOTOS is: with no bucket the
 * feature says so, in words, and everything else works as before. Coverage is
 * whatever the operator built — a metro, a county, a state — and a shape drawn
 * outside it finds nothing rather than something wrong.
 *
 * ## What does not become a lead
 *
 * An address that is already a lead in this company, by the same normalised
 * key the import uses (`addressKey`), or that sits within a few metres of an
 * existing lead with the same house number — two spellings of one door. One
 * that was erased, because a homeowner who asked to be forgotten does not come
 * back as a fresh lead the next time somebody draws round their street. And
 * anything past the cap, with a sentence saying so, rather than half a
 * territory silently.
 *
 * There is no residential flag in the data, so a corner shop becomes a lead
 * too. A rep marks it and moves on; that is cheaper than a filter that guesses.
 */

export const TILE_ZOOM = 14
/** More cells than this is a county, not a patch; the shape is refused. */
const MAX_TILES = 96
/** Created per call. Past this the call still succeeds and says what it skipped. */
export const MAX_NEW_LEADS = 5000
/** Two spellings of one door: same house number this close together. */
const SAME_DOOR_METRES = 12

/** One address as the tile holds it: number, street, unit, city, state, zip, lng, lat. */
export type TileRow = [string, string, string | null, string, string, string, number, number]

export interface FoundAddress {
  address1: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  /** The row named a unit (apartment, suite): one door of several at a point. */
  unit: boolean
}

/* --- tiles --------------------------------------------------------------- */

/** Web-Mercator tile holding this point at `z`. The same arithmetic as the tiler. */
export function tileFor(lng: number, lat: number, z = TILE_ZOOM): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) }
}

export const tileKey = (x: number, y: number, z = TILE_ZOOM) => `v1/${z}/${x}/${y}.json`

/** Every tile a polygon's bounding box touches. */
export function tilesCovering(polygon: LatLng[], z = TILE_ZOOM): { x: number; y: number }[] {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const p of polygon) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng)
  }
  const a = tileFor(minLng, maxLat, z) // north-west corner: lowest y
  const b = tileFor(maxLng, minLat, z) // south-east corner
  const out: { x: number; y: number }[] = []
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ x, y })
  return out
}

/* --- reading -------------------------------------------------------------- */

export type Bucket = Pick<R2Bucket, 'get'>

/** A tile's rows, or none: a cell nobody built is empty ground, not an error. */
async function readTile(bucket: Bucket, x: number, y: number): Promise<TileRow[]> {
  const obj = await bucket.get(tileKey(x, y))
  if (!obj) return []
  const parsed: unknown = await obj.json()
  return Array.isArray(parsed) ? (parsed as TileRow[]) : []
}

export type Inside =
  | { addresses: FoundAddress[]; tiles: number }
  | { error: string; status: number; code: 'addresses_not_configured' | 'territory_too_large' }

/** The addresses inside a polygon, de-duplicated by the import's address key. */
export async function addressesInside(env: Pick<Env, 'ADDRESSES'>, polygon: LatLng[]): Promise<Inside> {
  if (!env.ADDRESSES) {
    return {
      error: 'Address data is not set up on this deployment, so the houses inside a territory cannot be looked up yet. See docs/ADDRESSES.md.',
      status: 501,
      code: 'addresses_not_configured',
    }
  }
  const tiles = tilesCovering(polygon)
  if (tiles.length > MAX_TILES) {
    return {
      error: `That territory covers too much ground to look up at once (${tiles.length} map cells; the limit is ${MAX_TILES}). Draw it as two or three smaller ones.`,
      status: 413,
      code: 'territory_too_large',
    }
  }
  const seen = new Set<string>()
  const addresses: FoundAddress[] = []
  // A few at a time: R2 is fast, and a territory is rarely more than a dozen cells.
  for (let i = 0; i < tiles.length; i += 8) {
    const batch = await Promise.all(tiles.slice(i, i + 8).map((t) => readTile(env.ADDRESSES!, t.x, t.y)))
    for (const rows of batch) {
      for (const r of rows) {
        const lng = Number(r[6]), lat = Number(r[7])
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        if (!pointInPolygon({ lat, lng }, polygon)) continue
        const a = toAddress(r, lat, lng)
        if (!a) continue
        const key = addressKey({ ref: '', ...a })
        if (seen.has(key)) continue
        seen.add(key)
        addresses.push(a)
      }
    }
  }
  return { addresses, tiles: tiles.length }
}

/** A tile row as a lead's address, or null when it has no street or number. */
export function toAddress(r: TileRow, lat: number, lng: number): FoundAddress | null {
  const number = String(r[0] ?? '').trim()
  const street = String(r[1] ?? '').trim()
  if (!number || !street) return null
  const unit = r[2] ? String(r[2]).trim() : ''
  return {
    address1: unit ? `${number} ${street} ${unit}` : `${number} ${street}`,
    city: String(r[3] ?? '').trim(),
    state: String(r[4] ?? '').trim(),
    zip: String(r[5] ?? '').trim(),
    lat,
    lng,
    unit: !!unit,
  }
}

/* --- making leads --------------------------------------------------------- */

export interface Generated {
  /** Addresses the data holds inside the shape. */
  found: number
  /** New leads written. */
  created: number
  /** Already leads in this company, by address or by being the same door. */
  existed: number
  /** Erased before, and left that way. */
  erased: number
  /** Past the cap and not written. */
  skipped: number
  tiles: number
}

const houseNumber = (address1: string) => /^\s*(\d+[a-z]?)\b/i.exec(address1)?.[1]?.toLowerCase() ?? null

function metresBetween(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const x = dLng * Math.cos(meanLat), y = dLat
  return Math.sqrt(x * x + y * y) * 6_371_000
}

/** Street suffixes, spelt one way: "Street" and "St" are one suffix, "Ct" and "Dr" are two. */
const SUFFIX: Record<string, string> = {
  street: 'st', str: 'st', st: 'st', avenue: 'av', ave: 'av', av: 'av', drive: 'dr', dr: 'dr',
  road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd', place: 'pl', pl: 'pl', way: 'way', trail: 'trl', trl: 'trl',
  parkway: 'pkwy', pkwy: 'pkwy', cove: 'cv', cv: 'cv', loop: 'loop', terrace: 'ter', ter: 'ter',
}

/** A street as its name and its suffix, without the house number: "12 Oak Ct" is { name: 'oak', suffix: 'ct' }. */
function streetParts(address1: string): { name: string; suffix: string } {
  const words = String(address1 ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/^\s*\d+[a-z]?\s+/, '')
    .split(/\s+/)
    .filter(Boolean)
  const last = words[words.length - 1] ?? ''
  const suffix = SUFFIX[last] ?? ''
  return { name: (suffix ? words.slice(0, -1) : words).join(' '), suffix }
}

/** Edit distance, bounded: only "is it within two" is ever asked. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j]!)
    }
    if (best > max) return false
    prev = cur
  }
  return prev[b.length]! <= max
}

/**
 * Do two addresses name the same street? A typo in the name is allowed —
 * "Insde St" is "Inside St", which is the case the same-door rule exists for
 * — but two different suffixes are two streets: "12 Oak Ct" is not "12 Oak Dr".
 */
function sameStreet(a: { name: string; suffix: string }, b: { name: string; suffix: string }): boolean {
  if (a.suffix && b.suffix && a.suffix !== b.suffix) return false
  if (!a.name || !b.name) return false
  return within(a.name, b.name, Math.min(a.name.length, b.name.length) >= 5 ? 2 : 1)
}

/**
 * Turn the addresses inside a territory into leads.
 *
 * Office roles only, like every other territory write. Re-running it is safe:
 * every address it has already made a lead of is "existed", and the id is the
 * import's deterministic one, so even a race writes one row.
 */
export async function generateLeadsForTerritory(
  env: Env,
  actor: SessionUser,
  territoryId: string,
): Promise<Generated | { error: string; status: number; code?: string }> {
  if (actor.role === 'field_rep') return { error: 'Not permitted.', status: 403 }

  const territory = await env.DB.prepare(
    'SELECT id, name, boundary FROM territories WHERE id = ?1 AND client_id = ?2',
  )
    .bind(territoryId, actor.clientId)
    .first<{ id: string; name: string; boundary: string | null }>()
  if (!territory) return { error: 'No such territory.', status: 404 }

  const boundary = parseBoundaryJson(territory.boundary)
  if (!boundary) {
    return { error: 'This territory has no outline on the map, so there is nothing to look inside. Draw it first.', status: 400, code: 'no_boundary' }
  }

  const inside = await addressesInside(env, boundary)
  if ('error' in inside) return inside

  // Sole rep gets the houses; a shared patch leaves them for the field —
  // the same rule as drawing the territory.
  const reps = await repsOf(env, territoryId)
  const claimFor = reps.length === 1 ? reps[0]! : null

  // Every lead this company has, once, for both duplicate tests.
  const existingRows = await env.DB.prepare(
    'SELECT id, address1, city, state, zip, lat, lng FROM properties WHERE client_id = ?1',
  )
    .bind(actor.clientId)
    .all<{ id: string; address1: string; city: string | null; state: string | null; zip: string | null; lat: number; lng: number }>()
  const existingKeys = new Set<string>()
  const existingIds = new Set<string>()
  const nearby: { lat: number; lng: number; number: string | null; street: { name: string; suffix: string } }[] = []
  for (const p of existingRows.results) {
    existingIds.add(p.id)
    existingKeys.add(addressKey({ ref: '', address1: p.address1, city: p.city ?? undefined, state: p.state ?? undefined, zip: p.zip ?? undefined }))
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, boundary)) {
      nearby.push({ lat: p.lat, lng: p.lng, number: houseNumber(p.address1), street: streetParts(p.address1) })
    }
  }

  /*
    The same door under two spellings: the same house number, on what reads
    as the same street (a typo in the name allowed, a different suffix not),
    within a few metres. Not a unit — a building lists each flat at one
    point, and the first of them to become a lead must not swallow the rest
    — and not "12 Oak Ct" beside "12 Oak Dr".

    The cap is applied here, before the hashing and the erasure check, so a
    dense patch of many tiles costs one bounded pass and a bounded number of
    queries rather than failing outright; what lies past the cap is counted
    as skipped and said so.
  */
  const candidates: { a: FoundAddress; id: string }[] = []
  let existed = 0
  let skipped = 0
  for (const a of inside.addresses) {
    if (existingKeys.has(addressKey({ ref: '', ...a }))) { existed++; continue }
    const n = houseNumber(a.address1)
    const street = streetParts(a.address1)
    if (n && !a.unit && nearby.some((e) => e.number === n && sameStreet(e.street, street) && metresBetween(e, a) <= SAME_DOOR_METRES)) { existed++; continue }
    if (candidates.length >= MAX_NEW_LEADS) { skipped++; continue }
    const id = await propertyIdFor(actor.clientId, { ref: '', ...a })
    if (existingIds.has(id)) { existed++; continue }
    candidates.push({ a, id })
  }

  const erasedIds = await erasedAmong(env, actor.clientId, candidates.map((c) => c.id))
  const toWrite = candidates.filter((c) => !erasedIds.has(c.id))
  const erased = candidates.length - toWrite.length

  const now = Date.now()
  let created = 0
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO properties
       (id, client_id, address1, city, state, zip, lat, lng, status, score,
        territory_id, assigned_rep_id, geo_precision, geo_provider, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',50,?9,?10,'rooftop','overture',?11)`,
  )
  for (let i = 0; i < toWrite.length; i += 100) {
    const batch = toWrite.slice(i, i + 100).map(({ a, id }) =>
      insert.bind(id, actor.clientId, a.address1, a.city || null, a.state || null, a.zip || null, a.lat, a.lng, territoryId, claimFor, now),
    )
    const results = await env.DB.batch(batch)
    for (const r of results) created += r.meta.changes ?? 0
  }
  // Two presses at once: the ids are deterministic and the insert ignores a
  // row that is already there, so the one that lost the race wrote nothing —
  // those houses are "already there", not nowhere.
  existed += toWrite.length - created

  await record(env, actor, {
    action: 'territory.generated',
    targetType: 'territory',
    targetId: territoryId,
    targetLabel: territory.name,
    detail: { found: inside.addresses.length, created, existed, erased, skipped, tiles: inside.tiles, repId: claimFor },
  })

  return { found: inside.addresses.length, created, existed, erased, skipped, tiles: inside.tiles }
}

function parseBoundaryJson(raw: string | null): LatLng[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 3) return null
    const pts = parsed
      .map((p: { lat?: unknown; lng?: unknown }) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    return pts.length >= 3 ? pts : null
  } catch {
    return null
  }
}
