import { IconLocate } from '../nav/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer'
import type { Property, Route } from '../../types'
import { bearing } from '../../lib/geo'
import type { Position } from '../../lib/geo'
import { STATUS_COLOR } from '../../data/outcomes'
import { locationPinElement } from './LocationPin'
import { GmapsError, gmapId, loadGmaps } from '../../lib/gmaps'
import { basemapWarning } from '../../lib/basemap'
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
/**
 * How long to wait for the map to actually paint before calling it broken.
 *
 * Generous on purpose. This has to clear a slow first paint on a cheap phone on
 * a bad connection, because the cost of being wrong is taking away a map that
 * was about to appear. Ten seconds is long enough that a real load wins and
 * short enough that a rep is not staring at grey wondering.
 */
const DRAW_TIMEOUT = 10_000
/**
 * Clustering, matched to the self-rendered map so the two behave the same.
 *
 * `FieldMap` merges pins below zoom 17 using a 58px screen cell, so these have
 * to mean the same thing — a rep switching between renderers should not find the
 * map grouping doors differently.
 *
 * The units are the trap. supercluster computes `radius` relative to its own
 * `extent`, which defaults to **512**, while Google renders **256px** tiles. So
 * the library's default `radius: 60` is about 30 screen pixels, not 60 — half
 * what it reads as, and half of what this map needs. Passing `extent: 256` makes
 * `radius` mean device pixels, which is the only interpretation anyone reading
 * this file would expect. Without it, pins 40px apart stayed stubbornly separate
 * and looked like clustering was simply broken.
 */
const CLUSTER_MAX_ZOOM = 16
const CLUSTER_RADIUS_PX = 58
const CLUSTER_EXTENT = 256
/** brand-500 — the one place on the map allowed to be teal by default. */
const SELECTED_PIN = '#0A8296'
/** How far above a covering sheet a revealed pin should sit. One pin's height. */
const PIN_MARGIN = 44

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
   * An arbitrary path to draw, in addition to any route line.
   *
   * Used by the navigate screen for the walking route from the rep to a door.
   * Kept as plain coordinates rather than an encoded polyline so this component
   * stays ignorant of where the path came from — decoding belongs with the
   * caller that asked for it. Not `Position`: a vertex on a route is not a GPS
   * fix and has no accuracy or timestamp to report.
   */
  path?: { lat: number; lng: number }[]
  /**
   * What kind of claim `path` is making, which decides how it is drawn.
   *
   * `route` is a way to get there: solid, heavy, the thing to follow.
   * `flight` is the direct line to somewhere unreachable on foot or by road —
   * drawn dashed, with a plane on it, because a solid line between two
   * continents reads as a route and there is no route. Same geometry, different
   * promise, and the promise is the part a rep acts on.
   */
  pathKind?: 'route' | 'flight'
  /**
   * Location picking, matching `FieldMap`'s prop of the same name so the map
   * screen can hand either renderer the same picker.
   *
   * While it is present a tap on open map reports a coordinate rather than
   * clearing the selection; a tap on a lead still opens that lead unless
   * `exclusive` is set. The reasoning for that split is written out at
   * `FieldMap`'s copy of this prop, which is the one place it belongs.
   */
  pick?: {
    at: { lat: number; lng: number } | null
    onPick: (point: { lat: number; lng: number }) => void
    label?: string
    /** Whether picking takes every tap, lead dots included. See `FieldMap`. */
    exclusive?: boolean
  }
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

/**
 * The plane on the flight line, pointing the way the path leaves.
 *
 * A dashed line alone reads as "route, but dotted". The glyph is what says *this
 * is not a walk* at a glance, which is the whole message when a rep opens a lead
 * from the wrong continent. Rotated to the bearing so it points along the arc
 * rather than sitting there decoratively — the direction is real information,
 * and it is the one thing the line and the number cannot say between them.
 */
function planeElement(headingDeg: number): HTMLElement {
  const el = document.createElement('div')
  // The same hook the self-rendered map puts on its own plane, so one selector
  // finds it whichever renderer drew it.
  el.dataset.plane = 'flight'
  el.style.cssText = [
    'width:34px',
    'height:34px',
    'border-radius:50%',
    'background:#fff',
    'display:grid',
    'place-items:center',
    'box-shadow:0 1px 5px rgba(17,24,39,.35)',
  ].join(';')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '19')
  svg.setAttribute('height', '19')
  svg.setAttribute('aria-hidden', 'true')
  // Built as nodes rather than assigned as markup: this element is created on a
  // code path that draws user data, and `innerHTML` on that path is a habit
  // worth not having even where the input is a number.
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    'M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
  )
  path.setAttribute('fill', SELECTED_PIN)
  svg.appendChild(path)
  // The glyph is drawn nose-up, so the bearing is the rotation directly.
  svg.style.transform = `rotate(${Math.round(headingDeg)}deg)`
  el.appendChild(svg)
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
  path,
  pathKind = 'route',
  pick,
  onUnavailable,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markersRef = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>())
  const clustererRef = useRef<MarkerClusterer | null>(null)
  const meRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const lineRef = useRef<google.maps.Polyline | null>(null)
  const pathRef = useRef<google.maps.Polyline | null>(null)
  const planeRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const pickRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const [ready, setReady] = useState(false)
  const [satellite, setSatellite] = useState(false)

  // Held in a ref so the marker click handlers created once do not close over a
  // stale callback when the screen re-renders.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable
  /*
    The picker, in a ref for the same reason and one more: the map's click
    listener is attached once at construction and must see whether picking is on
    *now*, not whether it was on when the map was made. Reading a prop through a
    ref is what lets one listener stay correct for the life of the map, which is
    the only way to avoid tearing the listener down and rebuilding it — and a
    rebuilt listener on a live Google map is how you end up with two.
  */
  const pickRefProp = useRef(pick)
  pickRefProp.current = pick

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
          /*
            Ask Google for the dark basemap.

            Everything else in this app is themed from `index.css`, but Google's
            tiles are rendered on their side and take none of it — left alone,
            tapping to the real map would drop a bright white rectangle into the
            middle of a near-black app.

            Passed as the string rather than the `ColorScheme.DARK` enum so an
            older Maps JS build ignores an option it does not know instead of
            throwing on a missing symbol. Vector maps only; a raster fallback
            stays light.

            A Map Style attached to this Map ID in the Cloud console wins over
            this. If the real map still comes up light, that is where to look —
            not here.

            Read from the applied theme rather than pinned. Left on DARK it was
            a near-black map with orange road labels sitting inside a white app,
            which is the same mistake as the original bright rectangle, made
            from the other side.

            Construction-time only: `colorScheme` is a MapOptions value and
            Maps JS does not re-read it, so switching theme with the map already
            open leaves it as it was until the screen is next opened. Recreating
            a live map would throw away the viewport and any tiles already
            fetched, which is a worse trade on a metered connection than a map
            that catches up on the next visit.
          */
          colorScheme:
            document.documentElement.dataset.theme === 'light' ? 'LIGHT' : 'DARK',
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

        /*
          A map that is created but never draws.

          Vector maps need WebGL and a WebAssembly compile, and both can fail on
          a device or under a policy that forbids them. When they do, Google
          throws inside its own worker: no rejected promise, no failed request,
          no callback. The map object exists and is perfectly happy. The rep sees
          grey.

          So success is defined as pixels, not as construction. `tilesloaded`
          firing once is the proof, and not firing is the failure — which is the
          only way this particular fault is observable from outside.
        */
        const drawn = window.setTimeout(() => {
          onUnavailableRef.current?.(
            new GmapsError('undrawable', 'The map loaded but could not draw on this device.'),
          )
        }, DRAW_TIMEOUT)
        google.maps.event.addListenerOnce(mapRef.current, 'tilesloaded', () => {
          window.clearTimeout(drawn)
          /*
            The map drew. Did it draw the map we asked for?

            `colorScheme: 'DARK'` is a request, and a raster fallback ignores it
            — which puts Google's light basemap in the middle of a near-black
            app with nothing anywhere saying why. Checked on `tilesloaded`
            rather than at construction because the rendering type is not
            settled until something has actually been painted.

            The console, not the screen: the map works, and a rep can read it.
            This is for whoever deployed it, the same channel and the same
            reasoning as the half-configured warning in `lib/gmaps`.
          */
          const warning = basemapWarning(mapRef.current?.getRenderingType())
          if (warning) console.warn(`[allstar] Google basemap: ${warning}`)
        })

        /*
          A tap on the map itself, which until now this renderer ignored.

          Two jobs, and which one it does is read from the ref at tap time
          rather than baked in here — this listener is attached once for the
          life of the map, because tearing one off a live Google map and
          re-attaching it on every prop change is how you end up with two of
          them and every tap handled twice.

          Google only fires `click` for a real tap on the basemap: a drag, a
          pinch and a fling do not produce one, and marker taps arrive as
          `gmp-click` on the marker instead. So the gesture safety this needs is
          the map library's own, and `clickableIcons: false` above already keeps
          Google's points of interest out of it.
        */
        mapRef.current.addListener('click', (ev: google.maps.MapMouseEvent) => {
          const at = ev.latLng?.toJSON()
          if (!at) return
          const picking = pickRefProp.current
          if (picking) {
            picking.onPick(at)
            return
          }
          // Parity with the self-rendered map, which has always dismissed the
          // property sheet this way. On Google it did not, so the sheet could
          // only be closed by dragging it down.
          onSelectRef.current(null)
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
        // `gmp-click`, not `click`: advanced markers deprecated the DOM event
        // name and warn about it on every listener attached.
        marker.addListener('gmp-click', (ev: { latLng?: google.maps.LatLng | null }) => {
          const picking = pickRefProp.current
          /*
            While the form is open every tap answers "which house?" — including
            one that lands on a lead the rep already has. See `pick.exclusive`
            in FieldMap, where the reasoning lives.

            The event's own coordinate, not the marker's: a rep aiming at the
            house next door lands on the edge of a 22px dot, and snapping their
            pin onto the existing lead would put it on the wrong roof. The
            marker's position is the fallback for a Maps version that does not
            carry one.
          */
          if (picking?.exclusive) {
            picking.onPick(ev?.latLng?.toJSON() ?? { lat: p.lat, lng: p.lng })
            return
          }
          onSelectRef.current(p.id)
        })
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
        // Constructed rather than passed as `algorithmOptions`, which is typed
        // to `maxZoom` alone — `radius` and `extent` belong to the algorithm.
        /*
          Replaces the library's default, which zooms to the cluster's bounds.
          That is still what happens — the one line below — except while the
          form is open, when a tap is an answer rather than navigation.
        */
        onClusterClick: (ev, cluster, clusterMap) => {
          const picking = pickRefProp.current
          const at = ev.latLng?.toJSON()
          if (picking?.exclusive && at) {
            picking.onPick(at)
            return
          }
          if (cluster.bounds) clusterMap.fitBounds(cluster.bounds)
        },
        algorithm: new SuperClusterAlgorithm({
          maxZoom: CLUSTER_MAX_ZOOM,
          radius: CLUSTER_RADIUS_PX,
          extent: CLUSTER_EXTENT,
        }),
      })
    })()

    return () => {
      cancelled = true
    }
  }, [ready, properties, selectedId, disableClustering])

  /* --- the pin under the rep's finger ------------------------------------- */
  //
  // Its own effect, and deliberately not part of the lead-marker one above:
  // that effect rebuilds the clusterer every time the filters change, and the
  // one marker that must not blink or move while a rep is looking at it is the
  // one showing where they just tapped.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    let cancelled = false
    ;(async () => {
      const { AdvancedMarkerElement } = (await google.maps.importLibrary(
        'marker',
      )) as google.maps.MarkerLibrary
      if (cancelled || !mapRef.current) return

      const at = pick?.at
      if (!at) {
        if (pickRef.current) pickRef.current.map = null
        return
      }
      if (pickRef.current) {
        // Moved rather than replaced, so tapping a different house slides the
        // same pin instead of flickering a new one into place.
        pickRef.current.position = at
        pickRef.current.map = mapRef.current
      } else {
        pickRef.current = new AdvancedMarkerElement({
          map: mapRef.current,
          position: at,
          content: locationPinElement(),
          title: pick?.label ?? 'Selected location',
          // Above every lead dot and every cluster bubble. A pin the rep just
          // placed that hides behind a house they already have is the one
          // moment this has to get right.
          zIndex: 1200,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, pick?.at, pick?.label])

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

  /* --- an explicitly supplied path --------------------------------------- */
  useEffect(() => {
    if (!ready || !mapRef.current) return
    pathRef.current?.setMap(null)
    pathRef.current = null
    if (planeRef.current) {
      planeRef.current.map = null
      planeRef.current = null
    }
    if (!path || path.length < 2) return
    const map = mapRef.current
    const flight = pathKind === 'flight'
    const coords = path.map((p) => ({ lat: p.lat, lng: p.lng }))

    pathRef.current = new google.maps.Polyline({
      map,
      path: coords,
      strokeColor: SELECTED_PIN,
      /*
        Dashed, for a flight. Maps JS has no dash property — a repeating symbol
        along an invisible line is how it is done, so the stroke goes to zero
        opacity and the dashes are the symbol. Getting this wrong leaves a solid
        line, which is exactly the claim this is trying not to make.
      */
      strokeOpacity: flight ? 0 : 0.9,
      // Heavier than the route line: this is the one thing the rep is following.
      strokeWeight: flight ? 3 : 5,
      icons: flight
        ? [
            {
              icon: {
                path: 'M 0,-1 0,1',
                strokeColor: SELECTED_PIN,
                strokeOpacity: 0.85,
                strokeWeight: 3,
                scale: 3,
              },
              offset: '0',
              repeat: '15px',
            },
          ]
        : undefined,
    })

    // Frame the whole walk rather than leaving the rep to pinch out and find it.
    // Every sample is extended, not just the two ends: the arc leaves the box
    // its endpoints describe, so fitting the endpoints alone crops the middle of
    // the line off the top of the screen.
    const bounds = new google.maps.LatLngBounds()
    for (const p of coords) bounds.extend(p)
    map.fitBounds(bounds, flight ? 40 : 56)

    if (!flight) return
    let cancelled = false
    void (async () => {
      const { AdvancedMarkerElement } = (await google.maps.importLibrary(
        'marker',
      )) as google.maps.MarkerLibrary
      if (cancelled || !mapRef.current) return
      // Halfway along, which on a great circle is nowhere near halfway between
      // the endpoints on screen — the reason to take it from the samples rather
      // than average the two ends.
      const i = Math.floor(coords.length / 2)
      const at = coords[i]
      const next = coords[Math.min(i + 1, coords.length - 1)]
      planeRef.current = new AdvancedMarkerElement({
        map: mapRef.current,
        position: at,
        content: planeElement(bearing(at, next)),
        title: 'Direct line — too far to route',
        zIndex: 1150,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [ready, path, pathKind])

  /* --- the imperative handle the screen uses ----------------------------- */
  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => {
    const map = mapRef.current
    if (!map) return
    map.panTo({ lat, lng })
    if (zoom) map.setZoom(zoom)
  }, [])

  /*
    Lift a point clear of the sheet that is about to cover it — the shared
    contract, worked out from the map's own bounds.

    Bounds rather than a projection object: `getProjection()` is only valid once
    the map has drawn, and this is called the instant a rep taps. Mercator is
    not linear in latitude, but across one phone screen at the zoom a rep works
    at the error is a fraction of a pixel, and the answer only has to be right
    to within "clear of the sheet".
  */
  const reveal = useCallback((at: { lat: number; lng: number }, covered: number) => {
    const map = mapRef.current
    const box = boxRef.current
    const bounds = map?.getBounds()
    if (!map || !box || !bounds) return
    const north = bounds.getNorthEast().lat()
    const south = bounds.getSouthWest().lat()
    if (north === south) return
    const y = ((north - at.lat) / (north - south)) * box.clientHeight
    /*
      A fraction of the screen, not of the map: the sheet is anchored to the
      viewport's bottom edge and the map's bottom edge is a nav bar above it.
      Same correction as the self-rendered map — see the longer note there.
    */
    const limit = window.innerHeight * (1 - covered) - box.getBoundingClientRect().top
    // Only when it would actually be covered, and positive y pans the centre
    // south, which moves the map's contents up.
    if (y > limit) map.panBy(0, y - limit + PIN_MARGIN)
  }, [])

  useEffect(() => {
    if (handleRef) handleRef.current = { flyTo, reveal }
  }, [handleRef, flyTo, reveal])

  const zoomBy = (d: number) => {
    const map = mapRef.current
    if (map) map.setZoom((map.getZoom() ?? DEFAULT_ZOOM) + d)
  }

  return (
    <div className={`relative ${className}`}>
      {/*
        The tour's anchors live on both renderers, deliberately.

        Which map is on screen depends on whether Google is configured, which is
        an environment fact rather than a code path anyone reading this file
        would think about. With the anchors only on the schematic map, every
        deployment that actually had Google keys — which is every real one —
        silently dropped the map steps out of the tutorial and renumbered around
        them.
      */}
      <div
        ref={boxRef}
        className="absolute inset-0"
        aria-label="Map of your leads"
        role="application"
        data-tour="map-canvas"
      />

      {/*
        Something between "asked for a map" and "has a map".

        Until tiles arrive this box is an empty rectangle with filter chips
        floating on it, and on a slow connection it stays that way for up to
        twelve seconds before the load timeout gives up and says why. Twelve
        seconds of nothing is indistinguishable from broken, and a rep on a
        rural road spends it wondering whether to close the app.

        Removed by `ready`, which is set on `tilesloaded` — the same event the
        undrawable watchdog waits for — so this says "loading" for exactly as
        long as the map is actually loading, and never after pixels exist.
      */}
      {!ready && (
        <div
          role="status"
          data-testid="map-loading"
          className="pointer-events-none absolute inset-0 grid place-items-center bg-surface-sunk"
        >
          <p className="text-[13px] font-medium text-ink-mute">Loading the map…</p>
        </div>
      )}

      {/* Thumb-sized controls, bottom-right, matching the self-rendered map. */}
      <div
        className="absolute right-3 flex flex-col gap-2"
        style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
      >
        <button
          onClick={() => setSatellite((s) => !s)}
          aria-label={`Switch to ${satellite ? 'streets' : 'satellite'} view`}
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field metal metal-map text-[11px] font-semibold !text-accent-strong"
        >
          {satellite ? 'MAP' : 'SAT'}
        </button>
        <button
          onClick={() => zoomBy(1)}
          aria-label="Zoom in"
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field metal metal-map text-xl font-semibold !text-ink-soft"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(-1)}
          aria-label="Zoom out"
          className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field metal metal-map text-xl font-semibold !text-ink-soft"
        >
          −
        </button>
        {position && (
          <button
            onClick={() => flyTo(position.lat, position.lng, 18)}
            aria-label="Center on my location"
            data-tour="map-locate"
            className="press focusable grid min-h-tap min-w-tap place-items-center rounded-field metal metal-map !text-accent-strong"
          >
            <IconLocate />
          </button>
        )}
      </div>

      {overlay}
    </div>
  )
}
