const EARTH_RADIUS_MI = 3958.8

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in miles. */
export function distanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Distance phrased the way a rep reads it while walking: feet up close, then
 * tenths of a mile. Never "0.03 mi".
 */
/** The plain centroid of some points — where a map should look to see all of them. */
export function centerOf(points: { lat: number; lng: number }[]): { lat: number; lng: number } {
  const n = points.length || 1
  return {
    lat: points.reduce((a, p) => a + p.lat, 0) / n,
    lng: points.reduce((a, p) => a + p.lng, 0) / n,
  }
}

export function formatDistance(miles: number): string {
  if (!Number.isFinite(miles)) return '—'
  const feet = miles * 5280
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`
  if (miles < 10) return `${miles.toFixed(1)} mi`
  // Grouped above a thousand. Reps never see these numbers walking a street —
  // they show up when someone opens a lead from another country, and "8472 mi"
  // has to be read twice to be believed.
  return `${Math.round(miles).toLocaleString('en-US')} mi`
}

/** Rough walking ETA — reps move door to door, not at driving speed. */
export function walkMinutes(miles: number): number {
  return Math.max(1, Math.round((miles / 3.1) * 60))
}

export function bearing(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return (Math.atan2(y, x) * 180) / Math.PI
}

/**
 * The direct path between two points on the globe, sampled.
 *
 * For the navigate screen when the rep is nowhere near the door — another state,
 * another country. There is no driving route to draw and no honest walking time
 * to quote, but "you are 8,472 miles away, and it is that way" is real
 * information, and a line on a world map says it faster than a sentence does.
 *
 * **Why sampled rather than a two-point line.** A straight line on a Mercator
 * map is not the direct path, and at this scale the difference is thousands of
 * miles. Manila to Austin looks like it should cut across the middle of the
 * Pacific; the actual shortest path passes north of Japan and clips Alaska.
 * Drawing the chord would be a picture of a route that does not exist, which is
 * the same class of small lie as calling a straight-line distance a walk.
 *
 * Sampling also keeps the renderer dumb. Consecutive points are close enough
 * that any map joins them the short way round, so the line crosses the
 * antimeridian without special handling and the samples double as the bounds to
 * frame — which a two-point line cannot do, because the arc bulges outside the
 * box its endpoints describe.
 *
 * Computed here, locally, for the same reason as `distanceMiles`: it is
 * arithmetic. It costs no request, needs no key, and works with no signal.
 */
export function greatCirclePath(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  samples = 64,
): { lat: number; lng: number }[] {
  const φ1 = toRad(a.lat)
  const λ1 = toRad(a.lng)
  const φ2 = toRad(b.lat)
  const λ2 = toRad(b.lng)

  // Angular separation. Below this the two points are the same place to within
  // a metre or so, and the interpolation below divides by sin(d).
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((φ2 - φ1) / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
        ),
      ),
    )
  if (!Number.isFinite(d) || d < 1e-9) {
    return [
      { lat: a.lat, lng: a.lng },
      { lat: b.lat, lng: b.lng },
    ]
  }

  const n = Math.max(2, Math.round(samples))
  const out: { lat: number; lng: number }[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    out.push({
      lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
      lng: (Math.atan2(y, x) * 180) / Math.PI,
    })
  }
  // Exact at both ends. The interpolation is accurate to well under a metre,
  // but the endpoints are a door and a rep, and those two should be *the* two
  // points rather than very close to them.
  out[0] = { lat: a.lat, lng: a.lng }
  out[out.length - 1] = { lat: b.lat, lng: b.lng }
  return out
}

/**
 * Is this point inside the polygon?
 *
 * Ray casting: count how many edges a ray from the point crosses. Odd means
 * inside. It is the standard method and it is a few lines, which matters here
 * because it runs once per lead per redraw — a manager dragging out a patch over
 * three thousand leads wants the count under their finger to keep up.
 *
 * Treated as flat rather than spherical on purpose. A sales territory is a few
 * miles across; over that distance the error from ignoring the curve is
 * centimetres, and the alternative costs trigonometry per edge per point. The
 * antimeridian is not handled for the same reason — a territory that spans it is
 * not a territory anybody walks.
 *
 * Points exactly on an edge are not guaranteed either way. That is inherent to
 * the method and harmless: a lead on the boundary line of a hand-drawn patch is
 * a lead the person drawing it did not have an opinion about.
 */
export function pointInPolygon(
  point: { lat: number; lng: number },
  polygon: { lat: number; lng: number }[],
): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    // Does the edge straddle the point's latitude, and if so, is the crossing
    // east of the point?
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Rough area in square miles, for telling somebody their patch is too big.
 *
 * The shoelace formula on degrees, scaled by the length of a degree at the
 * polygon's own latitude. Rough is the right word and the right answer: this
 * exists to say "that is 40 square miles, are you sure", not to bill anyone.
 */
export function polygonAreaSqMiles(polygon: { lat: number; lng: number }[]): number {
  if (polygon.length < 3) return 0
  const meanLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length
  const milesPerDegLat = 69.0
  const milesPerDegLng = 69.172 * Math.cos(toRad(meanLat))
  let sum = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j].lng * polygon[i].lat - polygon[i].lng * polygon[j].lat
  }
  return Math.abs(sum / 2) * milesPerDegLat * milesPerDegLng
}

/* --- Web Mercator, used by the in-app map renderer ----------------------- */

export function project(lat: number, lng: number) {
  const x = (lng + 180) / 360
  const s = Math.sin(toRad(lat))
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
  return { x, y }
}

export function unproject(x: number, y: number) {
  const lng = x * 360 - 180
  const n = Math.PI * (1 - 2 * y)
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lat, lng }
}
