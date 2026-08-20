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
 * Concurrent requests per batch. Deliberately modest: a Worker's subrequest
 * budget is spent by this loop, and exceeding it takes down the whole import
 * rather than one address.
 */
const CONCURRENCY = 6

interface GoogleResult {
  formatted_address?: string
  partial_match?: boolean
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
  const url = `${ENDPOINT}?address=${encodeURIComponent(oneLine(row))}&key=${encodeURIComponent(key)}`
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
