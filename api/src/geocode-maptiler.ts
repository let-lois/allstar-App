import type { GeocodeMatch, GeocodeRequest } from './geocode'

/**
 * MapTiler's geocoding API.
 *
 * Preferred over Google for one reason that has nothing to do with accuracy:
 * this app draws its basemap from MapTiler tiles, and Google's platform terms
 * generally expect Google-derived content to be shown on a Google map. Plotting
 * Google coordinates on a MapLibre-style basemap is at best an unresolved
 * question for a paying customer to inherit. Geocoding with the same provider
 * that supplies the imagery removes the question rather than answering it.
 *
 * Practical differences from Google that shape this file:
 *
 * **No batch endpoint either.** One request per address, so the same concurrency
 * discipline applies — a Worker has a hard cap on outbound subrequests and
 * blowing it fails the entire import rather than one row.
 *
 * **Precision is inferred, not stated.** There is no `location_type` field.
 * MapTiler returns a GeoJSON feature whose `place_type` says what kind of thing
 * was matched, and only an address-level match with a house number is a rooftop.
 * Anything coarser is reported as such rather than flattered.
 *
 * The type vocabulary is MapTiler's own and worth stating, because it is not the
 * one it resembles: a street is `road` here, where the Mapbox-style APIs this
 * looks like call it `street`. Sending `street` makes the request invalid, and
 * the whole provider silently degrades to the next in the chain — which is
 * exactly what happened the first time this shipped.
 *
 * **`relevance` is how it says "I guessed".** Google sets `partial_match`;
 * MapTiler scores the match 0-1. A confident match is ~1.0, and anything
 * materially below that came back from a fuzzy search — which is exactly the
 * case where a rep ends up at the wrong door.
 */

const ENDPOINT = 'https://api.maptiler.com/geocoding'

/**
 * Concurrent requests per batch, matching the Google provider. Modest on
 * purpose: this loop spends the Worker's subrequest budget.
 */
const CONCURRENCY = 6

/**
 * Below this, treat the result as a guess rather than a match.
 *
 * MapTiler scores an exact hit at or near 1.0 and degrades as it has to reach.
 * 0.9 is strict enough to catch a fuzzy street-name match while leaving room for
 * the small penalties an abbreviation or a missing unit number attracts.
 */
const PARTIAL_BELOW = 0.9

interface Feature {
  place_name?: string
  place_type?: string[]
  relevance?: number
  center?: number[]
  geometry?: { coordinates?: number[] }
  address?: string
}

interface Response {
  features?: Feature[]
  message?: string
}

/**
 * Parse one response.
 *
 * Exported and pure so it can be tested against recorded output rather than a
 * live, metered service — the parsing is where the bugs are, and a test that
 * costs quota per run is a test that gets skipped.
 *
 * The trap this contains: GeoJSON `center` and `coordinates` are
 * **[longitude, latitude]**. Read left-to-right into lat/lng, every Texas
 * address lands off the coast of Somalia and nothing throws.
 */
export function parseMapTilerResponse(ref: string, body: Response): GeocodeMatch {
  const top = body.features?.[0]
  if (!top) {
    // An error body carries `message`; no features and no message is a genuine
    // "nothing there". Distinguishing them matters, because "not found" sends an
    // operator hunting for a typo and "error" does not.
    return body.message
      ? { ref, status: 'error', error: body.message }
      : { ref, status: 'no_match' }
  }

  const coords = top.center ?? top.geometry?.coordinates
  const lng = Number(coords?.[0])
  const lat = Number(coords?.[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ref, status: 'no_match' }
  // A latitude beyond ±90 means the pair only makes sense the other way round,
  // which is a parse error rather than data.
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ref, status: 'no_match' }

  return {
    ref,
    status: 'match',
    lat,
    lng,
    matchedAddress: top.place_name,
    precision: precisionOf(top),
    partial: typeof top.relevance === 'number' && top.relevance < PARTIAL_BELOW,
    provider: 'maptiler',
  }
}

/**
 * What kind of thing was matched.
 *
 * Only an address with a house number is a building. A match on `road` is the
 * street, and a match on `place` or `postal_code` is the middle of something far
 * bigger than a house — reporting either as a rooftop would be the one lie that
 * makes this whole change pointless.
 */
function precisionOf(f: Feature): GeocodeMatch['precision'] {
  const types = f.place_type ?? []
  if (types.includes('address')) {
    return f.address ? 'rooftop' : 'interpolated'
  }
  if (types.includes('road')) return 'interpolated'
  return 'approximate'
}

const oneLine = (r: GeocodeRequest) =>
  [r.address1, r.city, r.state, r.zip]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(', ')

async function geocodeOne(row: GeocodeRequest, key: string): Promise<GeocodeMatch> {
  // `limit=1` because only the top hit is ever used, and the type filter keeps a
  // failed house number from silently resolving to the middle of the city — a
  // plausible-looking pin in the wrong place is worse than an honest no-match.
  //
  // `address,road` are MapTiler's spellings. `street` is not a MapTiler type and
  // makes the request invalid; see the note in the header.
  const url =
    `${ENDPOINT}/${encodeURIComponent(oneLine(row))}.json` +
    `?key=${encodeURIComponent(key)}&limit=1&types=address,road&country=us`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      return { ref: row.ref, status: 'error', error: `Geocoder returned ${res.status}` }
    }
    return parseMapTilerResponse(row.ref, (await res.json()) as Response)
  } catch (err) {
    return {
      ref: row.ref,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Geocode a batch, a few at a time. Never throws — failures come back as rows. */
export async function maptilerGeocode(
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
