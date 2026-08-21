import { distanceMiles, formatDistance, greatCirclePath } from '../src/lib/geo.ts'

/**
 * The direct line, as maths.
 *
 * Unlike every other gate here this one runs no browser, because the thing that
 * can be wrong is arithmetic. Node imports the module under test directly — type
 * stripping, no build step — so this asserts the real function rather than a
 * copy of it, which is the only version of this test worth having.
 *
 * The property that matters is not "a line appears". It is that the line is the
 * *great circle* and not the straight line a Mercator map invites. Those differ
 * by thousands of miles on exactly the journeys this feature exists for: the
 * shortest path from Manila to Austin passes near the Aleutians, roughly 22
 * degrees of latitude north of either end. A chord drawn between the two would
 * cross the mid-Pacific and be a picture of a route nobody flies.
 *
 * So the checks are the ones that can tell those two lines apart, plus the ones
 * that keep a renderer from having to think: no jump across the antimeridian, no
 * NaN, and endpoints that are exactly the rep and exactly the door.
 */

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

const MANILA = { lat: 14.5995, lng: 120.9842 }
const AUSTIN = { lat: 30.5083, lng: -97.6789 }
const CHICAGO = { lat: 41.8781, lng: -87.6298 }
/** Two doors on the same street — the near case, which must not misbehave. */
const DOOR_A = { lat: 30.5083, lng: -97.6789 }
const DOOR_B = { lat: 30.5091, lng: -97.6771 }

/** Length of the drawn polyline, summed segment by segment. */
const walked = (path) =>
  path.slice(1).reduce((sum, p, i) => sum + distanceMiles(path[i], p), 0)

/** Largest longitude step, measured the short way round. */
const biggestStep = (path) =>
  path.slice(1).reduce((max, p, i) => {
    const raw = Math.abs(p.lng - path[i].lng)
    return Math.max(max, raw > 180 ? 360 - raw : raw)
  }, 0)

/* --- the intercontinental case, which is what this is for ----------------- */
{
  const path = greatCirclePath(MANILA, AUSTIN)
  const direct = distanceMiles(MANILA, AUSTIN)

  ok(path.length === 65, `65 samples for 64 segments (${path.length})`)
  ok(
    path[0].lat === MANILA.lat && path[0].lng === MANILA.lng,
    'it starts exactly where the rep is',
  )
  ok(
    path.at(-1).lat === AUSTIN.lat && path.at(-1).lng === AUSTIN.lng,
    'and ends exactly at the door',
  )

  // The polyline is the great circle: its own length matches the great-circle
  // distance. A chord between the same endpoints would come out shorter.
  const drawn = walked(path)
  ok(
    Math.abs(drawn - direct) / direct < 0.001,
    `the drawn line is the shortest path, not a chord (${drawn.toFixed(0)} mi vs ${direct.toFixed(0)} mi)`,
  )

  /*
    The bulge, which is the whole point. On a flat map the line has to leave the
    box its endpoints describe — if it does not, something has interpolated
    latitude and longitude linearly and drawn the wrong line convincingly.
  */
  const topLat = Math.max(...path.map((p) => p.lat))
  ok(
    topLat > Math.max(MANILA.lat, AUSTIN.lat) + 15,
    `the arc bows north of both ends, as a real great circle does (${topLat.toFixed(1)}°N)`,
  )

  // The renderer joins consecutive points the short way, so this is what keeps
  // the line off a 360° detour back across Asia.
  ok(biggestStep(path) < 10, `no sample-to-sample jump for a map to guess at (${biggestStep(path).toFixed(1)}°)`)
  ok(
    path.some((p, i) => i > 0 && Math.abs(p.lng - path[i - 1].lng) > 180),
    'and it crosses the antimeridian, because the short way from Manila does',
  )

  ok(
    path.every(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lng) <= 180,
    ),
    'every point is a real coordinate',
  )
}

/* --- another state, which is the common version of this ------------------- */
{
  const path = greatCirclePath(CHICAGO, AUSTIN)
  const direct = distanceMiles(CHICAGO, AUSTIN)
  ok(direct > 900 && direct < 1050, `Chicago to Austin is about a thousand miles (${direct.toFixed(0)})`)
  ok(
    Math.abs(walked(path) - direct) / direct < 0.001,
    'the line matches the distance at continental scale too',
  )
  ok(formatDistance(direct) === '963 mi', `and the number reads plainly (${formatDistance(direct)})`)
  ok(formatDistance(8397.4) === '8,397 mi', `four figures are grouped (${formatDistance(8397.4)})`)
}

/* --- degenerate inputs ---------------------------------------------------- */
{
  // Same point. The interpolation divides by sin(angular distance), so this is
  // the one input that can produce a path made entirely of NaN.
  const same = greatCirclePath(AUSTIN, { ...AUSTIN })
  ok(
    same.length >= 2 && same.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    'a lead at the rep’s own feet returns a usable path rather than NaN',
  )

  // Two doors on a street. Nothing uses the arc at this range, but a function
  // that goes wild on small inputs is a trap for whoever reuses it.
  const near = greatCirclePath(DOOR_A, DOOR_B)
  const latSpan = Math.max(...near.map((p) => p.lat)) - Math.min(...near.map((p) => p.lat))
  ok(
    latSpan < 0.002,
    `at street range the path stays between its endpoints (${(latSpan * 364000).toFixed(0)} ft of span)`,
  )

  ok(greatCirclePath(MANILA, AUSTIN, 1).length >= 2, 'a silly sample count still yields a line')
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== flight line OK ===')
process.exit(fails.length ? 1 : 0)
