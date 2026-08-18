/**
 * Geocoding, via the US Census Bureau's public geocoder.
 *
 * Chosen for one reason that outranks accuracy: it is free and needs no API key,
 * no billing account and no card. A prototype that requires a payment method to
 * put its first lead on a map isn't a prototype anyone can try.
 *
 * The trade-offs, stated because they matter later:
 *   - US addresses only. That's the market this app is for, but it's a ceiling.
 *   - It matches against TIGER road centrelines, so a result is "the right point
 *     on the right block", not a rooftop. For walking a street that's fine; for
 *     a 40-acre rural parcel it's a driveway entrance at best.
 *   - No SLA. It's a government service that occasionally goes slow.
 *
 * Swapping in Google or Mapbox later is this file only — which is why the
 * response parsing below is separated from the HTTP call.
 */

import { googleGeocode } from './geocode-google'

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'

/**
 * The service's own documented ceiling is 10,000; we chunk far below it so a
 * single slow request can't hold a whole import hostage.
 */
/**
 * Addresses per request.
 *
 * Sized for the worst case rather than the best: Census takes a thousand in one
 * upload, but Google has no batch endpoint at all — one HTTP request per
 * address — and a Worker has a hard cap on outbound subrequests. Forty fits
 * comfortably under it with room for the fallback pass.
 *
 * The client chunks to match (see `GEOCODE_CHUNK` in src/admin/AdminImport.tsx);
 * if these two ever disagree the larger one gets a 413.
 */
export const GEOCODE_CHUNK = 40

export interface GeocodeRequest {
  ref: string
  address1: string
  city?: string
  state?: string
  zip?: string
}

export interface GeocodeMatch {
  ref: string
  lat?: number
  lng?: number
  matchedAddress?: string
  /**
   * `error` is deliberately distinct from `no_match`. A quota problem, a bad key
   * or an outage is not the address's fault, and reporting it as "not found"
   * sends an operator hunting for a typo that isn't there.
   */
  status: 'match' | 'no_match' | 'tie' | 'error'
  error?: string
  /**
   * How sure the provider is. `rooftop` is the actual building; `interpolated`
   * is a house number estimated along a block; `approximate` is the middle of
   * something bigger than a house.
   */
  precision?: 'rooftop' | 'interpolated' | 'approximate'
  /** The provider answered a misspelled or incomplete address by guessing. */
  partial?: boolean
  provider?: 'google' | 'census'
}

/** CSV field splitter for the response — quoted, comma-separated, one row. */
function splitLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') inQuotes = true
    else if (c === ',') {
      out.push(field)
      field = ''
    } else field += c
  }
  out.push(field)
  return out
}

/**
 * Parse the geocoder's CSV response.
 *
 * Exported and pure so it can be tested against recorded output rather than
 * against a live government service — the parsing is where the bugs are, and a
 * test that needs the internet is a test that gets skipped.
 *
 * The trap this function exists to contain: the Coordinates field is
 * **longitude,latitude**, in that order. Reading it left-to-right into lat,lng
 * puts every US address in the Indian Ocean, and nothing throws.
 */
export function parseCensusResponse(body: string): GeocodeMatch[] {
  const matches: GeocodeMatch[] = []

  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const f = splitLine(line)
    const ref = f[0]
    if (!ref) continue

    const status = (f[2] ?? '').toLowerCase()
    if (status !== 'match') {
      matches.push({ ref, status: status === 'tie' ? 'tie' : 'no_match' })
      continue
    }

    // f[4] = matched address, f[5] = "longitude,latitude"
    const coords = (f[5] ?? '').split(',')
    const lng = Number(coords[0])
    const lat = Number(coords[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      matches.push({ ref, status: 'no_match' })
      continue
    }
    // Belt and braces on the ordering: a latitude is never beyond ±90, so a pair
    // that only makes sense the other way round is a parse error, not data.
    if (Math.abs(lat) > 90) {
      matches.push({ ref, status: 'no_match' })
      continue
    }

    matches.push({
      ref,
      status: 'match',
      lat,
      lng,
      matchedAddress: f[4] || undefined,
      // Census matches road centrelines and interpolates the house number
      // along the block. Never a rooftop, and it should not claim to be.
      precision: 'interpolated',
      provider: 'census',
    })
  }

  return matches
}

/** The upload format: no header, `id, street, city, state, zip` per line. */
export function toCensusCsv(rows: GeocodeRequest[]): string {
  const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`
  return rows
    .map((r) =>
      [esc(r.ref), esc(r.address1), esc(r.city ?? ''), esc(r.state ?? ''), esc(r.zip ?? '')].join(
        ',',
      ),
    )
    .join('\n')
}

async function batch(rows: GeocodeRequest[]): Promise<GeocodeMatch[]> {
  const form = new FormData()
  form.append('benchmark', 'Public_AR_Current')
  form.append('addressFile', new Blob([toCensusCsv(rows)], { type: 'text/csv' }), 'addresses.csv')

  const res = await fetch(CENSUS_BATCH_URL, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  return parseCensusResponse(await res.text())
}

/**
 * Geocode a batch, then have a second go at whatever didn't place.
 *
 * The retry drops the ZIP. This is not a nicety — a wrong ZIP is the single most
 * common reason a real address fails to match, because ZIP boundaries don't
 * follow city boundaries, they get re-cut, and every list that has been sitting
 * in a spreadsheet for a year has some that are stale. The street, city and
 * state are usually right even when the ZIP isn't, and the geocoder can place an
 * address from those alone.
 *
 * Refusing to import a house that exists because five digits next to it are out
 * of date is the wrong trade: the rep can see the address is real, and being
 * told "not found" makes the app look broken rather than careful.
 */
/**
 * Geocode a batch, using the best provider available.
 *
 * Google when a key is configured, Census otherwise — and Census again for
 * anything Google could not place or errored on. That ordering is the whole
 * design:
 *
 *   - **Precision by default.** Google returns rooftops; Census returns the
 *     right point on the block. Paying for the first and then not using it
 *     would be strange.
 *   - **An outage degrades, it doesn't fail.** If the key expires, the quota
 *     runs out, or Google is down, the import still completes on the free
 *     geocoder rather than returning a page of red rows.
 *   - **No key changes nothing.** The whole feature is absent rather than
 *     broken, which is what makes it safe to ship before anyone has a key.
 */
export async function geocode(
  rows: GeocodeRequest[],
  googleKey?: string,
): Promise<GeocodeMatch[]> {
  if (rows.length === 0) return []

  if (googleKey) {
    const primary = await googleGeocode(rows, googleKey)
    const byRef = new Map(primary.map((m) => [m.ref, m]))

    const unresolved = rows.filter((r) => byRef.get(r.ref)?.status !== 'match')
    if (unresolved.length === 0) return primary

    // Second opinion from the free one. Only ever upgrades a failure into a
    // match — a Census no-match must not overwrite Google's more specific
    // reason for refusing.
    const fallback = await censusGeocode(unresolved)
    for (const m of fallback) {
      if (m.status === 'match') byRef.set(m.ref, m)
    }
    return rows.map((r) => byRef.get(r.ref) ?? { ref: r.ref, status: 'no_match' as const })
  }

  return censusGeocode(rows)
}

async function censusGeocode(rows: GeocodeRequest[]): Promise<GeocodeMatch[]> {
  if (rows.length === 0) return []

  const first = await batch(rows)
  const byRef = new Map(first.map((m) => [m.ref, m]))

  const retry = rows.filter((r) => byRef.get(r.ref)?.status !== 'match' && r.zip)
  if (retry.length === 0) return first

  const second = await batch(retry.map((r) => ({ ...r, zip: undefined })))
  for (const m of second) {
    // Only ever upgrade a failure into a match. A second no-match must not
    // overwrite the first attempt's more specific reason.
    if (m.status === 'match') byRef.set(m.ref, m)
  }

  return rows.map((r) => byRef.get(r.ref) ?? { ref: r.ref, status: 'no_match' as const })
}
