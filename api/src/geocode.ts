/**
 * Geocoding — the provider chain, and the US Census implementation.
 *
 * Census sits at the bottom of the chain and is never removed, for a reason that
 * outranks accuracy: it needs no API key, no billing account and no card. It is
 * what makes an import work on a fresh deployment before anyone has an account,
 * and what keeps one working when a paid provider is down.
 *
 * Its trade-offs, stated because they matter later:
 *   - US addresses only. That's the market this app is for, but it's a ceiling.
 *   - It matches against TIGER road centrelines, so a result is "the right point
 *     on the right block", not a rooftop. For walking a street that's fine; for
 *     a 40-acre rural parcel it's a driveway entrance at best.
 *   - No SLA. It's a government service that occasionally goes slow.
 *
 * Adding or reordering providers is `geocode()` below and nothing else — which
 * is why each provider lives in its own file with its response parsing kept
 * separate from its HTTP call.
 */

import { googleGeocode } from './geocode-google'
import { maptilerGeocode } from './geocode-maptiler'

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
  provider?: 'maptiler' | 'google' | 'census'
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

export interface GeocodeKeys {
  maptiler?: string
  google?: string
}

/**
 * What one provider did with the batch it was handed.
 *
 * Added because the chain's greatest strength is also its blind spot: a provider
 * that rejects every request degrades so gracefully that nothing anywhere says
 * so. A misconfigured key looks identical to a provider that simply had nothing
 * to add — the import succeeds, the pins are merely worse than they should be,
 * and the operator has no way to tell. This is what makes that visible.
 */
export interface GeocodeAttempt {
  provider: 'maptiler' | 'google' | 'census'
  asked: number
  matched: number
  errors: number
  /** The provider's own words, so a bad key reads as a bad key. */
  firstError?: string
}

/**
 * Geocode a batch, using the best provider available.
 *
 * An ordered chain — MapTiler, then Google, then Census — where each provider
 * only ever sees what the one before it could not place. The ordering is the
 * whole design:
 *
 *   - **MapTiler first, and not because it is the most accurate.** This app
 *     draws its basemap from MapTiler tiles, and Google's platform terms
 *     generally expect Google-derived content to be displayed on a Google map.
 *     Geocoding with the provider that supplies the imagery removes that
 *     question instead of leaving it for a paying customer to inherit.
 *   - **Precision before thrift.** Both paid providers return rooftops; Census
 *     interpolates a house number along a block. Reaching for the free one
 *     first would mean discarding the precision on every address that would
 *     have resolved anyway.
 *   - **An outage degrades, it never fails.** Expired key, exhausted quota,
 *     provider down — the batch falls through to the next link and the import
 *     still completes, rather than returning a page of red rows.
 *   - **No keys changes nothing.** With neither configured this is exactly the
 *     Census-only path it has always been, which is what makes the whole
 *     feature safe to ship before anyone has an account.
 */
/**
 * How good a result is, for choosing between two answers about the same address.
 *
 * The chain used to fall through on *failure* only: any `status: 'match'` was
 * treated as placed and stopped the chain. That was wrong, and it shipped a
 * regression. MapTiler answers a US street address by fuzzy-matching tokens
 * against street geometry — "704 W 40th St, Austin, 78751" comes back as West
 * 40th Street in 78756, relevance 0.74, with the house number discarded — and
 * because that carried `status: 'match'`, Census was never asked. Census would
 * have used the house number to interpolate along the correct block in the
 * correct ZIP. A worse answer was silently preferred because it arrived first.
 *
 * So quality decides, not arrival order. Only a confident match ends the search;
 * anything less is held as a fallback while the next provider tries.
 *
 * The `partial` cliff is deliberately steep. A guessed match is not a slightly
 * worse rooftop, it is a different kind of thing: the provider was asked about a
 * house and answered about a street, or a street in another town. One of those
 * sends a rep to the wrong door, so it must never outrank an honest answer from
 * a provider that actually parsed the address.
 *
 * The rank is quality only, and deliberately says nothing about which provider
 * an answer came from. Two providers disagreeing about the same address is not
 * resolved by brand.
 */
const CONFIDENT = 40

const PRECISION_RANK: Record<string, number> = { rooftop: 20, interpolated: 10, approximate: 0 }

function rank(m: GeocodeMatch): number {
  if (m.status === 'match') {
    const p = PRECISION_RANK[m.precision ?? 'approximate'] ?? 0
    // A guess sits below every honest answer, however coarse that answer is —
    // but guesses are still ordered among themselves by precision. Skipping that
    // second part was a real bug: a guessed street in the right county and a
    // guessed centroid of a whole state ranked identically, so whichever
    // provider answered first won. Google returning "Texas, USA" for a rural
    // address beat MapTiler returning the right street in the right county,
    // and the pin landed 300 miles out.
    //
    // The partial band is halved so it cannot collide with CONFIDENT: a guessed
    // rooftop scores 30, still below the coarsest honest match at 40. A guess
    // that happened to land on a building is still a guess about which building.
    return m.partial ? 20 + p / 2 : CONFIDENT + p
  }
  // A specific reason beats a bare "not found": "quota exceeded" sends an
  // operator to the dashboard, "not found" sends them hunting for a typo.
  if (m.status === 'error') return 15
  if (m.status === 'tie') return 10
  return 0
}

export async function geocode(
  rows: GeocodeRequest[],
  keys: GeocodeKeys = {},
  /**
   * Filled in with one entry per provider that was asked. Optional because the
   * import path does not need it; the selftest endpoint does, and without it a
   * provider silently rejecting every request is undiagnosable from outside.
   */
  trace?: GeocodeAttempt[],
): Promise<GeocodeMatch[]> {
  if (rows.length === 0) return []

  const byRef = new Map<string, GeocodeMatch>()
  const held = (r: GeocodeRequest) => byRef.get(r.ref)
  const pending = () =>
    rows.filter((r) => rank(held(r) ?? { ref: r.ref, status: 'no_match' }) < CONFIDENT)

  /*
   * Ordered by what each provider can actually deliver for a US address,
   * measured rather than assumed.
   *
   *   google    first, where a key is configured. It returns the rooftop where
   *             it knows one and says so via `location_type`, which is the only
   *             thing in this chain that can put a pin on the right house rather
   *             than the right block. It sat second while this app drew a
   *             MapTiler basemap, because Google's terms expect Google content on
   *             a Google map; that objection retires when the basemap is Google.
   *             See the caching constraint in geocode-google.ts before relying on
   *             stored coordinates — it is a licence question, not a code one.
   *   census    second, and never removed. Free, no key, no card, batched a
   *             thousand at a time, public-domain output, US only, and it reads
   *             the house number to interpolate along the right block. This is
   *             what keeps an import working on a fresh deployment, when a card
   *             expires, and when a paid provider is down.
   *   maptiler  last, because of how it fails rather than what it covers. Asked
   *             about an address it cannot resolve, it returns a fuzzy street
   *             match with the house number discarded and the ZIP ignored —
   *             "704 W 40th St, Austin, 78751" comes back as West 40th Street in
   *             78756, with Texarkana and Mission behind it at 0.62. Census
   *             answers the same address with an honest no-match. A wrong pin is
   *             worse than an absent one because an absent one is visible, so the
   *             provider that guesses goes last. Kept rather than removed so it
   *             can still offer an operator something to look at, flagged.
   *
   * With no keys at all this is Census alone, which is a working product rather
   * than a degraded one. That property is the reason the free provider is never
   * removed from the bottom of this list.
   */
  const chain: {
    name: GeocodeAttempt['provider']
    run: (batch: GeocodeRequest[]) => Promise<GeocodeMatch[]>
  }[] = []
  if (keys.google) {
    chain.push({ name: 'google', run: (b) => googleGeocode(b, keys.google as string) })
  }
  chain.push({ name: 'census', run: censusGeocode })
  if (keys.maptiler) {
    chain.push({ name: 'maptiler', run: (b) => maptilerGeocode(b, keys.maptiler as string) })
  }

  for (const provider of chain) {
    const batch = pending()
    if (batch.length === 0) break

    const results = await provider.run(batch)
    for (const m of results) {
      // Only ever upgrade, by quality rather than by order of arrival.
      const prev = byRef.get(m.ref)
      if (!prev || rank(m) > rank(prev)) byRef.set(m.ref, m)
    }

    trace?.push({
      provider: provider.name,
      asked: batch.length,
      matched: results.filter((m) => m.status === 'match').length,
      errors: results.filter((m) => m.status === 'error').length,
      firstError: results.find((m) => m.status === 'error')?.error,
    })
  }

  return rows.map((r) => byRef.get(r.ref) ?? { ref: r.ref, status: 'no_match' as const })
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
