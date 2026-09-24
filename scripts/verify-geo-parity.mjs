import { pointInPolygon as clientInside, polygonAreaSqMiles as clientArea } from '../src/lib/geo.ts'
import { pointInPolygon as workerInside, polygonAreaSqMiles as workerArea, parseBoundary, territoryFor, bearing as workerBearing, distanceMeters } from '../api/src/geo.ts'
import { bearing as clientBearing, distanceMiles } from '../packages/core/src/geo.ts'

/**
 * The two copies of the territory geometry agree.
 *
 * `api/src/geo.ts` deliberately duplicates two functions from `src/lib/geo.ts` —
 * the Worker is its own package and borrowing across would couple two builds for
 * the life of the project. Duplication is a fine trade *if* the copies cannot
 * drift, and this is what makes that true: both run over the same fixtures and
 * any disagreement fails.
 *
 * It matters because drift here is silent and expensive. A manager draws a patch
 * on the map and the client tells them it holds 340 leads; the import puts a
 * different set of leads in it. Nothing errors, and the first person to notice is
 * a rep knocking a street that is not theirs.
 *
 * No browser: both modules are pure and Node reads TypeScript directly.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- fixtures ------------------------------------------------------------- */

const square = [
  { lat: 30.50, lng: -97.70 },
  { lat: 30.50, lng: -97.60 },
  { lat: 30.60, lng: -97.60 },
  { lat: 30.60, lng: -97.70 },
]

// Concave, because a hand-drawn patch usually is — a ray from a point in the
// notch crosses four edges, which is where a naive implementation goes wrong.
const notched = [
  { lat: 30.50, lng: -97.70 },
  { lat: 30.50, lng: -97.60 },
  { lat: 30.55, lng: -97.60 },
  { lat: 30.55, lng: -97.65 },
  { lat: 30.58, lng: -97.65 },
  { lat: 30.58, lng: -97.60 },
  { lat: 30.60, lng: -97.60 },
  { lat: 30.60, lng: -97.70 },
]

// Wound the other way. Ray casting should not care, and an area function that
// forgets its absolute value very much does.
const reversed = [...square].reverse()

const shapes = { square, notched, reversed }

/*
  A spread of points: inside, outside, in the notch, on a vertex, on an edge,
  and just off each. Generated rather than listed so the grid is dense enough to
  catch a disagreement in one corner of one polygon.
*/
const points = []
for (let lat = 30.45; lat <= 30.65; lat += 0.005) {
  for (let lng = -97.75; lng <= -97.55; lng += 0.005) {
    points.push({ lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) })
  }
}
points.push(
  ...square,                                   // exactly on the vertices
  { lat: 30.50, lng: -97.65 },                 // exactly on an edge
  { lat: 30.5000001, lng: -97.65 },            // a hair inside it
  { lat: 30.4999999, lng: -97.65 },            // a hair outside it
)

/* --- inside/outside ------------------------------------------------------- */

let compared = 0
let disagreed = 0
let firstDisagreement = null
for (const [name, poly] of Object.entries(shapes)) {
  for (const p of points) {
    const a = clientInside(p, poly)
    const b = workerInside(p, poly)
    compared += 1
    if (a !== b) {
      disagreed += 1
      firstDisagreement ??= `${name} at ${p.lat},${p.lng}: client ${a}, worker ${b}`
    }
  }
}
ok(compared > 4000, 'the fixture grid is dense enough to be worth running', `${compared} comparisons`)
ok(
  disagreed === 0,
  'both copies answer inside/outside identically',
  disagreed ? firstDisagreement : `${compared} agreed`,
)

/* --- area ----------------------------------------------------------------- */

for (const [name, poly] of Object.entries(shapes)) {
  const a = clientArea(poly)
  const b = workerArea(poly)
  ok(a === b, `both copies measure the ${name} identically`, `${a.toFixed(6)} sq mi`)
}

/* --- the polygons are actually different ---------------------------------- */
//
// Without this the whole file would still pass if every fixture were the same
// shape, or if both implementations returned false for everything.
{
  const inSquare = points.filter((p) => clientInside(p, square)).length
  const inNotch = points.filter((p) => clientInside(p, notched)).length
  ok(inSquare > 100, 'the square contains a meaningful share of the grid', `${inSquare} points`)
  ok(inNotch < inSquare, 'and the notched polygon contains fewer, so the notch is real',
     `${inNotch} vs ${inSquare}`)
  ok(clientArea(square) === clientArea(reversed), 'winding order does not change the area')
}

/* --- what the import actually calls --------------------------------------- */

{
  const big = { id: 'city', repId: 'u_city', boundary: square, areaSqMiles: clientArea(square) }
  const small = {
    id: 'downtown',
    repId: 'u_downtown',
    boundary: [
      { lat: 30.52, lng: -97.68 },
      { lat: 30.52, lng: -97.66 },
      { lat: 30.54, lng: -97.66 },
      { lat: 30.54, lng: -97.68 },
    ],
    areaSqMiles: 0,
  }
  small.areaSqMiles = clientArea(small.boundary)

  // Overlap is the normal case, not a mistake: a downtown patch carved out of a
  // city-wide one. The specific one has to win, or every downtown lead lands in
  // the city bucket.
  const inBoth = { lat: 30.53, lng: -97.67 }
  ok(territoryFor(inBoth, [big, small])?.id === 'downtown',
     'a lead inside two territories goes to the smaller one')
  ok(territoryFor(inBoth, [small, big])?.id === 'downtown',
     'and the answer does not depend on the order they came out of the database')

  const cityOnly = { lat: 30.58, lng: -97.62 }
  ok(territoryFor(cityOnly, [big, small])?.id === 'city', 'a lead in only one goes there')

  // Same size, same lead. Without a tie-break the winner is whichever row the
  // database returned first, which is free to change between imports.
  const twinA = { id: 'aaa', repId: 'u_a', boundary: small.boundary, areaSqMiles: small.areaSqMiles }
  const twinB = { id: 'bbb', repId: 'u_b', boundary: small.boundary, areaSqMiles: small.areaSqMiles }
  ok(territoryFor(inBoth, [twinA, twinB])?.id === 'aaa', 'two equal patches resolve by id')
  ok(
    territoryFor(inBoth, [twinB, twinA])?.id === 'aaa',
    'and resolve to the same one whichever order they arrive in',
  )

  const nowhere = { lat: 31.90, lng: -96.10 }
  ok(territoryFor(nowhere, [big, small]) === null,
     'a lead in no territory is left alone rather than pushed into the nearest')
}

/* --- boundaries that are not boundaries ----------------------------------- */
//
// A malformed shape must be dropped, not repaired. Guessing what a manager
// meant puts real leads in a patch nobody drew.
{
  ok(parseBoundary(JSON.stringify(square))?.length === 4, 'a good boundary parses')
  ok(parseBoundary(null) === null, 'a missing boundary is not a boundary')
  ok(parseBoundary('') === null, 'an empty string is not a boundary')
  ok(parseBoundary('not json') === null, 'unparseable JSON is refused')
  ok(parseBoundary('{"lat":1}') === null, 'an object is not a ring')
  ok(parseBoundary(JSON.stringify(square.slice(0, 2))) === null, 'two points cannot enclose anything')
  ok(parseBoundary(JSON.stringify([...square, null])) === null, 'a null vertex refuses the whole ring')
  ok(
    parseBoundary(JSON.stringify([...square, { lat: 'x', lng: 0 }])) === null,
    'a non-numeric vertex refuses the whole ring',
  )
  ok(
    parseBoundary(JSON.stringify([...square, { lat: 200, lng: 0 }])) === null,
    'a latitude off the planet refuses the whole ring',
  )
  ok(
    parseBoundary(JSON.stringify([...square, { lat: 0, lng: NaN }])) === null,
    'NaN survives JSON as null and is refused',
  )
}

/* --- the second pair of copies: bearing, and metres ----------------------- */
//
// Added for Street View, which finds the nearest panorama to a house and then
// has to aim the camera at the house. Both functions are duplicated from
// `packages/core/src/geo.ts` for the reason at the top of `api/src/geo.ts`, so
// both are held here.
//
// Drift in these is quieter than drift in the polygon maths and costs the same
// kind of afternoon: a bearing a few degrees out photographs the neighbour's
// door, and a distance out by a factor points the camera from the wrong street.
{
  const pairs = []
  for (const dLat of [-0.01, -0.0005, 0, 0.0005, 0.01, 2]) {
    for (const dLng of [-0.01, -0.0005, 0, 0.0005, 0.01, 2]) {
      if (dLat === 0 && dLng === 0) continue
      pairs.push([
        { lat: 30.5, lng: -97.6 },
        { lat: 30.5 + dLat, lng: -97.6 + dLng },
      ])
    }
  }
  // Across the antimeridian and over a pole, where a flat approximation stops
  // agreeing with itself and a spherical one keeps working.
  pairs.push([{ lat: 10, lng: 179.9 }, { lat: 10, lng: -179.9 }])
  pairs.push([{ lat: 89.9, lng: 0 }, { lat: 89.9, lng: 180 }])
  pairs.push([{ lat: 14.6, lng: 120.98 }, { lat: 30.5, lng: -97.6 }])

  const offBearing = pairs
    .map(([a, b]) => Math.abs(workerBearing(a, b) - clientBearing(a, b)))
    .reduce((m, d) => Math.max(m, d), 0)
  ok(offBearing < 1e-9, `both copies of bearing agree over ${pairs.length} pairs`, `max Δ ${offBearing}`)

  /*
    Distance is the same great circle in different units, so this checks the
    conversion rather than a shared implementation — the Worker needs metres
    because that is what Street View's `radius` parameter is in, and the client
    needs miles because that is what a rep reads.
  */
  const MI_PER_M = 1 / 1609.344
  const offDist = pairs
    .map(([a, b]) => {
      const mi = distanceMiles(a, b)
      const m = distanceMeters(a, b)
      return mi === 0 ? Math.abs(m) : Math.abs((m * MI_PER_M - mi) / mi)
    })
    .reduce((m, d) => Math.max(m, d), 0)
  // Loose, deliberately: the two use slightly different Earth radii (3958.8 mi
  // and 6,371,008.8 m — the mean radius to different precisions), so they are
  // the same sphere to about one part in ten thousand rather than exactly.
  ok(offDist < 2e-4, 'and the metric distance is the same great circle', `max relative Δ ${offDist.toExponential(2)}`)

  // A known answer, so a matched pair of wrong implementations cannot pass.
  const due = { lat: 30.5, lng: -97.6 }
  const north = { lat: 30.5 + 0.00027, lng: -97.6 }
  ok(Math.abs(workerBearing(due, north)) < 0.01, 'due north is a bearing of 0')
  ok(
    Math.abs(workerBearing(due, { lat: 30.5, lng: -97.6 + 0.0003 }) - 90) < 0.01,
    'due east is 90',
  )
  ok(Math.abs(distanceMeters(due, north) - 30) < 0.5, `and 0.00027° of latitude is 30 m (${distanceMeters(due, north).toFixed(1)})`)
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== geo parity OK ===')
