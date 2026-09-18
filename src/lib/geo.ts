/**
 * The half of geo that needs a device under it.
 *
 * The spherical maths and the Web Mercator projection moved to
 * `@allstar/core/geo` — they are arithmetic, and the React Native app needs the
 * same arithmetic to build the same route. What stayed is everything that asks
 * the platform a question: which maps app to hand an address to, and where the
 * phone currently is. Both have React Native equivalents, and neither is the
 * same call, which is exactly why the seam is here.
 *
 * Re-exported below so `from '../lib/geo'` keeps resolving the pure half too.
 */
export * from '@allstar/core/geo'


/** Where a hand-off will land. `navigationAppName` is the same answer, for a label. */
export function navigationApp(ua: string = navigator.userAgent): 'apple' | 'google' {
  return /iPhone|iPad|iPod|Macintosh/.test(ua) ? 'apple' : 'google'
}

/**
 * The name of the app the hand-off will actually open.
 *
 * Exists because the button used to say "Google Maps" on every platform while
 * `navigationUrl` sent an iPhone to Apple Maps. A rep tapping a button named
 * after one app and getting another is a small thing that makes the whole
 * screen feel untrustworthy.
 */
export function navigationAppName(ua: string = navigator.userAgent): string {
  return navigationApp(ua) === 'apple' ? 'Apple Maps' : 'Google Maps'
}

export interface NavDestination {
  lat: number
  lng: number
  address1?: string
  city?: string
  state?: string
  zip?: string
}

/**
 * Enough of an address to hand to a maps app, or nothing.
 *
 * `address1` alone is not enough and is actively dangerous: "1302 Deepwood
 * Drive" exists in dozens of states, and a maps app handed an ambiguous string
 * picks one. A street needs a town or a postcode with it before it identifies a
 * house rather than a name.
 */
function oneLine(dest: NavDestination): string | null {
  const street = dest.address1?.trim()
  const city = dest.city?.trim()
  const zip = dest.zip?.trim()
  if (!street || !(city || zip)) return null
  return [street, city, dest.state?.trim(), zip].filter(Boolean).join(', ')
}

/**
 * Hands the destination off to whatever the device actually uses for
 * turn-by-turn. Apple Maps on iOS, Google Maps elsewhere — reps should not have
 * to copy/paste.
 *
 * **The address, when there is one.** This used to send bare coordinates, and
 * the result was reported from a phone: the maps app opened on an unnamed pin,
 * so the rep could not tell what they were driving to and retyped the address
 * by hand — which is the one thing this button exists to prevent.
 *
 * The trade is real and worth stating. Coordinates are the rep's own finger and
 * exact by definition; an address is re-geocoded by the maps app and can land a
 * few metres off, or on the wrong half of a duplex. For *driving to a street*
 * the address wins: it is named, it is recognisable on the turn list, and the
 * last few metres are walked anyway. Where there is no usable address — a
 * coarse reverse-geocode drops the street number — coordinates are all there
 * is, and they still route.
 *
 * `ua` is injectable so both platforms can be exercised without a device.
 */
export function navigationUrl(dest: NavDestination, ua: string = navigator.userAgent): string {
  const destination = oneLine(dest) ?? `${dest.lat},${dest.lng}`
  if (navigationApp(ua) === 'apple') {
    return `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=d`
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`
}

export interface Position {
  lat: number
  lng: number
  accuracy: number
  at: number
}

/* --- one source of position for the whole app ------------------------------- */

/**
 * The last fix anybody got, however they got it.
 *
 * This exists because of what a browser does with repeated requests. Every call
 * to `getCurrentPosition` or `watchPosition` is its own permission request, and
 * until somebody makes a *persistent* choice the browser asks again on each one
 * — so a rep who taps "Allow this time", or dismisses the bar, gets the prompt
 * again on the next screen, and the next. Four places asked independently: the
 * shared watcher, a refresh on boot and sign-in and pull-to-refresh, a stamp on
 * visit start, and the new-lead form. That is four prompts for one question.
 *
 * A module-level cache rather than a store field: `lib/geo` has no business
 * importing the store, and this has to work for callers that run before any
 * component has mounted.
 */
let lastFix: Position | null = null

/** A shared in-flight request, so concurrent callers ask the browser once. */
let inflight: Promise<Position | null> | null = null

/**
 * The location permission as the browser reports it, without asking.
 *
 * Exported for the onboarding setup screen, which has to show "on", "off" or
 * "not yet asked" before offering a button — and must never raise a prompt
 * just by being looked at. `undefined` where the browser cannot say.
 */
export const locationPermission = (): Promise<PermissionState | undefined> => permissionState()

/**
 * Whether asking is worth it, without asking.
 *
 * `permissions.query` does not prompt — that is the whole point of it. A denied
 * permission means every subsequent call resolves to an error after a round trip
 * through the browser's UI layer, and on some browsers re-prompts; skipping it
 * entirely is both faster and quieter. Undefined where the API is missing, in
 * which case we simply try.
 */
async function permissionState(): Promise<PermissionState | undefined> {
  try {
    if (!navigator.permissions?.query) return undefined
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
    return status.state
  } catch {
    // Firefox has historically thrown for some names, and Safari added this
    // late. Not being able to ask is not a reason to skip the fix.
    return undefined
  }
}

/**
 * A fix, reusing a recent one rather than asking again.
 *
 * `maxAgeMs` is the app's own staleness rule, not the browser's `maximumAge`.
 * The browser's applies to *its* cache and still counts as a request — which
 * still prompts. This one is answered without touching the browser at all.
 *
 * Two minutes by default: a rep walks a street in that time, which is inside
 * the accuracy this is used for — which house is nearest, and where somebody
 * stood when they knocked.
 */
export function getPosition(timeoutMs = 8000, maxAgeMs = 120_000): Promise<Position | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)

  if (lastFix && Date.now() - lastFix.at < maxAgeMs) return Promise.resolve(lastFix)
  // Somebody is already asking. Wait for their answer rather than raising a
  // second prompt behind the first.
  if (inflight) return inflight

  inflight = requestPosition(timeoutMs).finally(() => {
    inflight = null
  })
  return inflight
}

async function requestPosition(timeoutMs: number): Promise<Position | null> {
  // Asked and refused. Calling anyway earns nothing and costs a prompt on the
  // browsers that re-ask.
  if ((await permissionState()) === 'denied') return null
  return new Promise((resolve) => {
    let settled = false
    const done = (p: Position | null) => {
      if (settled) return
      settled = true
      if (p) lastFix = p
      resolve(p)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        done({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: pos.timestamp,
        })
      },
      () => {
        clearTimeout(timer)
        done(null)
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 },
    )
  })
}

/**
 * The shared watcher. One per app — several is the fastest way to flatten a
 * phone over an eight-hour shift, and each one is its own permission request.
 *
 * Every fix it produces also fills the cache above, which is what lets the rest
 * of the app stop asking: once this is running, a screen that wants to know
 * where the rep is has an answer already.
 */
export function watchPosition(cb: (p: Position) => void): () => void {
  if (!('geolocation' in navigator)) return () => {}
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const next = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      }
      lastFix = next
      cb(next)
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
