import { pointInPolygon, polygonAreaSqMiles } from './geo'

/**
 * Turning a finger's trace into a territory outline, and the leads inside it.
 *
 * Pure arithmetic with no DOM and no map library, so the web app, the console and
 * the React Native app share it and a Node gate can drive every case — the
 * browser part (`FreehandLayer`) only records where the finger went.
 *
 * ## Two stages, because the units differ
 *
 * **`prepareTrace` works in screen pixels.** A finger leaves hundreds of points a
 * second; most are noise. They are thinned and simplified *before* being turned
 * into coordinates, in pixels, so the amount of simplification feels the same at
 * every zoom and so the cost on a low-end phone is a few hundred cheap distance
 * checks rather than a projection per sample.
 *
 * **`buildOutline` works in latitude and longitude.** The simplified vertices are
 * converted once and then judged where it matters: is there an area, does the
 * line cross itself, does it fit the server's limits. Crossing tests are
 * unchanged by stretching an axis, so testing in degrees is exact; only lengths
 * and areas need the cosine of the latitude, and are given it.
 *
 * ## Limits it has to respect
 *
 * `api/src/territories.ts` accepts 3–200 points, finite, on Earth. A freehand
 * trace is simplified to at most `FREEHAND_MAX_VERTICES`, well under the ceiling,
 * so a long stroke can never be refused for its length.
 *
 * Which leads count as "inside" is the same even-odd test the server runs
 * (`pointInPolygon`, kept in step by `verify:geo-parity`), so the count a manager
 * sees is the count the selection gets. A lead sitting exactly on the line is a
 * lead the person drawing it had no opinion about; the territory import also
 * claims leads within a few metres of the line, so a saved territory can hold a
 * handful more than the preview said — never fewer.
 */

export interface LatLng {
  lat: number
  lng: number
}
export interface ScreenPoint {
  x: number
  y: number
}

/** A point is kept only if the finger has moved at least this far from the last. */
export const FREEHAND_SAMPLE_PX = 3
/** Shorter than this is a tap or a twitch, not an outline. */
export const FREEHAND_MIN_TRACE_PX = 30
/** How closely the simplified line must follow the trace. */
export const FREEHAND_SIMPLIFY_PX = 2
/** Well under the server's 200, so the limit is never what stops somebody. */
export const FREEHAND_MAX_VERTICES = 120
/** About 100 square metres: smaller than a house lot, so a scribble and not an area. */
export const FREEHAND_MIN_AREA_SQ_MILES = 0.00004
/**
 * How much of the line may be cut off to remove an overshoot.
 *
 * Closing a loop by hand usually runs past the start and crosses the beginning of
 * the line. Cutting the tail that sticks out is what the person meant; cutting a
 * quarter of the drawing to make it valid is a guess, so past this it is refused
 * and they redraw.
 */
export const FREEHAND_MAX_TRIM_FRACTION = 0.25
/** The server's ceiling, restated here so a caller can check without importing the Worker. */
export const OUTLINE_MAX_POINTS = 200

const EPS = 1e-9

const gap = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y)

export function pathLength(points: readonly ScreenPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += gap(points[i - 1], points[i])
  return total
}

/** Drop samples closer than `minGap` to the last one kept. First and last always survive. */
export function thinTrace<T extends ScreenPoint>(points: readonly T[], minGap = FREEHAND_SAMPLE_PX): T[] {
  if (points.length === 0) return []
  const out: T[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    if (gap(out[out.length - 1], points[i]) >= minGap) out.push(points[i])
  }
  if (points.length > 1) {
    const last = points[points.length - 1]
    const prev = out[out.length - 1]
    if (last.x !== prev.x || last.y !== prev.y) out.push(last)
  }
  return out
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return gap(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Douglas–Peucker, iterative.
 *
 * Not recursive: a long stroke on a slow phone must not be able to run the stack
 * out, and an explicit stack is no harder to read.
 */
export function simplifyPath<T extends ScreenPoint>(points: readonly T[], epsilon: number): T[] {
  const n = points.length
  if (n < 3) return [...points]
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    let far = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(points[i], points[a], points[b])
      if (d > far) {
        far = d
        at = i
      }
    }
    if (at >= 0 && far > epsilon) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** Simplify, loosening the tolerance until the result fits `maxVertices`. */
export function simplifyToLimit<T extends ScreenPoint>(
  points: readonly T[],
  maxVertices = FREEHAND_MAX_VERTICES,
  epsilon = FREEHAND_SIMPLIFY_PX,
): T[] {
  let tolerance = epsilon
  let out = simplifyPath(points, tolerance)
  for (let i = 0; i < 40 && out.length > maxVertices; i++) {
    tolerance *= 1.4
    out = simplifyPath(points, tolerance)
  }
  return out
}

export type TraceResult<T extends ScreenPoint = ScreenPoint> =
  | { ok: true; points: T[] }
  | { ok: false; reason: OutlineProblem; message: string }

/**
 * A raw finger trace, thinned and simplified, or the reason it cannot be an outline.
 *
 * Fewer than three vertices after simplification is a straight line — it has no
 * inside — and is reported as too small rather than as too short, because the
 * person dragged a long way and the useful answer is "draw round something".
 */
export function prepareTrace<T extends ScreenPoint>(raw: readonly T[]): TraceResult<T> {
  const thin = thinTrace(raw)
  if (thin.length < 2 || pathLength(thin) < FREEHAND_MIN_TRACE_PX) return fail('too_short')
  const points = simplifyToLimit(thin)
  if (points.length < 3) return fail('too_small')
  return { ok: true, points }
}

/* --- the outline, in coordinates ------------------------------------------ */

export type OutlineProblem =
  | 'invalid'
  | 'too_short'
  | 'too_small'
  | 'crosses_itself'
  | 'crosses_dateline'
  | 'too_many'

export const OUTLINE_MESSAGES: Record<OutlineProblem, string> = {
  invalid: "That outline couldn't be read. Try drawing it again.",
  too_short: 'That was too short to be an outline. Drag all the way round the area.',
  too_small: 'That outline is too small or too flat. Draw round a bigger area.',
  crosses_itself: 'The outline crosses itself. Draw it again without crossing your own line.',
  crosses_dateline: 'That outline is too large. Draw a smaller area.',
  too_many: 'That outline has too many points. Draw it again with a smoother line.',
}

function fail(reason: OutlineProblem): { ok: false; reason: OutlineProblem; message: string } {
  return { ok: false, reason, message: OUTLINE_MESSAGES[reason] }
}

export type OutlineResult =
  | { ok: true; outline: LatLng[]; areaSqMiles: number; trimmed: boolean }
  | { ok: false; reason: OutlineProblem; message: string }

/** x is longitude, y is latitude: orientation is unchanged by stretching either axis. */
function orient(a: LatLng, b: LatLng, c: LatLng): number {
  return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng)
}

/**
 * Orientations smaller than this are treated as zero.
 *
 * Points that are in a line in the drawing are not in a line to the last bit once
 * they have been through a projection, and the leftover noise (around 1e-19)
 * would otherwise read as a crossing — so a flat scribble would be reported as
 * "crosses itself" when the useful answer is "too flat". Real crossings in a
 * drawing as small as one metre across are several orders of magnitude larger.
 */
const ORIENT_EPS = 1e-13
const side = (v: number) => (v > ORIENT_EPS ? 1 : v < -ORIENT_EPS ? -1 : 0)

/** Do the segments cross at a point interior to both? Touching ends and overlap do not count. */
export function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  return (
    side(orient(a, b, c)) * side(orient(a, b, d)) < 0 && side(orient(c, d, a)) * side(orient(c, d, b)) < 0
  )
}

function crossingPoint(a: LatLng, b: LatLng, c: LatLng, d: LatLng): LatLng {
  const d1 = { lat: b.lat - a.lat, lng: b.lng - a.lng }
  const d2 = { lat: d.lat - c.lat, lng: d.lng - c.lng }
  const denom = d1.lng * d2.lat - d1.lat * d2.lng
  const t = ((c.lng - a.lng) * d2.lat - (c.lat - a.lat) * d2.lng) / denom
  return { lat: a.lat + t * d1.lat, lng: a.lng + t * d1.lng }
}

/** Does any edge of the closed ring cross a non-neighbouring edge? */
export function selfIntersects(ring: readonly LatLng[]): boolean {
  const n = ring.length
  if (n < 4) return false
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      // Edge 0 and the closing edge share a vertex; they are neighbours.
      if (i === 0 && j === n - 1) continue
      if (segmentsCross(a, b, ring[j], ring[(j + 1) % n])) return true
    }
  }
  return false
}

/** Length of a run of coordinates, east–west distances scaled by the latitude. */
function runLength(points: readonly LatLng[]): number {
  if (points.length < 2) return 0
  const k = Math.cos((points[0].lat * Math.PI) / 180)
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot((points[i].lng - points[i - 1].lng) * k, points[i].lat - points[i - 1].lat)
  }
  return total
}

/**
 * Cut off the tail that overshoots the start.
 *
 * The line a finger draws is open; the shape closes itself. Running past the
 * start crosses the opening of the line, which would otherwise make the whole
 * outline "cross itself". When there is exactly one crossing, and cutting at it
 * removes only a small part of the drawing, the overshoot is removed and the
 * outline starts and ends at the crossing. Anything more tangled is left alone
 * for `selfIntersects` to refuse.
 */
export function trimClosingLoop(points: readonly LatLng[]): { points: LatLng[]; trimmed: boolean } {
  const n = points.length
  if (n < 4) return { points: [...points], trimmed: false }
  const found: [number, number][] = []
  for (let j = 0; j < n - 1 && found.length < 2; j++) {
    for (let m = j + 2; m < n - 1 && found.length < 2; m++) {
      if (segmentsCross(points[j], points[j + 1], points[m], points[m + 1])) found.push([j, m])
    }
  }
  if (found.length !== 1) return { points: [...points], trimmed: false }
  const [j, m] = found[0]
  const x = crossingPoint(points[j], points[j + 1], points[m], points[m + 1])
  const cut = runLength([...points.slice(0, j + 1), x]) + runLength([x, ...points.slice(m + 1)])
  const total = runLength(points)
  if (total === 0 || cut / total > FREEHAND_MAX_TRIM_FRACTION) return { points: [...points], trimmed: false }
  return { points: [x, ...points.slice(j + 1, m + 1)], trimmed: true }
}

/**
 * The outline for a set of coordinates, or why it cannot be one.
 *
 * Takes the open line the finger drew (the closing edge is implied) and returns
 * it ready to store: valid, free of crossings, with an area. A returned outline
 * always satisfies the server's checks for a territory.
 */
export function buildOutline(raw: readonly LatLng[]): OutlineResult {
  if (!Array.isArray(raw)) return fail('invalid')
  const cleaned: LatLng[] = []
  for (const p of raw) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return fail('invalid')
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return fail('invalid')
    const last = cleaned[cleaned.length - 1]
    if (last && Math.abs(last.lat - p.lat) < EPS && Math.abs(last.lng - p.lng) < EPS) continue
    cleaned.push({ lat: p.lat, lng: p.lng })
  }
  // A trace that ends where it began is closed already; the closing edge is implied.
  if (cleaned.length > 1) {
    const a = cleaned[0]
    const b = cleaned[cleaned.length - 1]
    if (Math.abs(a.lat - b.lat) < EPS && Math.abs(a.lng - b.lng) < EPS) cleaned.pop()
  }
  if (cleaned.length < 3) return fail('too_short')
  if (cleaned.length > OUTLINE_MAX_POINTS) return fail('too_many')

  // Longitude wraps; the stored shape and the server's test do not. A shape that
  // spans more than half the world is across the date line or not a patch at all.
  const lngs = cleaned.map((p) => p.lng)
  if (Math.max(...lngs) - Math.min(...lngs) > 180) return fail('crosses_dateline')

  const trimmed = trimClosingLoop(cleaned)
  const outline = trimmed.points
  if (outline.length < 3) return fail('too_small')
  if (selfIntersects(outline)) return fail('crosses_itself')

  const areaSqMiles = polygonAreaSqMiles(outline)
  if (!(areaSqMiles >= FREEHAND_MIN_AREA_SQ_MILES)) return fail('too_small')
  return { ok: true, outline, areaSqMiles, trimmed: trimmed.trimmed }
}

/**
 * The items whose coordinates fall inside the outline.
 *
 * Leads without usable coordinates are skipped rather than counted. A bounding
 * box rules out most of a large list before the exact test runs.
 */
export function pointsInside<T extends LatLng>(items: readonly T[], outline: readonly LatLng[]): T[] {
  if (outline.length < 3) return []
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of outline) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  const ring = outline as LatLng[]
  const out: T[] = []
  for (const item of items) {
    const { lat, lng } = item
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue
    if (pointInPolygon(item, ring)) out.push(item)
  }
  return out
}

/**
 * An area a person can picture. Acres below half a square mile, because "0.04 sq
 * mi" means nothing standing on a street and "26 acres" does; square miles above.
 */
export function formatArea(sqMiles: number): string {
  if (!Number.isFinite(sqMiles) || sqMiles <= 0) return '0 acres'
  if (sqMiles < 0.5) {
    const acres = Math.max(1, Math.round(sqMiles * 640))
    return `${acres.toLocaleString('en-US')} ${acres === 1 ? 'acre' : 'acres'}`
  }
  return `${sqMiles < 10 ? sqMiles.toFixed(1) : Math.round(sqMiles).toLocaleString('en-US')} sq mi`
}
