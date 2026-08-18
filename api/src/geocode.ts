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

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'

/**
 * The service's own documented ceiling is 10,000; we chunk far below it so a
 * single slow request can't hold a whole import hostage.
 */
export const GEOCODE_CHUNK = 100

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
  status: 'match' | 'no_match' | 'tie'
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

    matches.push({ ref, status: 'match', lat, lng, matchedAddress: f[4] || undefined })
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
export async function geocode(rows: GeocodeRequest[]): Promise<GeocodeMatch[]> {
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
