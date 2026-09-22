import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Property, Route } from '../../types'
import { project, unproject, type Position, centerOf } from '../../lib/geo'
import { LocationPinSvg } from './LocationPin'
import { useStoredTiles } from '../../lib/tile-source'
import { STATUS_COLOR } from '../../data/outcomes'
import {
  LAYERS,
  loadLayer,
  saveLayer,
  tilesAvailable,
  visibleTiles,
  type LayerId,
} from '../../lib/tiles'

/** brand-500 — the one place on the map that is allowed to be teal by default. */
const SELECTED_PIN = '#20C4D3'

/*
  The centre of a pin whose position is an estimate.

  A literal, like every other colour in this file: the map draws into an SVG
  over its own self-rendered basemap, and the CSS custom properties here hold
  raw RGB triples for Tailwind rather than usable colour values. This matches
  the basemap's own land tone, so a hollow pin reads as an outline on the map
  rather than as a white sticker on top of it.
*/
const ESTIMATED_FILL = '#0F1828'

/**
 * Touch-first map renderer.
 *
 * Draws real imagery when a tile key is configured, and its own basemap when not
 * — in that order, layered. The drawn grid is painted first and tiles go over
 * the top, so a tile that has not arrived (no signal, not yet cached, provider
 * down) leaves a usable map underneath instead of a grey square. That is what
 * keeps imagery an enhancement rather than a dependency, on a screen a rep uses
 * at zero bars.
 *
 * Projection, pan/zoom and hit-testing are all local rather than delegated to a
 * mapping library: the arithmetic is forty lines, and MapLibre would cost ~200 kB
 * gzipped against a 47 kB bundle aimed at cheap phones.
 *
 * Controls are sized and positioned for a thumb, not a mouse pointer.
 */

const TILE = 256
/**
 * How far out this map can go.
 *
 * Was 12 — a neighbourhood — which was right while the only thing this map ever
 * showed was a territory. It is wrong the moment the screen has to show a rep in
 * one country and a door in another: at zoom 12 the two are thousands of
 * kilometres off opposite edges, so the line between them could not be drawn and
 * the far-away case had to be handed to the other renderer. Two renderers that
 * disagree about what they can show is the thing the shared prop contract exists
 * to prevent.
 */
const MIN_ZOOM = 1
const MAX_ZOOM = 19
/**
 * Below this the drawn street grid stops being a plausible street grid.
 *
 * It is a synthetic lattice at roughly block spacing — real spatial texture at
 * the zooms a rep works at, and nonsense at continental scale, where it would
 * also mean tens of thousands of SVG lines. Below this zoom the basemap draws the
 * true graticule instead: fewer lines, no invention, and it gives scale.
 */
const STREET_GRID_FROM_ZOOM = 12
/**
 * Graticule spacings, coarse to fine. The first one that puts no more than a
 * dozen lines across the viewport wins.
 */
const GRATICULE_STEPS = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02]
/** Below this, nearby pins merge into counts so the map stays readable. */
const CLUSTER_UNTIL_ZOOM = 17
const CLUSTER_CELL_PX = 58
/** How far above a covering sheet a revealed pin should sit. One pin's height. */
const PIN_MARGIN = 44
/** Room left round a fitted set of points, so the tallest pin glyph is inside. */
const FIT_PAD = 64

export interface MapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void
  /**
   * Show all of these points at once.
   *
   * For a list opened from its page: the rep asked to see *these* houses, and
   * a map that opens on whichever lead sorts first, at street zoom, shows one
   * of them and leaves the rest to be found by panning. One point is a flight
   * to it; more is the tightest view that holds them all.
   */
  fit: (points: { lat: number; lng: number }[]) => void
  /**
   * Pan just enough to lift a point clear of the bottom `covered` fraction of
   * the map, and not one pixel more.
   *
   * For the sheet that rises over a tapped house. Recentring on the point would
   * be the easy thing and the wrong one — the rep is watching the pin land
   * where their finger was, and sliding it to the middle of the screen throws
   * away the confirmation the tap was for. So this does nothing at all unless
   * the point is actually about to be covered.
   *
   * The renderer works it out rather than the caller: only the map knows how
   * tall it is and where a coordinate falls inside it.
   */
  reveal: (at: { lat: number; lng: number }, covered: number) => void
}

interface Props {
  properties: Property[]
  position: Position | null
  route?: Route | null
  selectedId?: string | null
  onSelect: (id: string | null) => void
  /** Rendered over the map — filter chips, sheets, floating buttons. */
  overlay?: React.ReactNode
  className?: string
  initialCenter?: { lat: number; lng: number }
  /** Overrides the default field zoom — used to frame a whole territory. */
  initialZoom?: number
  /**
   * Clustering exists so a rep isn't shown fifty overlapping dots they can't
   * distinguish while walking. In an office territory view the opposite is
   * true: seeing every property *is* the point, so the console turns it off.
   */
  disableClustering?: boolean
  handleRef?: React.MutableRefObject<MapHandle | null>
  /**
   * An arbitrary path to draw, matching `GoogleFieldMap`'s prop of the same name
   * so the navigate screen can hand either renderer the same line.
   *
   * Supplying one also frames it: the view fits the whole path once, and stops
   * following the rep, because a line whose far end is off screen is not a line
   * anybody can read.
   */
  path?: { lat: number; lng: number }[]
  /**
   * `route` is a way to get there. `flight` is the direct line to somewhere no
   * route reaches — dashed, with a plane on it, because a solid line between two
   * continents reads as a route and there is none.
   */
  pathKind?: 'route' | 'flight'
  /**
   * Territory drawing. When present the map is a drawing surface: a tap drops a
   * vertex instead of selecting a pin, and the shape so far is filled in.
   *
   * The points live with the caller, not here. Whoever is drawing owns the undo,
   * the name and the save; this component's job is to turn a tap into a
   * coordinate and show what has been drawn, which is the only part that needs
   * to know about the projection.
   */
  draw?: {
    points: { lat: number; lng: number }[]
    onAddPoint: (point: { lat: number; lng: number }) => void
    /**
     * What the drawing is for, announced to a screen reader.
     *
     * The gesture has two callers now — outlining a territory, and selecting a
     * block of leads to act on — and while it was only ever the first, the label
     * said "territory" unconditionally. Reusing the gesture without this made
     * the map tell a screen reader the wrong thing about what a tap would do.
     */
    label?: string
  }
  /**
   * Location picking — the tap that becomes a lead.
   *
   * Separate from `draw` because it answers a different question with the same
   * gesture. Drawing collects a shape and keeps collecting; picking holds one
   * point and replaces it, so a rep who tapped the wrong house taps the right
   * one rather than undoing anything.
   *
   * `at` lives with the caller for the same reason `draw.points` does: whoever
   * opened the form owns the coordinate, and this component's job is only to
   * turn a tap into one and draw where it landed.
   */
  pick?: {
    at: { lat: number; lng: number } | null
    onPick: (point: { lat: number; lng: number }) => void
    /** What a tap will do, for a screen reader. */
    label?: string
    /**
     * Whether picking takes *every* tap, including one on a lead's own dot.
     *
     * Off by default, and the default is the important half. A rep tapping a
     * house they already have is asking about that house — so with the picker
     * merely armed, a tap that lands on a dot opens the lead as it always did,
     * and only a tap that misses everything places a new pin. Nothing about
     * looking at the map changes.
     *
     * On while the form is open, when the question has already been asked:
     * every tap is the answer to "which house?", and a dot 22px wide sitting a
     * few feet from the one the rep means must not hijack it into opening
     * somebody else's lead over the form. Lead dots stay drawn, because they
     * are the context that makes the choice make sense; they just stop being
     * buttons until the question is answered.
     */
    exclusive?: boolean
  }
}

interface View {
  lat: number
  lng: number
  zoom: number
}

export function FieldMap({
  properties,
  position,
  route,
  selectedId,
  onSelect,
  overlay,
  className = '',
  initialCenter,
  initialZoom,
  disableClustering,
  handleRef,
  path,
  pathKind = 'route',
  draw,
  pick,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>(() => ({
    lat: initialCenter?.lat ?? properties[0]?.lat ?? 30.5083,
    lng: initialCenter?.lng ?? properties[0]?.lng ?? -97.6789,
    zoom: initialZoom ?? 16,
  }))
  const [followMe, setFollowMe] = useState(true)
  const [layer, setLayer] = useState<LayerId>(() => loadLayer())
  const hasTiles = tilesAvailable()

  /* --- viewport ---------------------------------------------------------- */

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Recenter on the rep only while "follow" is on — any manual pan turns it off,
  // otherwise the map yanks itself back mid-drag.
  useEffect(() => {
    if (followMe && position) {
      setView((v) => ({ ...v, lat: position.lat, lng: position.lng }))
    }
  }, [position, followMe])

  const scale = TILE * 2 ** view.zoom
  const centerWorld = useMemo(() => project(view.lat, view.lng), [view.lat, view.lng])

  const tiles = useMemo(
    () =>
      visibleTiles({
        layer,
        zoom: view.zoom,
        centerLat: view.lat,
        centerLng: view.lng,
        width: size.w,
        height: size.h,
        scale,
      }),
    [layer, view.zoom, view.lat, view.lng, size.w, size.h, scale],
  )
  /*
    Downloaded imagery, read back in app code. The service worker used to be
    the only thing that turned a tile request into a cache hit, and the packaged
    app has no service worker — see `lib/tile-source.ts`. A tile that is not
    stored keeps its network URL, so online this is exactly the map it was.
  */
  const tileHref = useStoredTiles(tiles)

  const toScreen = useCallback(
    (lat: number, lng: number) => {
      const w = project(lat, lng)
      /*
        Longitude as a wrapped offset from the centre rather than an absolute
        world coordinate. For anything inside one hemisphere this is the same
        arithmetic — which is every other use of this map — but it is what lets a
        line from Manila to Texas cross the antimeridian instead of being drawn
        the long way back across Asia. The tiles agree, because they are only
        fetched for the viewport and fold their own x into range.
      */
      return {
        x: (wrapDegrees(lng - view.lng) / 360) * scale + size.w / 2,
        y: (w.y - centerWorld.y) * scale + size.h / 2,
      }
    },
    [view.lng, centerWorld, scale, size.w, size.h],
  )

  /*
    The inverse of `toScreen`, and it has to stay the inverse — longitude is a
    wrapped offset from the centre there, so it is an offset here too rather than
    an absolute world coordinate.
  */
  const toLatLng = useCallback(
    (px: number, py: number) => {
      const w = unproject(centerWorld.x, centerWorld.y + (py - size.h / 2) / scale)
      return {
        lat: w.lat,
        lng: wrapDegrees(view.lng + ((px - size.w / 2) / scale) * 360),
      }
    },
    [centerWorld, scale, size.w, size.h, view.lng],
  )

  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => {
    setFollowMe(false)
    setView((v) => ({ lat, lng, zoom: zoom ?? Math.max(v.zoom, 17) }))
  }, [])

  /*
    Held until the box has been measured. A fit asked for on the first render
    has no width to fit into — the ResizeObserver above has not fired yet — and
    guessing a size would frame the list for a phone that is not this one.
  */
  const pendingFit = useRef<{ lat: number; lng: number }[] | null>(null)
  const applyFit = useCallback((points: { lat: number; lng: number }[], w: number, h: number) => {
    setFollowMe(false)
    if (points.length === 1) {
      setView({ lat: points[0].lat, lng: points[0].lng, zoom: 18 })
      return
    }
    /*
      Padded in pixels, not as a fraction of the span. Four houses on one block
      span a hundred metres; fifteen per cent of that is a few pixels, and a pin
      is drawn forty-four pixels tall above its point — so the northernmost
      house's pin was clipped by the top edge while its coordinate was
      technically in view. FIT_PAD leaves room for the glyph on every side.
    */
    setView({
      ...centerOf(points),
      zoom: fitZoom(points, Math.max(1, w - 2 * FIT_PAD), Math.max(1, h - 2 * FIT_PAD), 0),
    })
  }, [])
  const fit = useCallback(
    (points: { lat: number; lng: number }[]) => {
      if (points.length === 0) return
      // Stop following the rep's position now, not when the box is measured:
      // a fix that arrives in between would drag the view off the list.
      setFollowMe(false)
      if (size.w === 0 || size.h === 0) {
        pendingFit.current = points
        return
      }
      applyFit(points, size.w, size.h)
    },
    [size.w, size.h, applyFit],
  )
  useEffect(() => {
    if (size.w === 0 || size.h === 0 || !pendingFit.current) return
    const points = pendingFit.current
    pendingFit.current = null
    applyFit(points, size.w, size.h)
  }, [size.w, size.h, applyFit])

  /* --- gestures ---------------------------------------------------------- */

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null)
  const panMoved = useRef(0)
  /**
   * Did this gesture ever have two fingers on the map?
   *
   * Reported from the field as "can't zoom in or out without having a pop up
   * for a new pin". Pinching ended with the add-lead sheet open on whatever
   * house happened to be under the last finger up, every time.
   *
   * The reason is that a pinch never accumulates `panMoved`: the two-finger
   * branch of `onPointerMove` returns before the pan arithmetic, so the
   * distance travelled stays zero. Lifting the first finger was suppressed by
   * the `pointers.size > 0` check — but lifting the *second* left no pointers,
   * zero travel, and a marker captured on the way down. That is indistinguishable
   * from a tap, so it was treated as one.
   *
   * Tracked for the whole gesture rather than inferred at release, because by
   * the time the last finger comes up every trace of the second one is gone.
   * Cleared only when the map is empty of pointers — a pinch that turns into a
   * one-finger drag is still a pinch, and must not end in a pin either.
   */
  const pinched = useRef(false)
  /**
   * Which marker the gesture started on.
   *
   * Taps are resolved here rather than with per-marker handlers because the SVG
   * root captures the pointer (so a drag that leaves the element still pans).
   * Pointer capture *retargets* every later event — including pointerup — to the
   * capturing element, so handlers on the markers themselves would never fire.
   * pointerdown is the one event that still reports the true target.
   */
  const downMarker = useRef<{ kind: string; index: number } | null>(null)

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setView((v) => {
        const s = TILE * 2 ** v.zoom
        const c = project(v.lat, v.lng)
        const next = unproject(c.x - dx / s, c.y - dy / s)
        return { ...v, lat: next.lat, lng: next.lng }
      })
    },
    [],
  )

  const reveal = useCallback(
    (at: { lat: number; lng: number }, covered: number) => {
      /*
        `covered` is a fraction of the *screen*, because that is what a sheet
        covers — it is anchored to the bottom of the viewport, not to the bottom
        of the map, and on this screen the two are a nav bar apart. Taking the
        fraction of the map's own height instead moved the pin by that nav bar
        on every tap, which the gate caught as a pin 60px above the finger.
      */
      const box = boxRef.current?.getBoundingClientRect()
      if (!box) return
      const limit = window.innerHeight * (1 - covered) - box.top
      const y = toScreen(at.lat, at.lng).y
      /*
        Only when the sheet would actually cover it. Nudging a pin that is
        already in clear view would trade the strongest confirmation this
        interaction has — the pin appearing exactly under the finger, map
        motionless — for tidier margins, which is the wrong way round.
      */
      if (y > limit) panBy(0, -(y - limit + PIN_MARGIN))
    },
    [toScreen, panBy],
  )

  useEffect(() => {
    if (handleRef) handleRef.current = { flyTo, reveal, fit }
  }, [handleRef, flyTo, reveal, fit])

  const onPointerDown = (e: React.PointerEvent) => {
    const hit = (e.target as Element).closest?.('[data-marker]') as HTMLElement | null
    downMarker.current = hit
      ? { kind: hit.dataset.marker ?? '', index: Number(hit.dataset.index ?? -1) }
      : null
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // Only the first finger starts a fresh gesture. Resetting on the second
    // was how a pinch arrived at release claiming to have travelled nowhere.
    if (pointers.current.size === 1) {
      panMoved.current = 0
      pinched.current = false
    }
    if (pointers.current.size === 2) {
      pinched.current = true
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const cur = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, cur)

    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const ratio = dist / pinchStart.current.dist
      const zoom = clamp(pinchStart.current.zoom + Math.log2(ratio), MIN_ZOOM, MAX_ZOOM)
      setView((v) => ({ ...v, zoom }))
      setFollowMe(false)
      return
    }

    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    panMoved.current += Math.abs(dx) + Math.abs(dy)
    if (panMoved.current > 6) setFollowMe(false)
    panBy(dx, dy)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null

    // A drag is never a tap. Anything under ~6px of travel counts as one, which
    // tolerates the wobble of tapping while walking. Nor is a pinch — see
    // `pinched`, which is the whole reason zooming used to end in a new pin.
    if (panMoved.current >= 6 || pointers.current.size > 0 || pinched.current) {
      downMarker.current = null
      // The gesture is over once the last finger leaves; the next one starts
      // clean. Left set, the first genuine tap after a pinch would be eaten.
      if (pointers.current.size === 0) pinched.current = false
      return
    }

    const hit = downMarker.current
    downMarker.current = null

    /*
      Drawing takes the tap before anything else does. Selecting a pin mid-draw
      would be the wrong thing twice: it loses the vertex the person meant to
      place, and it opens a lead they were not asking about.
    */
    if (draw) {
      const box = boxRef.current?.getBoundingClientRect()
      if (box) draw.onAddPoint(toLatLng(e.clientX - box.left, e.clientY - box.top))
      return
    }

    /*
      Then the location picker — for a tap that hit nothing, or for any tap at
      all once the form is open. See `pick.exclusive`, which is where the
      difference between those two is argued.
    */
    if (pick && (pick.exclusive || !hit)) {
      const box = boxRef.current?.getBoundingClientRect()
      if (box) pick.onPick(toLatLng(e.clientX - box.left, e.clientY - box.top))
      return
    }

    if (!hit) {
      onSelect(null)
      return
    }
    if (hit.kind === 'pin') {
      const pin = pins[hit.index]
      if (pin) onSelect(pin.id)
      return
    }
    if (hit.kind === 'cluster') {
      const c = clusters[hit.index]
      // Zoom toward the cluster rather than selecting it — at this zoom the rep
      // can't tell these doors apart anyway.
      if (c) flyTo(c.members[0].property.lat, c.members[0].property.lng, Math.min(MAX_ZOOM, view.zoom + 2))
    }
  }

  /**
   * Wheel zoom, which was on the map and effectively did not work.
   *
   * Reported from the console: "Zooming is difficult and you have to use the +
   * and - buttons." Two faults, and either alone is enough to make a wheel feel
   * broken.
   *
   * **It was far too slow, and unpredictably so.** `deltaY * 0.002` assumes
   * `deltaY` is in pixels — one mouse notch is about 100, so a fifth of a zoom
   * level per notch, five notches to move one step. But `deltaMode` is not
   * always pixels: Firefox and some Windows configurations report *lines*,
   * where a notch is about 3, giving 0.006 of a zoom level — a wheel that
   * genuinely does nothing at all. That is almost certainly what was seen.
   * Normalising by `deltaMode` first is what makes the gesture behave the same
   * everywhere.
   *
   * **The page scrolled instead.** Without `preventDefault` the wheel does its
   * usual job as well, so the console scrolls away under the cursor while the
   * map creeps. And `preventDefault` from React's `onWheel` cannot fix it:
   * React attaches wheel at the root as a *passive* listener, where
   * `preventDefault()` is a silent no-op. It has to be a native listener
   * registered with `{ passive: false }`, which is why this is an effect on the
   * box rather than a prop on the SVG.
   */
  useEffect(() => {
    const el = boxRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      // The map owns the gesture; the page must not also scroll.
      e.preventDefault()
      /*
        A notch, in whatever unit this browser chose to report it.

        The conversion is chosen so that one detent of a wheel is one detent
        everywhere, which is the only thing a hand can feel. In pixel mode a
        detent is about 100; in line mode it is three lines; in page mode it is
        one page. So a line is a third of a detent and a page is a whole one,
        and all three arrive here as the same number.
      */
      const perLine = 100 / 3
      const perPage = 100
      const pixels =
        e.deltaMode === 1 ? e.deltaY * perLine : e.deltaMode === 2 ? e.deltaY * perPage : e.deltaY

      /*
        About half a zoom level per mouse notch: two notches to a step, which is
        fast enough to cross a city and slow enough to land on a street. A
        trackpad sends many small deltas and lands on the same rate.
      */
      const step = -pixels * 0.005
      setFollowMe(false)
      setView((v) => ({ ...v, zoom: clamp(v.zoom + step, MIN_ZOOM, MAX_ZOOM) }))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /* --- basemap ----------------------------------------------------------- */

  // A street grid derived from the projection itself. It gives real spatial
  // context (blocks, arterials) with zero network cost — and below the zooms
  // where streets exist, the true graticule instead. Same drawing code, two
  // spacings: one invented and plausible, one real and coarse.
  const grid = useMemo(() => {
    if (!size.w || !size.h)
      return { minor: [] as string[], major: [] as string[], streets: true }
    const tl = screenToLatLng(0, 0)
    const br = screenToLatLng(size.w, size.h)
    const streets = view.zoom >= STREET_GRID_FROM_ZOOM
    /*
      At block spacing a continental view would be fifty thousand lines, which is
      a frozen phone rather than a slow one — so the spacing is chosen from the
      span, and the loops below are bounded regardless.
    */
    const span = Math.max(Math.abs(tl.lat - br.lat), Math.abs(wrapDegrees(br.lng - tl.lng)))
    const coarse = GRATICULE_STEPS.find((s) => span / s <= 12) ?? 0.02
    const latStep = streets ? 0.0022 : coarse
    const lngStep = streets ? 0.00255 : coarse
    const minor: string[] = []
    const major: string[] = []

    const latStart = Math.floor(br.lat / latStep) * latStep
    const limit = 240
    for (let lat = latStart, n = 0; lat <= tl.lat + latStep && n < limit; lat += latStep, n++) {
      const y = toScreen(lat, tl.lng).y
      if (y < -20 || y > size.h + 20) continue
      const line = `M0 ${y.toFixed(1)} H${size.w}`
      ;(Math.round(lat / latStep) % 4 === 0 ? major : minor).push(line)
    }
    const lngStart = Math.floor(tl.lng / lngStep) * lngStep
    for (let lng = lngStart, n = 0; lng <= br.lng + lngStep && n < limit; lng += lngStep, n++) {
      const x = toScreen(tl.lat, lng).x
      if (x < -20 || x > size.w + 20) continue
      const line = `M${x.toFixed(1)} 0 V${size.h}`
      ;(Math.round(lng / lngStep) % 5 === 0 ? major : minor).push(line)
    }
    return { minor, major, streets }

    function screenToLatLng(px: number, py: number) {
      return unproject(
        centerWorld.x + (px - size.w / 2) / scale,
        centerWorld.y + (py - size.h / 2) / scale,
      )
    }
  }, [size.w, size.h, centerWorld, scale, toScreen, view.zoom])

  /* --- markers + clustering ---------------------------------------------- */

  const { pins, clusters } = useMemo(() => {
    if (!size.w) return { pins: [] as Pin[], clusters: [] as Cluster[] }
    const margin = 80
    const visible: Pin[] = []

    for (const p of properties) {
      const { x, y } = toScreen(p.lat, p.lng)
      // Cull off-screen work before it ever reaches the DOM.
      if (x < -margin || x > size.w + margin || y < -margin || y > size.h + margin) continue
      visible.push({ id: p.id, x, y, property: p })
    }

    if (disableClustering || view.zoom >= CLUSTER_UNTIL_ZOOM)
      return { pins: visible, clusters: [] }

    // Screen-space grid clustering: cheap, stable, and good enough at the zooms
    // where individual doors aren't distinguishable anyway.
    const cells = new Map<string, Pin[]>()
    for (const pin of visible) {
      const key = `${Math.floor(pin.x / CLUSTER_CELL_PX)}:${Math.floor(pin.y / CLUSTER_CELL_PX)}`
      const arr = cells.get(key)
      if (arr) arr.push(pin)
      else cells.set(key, [pin])
    }

    const soloPins: Pin[] = []
    const groups: Cluster[] = []
    for (const members of cells.values()) {
      if (members.length === 1 || members.some((m) => m.id === selectedId)) {
        soloPins.push(...members)
      } else {
        const x = members.reduce((a, m) => a + m.x, 0) / members.length
        const y = members.reduce((a, m) => a + m.y, 0) / members.length
        groups.push({ x, y, members })
      }
    }
    return { pins: soloPins, clusters: groups }
  }, [properties, toScreen, size.w, size.h, view.zoom, selectedId, disableClustering])

  /* --- route path -------------------------------------------------------- */

  const routePaths = useMemo(() => {
    if (!route || !size.w) return null
    const byId = new Map(properties.map((p) => [p.id, p]))
    const ordered = [...route.stops].sort((a, b) => a.order - b.order)
    const done: string[] = []
    const todo: string[] = []
    let prev: { x: number; y: number } | null = null
    let prevDone = true
    for (const stop of ordered) {
      const p = byId.get(stop.propertyId)
      if (!p) continue
      const pt = toScreen(p.lat, p.lng)
      if (prev) {
        const seg = `M${prev.x.toFixed(1)} ${prev.y.toFixed(1)} L${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`
        if (prevDone && stop.status === 'done') done.push(seg)
        else todo.push(seg)
      }
      prev = pt
      prevDone = stop.status === 'done'
    }
    return { done: done.join(' '), todo: todo.join(' ') }
  }, [route, properties, toScreen, size.w])

  /*
    Frame a supplied path once.

    Once, not on every render: a rep is allowed to pinch and pan afterwards, and
    a view that snaps back to the whole line is the most annoying possible bug on
    a map. Following the rep is switched off for the same reason — the two
    endpoints are the subject, and one of them being centred puts the other off
    screen by a continent.
  */
  const fitted = useRef(false)
  useEffect(() => {
    if (!path || path.length < 2 || !size.w || !size.h || fitted.current) return
    fitted.current = true
    setFollowMe(false)
    setView({
      ...fitCenter(path),
      /*
        Generous padding, and it is not decoration. The plane glyph and both end
        markers stick out past the line itself, and the zoom controls sit over
        the right edge — at 0.3 the door pin landed underneath them.
      */
      zoom: fitZoom(path, size.w, size.h, 0.45),
    })
  }, [path, size.w, size.h])

  /* --- an explicitly supplied path --------------------------------------- */
  const drawnPath = useMemo(() => {
    if (!path || path.length < 2 || !size.w) return null
    const pts = path.map((p) => toScreen(p.lat, p.lng))
    const d = pts
      .map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
      .join(' ')
    // The plane sits halfway along the samples, which on a great circle is
    // nowhere near halfway between the endpoints on screen.
    const i = Math.floor(pts.length / 2)
    const a = pts[i]
    const b = pts[Math.min(i + 1, pts.length - 1)]
    // Screen-space heading: the glyph points along the line as drawn, which is
    // what a rep is looking at, rather than along the true bearing.
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90
    return { d, plane: { x: a.x, y: a.y, angle } }
  }, [path, toScreen, size.w])

  /* --- the territory being drawn ------------------------------------------ */
  const drawn = useMemo(() => {
    if (!draw || !size.w) return null
    const pts = draw.points.map((p) => toScreen(p.lat, p.lng))
    return {
      pts,
      // Closed as soon as there are three, because that is when it becomes a
      // shape — showing an open line up to that point is what tells somebody
      // they need one more tap.
      d:
        pts.length === 0
          ? ''
          : pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
            (pts.length >= 3 ? ' Z' : ''),
    }
  }, [draw, toScreen, size.w])

  /*
    Where the picked point is on screen, recomputed with the view like
    everything else here — the pin has to stay on its house through a pan and a
    zoom, which is the difference between a marker and a sticker.
  */
  const pickAt = pick?.at ? toScreen(pick.at.lat, pick.at.lng) : null

  const me = position ? toScreen(position.lat, position.lng) : null
  // Accuracy circle drawn to true scale — a 40m fix should *look* uncertain.
  const accuracyPx = position
    ? (position.accuracy / metersPerPixel(view.lat, view.zoom))
    : 0

  return (
    <div
      ref={boxRef}
      /*
        Named and roled to match `GoogleFieldMap`, so the two renderers are the
        same object to a screen reader and to anything looking for the map. It
        went unlabelled while it was only ever a picture; now a tap on it places
        a territory vertex, which makes it a control.
      */
      role="application"
      aria-label={draw ? (draw.label ?? 'Outline a territory on the map') : 'Map of your leads'}
      data-tour="map-canvas"
      className={`relative touch-none overflow-hidden bg-[#EDF1F3] ${className}`}
    >
      <svg
        width={size.w}
        height={size.h}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* basemap */}
        {/* Deep ground, lit roads — the same navy family as the app background,
            so the map reads as part of the product rather than an embedded
            widget from somewhere else. The relationship is the one it always
            was: the ground recedes and the street network sits on top of it.
            Inverted, because everything else was. */}
        <rect width={size.w} height={size.h} fill="var(--map-ground)" />
        {/*
          Roads at street zooms, a graticule below them. The widths are the
          difference between the two claims: fat lit ribbons read as streets, and
          drawing the world's meridians that way would be inventing a road
          network across the Pacific.
        */}
        {grid.streets ? (
          <>
            <path d={grid.minor.join(' ')} stroke="var(--map-grid-minor)" strokeWidth={7} fill="none" />
            <path d={grid.major.join(' ')} stroke="var(--map-grid-major)" strokeWidth={13} fill="none" />
            <path d={grid.major.join(' ')} stroke="var(--map-grid-edge)" strokeWidth={1} fill="none" />
          </>
        ) : (
          <>
            <path d={grid.minor.join(' ')} stroke="var(--map-grid-hair)" strokeWidth={1} fill="none" />
            <path d={grid.major.join(' ')} stroke="var(--map-grid-hair-major)" strokeWidth={1.5} fill="none" />
          </>
        )}

        {/*
          Imagery, over the drawn grid rather than instead of it.

          `preserveAspectRatio="none"` because the tile is placed at exactly its
          projected size — letting the renderer letterbox it would introduce
          seams. A tile that fails to load renders nothing at all, which is the
          whole point of the ordering here: the grid shows through.
        */}
        {tiles.map((t) => (
          <image
            key={t.key}
            href={tileHref(t.url)}
            x={t.x}
            y={t.y}
            width={t.size + 0.5}
            height={t.size + 0.5}
            preserveAspectRatio="none"
          />
        ))}

        {/* route */}
        {routePaths && (
          /*
            Named so a gate can ask whether the line is drawn at all. The scope
            control is a filter *and* the switch that feeds the route to both
            renderers, and a restructure that kept the filtering while dropping
            the line would look right on every other count.
          */
          <g data-route-line="">
            <path
              d={routePaths.todo}
              stroke="#20C4D3"
              strokeWidth={5}
              strokeLinecap="round"
              strokeDasharray="2 10"
              fill="none"
              opacity={0.85}
            />
            <path
              d={routePaths.done}
              stroke={layer === 'satellite' && hasTiles ? '#F1F5F9' : '#43587F'}
              strokeWidth={4}
              strokeLinecap="round"
              fill="none"
              opacity={0.7}
            />
          </g>
        )}

        {/*
          An explicitly supplied path — the walk to a door, or the direct line to
          one too far to route. Drawn under the markers so the two endpoints stay
          on top of it.
        */}
        {drawnPath && (
          <g>
            <path
              /* A stable hook for the gate: the alternative is asserting on a
                 stroke pattern, which is styling and will move. */
              data-line={pathKind}
              d={drawnPath.d}
              stroke={SELECTED_PIN}
              strokeWidth={pathKind === 'flight' ? 3 : 5}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={pathKind === 'flight' ? '7 9' : undefined}
              fill="none"
              opacity={0.9}
            />
            {pathKind === 'flight' && (
              /*
                The glyph is what says *this is not a walk* at a glance, which is
                the whole message when a rep opens a lead from the wrong
                continent. Rotated to the line as drawn, so it points the way the
                journey goes.
              */
              <g
                data-plane="flight"
                transform={`translate(${drawnPath.plane.x.toFixed(1)} ${drawnPath.plane.y.toFixed(
                  1,
                )})`}
              >
                <circle r={17} fill="#123846" stroke="#20C4D3" strokeWidth={1.5} opacity={0.97} />
                <g transform={`rotate(${drawnPath.plane.angle.toFixed(0)}) translate(-9.5 -9.5)`}>
                  <path
                    d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
                    fill={SELECTED_PIN}
                    transform="scale(0.79)"
                  />
                </g>
              </g>
            )}
          </g>
        )}

        {/*
          The territory being drawn. Over the pins, because while drawing the
          shape is the subject and the pins are the reference — and a vertex
          handle hidden behind a lead is a vertex nobody can see they placed.
        */}
        {drawn && drawn.pts.length > 0 && (
          <g data-draw="territory">
            <path
              d={drawn.d}
              fill={drawn.pts.length >= 3 ? 'rgba(15,169,184,0.16)' : 'none'}
              stroke="#20C4D3"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeDasharray={drawn.pts.length >= 3 ? undefined : '6 5'}
            />
            {drawn.pts.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={6}
                fill="#ffffff"
                stroke="#20C4D3"
                strokeWidth={2.5}
              />
            ))}
          </g>
        )}

        {/* current location */}
        {me && (
          <g>
            <circle
              cx={me.x}
              cy={me.y}
              r={Math.max(12, Math.min(accuracyPx, 400))}
              fill="#60A5FA"
              opacity={0.12}
            />
            <circle cx={me.x} cy={me.y} r={9} fill="#60A5FA" stroke="#0F1828" strokeWidth={3} />
          </g>
        )}

        {/* clusters */}
        {clusters.map((c, i) => (
          /*
            A white bubble with a teal hairline and a teal count.

            It used to be a white disc ringed in near-black over a soft dark
            halo, and eight of those on one screen read as a diagram rather than
            a map — the loudest things on it were the things standing in for the
            pins. The count is what carries the meaning, so the count gets the
            colour and the ring is only there to hold the shape against imagery.
          */
          <g key={`c${i}`} data-marker="cluster" data-index={i} className="cursor-pointer">
            {/* The same invisible 44px target a single pin gets. Without it a
                cluster was a 38px bubble — the one marker on this map a thumb
                could miss, and the one standing for the most doors. */}
            <circle cx={c.x} cy={c.y} r={22} fill="transparent" />
            <circle cx={c.x} cy={c.y} r={19} fill="#20C4D3" opacity={0.22} />
            {/* Dark disc, bright count: 6.9:1. A white disc would need a dark
                label, and a dark label is the one thing on this map that has
                nothing else the same colour. */}
            <circle
              cx={c.x}
              cy={c.y}
              r={17}
              fill="#123846"
              stroke="#20C4D3"
              strokeWidth={1.5}
            />
            <text
              x={c.x}
              y={c.y + 5}
              textAnchor="middle"
              className="nums"
              fontSize={13.5}
              fontWeight={600}
              fill="#7FE0EF"
            >
              {c.members.length}
            </text>
          </g>
        ))}

        {/* individual properties */}
        {pins.map((pin, i) => {
          const selected = pin.id === selectedId
          /*
            Status colours the dot; selection overrides it with the brand orange.
            Selection is a UI state rather than a property of the lead, and
            "the same colour but bigger" is unreadable the moment the pin beside
            it shares a status.
          */
          const color = selected ? SELECTED_PIN : STATUS_COLOR[pin.property.status]
          const r = selected ? 13 : 9
          /*
            Whether we actually know which house this is.

            The geocoders have always reported this and the map has always drawn
            every pin the same, which is the one version of this that misleads
            somebody: an estimated position rendered with exactly the confidence
            of a surveyed one. A rep walks to the dot, knocks, and finds out at
            the door that the app was guessing.

            `interpolated` means a house number estimated along a block — right
            street, right side, quite possibly the wrong house. So it gets a ring
            roughly the width of that uncertainty and a hollow centre: the pin
            still says "a lead is about here", and stops claiming "a lead is
            *here*".

            Undefined is left alone deliberately. A lead imported before this was
            recorded has no verdict either way, and drawing thousands of them as
            uncertain would be its own false claim — this marks what we know to
            be estimated, not everything we have not checked.
          */
          const estimated =
            pin.property.geoPrecision === 'interpolated' ||
            pin.property.geoPrecision === 'approximate'
          /*
            Knocked, and nobody came to the door.

            `no_answer` deliberately does not move a lead's status — a miss is
            not pipeline progress, and that rule is right. The consequence
            nobody had noticed is that the map colours pins *by status only*, so
            a door knocked three times looked exactly like a door nobody had
            ever walked up to. For a canvasser that is close to the most useful
            thing a pin can say, and it was the one thing it could not.

            Status and visit history are two different questions, so they get two
            different channels rather than one colour trying to answer both. The
            mark is a bar across the dot, which is the same glyph the outcome
            grid already uses for No Answer — a rep has seen "—" mean this since
            their first knock. It is a shape rather than a shade, so it survives
            sunlight and colourblindness the way the outcome buttons do.
          */
          const noAnswer = pin.property.lastOutcome === 'no_answer'
          return (
            <g
              key={pin.id}
              data-marker="pin"
              data-index={i}
              // Which lead this is, not just that it is one. Added for the gate
              // that has to prove a saved lead landed where the pin was; a
              // marker you cannot name is one you cannot check.
              data-id={pin.id}
              className="cursor-pointer"
            >
              {/* Invisible 44px hit area — the visible dot is far too small to
                  hit reliably with a thumb, so the target is decoupled from it. */}
              <circle cx={pin.x} cy={pin.y} r={22} fill="transparent" />
              {selected && (
                <circle cx={pin.x} cy={pin.y} r={22} fill={color} opacity={0.2} />
              )}
              {estimated && (
                /*
                  Dashed rather than a second solid ring, and under the dot so it
                  never competes with it. A solid halo reads as emphasis — the
                  selected pin already uses one — and this is the opposite claim.
                */
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={r + 8}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  opacity={0.7}
                />
              )}
              <circle
                cx={pin.x}
                cy={pin.y}
                r={r}
                // Hollow when the position is estimated: the colour still carries
                // the lead's status, the emptiness carries the doubt.
                fill={estimated ? ESTIMATED_FILL : color}
                stroke={estimated ? color : '#fff'}
                strokeWidth={selected ? 3.5 : 2.5}
              />
              {noAnswer && (
                /*
                  Drawn over the dot, and its colour flips with the fill beneath
                  it: dark ink reads on all eight status colours, which are
                  mid-to-light by design, and the status colour reads on the dark
                  centre of an estimated pin. One fixed colour would disappear
                  against one of the two.
                */
                <line
                  x1={pin.x - (selected ? 7 : 5)}
                  y1={pin.y}
                  x2={pin.x + (selected ? 7 : 5)}
                  y2={pin.y}
                  stroke={estimated ? color : ESTIMATED_FILL}
                  strokeWidth={selected ? 3 : 2.5}
                  strokeLinecap="round"
                />
              )}
            </g>
          )
        })}

        {/*
          Last in the SVG, so it is over every lead dot. A pin the rep just
          placed that renders *under* a house they already have is the one
          moment this feature has to get right.
        */}
        {pickAt && <LocationPinSvg x={pickAt.x} y={pickAt.y} label={pick?.label} />}
      </svg>

      {/*
        All map controls live in one bottom-right stack.

        Zoom buttons conventionally sit top-right on desktop maps; on a phone
        that's the one corner a thumb can't reach, and it collides with the
        filter rail. Pinch is the primary zoom — these are the one-handed
        fallback, so they belong down here with everything else.
      */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="pointer-events-auto absolute right-3 flex flex-col items-center gap-2"
          style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="metal metal-map flex flex-col overflow-hidden rounded-pill">
            <button
              onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom + 1, MIN_ZOOM, MAX_ZOOM) }))}
              aria-label="Zoom in"
              className="focusable grid h-11 w-11 place-items-center text-xl font-medium text-ink-soft active:bg-surface-field"
            >
              +
            </button>
            <span className="h-px bg-line-soft" />
            <button
              onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom - 1, MIN_ZOOM, MAX_ZOOM) }))}
              aria-label="Zoom out"
              className="focusable grid h-11 w-11 place-items-center text-xl font-medium text-ink-soft active:bg-surface-field"
            >
              −
            </button>
          </div>

          {/*
            Basemap toggle. Only rendered when imagery is actually configured —
            a control that switches between the drawn grid and the drawn grid is
            just a puzzle.
          */}
          {hasTiles && (
            <button
              onClick={() => {
                const next: LayerId = layer === 'streets' ? 'satellite' : 'streets'
                setLayer(next)
                saveLayer(next)
              }}
              aria-label={`Switch to ${layer === 'streets' ? 'satellite' : 'streets'} view`}
              className="metal metal-map press focusable grid h-11 w-11 place-items-center rounded-pill text-[10px] font-semibold uppercase tracking-wide !text-ink-soft"
            >
              {layer === 'streets' ? 'SAT' : 'MAP'}
            </button>
          )}

          {/* Only offered when there's a location to go to — in the console
              there isn't, and a button that does nothing is worse than none. */}
          {position && (
          <button
            onClick={() => {
              setFollowMe(true)
              if (position)
                setView((v) => ({
                  ...v,
                  lat: position.lat,
                  lng: position.lng,
                  zoom: Math.max(v.zoom, 17),
                }))
            }}
            aria-label="Center on my location"
            data-tour="map-locate"
            aria-pressed={followMe}
            /*
              White with a teal glyph when following, rather than a filled teal
              disc. Two saturated circles stacked above the quick-action button
              made the corner of the map the busiest part of the screen — and the
              filled one was the *passive* state indicator, not the action.
            */
            /*
              And now it does what the note above says.

              `metal-brand !text-accent-strong` painted the glyph in exactly the
              colour of the face beneath it — measured at 1.00:1 against the top
              stop of its own gradient in the dark theme, which is this app's
              default, and under 3:1 across the lower half in the light one. The
              button that says "I am following you" was a teal disc with an
              invisible glyph on it, stacked 26px above the quick-action button
              wearing the identical gradient.

              One face, and the state lives in the glyph's colour and in
              `aria-pressed`, which is where a screen reader was already
              reading it from.
            */
            className={`metal metal-map press focusable grid h-11 w-11 place-items-center rounded-full ${
              followMe ? '!text-accent-strong' : '!text-ink-soft'
            }`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3.2" />
              <circle cx="12" cy="12" r="8" />
              <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" strokeLinecap="round" />
            </svg>
          </button>
          )}
        </div>
      </div>

      {/*
        Attribution is a condition of the tile licence and of ODbL for the
        OSM-derived data — so it lives on the map, at the bottom edge clear of the
        thumb controls, not hidden behind a settings screen.
      */}
      {hasTiles && (
        <p className="pointer-events-none absolute bottom-0 left-0 max-w-full truncate bg-surface-sunk/80 px-1.5 py-0.5 text-[10px] leading-tight text-ink-soft">
          {LAYERS[layer].attribution}
        </p>
      )}

      {overlay}
    </div>
  )
}

interface Pin {
  id: string
  x: number
  y: number
  property: Property
}

interface Cluster {
  x: number
  y: number
  members: Pin[]
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * The zoom that frames a set of points inside a viewport of the given size.
 *
 * Without this an admin looking at a territory gets the rep's street-level
 * zoom, where every property collapses into a cluster bubble and the shape of
 * the patch — the whole reason to show a map here — is invisible.
 */
export function fitZoom(
  points: { lat: number; lng: number }[],
  width: number,
  height: number,
  padding = 0.15,
): number {
  if (points.length < 2) return 16
  const b = spanOf(points)
  const spanX = Math.max(b.maxX - b.minX, 1e-9) * (1 + padding)
  const spanY = Math.max(b.maxY - b.minY, 1e-9) * (1 + padding)
  const zx = Math.log2(width / (TILE * spanX))
  const zy = Math.log2(height / (TILE * spanY))
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zx, zy)))
}

/**
 * The centre of the same box `fitZoom` measures.
 *
 * Latitude is averaged in *projected* space, not in degrees: Mercator stretches
 * the poles, so the midpoint of 14°N and 52°N on screen is not 33°N.
 */
export function fitCenter(points: { lat: number; lng: number }[]): {
  lat: number
  lng: number
} {
  if (!points.length) return { lat: 30.5083, lng: -97.6789 }
  const b = spanOf(points)
  const mid = unproject(0.5, (b.minY + b.maxY) / 2)
  return {
    lat: mid.lat,
    lng: wrapDegrees(points[0].lng + ((b.minX + b.maxX) / 2) * 360),
  }
}

/**
 * The bounding box of a set of points, in projected units, with longitude taken
 * *relative to the first point*.
 *
 * That relative part is the antimeridian fix. Measured absolutely, Manila to
 * Texas spans 218° — the long way, back across Asia and Europe — and both the
 * zoom and the centre come out describing the wrong two thirds of the planet.
 * Relative longitudes wrap to the short way, and every use inside one hemisphere
 * is unaffected.
 */
function spanOf(points: { lat: number; lng: number }[]) {
  let minX = 0
  let maxX = 0
  let minY = 1
  let maxY = 0
  for (const p of points) {
    const dx = wrapDegrees(p.lng - points[0].lng) / 360
    minX = Math.min(minX, dx)
    maxX = Math.max(maxX, dx)
    const y = project(p.lat, p.lng).y
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { minX, maxX, minY, maxY }
}

/**
 * A longitude difference folded into ±180°.
 *
 * The whole antimeridian problem in one line: 263° east and 97° west are the same
 * direction, and only one of them is the short way round.
 */
function wrapDegrees(deg: number) {
  return (((deg % 360) + 540) % 360) - 180
}

function metersPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}
