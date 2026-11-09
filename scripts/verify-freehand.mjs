import { readFileSync } from 'node:fs'
import {
  FREEHAND_MAX_VERTICES,
  FREEHAND_MIN_AREA_SQ_MILES,
  OUTLINE_MAX_POINTS,
  buildOutline,
  formatArea,
  pointsInside,
  prepareTrace,
  segmentsCross,
  selfIntersects,
  simplifyPath,
  simplifyToLimit,
  thinTrace,
  trimClosingLoop,
} from '../packages/core/src/freehand.ts'
import { pointInPolygon as coreInside, polygonAreaSqMiles, project, unproject } from '../packages/core/src/geo.ts'
import { pointInPolygon as workerInside } from '../api/src/geo.ts'
import { OUTLINE_Z, DRAW_Z_SHAPE, outlineOverlay, pixelToLatLng } from '../src/components/map/map-contract.ts'

/**
 * The geometry behind freehand territory drawing, without a browser.
 *
 * A finger's trace has to become an outline the server will store, and the leads
 * inside it have to be exactly the leads the server would put inside it. Both are
 * arithmetic, so both are pinned here: noise is thinned and simplified without
 * losing the shape, a loop closed by overshooting is repaired and a figure-eight is
 * refused, a sliver or a scribble is not an area, longitude is judged the way the
 * server's test judges it, and the screen-to-coordinate step the Google map uses
 * agrees with the self-rendered map's own projection.
 *
 * Run with `node --import ./scripts/lib/ts-imports.mjs`.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured !== undefined ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/* A deterministic generator, so a failure is the same failure next run. */
let seed = 20261103
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

/* --- fixtures ------------------------------------------------------------- */

const HOME = { lat: 30.5083, lng: -97.6789 } // Round Rock, TX
/** A square `half` degrees either side of a centre, wound either way. */
const square = (c = HOME, half = 0.002, clockwise = true) => {
  const pts = [
    { lat: c.lat + half, lng: c.lng - half },
    { lat: c.lat + half, lng: c.lng + half },
    { lat: c.lat - half, lng: c.lng + half },
    { lat: c.lat - half, lng: c.lng - half },
  ]
  return clockwise ? pts : [...pts].reverse()
}
/** A circle of `n` samples and `turns` revolutions, in pixels or degrees. */
const circle = (cx, cy, r, n, turns = 1) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2 * turns
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
  })
const geoCircle = (c, r, n, turns = 1) =>
  circle(c.lng, c.lat, r, n, turns).map((p) => ({ lat: p.y, lng: p.x }))
/**
 * A loop closed the way a hand closes one: it swings out past the start and cuts
 * back in across the first part of the line. Exactly one crossing, a few percent
 * of the way round. (A circle retraced at the same radius overlaps itself and
 * never crosses, which is why this is not just \`turns = 1.08\`.)
 */
const overshoot = (c, r, perTurn) => {
  const total = Math.round(perTurn * 1.08)
  return Array.from({ length: total + 1 }, (_, i) => {
    const t = i / perTurn
    const radius = t <= 0.96 ? r : t <= 1.0 ? r * (1 + (2.5 * (t - 0.96))) : r * (1.1 - 5 * (t - 1.0))
    const a = t * Math.PI * 2
    return { lat: c.lat + Math.sin(a) * radius, lng: c.lng + Math.cos(a) * radius }
  })
}
/** A spiral that winds inward twice: never crosses itself, but cannot be closed. */
const spiral = (c, r, perTurn, turns) =>
  Array.from({ length: Math.round(perTurn * turns) + 1 }, (_, i) => {
    const t = i / perTurn
    const radius = r * (1 - (0.4 * t) / turns)
    const a = t * Math.PI * 2
    return { lat: c.lat + Math.sin(a) * radius, lng: c.lng + Math.cos(a) * radius }
  })

/* --- thinning and simplifying --------------------------------------------- */

{
  const dense = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.5, y: 0 }))
  const thin = thinTrace(dense)
  ok(thin.length < 25 && thin[0] === dense[0] && thin[thin.length - 1] === dense[99], 'thinning drops samples closer than the gap and keeps both ends', `${dense.length} → ${thin.length}`)
  ok(thinTrace([]).length === 0 && thinTrace([{ x: 1, y: 1 }]).length === 1, 'and copes with nothing and with one sample')

  const line = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i * 0.5 }))
  ok(simplifyPath(line, 2).length === 2, 'a straight run simplifies to its two ends')
  const zig = Array.from({ length: 60 }, (_, i) => ({ x: i * 5, y: i % 2 ? 40 : 0 }))
  ok(simplifyPath(zig, 2).length === zig.length, 'a sharp zigzag keeps its corners')

  const noisy = circle(300, 300, 120, 1200).map((p) => ({ x: p.x + (rand() - 0.5) * 1.5, y: p.y + (rand() - 0.5) * 1.5 }))
  const limited = simplifyToLimit(noisy, FREEHAND_MAX_VERTICES)
  ok(limited.length <= FREEHAND_MAX_VERTICES && limited.length >= 8, 'a noisy circle is cut to the vertex limit and stays a circle', `${noisy.length} → ${limited.length}`)
  const tight = simplifyToLimit(circle(300, 300, 120, 1200), 12)
  ok(tight.length <= 12, 'a harder limit loosens the tolerance until it fits', `${tight.length}`)
  const huge = Array.from({ length: 5000 }, () => ({ x: rand() * 500, y: rand() * 500 }))
  ok(simplifyToLimit(huge, FREEHAND_MAX_VERTICES).length <= FREEHAND_MAX_VERTICES, 'even random scribble is brought under the limit, and without recursing')
}

/* --- from a finger's trace ------------------------------------------------- */

{
  const tap = prepareTrace([{ x: 10, y: 10 }])
  ok(!tap.ok && tap.reason === 'too_short', 'a tap is too short to be an outline')
  const twitch = prepareTrace([{ x: 10, y: 10 }, { x: 14, y: 12 }, { x: 18, y: 14 }])
  ok(!twitch.ok && twitch.reason === 'too_short', 'so is a twitch of a few pixels', twitch.ok ? '' : twitch.reason)
  const flat = prepareTrace(Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: 50 })))
  ok(!flat.ok && flat.reason === 'too_small', 'a long straight drag has no inside', flat.ok ? '' : flat.reason)
  const loop = prepareTrace(circle(200, 200, 90, 500))
  ok(loop.ok && loop.points.length >= 8 && loop.points.length <= FREEHAND_MAX_VERTICES, 'a drawn loop becomes a modest outline', loop.ok ? `${loop.points.length} vertices` : loop.reason)
  const marathon = prepareTrace(circle(200, 200, 90, 4000, 6))
  ok(marathon.ok && marathon.points.length <= FREEHAND_MAX_VERTICES, 'a stroke that goes round six times still fits the limit')
  ok(FREEHAND_MAX_VERTICES < OUTLINE_MAX_POINTS, 'with room under the server ceiling', `${FREEHAND_MAX_VERTICES} < ${OUTLINE_MAX_POINTS}`)
  const carry = prepareTrace([{ x: 0, y: 0, cx: 1 }, { x: 80, y: 0, cx: 2 }, { x: 80, y: 80, cx: 3 }, { x: 0, y: 80, cx: 4 }])
  ok(carry.ok && carry.points.every((p) => 'cx' in p), 'extra fields on the samples survive, which is how page coordinates ride along')
}

/* --- from coordinates to an outline ---------------------------------------- */

{
  const sq = buildOutline(square())
  ok(sq.ok && sq.outline.length === 4 && sq.areaSqMiles > 0.05 && !sq.trimmed, 'a square is an outline with an area', sq.ok ? `${sq.areaSqMiles.toFixed(2)} sq mi` : sq.reason)
  ok(buildOutline(square(HOME, 0.002, false)).ok, 'whichever way it is wound')
  const closed = buildOutline([...square(), square()[0]])
  ok(closed.ok && closed.outline.length === 4, 'a ring that ends where it began is not given a duplicate corner')
  const dup = buildOutline([square()[0], square()[0], ...square().slice(1), square()[3]])
  ok(dup.ok && dup.outline.length === 4, 'repeated points are collapsed')

  const bad = (pts) => buildOutline(pts)
  ok(bad([{ lat: NaN, lng: 1 }, { lat: 1, lng: 1 }, { lat: 2, lng: 3 }]).reason === 'invalid', 'a point with no coordinates is refused as unreadable')
  ok(bad([{ lat: 91, lng: 0 }, { lat: 1, lng: 1 }, { lat: 2, lng: 3 }]).reason === 'invalid', 'a point not on Earth is refused')
  ok(bad([{ lat: 10, lng: 181 }, { lat: 1, lng: 1 }, { lat: 2, lng: 3 }]).reason === 'invalid', 'so is a longitude past 180')
  ok(bad(square().slice(0, 2)).reason === 'too_short', 'two points are too short')
  ok(bad([]).reason === 'too_short', 'and none at all')
  ok(bad(null).reason === 'invalid', 'something that is not a list is unreadable')

  const collinear = bad([0, 1, 2, 3].map((i) => ({ lat: HOME.lat + i * 0.001, lng: HOME.lng + i * 0.001 })))
  ok(collinear.reason === 'too_small', 'points in a straight line are not an area')
  const sliver = bad(square(HOME, 0.00002))
  ok(sliver.reason === 'too_small' && polygonAreaSqMiles(square(HOME, 0.00002)) < FREEHAND_MIN_AREA_SQ_MILES, 'a square ten metres across is a scribble, not a patch')
  ok(bad(square(HOME, 0.0003)).ok, 'while one a block wide is fine', `${polygonAreaSqMiles(square(HOME, 0.0003)).toFixed(4)} sq mi`)

  const eight = bad([
    { lat: HOME.lat + 0.002, lng: HOME.lng - 0.002 },
    { lat: HOME.lat - 0.002, lng: HOME.lng + 0.002 },
    { lat: HOME.lat + 0.002, lng: HOME.lng + 0.002 },
    { lat: HOME.lat - 0.002, lng: HOME.lng - 0.002 },
  ])
  ok(eight.reason === 'crosses_itself', 'a bow-tie that crosses itself in the middle is refused')

  const over = bad(overshoot(HOME, 0.003, 120))
  ok(over.ok && over.trimmed && !selfIntersects(over.outline), 'a loop closed by running past the start is trimmed back to a clean outline', over.ok ? `${over.outline.length} corners` : over.reason)
  const noTrim = buildOutline(overshoot(HOME, 0.003, 120), { trimOvershoot: false })
  ok(noTrim.reason === 'crosses_itself', 'with trimming off (corners dragged by hand) the same crossing is refused instead of cut away', noTrim.reason)
  const plain = bad(geoCircle(HOME, 0.003, 120, 0.96))
  ok(plain.ok && !plain.trimmed, 'a loop that stops short of the start needs nothing trimmed')
  const area = (r) => (r.ok ? r.areaSqMiles : 0)
  ok(Math.abs(area(over) - area(plain)) / area(plain) < 0.1, 'and the trimmed one is the same shape, within ten percent of the area', `${area(over).toFixed(4)} vs ${area(plain).toFixed(4)}`)
  const twice = bad(spiral(HOME, 0.003, 80, 2.2))
  ok(twice.reason === 'crosses_itself', 'a line wound twice round is too tangled to repair, and says so', twice.reason)

  const across = bad([
    { lat: 10, lng: 170 }, { lat: 10, lng: -170 }, { lat: -10, lng: -170 }, { lat: -10, lng: 170 },
  ])
  ok(across.reason === 'crosses_dateline', 'a shape across the date line is refused rather than stored inside out')
  ok(bad(square({ lat: -33.87, lng: 151.21 })).ok && bad(square({ lat: 51.5, lng: -0.12 })).ok, 'southern and western hemispheres draw as well as Texas does')
  const eq = polygonAreaSqMiles(square({ lat: 0, lng: 0 }))
  const high = polygonAreaSqMiles(square({ lat: 60, lng: 0 }))
  ok(high < eq * 0.6, 'the same degrees cover less ground at latitude 60, and the area knows it', `${eq.toFixed(2)} vs ${high.toFixed(2)}`)
  ok(bad(Array.from({ length: 201 }, (_, i) => ({ lat: HOME.lat + Math.sin(i) * 0.01, lng: HOME.lng + Math.cos(i) * 0.01 }))).reason === 'too_many', 'more points than the server takes are refused here first')

  ok(segmentsCross({ lat: 0, lng: 0 }, { lat: 2, lng: 2 }, { lat: 0, lng: 2 }, { lat: 2, lng: 0 }), 'two diagonals cross')
  ok(!segmentsCross({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 1, lng: 0 }, { lat: 1, lng: 1 }), 'segments that only share an end do not')
  ok(!selfIntersects(square()) && selfIntersects(eight.ok ? [] : [
    { lat: 0, lng: 0 }, { lat: 2, lng: 2 }, { lat: 0, lng: 2 }, { lat: 2, lng: 0 },
  ]), 'a square is simple and a bow-tie is not')
  ok(!trimClosingLoop(square()).trimmed, 'and a simple outline is returned as it came')
}

/* --- which leads are inside ------------------------------------------------ */

{
  const sq = square()
  const lead = (id, lat, lng) => ({ id, lat, lng })
  const leads = [
    lead('in1', HOME.lat, HOME.lng),
    lead('in2', HOME.lat + 0.001, HOME.lng - 0.001),
    lead('out', HOME.lat + 0.01, HOME.lng),
    lead('nan', NaN, HOME.lng),
    lead('undef', undefined, undefined),
    lead('inf', Infinity, HOME.lng),
  ]
  const hit = pointsInside(leads, sq).map((l) => l.id)
  ok(hit.length === 2 && hit.includes('in1') && hit.includes('in2'), 'the leads in the outline are found and the ones outside are not', hit.join(','))
  ok(!hit.includes('nan') && !hit.includes('undef') && !hit.includes('inf'), 'leads with no usable coordinates are left out rather than counted')
  ok(pointsInside(leads, sq.slice(0, 2)).length === 0 && pointsInside(leads, []).length === 0, 'and nothing is inside a line')

  // An L: the notch is inside the bounding box and outside the shape.
  const L = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 4 }, { lat: 2, lng: 4 }, { lat: 2, lng: 2 }, { lat: 4, lng: 2 }, { lat: 4, lng: 0 },
  ]
  const probes = [lead('arm', 1, 3), lead('stem', 3, 1), lead('notch', 3, 3), lead('corner', 1, 1)]
  const ids = pointsInside(probes, L).map((l) => l.id).sort()
  ok(ids.join() === 'arm,corner,stem', 'a concave shape leaves out its notch, which a bounding box would not', ids.join(','))

  const dupes = [lead('a', HOME.lat, HOME.lng), lead('a', HOME.lat, HOME.lng)]
  ok(new Set(pointsInside(dupes, sq).map((l) => l.id)).size === 1, 'the same lead twice in the input is one id, which is what a selection set keeps')

  // The browser and the Worker agree on every probe.
  let disagreements = 0
  let probesRun = 0
  for (let n = 0; n < 25; n++) {
    const c = { lat: 30 + rand(), lng: -98 + rand() }
    const sides = 3 + Math.floor(rand() * 8)
    const poly = Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2
      const r = 0.002 + rand() * 0.004
      return { lat: c.lat + Math.sin(a) * r, lng: c.lng + Math.cos(a) * r }
    })
    const points = Array.from({ length: 400 }, (_, i) => lead(`p${i}`, c.lat + (rand() - 0.5) * 0.012, c.lng + (rand() - 0.5) * 0.012))
    const mine = new Set(pointsInside(points, poly).map((p) => p.id))
    for (const p of points) {
      probesRun++
      if (mine.has(p.id) !== workerInside(p, poly) || mine.has(p.id) !== coreInside(p, poly)) disagreements++
    }
  }
  ok(disagreements === 0, 'the selection agrees with the Worker’s own test on every probe', `${probesRun} probes, ${disagreements} differ`)

  const all = Array.from({ length: 300 }, (_, i) => lead(`l${i}`, HOME.lat + (rand() - 0.5) * 0.006, HOME.lng + (rand() - 0.5) * 0.006))
  const filtered = all.filter((_, i) => i % 3 === 0)
  const inAll = new Set(pointsInside(all, sq).map((l) => l.id))
  const inFiltered = pointsInside(filtered, sq).map((l) => l.id)
  ok(inFiltered.every((id) => inAll.has(id)) && inFiltered.length < inAll.size, 'drawn over a filtered list it selects a subset of what it would unfiltered', `${inFiltered.length} of ${inAll.size}`)
}

/* --- area wording ---------------------------------------------------------- */

ok(formatArea(0.04) === '26 acres' && formatArea(0.0002) === '1 acre' && formatArea(1.234) === '1.2 sq mi' && formatArea(42.4) === '42 sq mi', 'areas read as acres up to half a square mile, then square miles', [formatArea(0.04), formatArea(1.234), formatArea(42.4)].join(' / '))
ok(formatArea(0) === '0 acres' && formatArea(NaN) === '0 acres', 'and nothing is zero acres')

/* --- the Google map's pixel step agrees with the self-rendered map's -------- */

{
  const TILE = 256
  const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180
  const fieldMapAt = (view, size, px, py) => {
    const scale = TILE * 2 ** view.zoom
    const c = project(view.lat, view.lng)
    const w = unproject(c.x, c.y + (py - size.h / 2) / scale)
    return { lat: w.lat, lng: wrap(view.lng + ((px - size.w / 2) / scale) * 360) }
  }
  const boundsOf = (view, size) => {
    const nw = fieldMapAt(view, size, 0, 0)
    const se = fieldMapAt(view, size, size.w, size.h)
    return { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng }
  }
  let worst = 0
  for (const view of [
    { lat: 30.5083, lng: -97.6789, zoom: 16 },
    { lat: 30.5083, lng: -97.6789, zoom: 12.6 },
    { lat: -33.87, lng: 151.21, zoom: 15 },
    { lat: 64.1, lng: -21.9, zoom: 11 },
    { lat: 0.2, lng: 179.99, zoom: 14 },
    { lat: 10, lng: -179.99, zoom: 13 },
  ]) {
    const size = { w: 390, h: 520 }
    const b = boundsOf(view, size)
    for (const [x, y] of [[0, 0], [390, 520], [195, 260], [40, 480], [350, 30], [120.5, 77.25]]) {
      const mine = pixelToLatLng(b, size, x, y)
      const theirs = fieldMapAt(view, size, x, y)
      const dLng = Math.abs(wrap(mine.lng - theirs.lng))
      worst = Math.max(worst, Math.abs(mine.lat - theirs.lat), dLng)
    }
  }
  ok(worst < 1e-9, 'a pixel resolves to the same coordinate as on the self-rendered map, at six views including the date line', `worst ${worst.toExponential(1)}°`)
  ok(pixelToLatLng({ north: 1, south: 0, east: 1, west: 0 }, { w: 0, h: 10 }, 1, 1) === null, 'a map with no size gives no answer')
  ok(pixelToLatLng({ north: NaN, south: 0, east: 1, west: 0 }, { w: 10, h: 10 }, 1, 1) === null, 'and nor does a missing bound')
  const b = boundsOf({ lat: 30.5, lng: -97.7, zoom: 17 }, { w: 400, h: 400 })
  const mid = pixelToLatLng(b, { w: 400, h: 400 }, 200, 200)
  ok(Math.abs(mid.lat - 30.5) < 1e-7 && Math.abs(mid.lng + 97.7) < 1e-7, 'the middle of the screen is the middle of the map')
}

/* --- saved territories on the map ----------------------------------------- */

{
  const square4 = square()
  const plain = outlineOverlay({ id: 't1', points: square4 })
  const strong = outlineOverlay({ id: 't2', points: square4, emphasis: true })
  ok(plain?.options.clickable === false && strong?.options.clickable === false, 'a saved outline never takes a tap, so a pin inside it still can')
  ok(plain.options.zIndex < DRAW_Z_SHAPE && strong.options.zIndex < DRAW_Z_SHAPE && plain.options.zIndex >= OUTLINE_Z, 'it sits under the shape being drawn', `${plain.options.zIndex}, ${strong.options.zIndex} < ${DRAW_Z_SHAPE}`)
  ok(strong.options.strokeColor === '#20C4D3' && plain.options.strokeColor !== strong.options.strokeColor, 'the selected territory is drawn in teal and the others are not')
  ok(plain.options.fillOpacity > 0 && plain.options.fillOpacity < 0.2 && strong.options.fillOpacity < 0.2, 'with a faint fill, so the leads under it stay readable')
  ok(outlineOverlay({ id: 'x', points: square4.slice(0, 2) }) === null, 'two points are not an area and draw nothing')
  ok(outlineOverlay({ id: 'y', points: [...square4, { lat: NaN, lng: 1 }] })?.path.length === 4, 'a corner with no coordinates is left out rather than drawn at 0,0')
}

/* --- what the screens must keep doing -------------------------------------- */

{
  const server = read('api/src/territories.ts')
  ok(/MAX_POINTS = (\d+)/.exec(server)?.[1] === String(OUTLINE_MAX_POINTS), 'the vertex ceiling here is the one the Worker enforces', /MAX_POINTS = \d+/.exec(server)?.[0])
  ok(/MIN_POINTS = 3/.test(server), 'as is the three-point minimum')

  const field = read('src/components/map/FieldMap.tsx')
  const google = read('src/components/map/GoogleFieldMap.tsx')
  for (const [name, src] of [['FieldMap', field], ['GoogleFieldMap', google]]) {
    ok(/toLatLng:\s*\(clientX/.test(src) && /prepareDraw/.test(src), `${name} gives the handle a way to turn a pixel into a coordinate`)
    ok(/\bsurface\b/.test(src) && /\{surface\}/.test(src), `${name} has the slot under its controls`)
    ok(/markedIds/.test(src), `${name} draws chosen leads as chosen`)
    ok(/showVertices/.test(src), `${name} can leave the dots off a freehand outline`)
  }
  ok(/pixelToLatLng/.test(google), 'and the Google map uses the shared conversion rather than its own')
  ok(field.indexOf('{surface}') < field.indexOf('Zoom in'), 'the self-rendered map puts the slot before its zoom buttons, so they stay above it')
  ok(google.indexOf('{surface}') < google.indexOf('aria-label="Zoom in"'), 'and so does the Google map')

  const layer = read('src/components/map/FreehandLayer.tsx')
  ok(/@allstar\/core\/freehand/.test(layer) && /prepareTrace/.test(layer) && /buildOutline/.test(layer), 'the layer uses the shared geometry and has none of its own')
  ok(/touchAction:\s*'none'/.test(layer) && /touch-none/.test(layer), 'the layer stops the browser panning under a drag')
  ok(/onPointerCancel/.test(layer) && /size > 1/.test(layer), 'it drops a cancelled stroke and a second finger')
  ok(/requestAnimationFrame/.test(layer), 'and paints once a frame, not once a sample')
  ok(/addEventListener\('touchmove', hold, \{ passive: false \}\)/.test(layer) && /addEventListener\('touchstart', hold, \{ passive: false \}\)/.test(layer), 'on iPhone and iPad the page is held still under a stroke by non-passive touch listeners')
  ok(/WebkitTouchCallout: 'none'/.test(layer) && /WebkitUserSelect: 'none'/.test(layer), 'and a resting finger brings up no callout and selects no text')
  for (const [name, src] of [['FieldMap', field], ['GoogleFieldMap', google]]) {
    ok(/outlineOverlay\(/.test(src) && /outlines/.test(src), `${name} draws saved territories through the shared outline spec`)
  }
  ok(/o\.points\.map\(\(p\) => `\$\{p\.lat\},\$\{p\.lng\}`\)/.test(google), 'the Google map redraws an outline when any corner of it moves, not only the first')
  ok(field.indexOf('data-outlines="territories"') < field.indexOf('{clusters.map(') && field.indexOf('data-outlines="territories"') < field.indexOf('{pins.map('), 'the self-rendered map draws outlines before the leads, so under them')

  const leads = read('src/admin/AdminLeads.tsx')
  ok(/Select pins/.test(leads) && /Draw territory/.test(leads), 'Admin Leads offers both tools')
  ok(/Select an area/.test(leads) && /commitLasso/.test(leads) && /onAddPoint: \(point\) => setLasso/.test(leads), 'and the tap-by-tap area is still there under Select pins')
  ok(/pointsInside\(rows,/.test(leads), 'the outline selects from the filtered rows')
  ok(/Select \$\{inOutline\.length/.test(leads) || /Select \{inOutline\.length/.test(leads), 'Apply is a selection and says how many')
  ok(!/eraseLeads|apiEraseLeads\([^)]*outline/.test(leads.slice(leads.indexOf('function selectOutlined'), leads.indexOf('function selectOutlined') + 400)), 'and drawing changes no lead record')
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== freehand territory geometry OK ===')
process.exit(fails.length ? 1 : 0)
