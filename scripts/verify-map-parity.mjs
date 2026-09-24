import { readFileSync } from 'node:fs'
import {
  DRAW_CLOSES_AT,
  DRAW_FILL,
  DRAW_FILL_OPACITY,
  DRAW_Z_VERTEX,
  drawOverlay,
  FIELDMAP_MAX_ZOOM,
  GOOGLE_MAX_ZOOM,
  MAP_MIN_ZOOM,
  drawClosed,
  mapAriaLabel,
  tapIntent,
} from '../src/components/map/map-contract.ts'
import { greatCirclePath, project } from '../packages/core/src/geo.ts'

/**
 * The two map renderers behave the same way.
 *
 * This app has two maps. `FieldMap` draws its own basemap from arithmetic;
 * `GoogleFieldMap` is the Maps JavaScript API. Which one a person gets is an
 * environment fact — is a key configured, did the map paint — and not something
 * any screen decides or any user can see. That only holds while they agree, and
 * the places they can disagree are exactly the places nothing else can check:
 *
 *   - The Google renderer needs a real key on an allowed origin, so no browser
 *     gate in this repo has ever executed a line of it. `verify:googlemap` says
 *     as much in its own header and tests only the failure paths.
 *   - The failures that follow from disagreement are silent. A tap that selects
 *     a lead instead of placing a vertex is not an error; it is a manager
 *     wondering why the shape stopped growing. A map that forgets satellite is
 *     not an error; it is a roof assessor re-picking it forty times a day.
 *
 * So the shared decisions were extracted into `map-contract.ts` — plain data
 * and pure functions, importable into Node — and this asserts two things: that
 * the contract is right, and that both renderers actually *read* it rather than
 * keeping a second opinion that happens to match today.
 *
 * The source-reading half is deliberate. Checking behaviour would need the
 * thing that cannot be had here; checking that neither file re-declares what it
 * was given is cheap, exact, and catches the real regression — somebody adding
 * a tap mode to one renderer and not the other.
 */

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
/** Source with comments removed — for asking what the code does, not what it says. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

const FIELD = read('src/components/map/FieldMap.tsx')
const GOOGLE = read('src/components/map/GoogleFieldMap.tsx')
const ALLSTAR = read('src/components/map/AllStarMap.tsx')
const FIELD_CODE = code(FIELD)
const GOOGLE_CODE = code(GOOGLE)

/* --- 1. the tap, which is the four-way one -------------------------------- */
//
// Every combination, not a sample. There are sixteen and they take no time, and
// the one that was wrong in the Google renderer for months — a marker tap while
// drawing — is the kind of corner a hand-picked list omits.
{
  const table = []
  for (const drawing of [false, true]) {
    for (const picking of [false, true]) {
      for (const pickExclusive of [false, true]) {
        for (const hitMarker of [false, true]) {
          table.push([
            { drawing, picking, pickExclusive, hitMarker },
            tapIntent({ drawing, picking, pickExclusive, hitMarker }),
          ])
        }
      }
    }
  }
  ok(table.length === 16, 'the tap has sixteen states')

  // Drawing wins outright: losing a vertex *and* opening a lead nobody asked
  // about is the same double failure on either renderer.
  ok(
    table.filter(([s]) => s.drawing).every(([, v]) => v === 'draw'),
    'while drawing, every tap is a vertex — pin, cluster or open map',
  )

  // The picker, armed but not exclusive: a tap on a house the rep already has
  // is a question about that house.
  ok(
    tapIntent({ drawing: false, picking: true, pickExclusive: false, hitMarker: true }) === 'select',
    'a merely armed picker still lets a tap on a lead open that lead',
  )
  ok(
    tapIntent({ drawing: false, picking: true, pickExclusive: false, hitMarker: false }) === 'pick',
    'and a tap that hits nothing places the point',
  )
  // With the form open the question has already been asked.
  ok(
    table
      .filter(([s]) => !s.drawing && s.picking && s.pickExclusive)
      .every(([, v]) => v === 'pick'),
    'with the form open every tap answers it, lead dots included',
  )
  ok(
    tapIntent({ drawing: false, picking: false, pickExclusive: false, hitMarker: true }) === 'select',
    'otherwise a tap on a pin selects it',
  )
  ok(
    tapIntent({ drawing: false, picking: false, pickExclusive: false, hitMarker: false }) ===
      'deselect',
    'and a tap on nothing dismisses',
  )
  // `pickExclusive` is meaningless without `picking`, and must not leak.
  ok(
    table
      .filter(([s]) => !s.drawing && !s.picking)
      .every(([s, v]) => v === (s.hitMarker ? 'select' : 'deselect')),
    'an exclusive flag with no picker changes nothing',
  )
}

/* --- 2. both renderers ask, rather than deciding for themselves ----------- */
{
  for (const [name, src] of [
    ['FieldMap', FIELD_CODE],
    ['GoogleFieldMap', GOOGLE_CODE],
  ]) {
    ok(/from '\.\/map-contract'/.test(src), `${name} imports the shared contract`)
    ok(/tapIntent\(/.test(src), `${name} routes its taps through tapIntent`)
    ok(/mapAriaLabel\(/.test(src), `${name} labels itself through mapAriaLabel`)
  }

  /*
    The precedence, un-reimplemented.

    A renderer that reached the same verdict with its own `if (draw)` chain
    would pass every behavioural check above and drift the moment a fifth mode
    is added. So: neither file may branch on `draw` and `pick` together outside
    the call to `tapIntent`.
  */
  for (const [name, src] of [
    ['FieldMap', FIELD_CODE],
    ['GoogleFieldMap', GOOGLE_CODE],
  ]) {
    const hand = src.match(/if\s*\(\s*(draw|pick)(RefProp\.current)?\s*(&&|\))/g) ?? []
    ok(
      hand.length === 0,
      `${name} keeps no second opinion about what a tap means`,
      hand.join(' / ') || 'none',
    )
  }

  // Google's three call sites: the map, a lead marker, a cluster bubble. All
  // three are gestures a thumb makes and all three must agree.
  const sites = (GOOGLE_CODE.match(/tapIntent\(\{/g) ?? []).length
  ok(sites === 3, `GoogleFieldMap asks at all three of its tap sites (${sites})`)
  ok(
    /hitMarker:\s*false/.test(GOOGLE_CODE) && /hitMarker:\s*true/.test(GOOGLE_CODE),
    'and tells it apart: the basemap is not a marker, a pin and a cluster are',
  )
}

/* --- 3. drawing --------------------------------------------------------- */
{
  ok(DRAW_CLOSES_AT === 3, 'a shape closes at three points')
  ok(!drawClosed([1, 2]) && drawClosed([1, 2, 3]), 'and not at two')

  ok(
    /draw\?:/.test(GOOGLE) && /onAddPoint/.test(GOOGLE_CODE),
    'GoogleFieldMap accepts the draw contract at all',
  )
  ok(
    /google\.maps\.Polygon/.test(GOOGLE_CODE) && /google\.maps\.Polyline/.test(GOOGLE_CODE),
    'drawing a filled polygon once closed and an open line before that',
  )
  ok(/gmpClickable:\s*false/.test(GOOGLE_CODE), 'and its vertex handles are never buttons')

  /* --- the overlay, as data ---------------------------------------------- */
  //
  // The part that matters most and could least be checked. Constructing a
  // `google.maps.Polygon` needs a real key on an allowed origin, so these were
  // the riskiest lines in the repo and nothing could execute them. `drawOverlay`
  // is the decision extracted as a pure function; `GoogleFieldMap` only applies
  // what it returns, which is a line this file can read.
  const P = (n) => Array.from({ length: n }, (_, i) => ({ lat: 30.5 + i * 0.001, lng: -97.6 }))

  ok(drawOverlay(P(0)) === null, 'nothing drawn for no points')

  for (const n of [1, 2]) {
    const spec = drawOverlay(P(n))
    ok(spec.kind === 'polyline', `${n} point(s): an open line, not a shape`)
    ok(spec.options.fillColor === undefined, `${n}: and nothing is filled in yet`)
    /*
      The dashes. Maps JS has no dash property, so a stroke at zero opacity
      carrying a repeated symbol is how it is done — and the failure mode of
      getting it wrong is a *solid* line, which is exactly the claim an
      unfinished shape must not make.
    */
    ok(spec.options.strokeOpacity === 0, `${n}: the line itself is invisible`)
    const dash = spec.options.icons?.[0]
    ok(!!dash, `${n}: the dashes are a repeating symbol`)
    ok(dash.icon.strokeOpacity === 1, `${n}: and the symbol is the visible part`)
    ok(
      dash.icon.scale * 2 === 6 && dash.repeat === '11px',
      `${n}: at the same 6-on-5-off rhythm as the SVG's dasharray`,
      `${dash.icon.scale * 2}px dash / ${dash.repeat}`,
    )
  }

  for (const n of [3, 4, 12]) {
    const spec = drawOverlay(P(n))
    ok(spec.kind === 'polygon', `${n} points: a closed, filled shape`)
    ok(spec.options.strokeOpacity === 1, `${n}: drawn solid rather than dashed`)
    ok(spec.options.icons === undefined, `${n}: with the dash symbol gone`)
    ok(spec.options.fillColor === DRAW_FILL, `${n}: filled in the contract's colour`)
    /*
      Separate from the colour, and the reason is a slab of solid teal over the
      map. `fillColor` and `fillOpacity` are independent options; a colour
      carrying its own alpha has it ignored and `fillOpacity` decides.
    */
    ok(
      spec.options.fillOpacity === DRAW_FILL_OPACITY,
      `${n}: at the contract's opacity, not an implicit 1`,
      String(spec.options.fillOpacity),
    )
  }

  /*
    The one that loses a vertex. A Google overlay swallows the click that lands
    on it, and this shape covers exactly the part of the map still being drawn
    on — so without it the third tap inside a triangle never reaches the map's
    listener. The self-rendered map cannot have this bug; its shape is an SVG
    under the pointer handler. Every point count, because a polygon and a
    polyline are two different objects and only one of them was ever wrong.
  */
  for (const n of [1, 2, 3, 6]) {
    ok(drawOverlay(P(n)).options.clickable === false, `${n} points: the shape never eats the next tap`)
  }

  // Points are passed through in order and unchanged — a shape that reorders or
  // rounds its vertices is a different shape from the one somebody drew.
  const echoed = drawOverlay(P(4))
  ok(
    JSON.stringify(echoed.path) === JSON.stringify(P(4)),
    'and the vertices arrive in the order they were placed',
  )

  // The shape sits above the pins, and the handles above the shape.
  ok(
    drawOverlay(P(3)).options.zIndex < DRAW_Z_VERTEX,
    'a vertex handle is never hidden behind its own shape',
  )
  ok(
    /zIndex: DRAW_Z_VERTEX/.test(GOOGLE_CODE),
    'and the renderer takes that ordering from the contract',
  )

  ok(
    /drawClosed\(/.test(FIELD_CODE),
    'the self-rendered map decides "closed" with the same function',
  )
  ok(
    drawClosed(P(3)) && !drawClosed(P(2)),
    'which is the same rule the overlay switches kind on',
  )

  /*
    The fill, split into a colour and an opacity.

    Asserted because collapsing them back into one `rgba()` string is the exact
    shape of a bug that looks fine in the self-rendered map and covers the
    Google one in solid teal: SVG honours a fourth channel in `fill`, and
    `google.maps.Polygon` takes `fillColor` and `fillOpacity` separately — so
    the alpha is dropped and `fillOpacity` decides, over the very part of the
    map somebody is drawing on.
  */
  ok(!/rgba\(/.test(String(DRAW_FILL)), `the fill is a plain colour (${DRAW_FILL})`)
  ok(
    DRAW_FILL_OPACITY > 0 && DRAW_FILL_OPACITY < 0.5,
    `with its transparency carried separately (${DRAW_FILL_OPACITY})`,
  )
  ok(
    /fillOpacity=\{DRAW_FILL_OPACITY\}/.test(FIELD_CODE),
    'the self-rendered map is given it too, so the two shapes are the same shade',
  )

  /*
    The renderer applies the spec rather than assembling its own options beside
    it. Otherwise the assertions above test a function nothing calls — which is
    the failure mode of extracting a decision and leaving the old code in place.
  */
  ok(/\.\.\.spec\.options/.test(GOOGLE_CODE), 'and the Google renderer spreads the spec it was given')
  /*
    Scoped to the *drawing* options. The route line and the flight line are
    different features with their own polylines and their own opacities — a
    pattern that catches `strokeOpacity: 0.75` on the route is matching the
    wrong thing, which this check did first time round.
  */
  const strays = [
    /fillColor:/.test(GOOGLE_CODE) && 'fillColor',
    /fillOpacity:/.test(GOOGLE_CODE) && 'fillOpacity',
    /strokeOpacity:\s*0(?![.\d])/.test(GOOGLE_CODE) && 'strokeOpacity: 0',
  ].filter(Boolean)
  ok(
    strays.length === 0,
    'rather than keeping a second set of drawing options next to it',
    strays.join(', ') || 'none',
  )

  // The vertex handle is the one piece of drawing style the renderer still owns,
  // because it is a DOM element rather than an overlay option.
  for (const token of ['DRAW_VERTEX_RADIUS', 'DRAW_VERTEX_FILL', 'DRAW_STROKE', 'DRAW_STROKE_WIDTH']) {
    ok(GOOGLE_CODE.includes(token), `the handle takes ${token} from the contract`)
  }
  for (const token of ['DRAW_STROKE', 'DRAW_FILL', 'DRAW_VERTEX_RADIUS', 'DRAW_STROKE_WIDTH']) {
    ok(FIELD_CODE.includes(token), `the self-rendered shape takes ${token} from the contract`)
  }
  ok(
    !/rgba\(15,169,184/.test(GOOGLE_CODE) && !/rgba\(15,169,184/.test(FIELD_CODE),
    'and neither hard-codes the drawing palette again',
  )
}

/* --- 4. the screen reader is told the same thing ------------------------- */
{
  ok(mapAriaLabel(undefined) === 'Map of your leads', 'a plain map says what it is')
  ok(
    mapAriaLabel({}) === 'Outline a territory on the map',
    'a drawing surface with no label of its own falls back to one sentence',
  )
  ok(
    mapAriaLabel({ label: 'Outline a list on the map' }) === 'Outline a list on the map',
    'and a caller that names the job keeps its own words',
  )
  ok(
    !/aria-label="Map of your leads"/.test(GOOGLE) &&
      !/aria-label=\{draw \?/.test(FIELD),
    'neither renderer spells the label out for itself',
  )
}

/* --- 5. zoom ------------------------------------------------------------- */
{
  ok(MAP_MIN_ZOOM === 1, 'both maps can zoom out to 1')
  /*
    The flight line is why. The navigate screen draws a direct path between a
    rep and a door on another continent, and at a neighbourhood zoom the two are
    thousands of kilometres off opposite edges — the case that used to be
    handed to whichever renderer could show it.
  */
  ok(
    /minZoom:\s*MAP_MIN_ZOOM/.test(GOOGLE_CODE),
    'Google is given the same floor rather than its own (which is 0)',
  )
  ok(/MIN_ZOOM = MAP_MIN_ZOOM/.test(FIELD_CODE), 'and the self-rendered map reads the same constant')
  /*
    Not equal at the top, and that is the contract. `FieldMap`'s ceiling is its
    tile vendor's; Google has real imagery past it. What must never happen is
    Google being the *shallower* of the two — a rep who gains the live map must
    not lose detail.
  */
  ok(
    GOOGLE_MAX_ZOOM >= FIELDMAP_MAX_ZOOM,
    `Google is never the shallower map (${GOOGLE_MAX_ZOOM} vs ${FIELDMAP_MAX_ZOOM})`,
  )
  ok(/maxZoom:\s*GOOGLE_MAX_ZOOM/.test(GOOGLE_CODE), 'and says so explicitly rather than defaulting')

  /*
    The case the floor exists for, checked as arithmetic rather than asserted.

    `verify:flightline` proves the great circle is the right *line* — it is pure
    maths and runs no renderer. What nothing checked is whether either map can
    frame it: a floor of 1 is only useful if the world at zoom 1 is big enough
    to hold the longest line this app ever draws, and the answer is not obvious
    (at zoom 1 the whole world is 512 CSS pixels wide).

    So: take the real worst case — Manila to Austin, the journey the flight line
    was built for — project its samples at zoom 1, and check the box they need
    fits on the narrowest phone this app supports. Renderer-independent, because
    Web Mercator is the same projection on both sides.
  */
  const WORLD = 256 * 2 ** MAP_MIN_ZOOM
  const PHONE = { w: 390, h: 844 }
  const arc = greatCirclePath({ lat: 14.5995, lng: 120.9842 }, { lat: 30.5083, lng: -97.6789 })
  const xs = arc.map((pt) => project(pt.lat, pt.lng).x * WORLD)
  const ys = arc.map((pt) => project(pt.lat, pt.lng).y * WORLD)
  /*
    Measured as "the world minus the biggest empty arc", which is the only
    correct way round a cylinder.

    This path crosses the antimeridian, so its x values sit in two clusters at
    opposite edges of the world. `max - min` therefore reads almost the whole
    globe, and `WORLD - (max - min)` — the obvious correction, and the one
    written here first — reads the *gap between the clusters*, which came out
    as 4px and would have passed this check for the wrong reason. Sorting and
    taking the largest step between neighbours finds the empty arc properly;
    what is left is the span.
  */
  const widest = (vals) => {
    const sorted = [...vals].sort((a, b) => a - b)
    let gap = sorted[0] + WORLD - sorted[sorted.length - 1] // the wrap-around step
    for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1])
    return WORLD - gap
  }
  const spanX = widest(xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  ok(
    spanX <= PHONE.w,
    `at zoom ${MAP_MIN_ZOOM} a Manila-to-Austin line fits a 390px phone across (${Math.round(spanX)}px)`,
  )
  ok(
    spanY <= PHONE.h,
    `and down (${Math.round(spanY)}px of ${PHONE.h})`,
  )
  // The margin is what makes the floor a *choice* rather than a coincidence: one
  // level shallower and the same line would not fit.
  ok(
    spanX * 2 > PHONE.w,
    'while one level in would not hold it, so 1 is the floor rather than an excess',
    `${Math.round(spanX * 2)}px at zoom ${MAP_MIN_ZOOM + 1}`,
  )
}

/* --- 6. the streets/satellite choice belongs to the person --------------- */
{
  for (const [name, src] of [
    ['FieldMap', FIELD_CODE],
    ['GoogleFieldMap', GOOGLE_CODE],
  ]) {
    ok(/loadLayer\(\)/.test(src), `${name} opens on the layer the rep last chose`)
    ok(/saveLayer\(/.test(src), `${name} remembers a change to it`)
    ok(
      /from '\.\.\/\.\.\/lib\/map-layer'/.test(src),
      `${name} reads it from the shared module, not its own copy`,
    )
  }
  /*
    The regression this replaced, named precisely.

    `const [satellite, setSatellite] = useState(false)` is what the Google map
    had: streets on every mount, so somebody assessing roofs re-picked satellite
    on every screen all day. Asserted against the declaring line rather than by
    scanning the file for `useState(false)` — the first version of this check did
    that and matched the `ready` flag four lines above, which is a different
    piece of state that is *correctly* false to begin with.
  */
  const declares = GOOGLE_CODE.split('\n').find((l) => /\[satellite,\s*setSatellite\]/.test(l))
  ok(!!declares, 'the Google map has a satellite flag to check')
  ok(
    /loadLayer\(\)/.test(declares ?? ''),
    'and seeds it from the stored choice rather than resetting to streets',
    (declares ?? '').trim(),
  )
  /*
    One key, so the choice survives the hand-off. A rep whose Google map dies
    mid-morning lands on the other renderer, and finding streets there after a
    morning in satellite is the same bug wearing a different hat.
  */
  const LAYER = read('src/lib/map-layer.ts')
  const keys = [...LAYER.matchAll(/'(allstar\.[a-z.]+)'/g)].map((m) => m[1])
  ok(new Set(keys).size === 1, `one storage key for the preference (${[...new Set(keys)]})`)
}

/* --- 7. one decision layer, and only one --------------------------------- */
//
// The requirement this file exists to hold: no screen decides for itself.
// Before `AllStarMap`, two screens each kept their own `useGoogle` boolean and
// four more named `FieldMap` directly — so a console with Google configured,
// working and paid for still drew the schematic map, and nothing reported it.
{
  ok(
    /gmapsConfigured\(\)/.test(code(ALLSTAR)),
    'AllStarMap is where the renderer is chosen',
  )
  ok(/onUnavailable/.test(code(ALLSTAR)), 'and where the fallback is handled')

  const screens = [
    'src/screens/MapScreen.tsx',
    'src/screens/Navigate.tsx',
    'src/screens/RepDetail.tsx',
    'src/admin/AdminTerritories.tsx',
    'src/admin/AdminLists.tsx',
    'src/admin/AdminLeads.tsx',
  ]
  for (const path of screens) {
    const src = code(read(path))
    ok(/<AllStarMap/.test(src), `${path.split('/').pop()} renders the shared map`)
    ok(
      !/<FieldMap|<GoogleFieldMap/.test(src),
      `${path.split('/').pop()} names neither renderer directly`,
    )
    ok(
      !/gmapsConfigured\(\)\s*&&/.test(src),
      `${path.split('/').pop()} keeps no second copy of the decision`,
    )
  }

  /*
    Nothing outside the decision layer may import a renderer to *render* it.
    `MapScreen` still imports `MapHandle` and the admin screens still import
    `fitZoom`, which are a type and a pure function — allowed, and distinguished
    by the same source read rather than by trust.
  */
  for (const path of screens) {
    const src = read(path)
    const imports = [...src.matchAll(/import \{([^}]*)\} from '[^']*\/(FieldMap|GoogleFieldMap)'/g)]
    for (const [, named] of imports) {
      const bad = named
        .split(',')
        .map((x) => x.replace(/\btype\b/, '').trim())
        .filter((x) => x === 'FieldMap' || x === 'GoogleFieldMap')
      ok(bad.length === 0, `${path.split('/').pop()} imports no renderer component`, bad.join(','))
    }
  }
}

/* --- 8. the two names the key arrives under ------------------------------ */
//
// The same key reaches the same line of code down two completely different
// pipelines, and only one of them is obvious.
//
// `lib/gmaps.ts` reads `process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY`. Metro inlines
// anything prefixed `EXPO_PUBLIC_` and so the phone is served directly. Vite
// does not know that prefix — and the app cannot use `import.meta.env`, which
// Metro will not parse — so `vite.config.ts` translates: the variable a person
// sets on Cloudflare Pages is `VITE_GOOGLE_MAPS_KEY`, and the `define` block
// substitutes it at the point the app reads the Expo name.
//
// Which means a rename on either side silently ships a build with no map and no
// error: `gmapsConfigured()` simply returns false and the app keeps its own
// renderer, which is exactly what it does when nobody has bought a key.
{
  const vite = code(read('vite.config.ts'))
  const gmaps = code(read('src/lib/gmaps.ts'))
  for (const name of ['GOOGLE_MAPS_KEY', 'GOOGLE_MAP_ID']) {
    ok(
      gmaps.includes(`process.env.EXPO_PUBLIC_${name}`),
      `the app reads EXPO_PUBLIC_${name}, which Metro inlines for the phone`,
    )
    ok(
      new RegExp(`'process\\.env\\.EXPO_PUBLIC_${name}':\\s*pass\\('${name}'\\)`).test(vite),
      `and Vite substitutes VITE_${name} into it for the web`,
    )
  }
  /*
    The unset case has to fold to a *provably* false `gmapsConfigured()`, or
    rollup keeps the Google renderer, the marker clusterer and supercluster in a
    bundle that can never use them. `pass()` returns the identifier `undefined`
    rather than `''` for exactly this reason — see the note in vite.config.ts.
  */
  ok(/return value \? JSON\.stringify\(value\) : 'undefined'/.test(vite), 'an unset key folds away entirely')

  // Nothing anywhere may put a key in the source. Both names are read from the
  // environment and never assigned one.
  const leaked = ['src/lib/gmaps.ts', 'src/components/map/AllStarMap.tsx', 'vite.config.ts'].filter(
    (f) => /AIza[0-9A-Za-z_-]{20,}/.test(read(f)),
  )
  ok(leaked.length === 0, 'and no Google key is written down in the source', leaked.join(','))
}

/* --- 9. the fallback is not going anywhere ------------------------------- */
//
// Stated as a gate because it is a promise rather than an implementation
// detail. The self-rendered map is what runs with no signal, on a device whose
// WebGL is blocked, and for a deployment with no Google account at all — and it
// is the only one of the two that needs nothing from anybody.
{
  ok(/<FieldMap/.test(code(ALLSTAR)), 'AllStarMap still falls back to the self-rendered map')
  ok(
    /gmapsConfigured\(\) && !dead/.test(code(ALLSTAR)),
    'and returns to it when Google reports it cannot draw',
  )
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== map parity OK ===')
process.exit(fails.length ? 1 : 0)
