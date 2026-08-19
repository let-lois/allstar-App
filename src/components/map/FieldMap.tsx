import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Property, Route } from '../../types'
import { project, unproject, type Position } from '../../lib/geo'
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
const SELECTED_PIN = '#0A8296'

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
const MIN_ZOOM = 12
const MAX_ZOOM = 19
/** Below this, nearby pins merge into counts so the map stays readable. */
const CLUSTER_UNTIL_ZOOM = 17
const CLUSTER_CELL_PX = 58

export interface MapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void
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

  const toScreen = useCallback(
    (lat: number, lng: number) => {
      const w = project(lat, lng)
      return {
        x: (w.x - centerWorld.x) * scale + size.w / 2,
        y: (w.y - centerWorld.y) * scale + size.h / 2,
      }
    },
    [centerWorld, scale, size.w, size.h],
  )

  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => {
    setFollowMe(false)
    setView((v) => ({ lat, lng, zoom: zoom ?? Math.max(v.zoom, 17) }))
  }, [])

  useEffect(() => {
    if (handleRef) handleRef.current = { flyTo }
  }, [handleRef, flyTo])

  /* --- gestures ---------------------------------------------------------- */

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null)
  const panMoved = useRef(0)
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

  const onPointerDown = (e: React.PointerEvent) => {
    const hit = (e.target as Element).closest?.('[data-marker]') as HTMLElement | null
    downMarker.current = hit
      ? { kind: hit.dataset.marker ?? '', index: Number(hit.dataset.index ?? -1) }
      : null
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    panMoved.current = 0
    if (pointers.current.size === 2) {
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
    // tolerates the wobble of tapping while walking.
    if (panMoved.current >= 6 || pointers.current.size > 0) {
      downMarker.current = null
      return
    }

    const hit = downMarker.current
    downMarker.current = null

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

  const onWheel = (e: React.WheelEvent) => {
    setFollowMe(false)
    setView((v) => ({ ...v, zoom: clamp(v.zoom - e.deltaY * 0.002, MIN_ZOOM, MAX_ZOOM) }))
  }

  /* --- basemap ----------------------------------------------------------- */

  // A street grid derived from the projection itself. It gives real spatial
  // context (blocks, arterials) with zero network cost.
  const grid = useMemo(() => {
    if (!size.w || !size.h) return { minor: [] as string[], major: [] as string[] }
    const tl = screenToLatLng(0, 0)
    const br = screenToLatLng(size.w, size.h)
    const latStep = 0.0022
    const lngStep = 0.00255
    const minor: string[] = []
    const major: string[] = []

    const latStart = Math.floor(br.lat / latStep) * latStep
    for (let lat = latStart; lat <= tl.lat + latStep; lat += latStep) {
      const y = toScreen(lat, tl.lng).y
      if (y < -20 || y > size.h + 20) continue
      const line = `M0 ${y.toFixed(1)} H${size.w}`
      ;(Math.round(lat / latStep) % 4 === 0 ? major : minor).push(line)
    }
    const lngStart = Math.floor(tl.lng / lngStep) * lngStep
    for (let lng = lngStart; lng <= br.lng + lngStep; lng += lngStep) {
      const x = toScreen(tl.lat, lng).x
      if (x < -20 || x > size.w + 20) continue
      const line = `M${x.toFixed(1)} 0 V${size.h}`
      ;(Math.round(lng / lngStep) % 5 === 0 ? major : minor).push(line)
    }
    return { minor, major }

    function screenToLatLng(px: number, py: number) {
      return unproject(
        centerWorld.x + (px - size.w / 2) / scale,
        centerWorld.y + (py - size.h / 2) / scale,
      )
    }
  }, [size.w, size.h, centerWorld, scale, toScreen])

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

  const me = position ? toScreen(position.lat, position.lng) : null
  // Accuracy circle drawn to true scale — a 40m fix should *look* uncertain.
  const accuracyPx = position
    ? (position.accuracy / metersPerPixel(view.lat, view.zoom))
    : 0

  return (
    <div ref={boxRef} className={`relative touch-none overflow-hidden bg-[#EDF1F3] ${className}`}>
      <svg
        width={size.w}
        height={size.h}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {/* basemap */}
        {/* Cool ground, white roads — the same off-white family as the app
            background, so the map reads as part of the product rather than an
            embedded widget from somewhere else. */}
        <rect width={size.w} height={size.h} fill="#EDF1F3" />
        <path d={grid.minor.join(' ')} stroke="#ffffff" strokeWidth={7} fill="none" />
        <path d={grid.major.join(' ')} stroke="#ffffff" strokeWidth={13} fill="none" />
        <path d={grid.major.join(' ')} stroke="#DCE3E7" strokeWidth={1} fill="none" />

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
            href={t.url}
            x={t.x}
            y={t.y}
            width={t.size + 0.5}
            height={t.size + 0.5}
            preserveAspectRatio="none"
          />
        ))}

        {/* route */}
        {routePaths && (
          <>
            <path
              d={routePaths.todo}
              stroke="#0A8296"
              strokeWidth={5}
              strokeLinecap="round"
              strokeDasharray="2 10"
              fill="none"
              opacity={0.85}
            />
            <path
              d={routePaths.done}
              stroke={layer === 'satellite' && hasTiles ? '#F1F5F9' : '#AEB8BE'}
              strokeWidth={4}
              strokeLinecap="round"
              fill="none"
              opacity={0.7}
            />
          </>
        )}

        {/* current location */}
        {me && (
          <g>
            <circle
              cx={me.x}
              cy={me.y}
              r={Math.max(12, Math.min(accuracyPx, 400))}
              fill="#2563eb"
              opacity={0.12}
            />
            <circle cx={me.x} cy={me.y} r={9} fill="#2563eb" stroke="#fff" strokeWidth={3} />
          </g>
        )}

        {/* clusters */}
        {clusters.map((c, i) => (
          <g key={`c${i}`} data-marker="cluster" data-index={i} className="cursor-pointer">
            <circle cx={c.x} cy={c.y} r={23} fill="#111827" opacity={0.10} />
            <circle cx={c.x} cy={c.y} r={19} fill="#ffffff" stroke="#111827" strokeWidth={1.5} />
            <text
              x={c.x}
              y={c.y + 5}
              textAnchor="middle"
              className="nums"
              fontSize={14}
              fontWeight={700}
              fill="#111827"
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
          return (
            <g key={pin.id} data-marker="pin" data-index={i} className="cursor-pointer">
              {/* Invisible 44px hit area — the visible dot is far too small to
                  hit reliably with a thumb, so the target is decoupled from it. */}
              <circle cx={pin.x} cy={pin.y} r={22} fill="transparent" />
              {selected && (
                <circle cx={pin.x} cy={pin.y} r={22} fill={color} opacity={0.2} />
              )}
              <circle
                cx={pin.x}
                cy={pin.y}
                r={r}
                fill={color}
                stroke="#fff"
                strokeWidth={selected ? 3.5 : 2.5}
              />
            </g>
          )
        })}
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
          <div className="flex flex-col overflow-hidden rounded-card bg-surface shadow-float ring-1 ring-ink/[0.06]">
            <button
              onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom + 1, MIN_ZOOM, MAX_ZOOM) }))}
              aria-label="Zoom in"
              className="focusable grid h-12 w-12 place-items-center text-xl font-semibold text-ink-soft active:bg-ink/[0.06]"
            >
              +
            </button>
            <span className="h-px bg-ink/10" />
            <button
              onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom - 1, MIN_ZOOM, MAX_ZOOM) }))}
              aria-label="Zoom out"
              className="focusable grid h-12 w-12 place-items-center text-xl font-semibold text-ink-soft active:bg-ink/[0.06]"
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
              className="press focusable grid h-12 w-12 place-items-center rounded-card bg-surface text-[10px] font-bold uppercase tracking-wide text-ink-soft shadow-float ring-1 ring-ink/[0.06]"
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
            aria-pressed={followMe}
            className={`press focusable grid h-12 w-12 place-items-center rounded-full shadow-float ${
              followMe
                ? 'bg-brand-600 text-white'
                : 'bg-surface text-ink-soft ring-1 ring-ink/[0.06]'
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
        <p className="pointer-events-none absolute bottom-0 left-0 max-w-full truncate bg-white/70 px-1.5 py-0.5 text-[10px] leading-tight text-ink-soft">
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
  let minX = 1
  let maxX = 0
  let minY = 1
  let maxY = 0
  for (const p of points) {
    const w = project(p.lat, p.lng)
    minX = Math.min(minX, w.x)
    maxX = Math.max(maxX, w.x)
    minY = Math.min(minY, w.y)
    maxY = Math.max(maxY, w.y)
  }
  const spanX = Math.max(maxX - minX, 1e-9) * (1 + padding)
  const spanY = Math.max(maxY - minY, 1e-9) * (1 + padding)
  const zx = Math.log2(width / (TILE * spanX))
  const zy = Math.log2(height / (TILE * spanY))
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zx, zy)))
}

function metersPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}
