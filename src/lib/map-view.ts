/**
 * Where the field map opens.
 *
 * It used to open on the first lead in the store — whichever house happened to
 * be inserted first, which for one company was a test lead in Phoenix — every
 * time the map screen mounted. And it mounts a lot: a visit replaces the whole
 * app shell, switching to the list unmounts the map, an over-the-air update
 * reloads the page. So a rep working a street in Gaffney finished a visit and
 * came back to Arizona.
 *
 * Now, in order:
 *   1. the lead the rep was just working on, when the screen is told one;
 *   2. where the rep last left the map (centre, zoom, and Google's heading and
 *      tilt where it has them), kept in this browser;
 *   3. where the rep is, when the phone has given a location;
 *   4. the first stop of today's route;
 *   5. the first lead with a location;
 *   6. the fixed default — the last resort, not the habit.
 *
 * Per device and per browser, in localStorage: a viewport is a convenience,
 * and a rep's phone and the office laptop should each remember their own.
 */

export interface MapView {
  lat: number
  lng: number
  zoom: number
  /** Google vector maps only; the self-drawn map does not rotate or tilt. */
  heading?: number
  tilt?: number
}

export type MapViewSource = 'lead' | 'saved' | 'device' | 'route' | 'first-lead' | 'default'

const KEY = 'allstar.map.view.v1'

/** The fixed fallback both renderers have always used. */
export const DEFAULT_VIEW: MapView = { lat: 30.5083, lng: -97.6789, zoom: 16 }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A stored or passed-in view, or null when it is not a real place. */
export function cleanView(v: unknown): MapView | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!finite(o.lat) || !finite(o.lng) || !finite(o.zoom)) return null
  if (Math.abs(o.lat) > 85 || Math.abs(o.lng) > 180 || o.zoom < 1 || o.zoom > 22) return null
  // (0, 0) is a real place, but no rep works in the Gulf of Guinea: it is what a
  // map reports before it has a centre.
  if (o.lat === 0 && o.lng === 0) return null
  const out: MapView = { lat: o.lat, lng: o.lng, zoom: o.zoom }
  if (finite(o.heading)) out.heading = o.heading
  if (finite(o.tilt)) out.tilt = o.tilt
  return out
}

export function loadMapView(): MapView | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? cleanView(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveMapView(v: MapView): void {
  const clean = cleanView(v)
  if (!clean) return
  try {
    localStorage.setItem(KEY, JSON.stringify(clean))
  } catch {
    // Private mode or full storage: the map still works, it just forgets.
  }
}

type Point = { lat: number; lng: number } | null | undefined
const isPoint = (p: Point): p is { lat: number; lng: number } => !!p && finite(p.lat) && finite(p.lng) && !(p.lat === 0 && p.lng === 0)

/** Zoom for "this lead" and "where I am": a street, close enough to see houses. */
export const CLOSE_ZOOM = 17

/**
 * The view the map opens on, and which rule chose it. Pure, so the order is
 * tested without a browser.
 */
export function initialMapView(input: {
  lead?: Point
  saved?: MapView | null
  position?: Point
  routeStop?: Point
  firstLead?: Point
}): { view: MapView; source: MapViewSource } {
  if (isPoint(input.lead)) {
    return { view: { lat: input.lead.lat, lng: input.lead.lng, zoom: Math.max(input.saved?.zoom ?? 0, CLOSE_ZOOM) }, source: 'lead' }
  }
  const saved = cleanView(input.saved)
  if (saved) return { view: saved, source: 'saved' }
  if (isPoint(input.position)) return { view: { lat: input.position.lat, lng: input.position.lng, zoom: DEFAULT_VIEW.zoom }, source: 'device' }
  if (isPoint(input.routeStop)) return { view: { lat: input.routeStop.lat, lng: input.routeStop.lng, zoom: DEFAULT_VIEW.zoom }, source: 'route' }
  if (isPoint(input.firstLead)) return { view: { lat: input.firstLead.lat, lng: input.firstLead.lng, zoom: DEFAULT_VIEW.zoom }, source: 'first-lead' }
  return { view: { ...DEFAULT_VIEW }, source: 'default' }
}

/**
 * Whether a location fix that arrives after the map opened should move it.
 * Only when the map opened on a guess — the first lead or the fixed default —
 * and the rep has not moved it since. A saved view, a lead and a route are
 * choices; a guess is not.
 */
export function shouldJumpToFix(source: MapViewSource, userMoved: boolean): boolean {
  return !userMoved && (source === 'first-lead' || source === 'default')
}
