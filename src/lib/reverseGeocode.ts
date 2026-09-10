import { fromGeocoder, partsToFields, precisionOf, type AddressFields, type AddressPrecision } from './address'

/**
 * What address is under this point?
 *
 * The other half of tapping a house on the map. The tap gives coordinates a rep
 * chose deliberately; this turns them into something a person can read, so the
 * Add-lead form arrives with the address already in it instead of asking a rep
 * standing in a driveway to type what is written on the door they are looking
 * at.
 *
 * ## This one costs money, per tap
 *
 * Geocoding is a separate billable API from Maps JavaScript and Places, and it
 * is billed per request. A rep taps the map all day, so the naive version of
 * this — one lookup per tap — is a bill that scales with how much the app is
 * used, which is the worst shape a cost can have. Three things hold it down,
 * and all three are load-bearing rather than tidiness:
 *
 *   **Only for a real intention.** The caller asks once the Add-lead form is
 *   open, not on every pin move. Panning, zooming and stray taps cost nothing.
 *
 *   **A session cache, keyed to about a metre.** Tapping the same roof twice —
 *   which reps do, correcting a pin — is one request, not two. Coordinates are
 *   rounded to five decimal places, which is roughly a metre at these
 *   latitudes: finer than that is not a different house.
 *
 *   **In memory only.** Google's terms permit caching geocoding results for
 *   about thirty days and no longer; a cache that lives and dies with the tab
 *   cannot outstay that, and needs no expiry logic to prove it. The address the
 *   rep *saves* is a different thing — that is a lead they created, and the
 *   README has the standing note about coordinates and Google's terms.
 *
 * ## It is allowed to fail, and says so
 *
 * The Geocoding API has to be enabled separately on the browser key. If nobody
 * has, every request comes back `REQUEST_DENIED` — so this reports a named
 * reason to the console once and returns nothing, and the form falls back to
 * what it did before: an empty address field the rep types into. A prefill that
 * quietly never happens is a feature nobody can tell from one that is switched
 * off, and whoever deployed it is the only person who can fix it.
 */

export interface ReverseAddress extends AddressFields {
  /**
   * How well Google located the address, NOT how well the rep located the
   * house. The coordinates belong to their finger and are exact by definition;
   * this describes only how much to trust the text.
   */
  precision: AddressPrecision
}

/** Roughly a metre. Two taps closer together than this are the same house. */
const PLACES = 5
const keyOf = (lat: number, lng: number) => `${lat.toFixed(PLACES)},${lng.toFixed(PLACES)}`

/**
 * Answers already paid for, for as long as this tab is open.
 *
 * `null` is cached too, deliberately: a point Google has no address for does
 * not acquire one by being asked twice, and the second ask costs the same as
 * the first.
 */
const cache = new Map<string, ReverseAddress | null>()

/** Test seam. Not exported from anywhere the app imports. */
export const __resetReverseCache = () => cache.clear()
export const __cacheSize = () => cache.size

export type ReverseLookup = (
  at: { lat: number; lng: number },
) => Promise<{ parts: { types: string[]; long_name?: string; short_name?: string }[]; locationType?: string } | null>

let warned = false

/**
 * Thrown when the question could not be put to Google at all — offline, no key,
 * the API not enabled. Distinct from a `null` answer, which means Google was
 * asked and had nothing, and which is worth remembering. See the cache note.
 */
class Unasked extends Error {}

/** The real one: Google's geocoder, loaded on demand. */
const googleLookup: ReverseLookup = async (at) => {
  /*
    Imported here rather than at the top of the file, so that this module can be
    loaded without loading the Maps loader.

    Not for bundle size — `AddressAutocomplete` imports `gmaps` statically, so
    it is in the main chunk either way. It is so the pure gate can exercise the
    cache and the coarse rule with no browser, no key and no network, which is
    where the failures that cost money live. `gmaps.ts` uses a TypeScript
    parameter property that Node's type-stripping refuses, so a static import
    here would put the whole module out of reach of a test that needs none of it.
  */
  /*
    Offline is the normal state of this app, not an edge case, and it is the
    one case where "no address" must not be remembered — see the cache note.
  */
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Unasked('offline')
  const { placesConfigured, loadGmaps } = await import('./gmaps')
  if (!placesConfigured()) throw new Unasked('no key')
  await loadGmaps()
  const { Geocoder } = (await google.maps.importLibrary('geocoding')) as google.maps.GeocodingLibrary
  try {
    const { results } = await new Geocoder().geocode({ location: at })
    const best = results[0]
    if (!best) return null
    return { parts: best.address_components, locationType: best.geometry?.location_type }
  } catch (err) {
    /*
      Once per session, and named. The likeliest cause by far is that the
      Geocoding API is not enabled on this key — a different switch in the Cloud
      console from Maps JavaScript and Places, and one that is easy to miss when
      the map itself is plainly working.
    */
    if (!warned) {
      warned = true
      console.warn(
        `[allstar] Reverse geocoding unavailable — addresses will not be filled in from the map. ` +
          `Check that the Geocoding API is enabled for this key. (${String(err).slice(0, 120)})`,
      )
    }
    // Not an answer. A key with the API switched on tomorrow must not find this
    // house already recorded as having no address.
    throw new Unasked('geocoder refused')
  }
}

/**
 * The address under a point, or nothing.
 *
 * `lookup` is injectable so the parts that decide what gets billed — the cache,
 * and what counts as an answer — can be tested without a key, a browser or a
 * network. That is deliberate: those are the parts whose failure costs money
 * rather than pixels.
 */
export async function reverseGeocode(
  at: { lat: number; lng: number },
  lookup: ReverseLookup = googleLookup,
): Promise<ReverseAddress | null> {
  const key = keyOf(at.lat, at.lng)
  if (cache.has(key)) return cache.get(key) ?? null

  let raw
  try {
    raw = await lookup(at)
  } catch {
    /*
      Asked and could not be answered — offline, no key, the API not enabled.
      Deliberately not cached: this app spends much of its life with no signal,
      and remembering "no address here" from a tap made in a dead zone would
      leave that house blank for the rest of the session, long after the rep
      walked back into coverage. Nothing is remembered, so the next tap asks
      again.
    */
    return null
  }
  if (!raw) {
    // Asked, and Google has nothing here. That does not change by asking twice.
    cache.set(key, null)
    return null
  }

  const precision = precisionOf(raw.locationType)
  const fields = partsToFields(fromGeocoder(raw.parts))

  /*
    A coarse answer keeps its town and loses its street.

    At `approximate` Google is describing the middle of a postcode or the centre
    of a road, and its street number — if it offers one — is a guess about a
    house the rep is standing in front of and can read. The town is not a guess:
    it is whichever town contains the point they tapped. So the town, state and
    postcode are worth having and the number is not, and the difference is said
    out loud in the form rather than left for the rep to discover on a lead the
    office later has to correct.
  */
  const result: ReverseAddress =
    precision === 'approximate' ? { ...fields, address1: '', precision } : { ...fields, precision }

  cache.set(key, result)
  return result
}
