/**
 * Loading the Google Maps JavaScript API.
 *
 * One job, and one thing it must never do: fail silently. A rejected key, a
 * blocked script or a dead connection all produce the same symptom on screen —
 * a grey rectangle — and a grey rectangle is indistinguishable from a map that
 * is still loading. That ambiguity cost hours on this project already with a
 * different provider, so every failure here resolves to a *named* reason that
 * the UI can show a person.
 *
 * Two configuration values, both build-time and both required:
 *
 *   VITE_GOOGLE_MAPS_KEY  the browser key, referrer-restricted. It is inlined
 *                         into the bundle and therefore public; the referrer
 *                         list and its narrow API scope are what protect it.
 *   VITE_GOOGLE_MAP_ID    a Map ID from the Cloud console. Advanced markers do
 *                         not render without one, and advanced markers are the
 *                         reason this app's own pin design survives the move to
 *                         Google — they are real DOM rather than a sprite.
 *
 * With either missing, this reports "not configured" and the app keeps its own
 * renderer. That is a deliberate binary: a half-configured Google map that draws
 * tiles but no pins would be worse than no Google map at all.
 */

const KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string | undefined)?.trim() || ''
const MAP_ID = (process.env.EXPO_PUBLIC_GOOGLE_MAP_ID as string | undefined)?.trim() || ''

/** Milliseconds before a load that has neither succeeded nor errored is given up
 *  on. A script tag on a stalled connection can hang indefinitely, and a rep
 *  staring at a spinner is worse off than one reading their route as a list. */
const LOAD_TIMEOUT = 12_000

export type GmapsFailure =
  /** No key or no Map ID compiled into this build. */
  | 'not-configured'
  /** Google rejected the key — wrong referrer, disabled API, or billing off. */
  | 'rejected'
  /** The script never arrived. Almost always no connection. */
  | 'unreachable'
  /**
   * The API loaded and the map was created, but nothing was ever drawn.
   *
   * Its own category because it has its own cause: a vector map needs WebGL and
   * a WebAssembly compile, and either can fail on a device or under a policy
   * that blocks it — with no callback, no rejected promise and no failed
   * request. It surfaces as an uncaught error inside Google's worker, which is
   * to say it surfaces as a grey rectangle.
   */
  | 'undrawable'

export class GmapsError extends Error {
  constructor(readonly reason: GmapsFailure, message: string) {
    super(message)
    this.name = 'GmapsError'
  }
}

export const gmapsConfigured = () => !!KEY && !!MAP_ID
/**
 * Places and the Geocoder need only the key. The Map ID is what advanced
 * markers want, and a deployment that has set the key but not the ID should
 * still get address suggestions and the address under a tapped pin — those are
 * the two things a rep adding a lead actually feels, and for months they were
 * silently off on exactly that half-configured build.
 */
export const placesConfigured = () => !!KEY
export const gmapId = () => MAP_ID

/**
 * Why a configured build still might not be usable, or null if it looks fine.
 *
 * Exported so the UI can explain a misconfiguration rather than render an empty
 * map. Half-configured is the case worth naming: someone sets the key, sees no
 * pins, and has no way to know a Map ID is the missing piece.
 */
export function gmapsConfigProblem(): string | null {
  if (KEY && !MAP_ID) return 'VITE_GOOGLE_MAP_ID is not set, so map pins cannot render.'
  if (!KEY && MAP_ID) return 'VITE_GOOGLE_MAPS_KEY is not set.'
  return null
}

/*
  A half-configured build is the case most likely to waste someone's afternoon:
  the key is set, the map looks like it should work, and it silently keeps the
  old renderer because advanced markers need a Map ID nobody mentioned. The
  console is the right channel for it — this is a build-time misconfiguration,
  visible to whoever deployed it, and not something to put in front of a rep.
*/
if (process.env.NODE_ENV !== 'production' || gmapsConfigProblem()) {
  const problem = gmapsConfigProblem()
  if (problem) console.warn(`[allstar] Google Maps is half-configured: ${problem}`)
}

let pending: Promise<void> | null = null

/**
 * Load the API once per page. Repeat callers share the first attempt.
 *
 * A failed attempt is *not* cached: a rep who walks back into coverage should
 * get a map when they revisit the screen, not a permanent error from a load that
 * happened in a lift.
 */
export function loadGmaps(): Promise<void> {
  // The key is the only hard requirement to load the API. Whether the *map*
  // can render is `gmapsConfigured()`, and its callers check that themselves.
  if (!placesConfigured()) {
    return Promise.reject(
      new GmapsError('not-configured', gmapsConfigProblem() ?? 'Google Maps is not configured.'),
    )
  }
  // `google.maps` existing at all means the bootstrap has run. Testing
  // `importLibrary` instead reads as always-true to TypeScript, since the types
  // declare it non-optional on a namespace that is itself optional here.
  if (window.google?.maps) return Promise.resolve()
  if (pending) return pending

  pending = new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: GmapsError) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (err) {
        // Cleared so the next visit retries rather than inheriting this failure.
        pending = null
        reject(err)
      } else {
        resolve()
      }
    }

    const timer = window.setTimeout(
      () => done(new GmapsError('unreachable', 'The map did not load in time.')),
      LOAD_TIMEOUT,
    )

    /*
      Google reports a rejected key by calling this global rather than by failing
      the script load, so without hooking it a bad referrer is silently a blank
      map. This is the single most likely thing to go wrong on a new deployment,
      and it is the one Google gives you no return value for.
    */
    window.gm_authFailure = () =>
      done(
        new GmapsError(
          'rejected',
          'Google rejected the map key for this site. Check the key’s website restrictions.',
        ),
      )

    const cb = '__allstarGmapsReady'
    ;(window as unknown as Record<string, unknown>)[cb] = () => done()

    const s = document.createElement('script')
    // `loading=async` is Google's own recommendation and silences its console
    // warning. `marker` is where advanced markers live, `places` is address
    // autocomplete, and `geometry` decodes the encoded polyline the Worker
    // returns for a walking route. All named here rather than imported on demand
    // because the alternative is a second network round trip at the moment a rep
    // starts typing an address or asks for a route, standing outside a house.
    s.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(KEY)}` +
      `&libraries=marker,places,geometry&loading=async&callback=${cb}`
    s.async = true
    s.onerror = () =>
      done(new GmapsError('unreachable', 'The map could not be reached. You may be offline.'))
    document.head.appendChild(s)
  })

  return pending
}

declare global {
  interface Window {
    google?: typeof google
    gm_authFailure?: () => void
  }
}
