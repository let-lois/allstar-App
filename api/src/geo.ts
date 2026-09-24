/**
 * The geometry the import needs to put a lead in the right patch.
 *
 * A deliberate copy of the two functions in `src/lib/geo.ts` rather than a
 * shared module. The Worker is its own package with its own tsconfig and its own
 * bundle; reaching into the browser app's module graph to borrow forty lines
 * would couple the two builds for the rest of the project's life, and the client
 * copy runs on every frame of a manager dragging out a territory, which is not a
 * constraint this side should inherit.
 *
 * Copies drift. That is the real cost, and it is the one thing gated:
 * `verify:geo-parity` runs both implementations over the same fixtures and fails
 * if they ever disagree. Change one, change the other, or find out immediately.
 */

export interface LatLng {
  lat: number
  lng: number
}

/**
 * Is this point inside the polygon?
 *
 * Ray casting: count how many edges a ray from the point crosses; odd means
 * inside.
 *
 * Flat rather than spherical, like the client's copy. A sales territory is a few
 * miles across and over that distance the error from ignoring the curve is
 * centimetres. The antimeridian is not handled for the same reason — a territory
 * spanning it is not a territory anybody walks.
 *
 * Points exactly on an edge are not guaranteed either way. Inherent to the
 * method, and harmless: a lead on the line of a hand-drawn patch is one the
 * person drawing it had no opinion about.
 */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside
    }
  }
  return inside
}

/** Shoelace area, scaled to miles at the polygon's own latitude. */
export function polygonAreaSqMiles(polygon: LatLng[]): number {
  if (polygon.length < 3) return 0
  const meanLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length
  const milesPerDegLat = 69.0
  const milesPerDegLng = 69.172 * Math.cos((meanLat * Math.PI) / 180)
  let sum = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j].lng * polygon[i].lat - polygon[i].lng * polygon[j].lat
  }
  return Math.abs(sum / 2) * milesPerDegLat * milesPerDegLng
}

export interface TerritoryShape {
  id: string
  repId: string | null
  boundary: LatLng[]
  /** Cached so an import of 500 rows measures each polygon once, not 500 times. */
  areaSqMiles: number
}

/**
 * Parse the stored boundary JSON into something worth matching against.
 *
 * Anything that is not a usable ring is dropped rather than repaired. A
 * territory with a two-point boundary or a null in the middle of it is a bug
 * somewhere else, and guessing what the manager meant would put real leads in a
 * patch nobody drew.
 */
export function parseBoundary(raw: unknown): LatLng[] | null {
  if (typeof raw !== 'string' || !raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return null
  const points: LatLng[] = []
  for (const p of parsed) {
    if (!p || typeof p !== 'object') return null
    const { lat, lng } = p as { lat?: unknown; lng?: unknown }
    if (typeof lat !== 'number' || typeof lng !== 'number') return null
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    points.push({ lat, lng })
  }
  return points
}

/**
 * Which drawn territory contains this point.
 *
 * Smallest first, so overlaps resolve to the most specific patch. Managers do
 * overlap territories — a downtown patch carved out of a city-wide one is the
 * normal case, not a mistake — and "the bigger one wins" would put every
 * downtown lead in the city-wide bucket, which is the answer nobody wants.
 *
 * Returns null for a point in nothing, which stays unassigned rather than being
 * pushed into the nearest patch. A lead ten miles outside every territory
 * belongs to a person deciding, not to whichever polygon happened to be closest.
 */
export function territoryFor(point: LatLng, shapes: TerritoryShape[]): TerritoryShape | null {
  let best: TerritoryShape | null = null
  for (const shape of shapes) {
    if (!pointInPolygon(point, shape.boundary)) continue
    if (!best) {
      best = shape
      continue
    }
    if (shape.areaSqMiles < best.areaSqMiles) {
      best = shape
      continue
    }
    /*
      Two patches of the same size over the same lead.

      Rare but not impossible — a territory duplicated and nudged, or two
      managers drawing the same block — and without a tie-break the winner is
      whichever row the database happened to return first. That is stable enough
      to look fine in testing and free to change under a re-import, which means
      leads quietly moving between reps with nothing in the audit log to explain
      it. Ordering by id makes the answer boring and repeatable.
    */
    if (shape.areaSqMiles === best.areaSqMiles && shape.id < best.id) best = shape
  }
  return best
}

/* --- bearing and metric distance ------------------------------------------
 *
 * The second pair of copies, and they are here for Street View.
 *
 * `streetViewAt` finds the nearest panorama to a house and then has to point
 * the camera at the house — which is a bearing from one coordinate to another,
 * and a check that the two are far enough apart for that bearing to mean
 * anything. Both are spherical rather than flat, unlike `pointInPolygon` above:
 * these run over tens of metres, where the flat approximation's error is a
 * fraction of a degree, but they also run over a lead geocoded to the wrong
 * continent, where it is not. Cheap to do properly, so done properly.
 *
 * Copied from `packages/core/src/geo.ts` for the reason at the top of this
 * file, and held to it the same way: `verify:geo-parity` runs both over the
 * same fixtures.
 */

const EARTH_RADIUS_M = 6_371_008.8

const toRad = (deg: number) => (deg * Math.PI) / 180

/**
 * Initial great-circle bearing from `a` to `b`, in degrees.
 *
 * Signed the way `Math.atan2` returns it, −180 to 180. Street View's `heading`
 * parameter takes 0–360 and treats them as the same circle, so the caller
 * normalises rather than this — a bearing is a bearing, and the wrapping is the
 * API's convention, not the geometry's.
 */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return (Math.atan2(y, x) * 180) / Math.PI
}

/** Great-circle distance in metres — the unit Street View's `radius` is in. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat))
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}
