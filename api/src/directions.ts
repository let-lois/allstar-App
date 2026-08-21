/**
 * One walking route, from where the rep is to the door they are going to.
 *
 * This lives on the Worker rather than in the browser for one reason: the
 * browser key is deliberately restricted to Maps JavaScript, Places and Street
 * View, so a leak of the key compiled into the bundle cannot spend routing
 * quota. Routes API is on the Worker's key instead. Moving the call here keeps
 * that split intact at the cost of one hop.
 *
 * What it returns is the *encoded polyline* — Google's compressed path along the
 * roads — plus the real distance and duration. The client decodes and draws it.
 * That is the whole point of the endpoint: a straight line between two pins is a
 * lie wherever a creek, a fence line or a highway sits between them, and a rep
 * following it walks into a dead end.
 *
 * Deliberately not a general-purpose directions proxy. It takes two points and
 * one travel mode and returns one route. No waypoints, no alternatives, no
 * free-text addresses — every extra input is another thing an authenticated but
 * bored user could spend the account's quota on.
 */

import type { Env } from './types'

/** Routes API, computing a single route. */
const COMPUTE = 'https://routes.googleapis.com/directions/v2:computeRoutes'

/** Modes a field rep actually uses. Anything else is refused rather than mapped. */
const MODES = new Set(['WALK', 'DRIVE'])

/**
 * Farthest apart two points may be before this refuses.
 *
 * A door-to-door route is metres to a few kilometres. A request for a
 * thousand-kilometre walking route is either a bug or somebody playing, and
 * either way it is a slow, expensive answer nobody asked for.
 */
const MAX_KM = 80

export interface Leg {
  distanceMeters: number
  seconds: number
  /** Google's encoded polyline, ready for `decodePath` in the browser. */
  polyline: string
}

const rad = (d: number) => (d * Math.PI) / 180

/** Straight-line kilometres, only used to reject absurd requests before paying. */
function directKm(a: Point, b: Point): number {
  const R = 6371
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface Point {
  lat: number
  lng: number
}

function validPoint(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  const lat = Number(p.lat)
  const lng = Number(p.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

export type DirectionsResult =
  | { ok: true; leg: Leg }
  | { ok: false; error: string; status: number }

export async function directions(
  env: Env,
  body: unknown,
): Promise<DirectionsResult> {
  const key = env.GOOGLE_MAPS_API_KEY
  if (!key) {
    return { ok: false, error: 'Directions are not configured.', status: 503 }
  }

  const b = (body ?? {}) as Record<string, unknown>
  const from = validPoint(b.from)
  const to = validPoint(b.to)
  if (!from || !to) {
    return { ok: false, error: 'Two valid coordinates are required.', status: 400 }
  }

  const mode = String(b.mode ?? 'WALK').toUpperCase()
  if (!MODES.has(mode)) {
    return { ok: false, error: 'Mode must be WALK or DRIVE.', status: 400 }
  }

  if (directKm(from, to) > MAX_KM) {
    return { ok: false, error: 'Those points are too far apart to route.', status: 400 }
  }

  try {
    const res = await fetch(COMPUTE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
        /*
          A field mask is mandatory on this API, and it is also the cost control:
          asking for only these three fields keeps the response small and keeps
          the request in the cheaper billing tier. Requesting everything is how
          a routing bill surprises somebody.
        */
        'x-goog-fieldmask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: mode,
        // Only meaningful for DRIVE, and ignored for WALK rather than an error.
        ...(mode === 'DRIVE' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
      }),
    })

    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      return { ok: false, error: `Routing failed (${res.status}): ${text}`, status: 502 }
    }

    const parsed = (await res.json()) as {
      routes?: {
        distanceMeters?: number
        duration?: string
        polyline?: { encodedPolyline?: string }
      }[]
    }
    const route = parsed.routes?.[0]
    const line = route?.polyline?.encodedPolyline
    if (!route || !line) {
      // A valid response with no route means there is no walkable path — an
      // answer, not a failure, and the client draws the direct line instead.
      return { ok: false, error: 'No route between those points.', status: 404 }
    }

    return {
      ok: true,
      leg: {
        distanceMeters: Number(route.distanceMeters ?? 0),
        // Duration arrives as a protobuf duration string: "372s".
        seconds: Number(String(route.duration ?? '0s').replace(/s$/, '')) || 0,
        polyline: line,
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 502,
    }
  }
}
