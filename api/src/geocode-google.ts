import type { GeocodeMatch, GeocodeRequest } from './geocode'

/**
 * Google's Geocoding API.
 *
 * Chosen over the Census geocoder for precision: Census matches against road
 * centrelines and interpolates a house number along the block, which is right
 * for walking a street and wrong for a rural parcel or a flag lot. Google
 * returns the rooftop where it knows it, and says so.
 *
 * Three things about this API shape the code:
 *
 * **There is no batch endpoint.** One HTTP request per address, where Census
 * takes a thousand in one upload. That is the entire reason for the concurrency
 * limit and the chunk size below — a Cloudflare Worker has a hard cap on
 * outbound subrequests per request, and blowing it fails the whole batch.
 *
 * **It reports its own precision.** `location_type` distinguishes a rooftop from
 * an interpolated guess from "somewhere in this postcode". Discarding that would
 * throw away the one thing worth paying for, so it is surfaced to the operator.
 *
 * **`partial_match` means it guessed.** Google returns a result for a misspelled
 * or incomplete address and flags it. Treating that as a clean match is how a
 * typo becomes a rep knocking on the wrong door.
 *
 * ---
 *
 * **A licence constraint this file cannot solve, recorded where it will be read.**
 *
 * Google's Maps Platform terms permit only temporary caching of latitude and
 * longitude — on the order of thirty days — after which they are to be deleted.
 * Place IDs are the stated exception and may be stored indefinitely.
 *
 * This app does the opposite: a lead's coordinates are written to D1 and to every
 * phone's IndexedDB and kept for the life of the record, because the map has to
 * draw with no signal. That is not an oversight in the offline design, it is a
 * direct conflict between the offline requirement and this provider's terms, and
 * no amount of code here resolves it.
 *
 * The compliant shape is to store the Place ID as the durable reference and
 * resolve coordinates at display time, which costs the offline map. The decision
 * is the product owner's and belongs with counsel, not in a comment. What is
 * recorded here is that the choice exists and which way this codebase currently
 * falls, so nobody discovers it from a letter.
 *
 * See "Before this goes to a paying customer" in the README.
 */

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json'

/**
 * Where Google's geocoder lives, unless a deployment says otherwise.
 *
 * `GOOGLE_GEOCODE_BASE_URL` overrides it, for exactly the reason
 * `CENSUS_BASE_URL` and `GHL_BASE_URL` exist: so the path can be driven end to
 * end against a stand-in. Here the case worth driving is the *unhappy* one — a
 * key that has been revoked, exhausted its quota, or lost its billing account,
 * which answers `REQUEST_DENIED` to every request. That failure used to be
 * invisible: the chain degraded to the free geocoder, every pin dropped from a
 * rooftop to a block, and the import reported success. Nothing but a real
 * refusal from a real endpoint exercises it.
 *
 * A Worker variable, settable only by whoever deploys, defaulting to Google
 * when unset. It never points anywhere but Google in a real deployment.
 */
let googleBase = ENDPOINT
export function useGoogleBase(url: string | undefined): void {
  googleBase = url || ENDPOINT
}

/**
 * Concurrent requests per batch. Deliberately modest: a Worker's subrequest
 * budget is spent by this loop, and exceeding it takes down the whole import
 * rather than one address.
 */
const CONCURRENCY = 6

interface GoogleResult {
  formatted_address?: string
  partial_match?: boolean
  /** What kind of thing was matched. See `tooCoarse`. */
  types?: string[]
  geometry?: {
    location?: { lat?: number; lng?: number }
    location_type?: string
  }
}

interface GoogleResponse {
  status?: string
  error_message?: string
  results?: GoogleResult[]
}

/**
 * Result types that cannot be an answer to a street address.
 *
 * Asked about a house it cannot parse, Google does not return ZERO_RESULTS — it
 * widens until something matches and hands back the centroid of that. A real
 * probe against a rural East Texas address returned `"Texas, USA"` at
 * 31.97,-99.90, which is the middle of the state and about 300 miles from the
 * house. `partial_match` was set and `location_type` was APPROXIMATE, so nothing
 * was hidden — but it still arrived as `status: 'match'` with coordinates, and a
 * pin is a pin.
 *
 * A geocoder answering "which house?" with "Texas" has failed to parse the
 * address. Reporting that as a match, however heavily flagged, means an operator
 * can accept it and a rep can be routed to it. So it is a no-match, which also
 * lets the chain move on to a provider that might do better.
 *
 * `postal_code` is deliberately absent from this list: a ZIP centroid is coarse
 * but it is in the right neighbourhood, which is a different kind of wrong from
 * the middle of a state.
 */
const TOO_COARSE = new Set([
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'colloquial_area',
  'continent',
])

/** A street-level type present anywhere in the list rescues the result. */
const STREET_LEVEL = new Set([
  'street_address',
  'premise',
  'subpremise',
  'route',
  'intersection',
  'street_number',
])

function tooCoarse(types: string[] | undefined): boolean {
  if (!types || types.length === 0) return false
  if (types.some((t) => STREET_LEVEL.has(t))) return false
  return types.some((t) => TOO_COARSE.has(t))
}

/** Google's own words for how sure it is, mapped to ours. */
function precisionOf(locationType: string | undefined): GeocodeMatch['precision'] {
  switch (locationType) {
    case 'ROOFTOP':
      return 'rooftop'
    case 'RANGE_INTERPOLATED':
      return 'interpolated'
    default:
      // GEOMETRIC_CENTER and APPROXIMATE both mean "the middle of something
      // bigger than a house" — a street, a suburb, a postcode.
      return 'approximate'
  }
}

/**
 * Parse one response. Exported and pure so it can be tested against recorded
 * output rather than against a billed API — the parsing is where the bugs are,
 * and a test that costs money per run is a test that gets skipped.
 */
export function parseGoogleResponse(ref: string, body: GoogleResponse): GeocodeMatch {
  const status = body.status ?? 'UNKNOWN_ERROR'

  if (status === 'ZERO_RESULTS') return { ref, status: 'no_match' }

  // A quota or key problem is not the address's fault. Reporting it as
  // "not found" would send an operator hunting for a typo that isn't there.
  if (status !== 'OK') {
    return { ref, status: 'error', error: body.error_message || status }
  }

  const top = body.results?.[0]
  const lat = top?.geometry?.location?.lat
  const lng = top?.geometry?.location?.lng
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { ref, status: 'no_match' }
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ref, status: 'no_match' }
  }
  // "Texas" is not an answer to "which house". See TOO_COARSE.
  if (tooCoarse(top?.types)) return { ref, status: 'no_match' }

  return {
    ref,
    status: 'match',
    lat,
    lng,
    matchedAddress: top?.formatted_address,
    precision: precisionOf(top?.geometry?.location_type),
    // Google answers a misspelled address rather than refusing, and flags that
    // it guessed. Carried through so the operator can look before importing.
    partial: top?.partial_match === true,
    provider: 'google',
  }
}

const oneLine = (r: GeocodeRequest) =>
  [r.address1, r.city, r.state, r.zip].map((s) => (s ?? '').trim()).filter(Boolean).join(', ')

async function geocodeOne(row: GeocodeRequest, key: string): Promise<GeocodeMatch> {
  const url = `${googleBase}?address=${encodeURIComponent(oneLine(row))}&key=${encodeURIComponent(key)}`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return { ref: row.ref, status: 'error', error: `Geocoder returned ${res.status}` }
    }
    return parseGoogleResponse(row.ref, (await res.json()) as GoogleResponse)
  } catch (err) {
    return {
      ref: row.ref,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Geocode a batch, a few at a time. Never throws — failures come back as rows. */
export async function googleGeocode(
  rows: GeocodeRequest[],
  key: string,
): Promise<GeocodeMatch[]> {
  const out: GeocodeMatch[] = []
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY)
    out.push(...(await Promise.all(slice.map((r) => geocodeOne(r, key)))))
  }
  return out
}
