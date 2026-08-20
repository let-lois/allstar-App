import { useCallback, useEffect, useRef, useState } from 'react'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import type { Property, Route } from '../../types'
import type { Position } from '../../lib/geo'
import { STATUS_COLOR } from '../../data/outcomes'
import { GmapsError, gmapId, loadGmaps } from '../../lib/gmaps'
import type { MapHandle } from './FieldMap'

/**
 * The Google Maps renderer.
 *
 * Deliberately a drop-in for `FieldMap`: same props, same `MapHandle`, so the
 * screen chooses a renderer and nothing else changes. The two are not variants
 * of one map — they are different maps with the same contract, which is what
 * makes it possible to keep the self-rendered one as the no-key path instead of
 * deleting a thing that works.
 *
 * Three decisions worth stating, because each of them is a phone-versus-desktop
 * choice that Google's defaults get wrong for this app:
 *
 * **Advanced markers, not Google's pins.** They render as real DOM, so the
 * status colours and the selected state that already exist in this product carry
 * over unchanged rather than being re-expressed as Google teardrops. They are
 * also focusable, which Google's sprite markers are not. The cost is a Map ID —
 * advanced markers silently do not appear without one, which is why
 * `gmapsConfigured()` insists on both values.
 *
 * **`gestureHandling: 'greedy'`.** Google's default asks for two fingers to pan
 * when the map is inside a scrollable page. On a full-bleed map that a rep is
 * using one-handed, in gloves, that default is simply broken.
 *
 * **`clickableIcons: false`.** Google's own points of interest are tappable by
 * default and sit on top of ours. A rep aiming for a lead and getting a dentist's
 * opening hours is the kind of thing that makes an app feel hostile.
 *
 * Failure is reported upward rather than drawn. A rejected key, a blocked
 * script and no signal all look identical on screen — grey — so this component
 * refuses to render that state and hands the reason to its parent, which has
 * somewhere useful to send the rep instead.
 */

const DEFAULT_ZOOM = 16
/** Matches FieldMap: below this, nearby pins merge into counts. */
const CLUSTER_UNTIL_ZOOM = 17
/** brand-500 — the one place on the map allowed to be teal by default. */
const SELECTED_PIN = '#0A8296'

interface Props {
  properties: Property[]
  position: Position | null
  route?: Route | null
  selectedId?: string | null
  onSelect: (id: string | null) => void
  overlay?: React.ReactNode
  className?: string
  initialCenter?: { lat: number; lng: number }
  initialZoom?: number
  disableClustering?: boolean
  handleRef?: React.MutableRefObject<MapHandle | null>
  /**
   * Called when the map cannot be shown, with the reason. The parent decides
   * what to do about it — this component never renders its own dead state,
   * because "grey rectangle" is not information.
   */
  onUnavailable?: (err: GmapsError) => void
}

/** One pin, as DOM. Sized for a thumb rather than a cursor. */
function pinElement(color: string, selected: boolean): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = [
    'width:22px',
    'height:22px',
    'border-radius:50%',
    `background:${selected ? SELECTED_PIN : color}`,
    `border:${selected ? '3px' : '2px'} solid #fff`,
    `box-shadow:0 1px 4px rgba(17,24,39,.45)${selected ? ',0 0 0 4px rgba(10,130,150,.28)' : ''}`,
    `transform:scale(${selected ? 1.35 : 1})`,
    'transition:transform 140ms ease',
    'cursor:pointer',
  ].join(';')
  return el
}

/** A cluster bubble. Same visual family as the pins rather than Google's default. */
function clusterElement(count: number): HTMLElement {
  const el = document.createElement('div')
  const size = count > 99 ? 46 : count > 9 ? 40 : 34
  el.textContent = count > 999 ? '999+' : String(count)
  el.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    'border-radius:50%',
    'background:#0A6B7D',
    'border:2px solid #fff',
    'box-shadow:0 2px 6px rgba(17,24,39,.4)',
    'color:#fff',
    'font:600 13px/1 ui-sans-serif,system-ui,sans-serif',
    'display:grid',
    'place-items:center',
    'cursor:pointer',
  ].join(';')
  return el
}

export function GoogleFieldMap({
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
  onUnavailable,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markersRef = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>())
  const clustererRef = useRef<MarkerClusterer | null>(null)
  const meRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const lineRef = useRef<google.maps.Polyline | null>(null)
  const [ready, setReady] = useState(false)
  const [satellite, setSatellite] = useState(false)

  // Held in a ref so the marker click handlers created once do not close over a
  // stale callback when the screen re-renders.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  /* --- create the map once ------------------------------------------------ */
  useEffect(() => {
    let cancelled = false
    loadGmaps()
      .then(async () => {
        if (cancelled || !boxRef.current) return
        const { Map } = (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary
        if (cancelled || !boxRef.current) return

        mapRef.current = new Map(boxRef.current, {
          mapId: gmapId(),
          center: initialCenter ??
            (properties[0] ? { lat: properties[0].lat, lng: properties[0].lng } : { lat: 30.5083, lng: -97.6789 }),
          zoom: initialZoom ?? DEFAULT_ZOOM,
          // Our own controls, sized for thumbs, live in the overlay.
          disableDefaultUI: true,
          // See the header: both of these defaults are wrong for a one-handed
          // full-bleed map.
          gestureHandling: 'greedy',
          clickableIcons: false,
        })
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const e =
          err instanceof GmapsError ? err : new GmapsError('unreachable', 'The map could not load.')
        onUnavailableRef.current?.(e)
      })
    return () => {
      cancelled = true
    }
    // Intentionally once: re-creating a Map on prop changes throws away the
    // rep's pan and zoom, which is the most annoying possible bug on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* --- imagery toggle ----------------------------------------------------- */
  useEffect(() => {
    mapRef.current?.setMapTypeId(satellite ? 'hybrid' : 'roadmap')
  }, [satellite])

  /* --- markers ------------------------------------------------------------ */
  useEffect(() => {
    if (!ready || !mapRef.current) return
    let cancelled = false

    ;(async () => {
      const { AdvancedMarkerElement } = (await google.maps.importLibrary(
        'marker',
      )) as google.maps.MarkerLibrary
      if (cancelled || !mapRef.current) return

      const map = mapRef.current
      const live = markersRef.current
      const wanted = new Set(properties.map((p) => p.id))

      // Remove what is no longer shown. Filters change often on this screen, so
      // this path runs far more than the create path.
      for (const [id, marker] of live) {
        if (!wanted.has(id)) {
          marker.map = null
          live.delete(id)
        }
      }

      for (const p of properties) {
        const existing = live.get(p.id)
        if (existing) {
          existing.content = pinElement(STATUS_COLOR[p.status], p.id === selectedId)
          existing.zIndex = p.id === selectedId ? 1000 : undefined
          continue
        }
        const marker = new AdvancedMarkerElement({
          position: { lat: p.lat, lng: p.lng },
          content: pinElement(STATUS_COLOR[p.status], p.id === selectedId),
          title: p.address1,
          gmpClickable: true,
        })
        marker.addListener('click', () => onSelectRef.current(p.id))
        live.set(p.id, marker)
      }

      const all = [...live.values()]

      if (disableClustering) {
        clustererRef.current?.clearMarkers()
        clustererRef.current = null
        for (const m of all) m.map = map
        return
      }

      // Rebuilt rather than diffed: the clusterer owns marker visibility, so
      // handing it a changed set is the supported way to update it.
      clustererRef.current?.clearMarkers()
      clustererRef.current = new MarkerClusterer({
        map,
        markers: all,
        renderer: {
          render: ({ count, position: at }) =>
            new AdvancedMarkerElement({ position: at, content: clusterElement(count), zIndex: 900 }),
        },
        algorithmOptions: { maxZoom: CLUSTER_UNTIL_ZOOM },
      })
    })()

    return () => {
      cancelled = true
    }
  }, [ready, properties, selectedId, disableClustering])

  /* --- the rep's own position --------------------------------------------- */
  useEffect(() => {
    if (!ready || !mapRef.current) return
    let cancelled = false
    ;(async () => {
      const { AdvancedMarkerElement } = (await google.maps.importLibrary(
        'marker',
      )) as google.maps.MarkerLibrary
      if (cancelled || !mapRef.current) return
      if (!position) {
        if (meRef.current) meRef.current.map = null
        return
      }
      const dot = document.createElement('div')
      dot.style.cssText =
        'width:16px;height:16px;border-radius:50%;background:#1D4ED8;border:3px solid #fff;box-shadow:0 0 0 6px rgba(29,78,216,.18)'
      if (meRef.current) {
        meRef.current.position = position
        meRef.current.content = dot
        meRef.current.map = mapRef.current
      } else {
        meRef.current = new AdvancedMarkerElement({
          map: mapRef.current,
          position,
          content: dot,
          title: 'You',
          zIndex: 1200,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, position])

  /* --- the route, as a line ---------------------------------------------- */
  useEffect(() => {
    if (!ready || !mapRef.current) return
    lineRef.current?.setMap(null)
    lineRef.current = null
    if (!route?.stops.length) return

    const byId = new Map(properties.map((p) => [p.id, p]))
    const path = route.stops
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => byId.get(s.propertyId))
      .filter((p): p is Property => !!p)
      .map((p) => ({ lat: p.lat, lng: p.lng }))
    if (path.length < 2) return

    lineRef.current = new google.maps.Polyline({
      map: mapRef.current,
      path,
      strokeColor: SELECTED_PIN,
      strokeOpacity: 0.75,
      strokeWeight: 3,
    })
  }, [ready, route, properties])

  /* --- the imperative handle the screen uses ----------------------------- */
  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => {
    const map = mapRef.current
    if (!map) return
    map.panTo({ lat, lng })
    if (zoom) map.setZoom(zoom)
  }, [])

  useEffect(() => {
    if (handleRef) handleRef.current = { flyTo }
  }, [handleRef, flyTo])

  const zoomBy = (d: number) => {
    const map = mapRef.current
    if (map) map.setZoom((map.getZoom() ?? DEFAULT_ZOOM) + d)
  }

  return (
    <div className={`relative ${className}`}>
      <div ref={boxRef} className="absolute inset-0" aria-label="Map of your leads" role="application" />

      {/* Thumb-sized controls, bottom-right, matching the self-rendered map. */}
      <div
        className="absolute right-3 flex flex-col gap-2"
        style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
      >
        <button
          onClick={() => setSatellite((s) => !s)}
          aria-label={`Switch to ${satellite ? 'streets' : 'satellite'} view`}
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field bg-surface text-[11px] font-bold text-brand-600 shadow-float ring-1 ring-ink/[0.06]"
        >
          {satellite ? 'MAP' : 'SAT'}
        </button>
        <button
          onClick={() => zoomBy(1)}
          aria-label="Zoom in"
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field bg-surface text-xl font-semibold text-ink-soft shadow-float ring-1 ring-ink/[0.06]"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(-1)}
          aria-label="Zoom out"
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field bg-surface text-xl font-semibold text-ink-soft shadow-float ring-1 ring-ink/[0.06]"
        >
          −
        </button>
        {position && (
          <button
            onClick={() => flyTo(position.lat, position.lng, 18)}
            aria-label="Center on my location"
            className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field bg-surface text-base text-brand-600 shadow-float ring-1 ring-ink/[0.06]"
          >
            ◎
          </button>
        )}
      </div>

      {overlay}
    </div>
  )
}
