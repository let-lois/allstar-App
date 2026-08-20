/**
 * Geocoder response parsing, and the import dedupe key.
 *
 * Both are pure functions, deliberately, so they can be tested without the
 * internet — the Census geocoder can't be reached from a development sandbox, and
 * a test that needs a government service to be up is a test that gets skipped.
 *
 * The response fixtures below are the documented format. If the live service
 * ever diverges from them, `GET /api/selftest/geocode` on the deployed Worker is
 * what catches it: it geocodes a known address and asserts the coordinates land
 * where that address actually is.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'geo-'))
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
  return import(out)
}
const { parseCensusResponse, toCensusCsv } = await load('src/geocode.ts', 'geocode')
const { parseGoogleResponse } = await load('src/geocode-google.ts', 'google')
const { parseMapTilerResponse } = await load('src/geocode-maptiler.ts', 'maptiler')
const { addressKey, propertyIdFor } = await load('src/import.ts', 'import')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/* --- the coordinate-order trap -------------------------------------------- */
//
// The service returns "longitude,latitude". Read left-to-right into lat,lng and
// every US address lands in the Indian Ocean — silently, with no error anywhere.
{
  const body =
    '"1","1600 Pennsylvania Ave NW, Washington, DC, 20500","Match","Exact",' +
    '"1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500","-77.03535,38.898754","76225813","L"'
  const [m] = parseCensusResponse(body)
  ok(m.status === 'match', 'a matched address is reported as a match')
  ok(
    Math.abs(m.lat - 38.898754) < 1e-6,
    `latitude comes from the second coordinate (got ${m.lat})`,
  )
  ok(
    Math.abs(m.lng + 77.03535) < 1e-6,
    `longitude comes from the first coordinate (got ${m.lng})`,
  )
  ok(m.matchedAddress?.includes('PENNSYLVANIA'), 'the normalised address is kept')
}

/* --- the failure statuses ------------------------------------------------- */
{
  const [m] = parseCensusResponse('"7","123 Nowhere Rd, Nowhere, ZZ, 00000","No_Match"')
  ok(m.status === 'no_match', 'an unmatched address is reported, not dropped')
  ok(m.lat === undefined, 'an unmatched address carries no coordinates')
}
{
  const [m] = parseCensusResponse('"8","100 Main St","Tie"')
  ok(m.status === 'tie', 'an ambiguous address is a tie, distinct from no match')
}
{
  // A quoted comma inside the input-address echo must not shift the columns and
  // turn a match into a no-match.
  const body =
    '"9","100 Main St, Apt 2, Austin, TX","Match","Non_Exact",' +
    '"100 MAIN ST, AUSTIN, TX, 78701","-97.7431,30.2672","1234","R"'
  const [m] = parseCensusResponse(body)
  ok(m.status === 'match' && Math.abs(m.lat - 30.2672) < 1e-6, 'commas inside quoted fields do not shift columns')
}
{
  const rows = parseCensusResponse(
    '"1","a","No_Match"\n\n"2","b","Match","Exact","B","-97.1,30.1","x","L"\n',
  )
  ok(rows.length === 2, 'blank lines in the response are skipped')
  ok(rows[0].ref === '1' && rows[1].ref === '2', 'refs survive so results can be matched to rows')
}
{
  // Defence against the service ever returning the pair the other way round.
  const [m] = parseCensusResponse('"1","a","Match","Exact","A","38.9,-770.3","x","L"')
  ok(m.status === 'no_match', 'an impossible latitude is refused rather than stored')
}

/* --- the upload format ---------------------------------------------------- */
{
  const csv = toCensusCsv([
    { ref: 'r1', address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' },
  ])
  ok(csv.split('\n').length === 1, 'one line per address')
  ok(csv.startsWith('"r1","1420 Cedar Bend Dr"'), 'id first, then street')
  const quoted = toCensusCsv([{ ref: 'r2', address1: '5 "The Oaks" Ln' }])
  ok(quoted.includes('""The Oaks""'), 'a quote in an address is escaped, not left to break the row')
}

/* --- the dedupe key ------------------------------------------------------- */
//
// The same house arrives spelled three ways across three files. Importing it
// three times means three reps knock on the same door.
{
  const a = { address1: '1420 Cedar Bend Dr.', city: 'Round Rock', state: 'TX', zip: '78664' }
  const b = { address1: '1420 CEDAR BEND DRIVE', city: 'round rock', state: 'tx', zip: '78664' }
  const c = { address1: '1420  Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  ok(addressKey(a) === addressKey(b), 'street-type spelling and case fold to one key')
  ok(addressKey(a) === addressKey(c), 'punctuation and repeated spaces fold to one key')

  const d = { address1: '1422 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  ok(addressKey(a) !== addressKey(d), 'a different house number is a different key')

  const e = { address1: '1420 Cedar Bend Dr', city: 'Austin', state: 'TX', zip: '78701' }
  ok(addressKey(a) !== addressKey(e), 'the same street in another city is a different key')
}
{
  const row = { address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  const one = await propertyIdFor('c_alpha', row)
  const two = await propertyIdFor('c_alpha', row)
  const other = await propertyIdFor('c_beta', row)
  ok(one === two, 're-importing the same row produces the same id — imports are idempotent')
  ok(one !== other, 'the same address in two tenants is two different properties')
  ok(/^p_[0-9a-f]{24}$/.test(one), `the id is a well-formed property id (${one})`)
}

/* --- Google's geocoder ----------------------------------------------------- */
//
// Parsed from recorded responses rather than a live call: this API is billed per
// request, and a test that costs money every run is a test that stops being run.

{
  const m = parseGoogleResponse('r1', {
    status: 'OK',
    results: [{
      formatted_address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA',
      geometry: { location: { lat: 37.4224764, lng: -122.0842499 }, location_type: 'ROOFTOP' },
    }],
  })
  ok(m.status === 'match', 'a rooftop result is a match')
  ok(m.lat === 37.4224764 && m.lng === -122.0842499, 'with the coordinates the right way round')
  ok(m.precision === 'rooftop', 'and marked as a rooftop — the thing being paid for')
  ok(m.provider === 'google', 'attributed to the provider that answered')
  ok(m.partial !== true, 'and not flagged as a guess')
}
{
  const m = parseGoogleResponse('r2', {
    status: 'OK',
    results: [{
      formatted_address: '742 Evergreen Terrace, Springfield, IL, USA',
      partial_match: true,
      geometry: { location: { lat: 39.8, lng: -89.6 }, location_type: 'RANGE_INTERPOLATED' },
    }],
  })
  ok(
    m.partial === true,
    'a partial match is flagged — Google answers a misspelled address rather than refusing, and a rep would knock on the wrong door',
  )
  ok(m.precision === 'interpolated', 'an interpolated result does not claim to be a rooftop')
}
{
  const m = parseGoogleResponse('r3', {
    status: 'OK',
    results: [{
      formatted_address: 'Round Rock, TX, USA',
      geometry: { location: { lat: 30.5, lng: -97.6 }, location_type: 'APPROXIMATE' },
    }],
  })
  ok(m.precision === 'approximate', 'a whole-town centroid is reported as approximate, not as a house')
}
{
  ok(parseGoogleResponse('r4', { status: 'ZERO_RESULTS' }).status === 'no_match', 'no results is a no-match')
}
{
  // The distinction that matters operationally: a quota or key problem is not
  // the address's fault, and calling it "not found" sends someone hunting for a
  // typo that isn't there.
  const over = parseGoogleResponse('r5', {
    status: 'OVER_QUERY_LIMIT',
    error_message: 'You have exceeded your daily request quota',
  })
  ok(over.status === 'error', 'a quota failure is an error, not a no-match')
  ok(/quota/i.test(over.error ?? ''), 'and carries the reason')

  const denied = parseGoogleResponse('r6', { status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' })
  ok(denied.status === 'error', 'a bad key is an error too')
  ok(/api key/i.test(denied.error ?? ''), 'with the reason preserved')
}
{
  ok(
    parseGoogleResponse('r7', { status: 'OK', results: [{ geometry: {} }] }).status === 'no_match',
    'a result with no coordinates is refused rather than stored as zero',
  )
  ok(
    parseGoogleResponse('r8', {
      status: 'OK',
      results: [{ geometry: { location: { lat: 999, lng: 0 } } }],
    }).status === 'no_match',
    'an impossible latitude is refused',
  )
}

/* --- the two providers agree on shape -------------------------------------- */
//
// They have to be interchangeable: the fallback swaps one for the other
// mid-batch, and a caller must not be able to tell which answered except by
// looking at `provider` and `precision`.
{
  const census = parseCensusResponse(
    '"9","a","Match","Exact","A ST, TX, 78664","-97.6,30.5","x","L"',
  )[0]
  const google = parseGoogleResponse('9', {
    status: 'OK',
    results: [{ formatted_address: 'A ST', geometry: { location: { lat: 30.5, lng: -97.6 }, location_type: 'ROOFTOP' } }],
  })
  const shape = (m) => ['ref', 'status', 'lat', 'lng'].every((k) => k in m)
  ok(shape(census) && shape(google), 'both providers return the same fields')
  ok(census.provider === 'census', 'census attributes itself')
  ok(
    census.precision === 'interpolated',
    'and does not claim rooftop precision it cannot deliver',
  )
}


/* --- MapTiler ------------------------------------------------------------- */
//
// Same coordinate trap as Census, in a different disguise: GeoJSON `center` is
// [longitude, latitude]. Read left-to-right, a Texas address lands off Somalia.
{
  const m = parseMapTilerResponse('1', {
    features: [
      {
        place_name: '1600 Pennsylvania Ave NW, Washington, DC',
        place_type: ['address'],
        relevance: 1,
        center: [-77.03535, 38.898754],
        address: '1600',
      },
    ],
  })
  ok(m.status === 'match', 'a matched address is reported as a match')
  ok(
    Math.abs(m.lat - 38.898754) < 1e-6 && Math.abs(m.lng + 77.03535) < 1e-6,
    'longitude and latitude are not transposed',
  )
  ok(m.provider === 'maptiler', 'attributed to the provider that answered')
  ok(m.precision === 'rooftop', 'an address match carrying a house number is a rooftop')
  ok(m.partial !== true, 'a full-relevance hit is not flagged as a guess')
}

// Precision has to be inferred here — there is no location_type field — so the
// inference is what needs pinning. Claiming rooftop for a street match would
// make the whole provider swap pointless.
{
  const street = parseMapTilerResponse('2', {
    features: [{ place_name: 'Cedar Bend Dr', place_type: ['street'], relevance: 1, center: [-97.7, 30.5] }],
  })
  ok(street.precision === 'interpolated', 'a street match is interpolated, never rooftop')

  const addressNoNumber = parseMapTilerResponse('3', {
    features: [{ place_name: 'Cedar Bend Dr', place_type: ['address'], relevance: 1, center: [-97.7, 30.5] }],
  })
  ok(
    addressNoNumber.precision === 'interpolated',
    'an address match with no house number is not a rooftop either',
  )

  const place = parseMapTilerResponse('4', {
    features: [{ place_name: 'Round Rock, TX', place_type: ['place'], relevance: 1, center: [-97.7, 30.5] }],
  })
  ok(place.precision === 'approximate', 'a place match is approximate')
}

// Relevance is how MapTiler says "I guessed", where Google sets partial_match.
{
  const fuzzy = parseMapTilerResponse('5', {
    features: [{ place_name: 'X', place_type: ['address'], relevance: 0.62, center: [-97.7, 30.5], address: '1' }],
  })
  ok(fuzzy.partial === true, 'a low-relevance hit is flagged so an operator can look before importing')
}

// An empty feature list is a genuine miss; a message is a fault. Reporting a
// fault as "not found" sends someone hunting for a typo that is not there.
{
  const none = parseMapTilerResponse('6', { features: [] })
  ok(none.status === 'no_match', 'no features means not found')

  const bad = parseMapTilerResponse('7', { message: 'Key is invalid' })
  ok(bad.status === 'error', 'a message means the provider failed, not that the address is wrong')
  ok(/invalid/i.test(bad.error ?? ''), 'and the reason is carried through')
}

// A latitude beyond ±90 only makes sense the other way round, which is a parse
// error rather than data.
{
  const swapped = parseMapTilerResponse('8', {
    features: [{ place_name: 'X', place_type: ['address'], center: [30.5, -197.7] }],
  })
  ok(swapped.status === 'no_match', 'an impossible coordinate pair is refused rather than plotted')
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocode parsing and dedupe are correct')
process.exit(fails.length ? 1 : 0)
