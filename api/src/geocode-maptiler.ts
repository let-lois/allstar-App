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

/* --- diagnostics ---------------------------------------------------------- */

/**
 * What one variant of the request returned.
 *
 * `url` has the key replaced rather than trimmed, so the shape of the request
 * stays readable in a browser tab without the secret travelling with it.
 */
export interface ProbeVariant {
  label: string
  why: string
  url: string
  status: number
  features: {
    place_name?: string
    place_type?: string[]
    relevance?: number
    /** Present only on a true address-level hit — this is the house number. */
    address?: string
    center?: number[]
  }[]
  error?: string
}

/**
 * Query parameters a caller may override or add, per variant.
 *
 * A whitelist rather than a passthrough. Every value here is one MapTiler
 * documents, and nothing else reaches the outbound URL — `key` in particular is
 * not overridable, so no caller can point this at someone else's quota.
 *
 * The reason this exists at all: each code change to this file costs a push, a
 * build, and a hunt through a build log for a preview URL. Each *parameter*
 * change should cost a page reload. Testing a hypothesis about a query string
 * should not require deploying a Worker.
 */
const TUNABLE = new Set([
  'language',
  'autocomplete',
  'fuzzyMatch',
  'types',
  'excludeTypes',
  'limit',
  'proximity',
  'bbox',
])

/** Extract the tunable parameters a caller supplied, ignoring everything else. */
export function probeOverrides(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of TUNABLE) {
    const v = params.get(k)
    if (v != null) out[k] = v
  }
  return out
}

/**
 * Build a query string, leaving commas literal.
 *
 * `types=address,road` is what MapTiler's own examples show. `%2C` ought to
 * decode identically, but "ought to" is how the last three hours went, so the
 * one thing already proven to work is what gets sent.
 */
const qs = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`)
    .join('&')

/**
 * The same address asked several different ways, reporting what came back.
 *
 * This exists because the production path reports our *interpretation* of
 * MapTiler's answer — a precision bucket and a boolean — and when that answer is
 * wrong the interpretation tells you nothing about why. Reading the raw feature
 * list is the difference between one round trip and four.
 *
 * The hypothesis under test now, and the reason `language` appears below:
 * MapTiler documents a US-specific address parser that activates only when
 * `country=us` and `language=en` are sent *together*. The import path has only
 * ever sent the first. Without the second, "704 W 40th St" is handled by the
 * generic parser, which token-matches `W`, `40th` and `St` across the state and
 * scores a street in the wrong ZIP at 0.74 — while an exact, non-fuzzy search
 * returns nothing at all.
 *
 * Variants pair up so the comparison is direct: each `no-lang` case differs from
 * its partner in exactly one parameter.
 *
 * Diagnostic only. Nothing in the import path calls this, so a change here can
 * never move a pin.
 */
export async function maptilerProbe(
  row: GeocodeRequest,
  key: string,
  overrides: Record<string, string> = {},
): Promise<ProbeVariant[]> {
  const q = encodeURIComponent(oneLine(row))

  const variants: { label: string; why: string; params: Record<string, string> }[] = [
    {
      label: 'current',
      why: 'the control — exactly what the import path sends today',
      params: { country: 'us', limit: '1', types: 'address,road' },
    },
    {
      label: 'us-parser',
      why: 'country=us with language=en, which is what activates the documented US address parser',
      params: { country: 'us', language: 'en', limit: '5', types: 'address' },
    },
    {
      label: 'us-parser-unfiltered',
      why: 'the US parser with no type filter, so a house number cannot be filtered out of the list',
      params: { country: 'us', language: 'en', limit: '5' },
    },
    {
      label: 'us-parser-exact',
      why: 'the US parser with autocomplete off, so a hit is a real match rather than a prefix guess',
      params: { country: 'us', language: 'en', limit: '5', types: 'address', autocomplete: 'false' },
    },
  ]

  const out: ProbeVariant[] = []
  for (const v of variants) {
    // Overrides last so a caller can change one parameter of every variant at
    // once — including removing a filter by passing it empty.
    const params = { ...v.params, ...overrides }
    const url = `${ENDPOINT}/${q}.json?key=${encodeURIComponent(key)}&${qs(params)}`
    const shown = url.replace(encodeURIComponent(key), '[redacted]')
    try {
      const res = await fetch(url)
      if (!res.ok) {
        out.push({
          label: v.label,
          why: v.why,
          url: shown,
          status: res.status,
          features: [],
          error: (await res.text()).slice(0, 300),
        })
        continue
      }
      const body = (await res.json()) as Response
      out.push({
        label: v.label,
        why: v.why,
        url: shown,
        status: res.status,
        features: (body.features ?? []).map((f) => ({
          place_name: f.place_name,
          place_type: f.place_type,
          relevance: f.relevance,
          address: f.address,
          center: f.center ?? f.geometry?.coordinates,
        })),
      })
    } catch (err) {
      out.push({
        label: v.label,
        why: v.why,
        url: shown,
        status: 0,
        features: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}
