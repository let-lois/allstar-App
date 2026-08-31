/**
 * Which geocoder answers, and what happens when one of them doesn't.
 *
 * `fetch` is stubbed rather than any service being called: this is about the
 * decision logic, and a test that depends on a metered API being up is a test
 * that stops being run. The parsing itself is covered by verify-geocode.
 *
 * Three behaviours are pinned here.
 *
 * Precision is preferred but never required — an expired key, an exhausted quota
 * or an outage has to degrade the import to the next provider rather than fail
 * it.
 *
 * The chain is ordered, and each provider only ever sees what the one before it
 * could not place, so nothing is billed twice.
 *
 * And the fall-through is on *quality*, not on failure. This is the one that
 * shipped broken: any `status: 'match'` used to end the search, so a fuzzy
 * street guess — house number discarded, ZIP ignored — stopped the next
 * provider from ever being asked, and a worse answer won because it arrived
 * first. A guessed match must never outrank an honest one.
 *
 * ## Two providers now, not three
 *
 * MapTiler was the third link and has been removed — not for quality, though it
 * was the one that guessed, but because the Worker using a MapTiler key was what
 * kept that key un-origin-lockable. See the note on `geocode` in
 * api/src/geocode.ts.
 *
 * Two things follow. The scenarios that needed a second *guessing* provider
 * cannot be built from Google and Census, because Census does not guess — it
 * matches or it says no. The ordering rule those scenarios protected is a pure
 * function, so it is asserted directly against `rank` at the bottom of this file
 * rather than being quietly dropped along with the provider.
 *
 * And a MapTiler request is now a bug rather than a code path: the stub has no
 * branch for it, so any attempt to reach api.maptiler.com throws.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'gc-')), 'geocode.mjs')
await build({ entryPoints: ['src/geocode.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const { geocode, rank } = await import(out)

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const ROWS = [
  { ref: 'a', address1: '1 A St', city: 'Austin', state: 'TX', zip: '78701' },
  { ref: 'b', address1: '2 B St', city: 'Austin', state: 'TX', zip: '78701' },
  { ref: 'c', address1: '3 C St', city: 'Austin', state: 'TX', zip: '78701' },
]

/**
 * Counts what each provider was asked for, so "was it even called" is testable.
 *
 * Anything that is not Google or Census throws by name. That is the guard on
 * MapTiler's removal: a chain that quietly regained a third provider, or a stray
 * key that still reached one, fails here instead of passing silently.
 */
function stub({ google, census }) {
  const calls = { google: [], census: 0, strays: [] }
  globalThis.fetch = async (url, init) => {
    const href = String(url)

    if (href.includes('googleapis.com')) {
      const address = decodeURIComponent(new URL(href).searchParams.get('address') ?? '')
      calls.google.push(address)
      const body = google(address)
      return { ok: body.httpOk !== false, status: body.httpOk === false ? 500 : 200, json: async () => body }
    }

    if (href.includes('census.gov')) {
      calls.census += 1
      const file = init?.body
      const text = typeof file?.get === 'function' ? await file.get('addressFile').text() : ''
      const refs = text.split('\n').filter(Boolean).map((l) => l.split(',')[0].replace(/"/g, ''))
      return { ok: true, status: 200, text: async () => census(refs) }
    }

    calls.strays.push(href)
    throw new Error(`unexpected fetch: ${href}`)
  }
  return calls
}

/* --- response builders ---------------------------------------------------- */

/**
 * Google's real behaviour for an address it cannot parse: widen until something
 * matches, and return that. Observed against a rural East Texas address, which
 * came back as "Texas, USA" at the centroid of the state.
 */
const googleTooCoarse = () => () => ({
  status: 'OK',
  results: [{
    formatted_address: 'Texas, USA',
    partial_match: true,
    types: ['administrative_area_level_1', 'political'],
    geometry: { location: { lat: 31.9685988, lng: -99.9018131 }, location_type: 'APPROXIMATE' },
  }],
})

const googleOk = (lat, { partial = false, locationType = 'ROOFTOP' } = {}) => (address) => ({
  status: 'OK',
  results: [{
    formatted_address: address.toUpperCase(),
    partial_match: partial || undefined,
    types: ['street_address'],
    geometry: { location: { lat, lng: -97.7 }, location_type: locationType },
  }],
})

const censusRows = (refs, matched = true) =>
  refs
    .map((r) =>
      matched
        ? `"${r}","in","Match","Exact","OUT ${r}","-97.75,30.26","x","L"`
        : `"${r}","in","No_Match"`,
    )
    .join('\n')

/** Census answers for every ref except the ones named. */
const censusExcept = (...missing) => (refs) =>
  refs
    .map((r) =>
      missing.includes(r)
        ? `"${r}","in","No_Match"`
        : `"${r}","in","Match","Exact","OUT ${r}","-97.75,30.26","x","L"`,
    )
    .join('\n')

/*
  Census retries without the ZIP whenever *any* row in the batch came back
  no-match — not only when all of them did (see censusGeocode). So a batch it
  places entirely costs one call, and a batch where even one row missed costs
  two. Named rather than written as a bare number, because a changed retry
  policy should read as a changed constant rather than as an unexplained figure
  moving; and named this way because the first version of these assertions got
  the rule wrong and expected one call for a batch with a single miss.
*/
const CENSUS_CALLS_CLEAN = 1
const CENSUS_CALLS_WITH_RETRY = 2

/* --- no key: the free geocoder, and nothing else -------------------------- */
{
  const calls = stub({ google: googleOk(30.3), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS)
  ok(calls.google.length === 0, 'with no key, Google is never called — no key means no bill')
  ok(calls.census === CENSUS_CALLS_CLEAN, 'Census answers instead, in one batched call')
  ok(res.every((m) => m.status === 'match'), 'and every address is placed')
  ok(
    res.every((m) => m.provider === 'census' && m.precision === 'interpolated'),
    'attributed honestly, without claiming rooftop precision',
  )
}

/* --- Google goes first, where a key is configured ------------------------ */
//
// It is the only provider here that can return a rooftop. It sat second while
// this app drew a MapTiler basemap, because Google's terms expect Google content
// on a Google map; that objection retires when the basemap is Google.
{
  const calls = stub({ google: googleOk(30.9), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(calls.google.length === 3, 'Google sees the batch first')
  ok(calls.census === 0, 'and nothing below it is asked about addresses it placed')
  ok(
    res.every((m) => m.provider === 'google' && m.precision === 'rooftop'),
    'every result is a rooftop from Google',
  )
}

/* --- a stray MapTiler key does nothing ----------------------------------- */
//
// The removal, pinned. A deployment that still has MAPTILER_API_KEY set as a
// secret, or a caller passing one out of habit, must behave exactly as if it
// were absent — not reach MapTiler, and not change what comes back.
//
// Census is made to fail every row on purpose, and that detail is the whole
// test. The first version of this let Census place all three, which meant the
// chain stopped at Census with nothing left pending — so a re-added third link
// would never have run and the assertion could not fail. Proved by re-adding a
// MapTiler link to the chain: the gate stayed green. With nothing placeable, any
// third link gets its turn, and reaching MapTiler throws in the stub.
{
  const calls = stub({
    google: googleOk(30.9),
    census: (refs) => censusRows(refs, false),
  })
  const res = await geocode(ROWS, { maptiler: 'a-key-that-should-be-ignored' })
  ok(calls.strays.length === 0, 'a leftover MapTiler key sends no request to MapTiler')
  ok(calls.google.length === 0, 'and does not enable Google either')
  ok(
    calls.census === CENSUS_CALLS_WITH_RETRY,
    'Census is the whole chain, and is asked with its retry',
  )
  ok(
    res.every((m) => m.status !== 'match'),
    'rows nothing can place come back unplaced — there is no third provider to guess',
  )
}

/* --- a guessed match must not end the search ----------------------------- */
//
// The regression, pinned. A provider that answers a house with a street — or a
// street in another town — has guessed, and a guess must not stop a provider
// that can actually parse the address from being asked. Google leads, so the
// guess is Google's and Census is the one that must still get a turn.
{
  const calls = stub({
    google: googleOk(30.9, { partial: true }),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(calls.google.length === 3, 'Google is asked first')
  ok(
    calls.census === CENSUS_CALLS_CLEAN,
    'and a guessed answer does not stop the next provider being asked about it',
  )
  ok(
    res.every((m) => m.provider === 'census' && m.partial !== true),
    'the confident answer wins over the guess that arrived first',
  )
}

/* --- but a guess is better than nothing ---------------------------------- */
//
// Kept rather than discarded: the import preview flags a partial match as "close
// match — check this one" and shows what was matched, which is something an
// operator can act on. An empty row is not.
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: googleOk(30.9, { partial: true }),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(
    res.every((m) => m.status === 'match' && m.partial === true),
    'when nothing confident exists, the flagged guess is still reported',
  )
}

/* --- each link only sees what the last one missed ------------------------- */
//
// This is also the "a later provider still wins where the first could not
// answer" case. It used to have its own block asserting that a rooftop from
// further down the chain was taken — written when Census led. With Google first
// and Google the only rooftop provider, that block could no longer fail, and it
// is folded in here rather than left passing on nothing.
{
  const calls = stub({
    google: (address) => (/2 B/.test(address) ? { status: 'ZERO_RESULTS' } : googleOk(30.9)(address)),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(calls.google.length === 3, 'Google is asked for all three')
  ok(
    calls.census === CENSUS_CALLS_CLEAN,
    'Census is asked once, for what Google could not place — and places it, so no retry',
  )
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'match' && b.provider === 'census', 'the missed address is placed by the next provider')
  ok(res.filter((m) => m.provider === 'google').length === 2, 'while the rest keep their original results')
}

/* --- precision is reported, not flattered -------------------------------- */
//
// A street-level match is the road, not the building. Reporting it as a rooftop
// would make this whole chain pointless: an operator would trust a pin that has
// not earned it. These used to be asserted through MapTiler's `road` type and
// its relevance score; the same two properties are Google's `location_type` and
// `partial_match`.
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: googleOk(30.9, { locationType: 'RANGE_INTERPOLATED' }),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(
    res.every((m) => m.precision === 'interpolated'),
    'an interpolated match is interpolated, never rooftop',
  )
}
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: googleOk(30.9, { locationType: 'GEOMETRIC_CENTER' }),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(
    res.every((m) => m.precision === 'approximate'),
    'and the centre of something bigger than a house is approximate',
  )
}
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: googleOk(30.9, { partial: true }),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(res.every((m) => m.partial === true), 'a guessed hit is flagged as a guess')
}

/* --- the trace makes a rejecting provider visible ------------------------ */
//
// The chain's strength is its blind spot: a dead provider degrades silently, so
// a misconfigured key is indistinguishable from a provider with nothing to add.
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: () => ({ status: 'REQUEST_DENIED', error_message: 'Bad request' }),
  })
  const trace = []
  const res = await geocode(ROWS, { google: 'k' }, trace)
  ok(trace.length === 2, 'both providers that were asked are recorded')
  const g = trace.find((t) => t.provider === 'google')
  ok(g.asked === 3 && g.matched === 0, 'Google is shown as having placed nothing')
  ok(/bad request/i.test(g.firstError ?? ''), "and its own reason is carried through")
  ok(
    res.every((m) => m.status === 'error' && /bad request/i.test(m.error ?? '')),
    'the failure reaches the caller rather than being flattened to "not found"',
  )
}
{
  stub({ census: (refs) => censusRows(refs), google: googleOk(30.9) })
  const trace = []
  await geocode(ROWS, { google: 'k' }, trace)
  ok(
    trace.length === 1 && trace[0].provider === 'google',
    'a provider that was never needed is not listed as having been asked',
  )
}

/* --- THE case: the paid provider is down or its key has expired ---------- */
//
// An import must not fail because a paid dependency did.
{
  const calls = stub({
    census: censusExcept('b'),
    google: () => ({ status: 'REQUEST_DENIED', error_message: 'Key is invalid' }),
  })
  const res = await geocode(ROWS, { google: 'dead-key' })
  ok(calls.google.length === 3, 'the dead key is still asked, since it leads the chain')
  ok(
    calls.census === CENSUS_CALLS_WITH_RETRY,
    'and Census is asked about everything it rejected, twice — its own ZIP-less retry',
  )
  ok(
    res.filter((m) => m.status === 'match').length === 2,
    'the rows the free provider can place are unaffected',
  )
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'error' && /invalid/i.test(b.error ?? ''), 'the one row that needed it reports why it failed')
}
{
  stub({ census: (refs) => censusRows(refs), google: () => ({ httpOk: false }) })
  const res = await geocode(ROWS, { google: 'k' })
  ok(
    res.every((m) => m.status === 'match' && m.provider === 'census'),
    'the paid provider being down is invisible when the free one can answer',
  )
}

/* --- when nothing can place it ------------------------------------------- */
{
  stub({ census: (refs) => censusRows(refs, false), google: () => ({ status: 'ZERO_RESULTS' }) })
  const res = await geocode(ROWS, { google: 'k' })
  ok(
    res.every((m) => m.status !== 'match'),
    'an address nobody can find is reported as unplaced rather than invented',
  )
  ok(res.length === ROWS.length, 'and every row still comes back — none are silently dropped')
}

/* --- a later no-match must not overwrite a real reason ------------------- */
{
  stub({
    census: (refs) => censusRows(refs, false),
    google: () => ({ status: 'OVER_QUERY_LIMIT', error_message: 'quota exceeded' }),
  })
  const res = await geocode(ROWS, { google: 'k' })
  ok(
    res.every((m) => m.status === 'error' && /quota/i.test(m.error ?? '')),
    'when everything fails, the more specific reason survives — "quota exceeded" beats "not found"',
  )
}

/* --- "Texas" is not an answer to "which house" --------------------------- */
//
// From one real probe of a rural East Texas address. Google returned the
// centroid of the state, flagged partial and APPROXIMATE. Nothing was concealed
// — and it still arrived as a match with coordinates, which is all a map needs
// to draw a pin 300 miles from the house.
//
// MapTiler used to catch these rows with a street-level guess. It is gone, so
// they now come back unplaced, and that is the point of the assertion: an
// operator sees a row that failed rather than a pin in the wrong county.
{
  const calls = stub({ google: googleTooCoarse(), census: (refs) => censusRows(refs, false) })
  const res = await geocode(ROWS, { google: 'google-key' })

  ok(
    calls.census === CENSUS_CALLS_WITH_RETRY,
    'an administrative-area answer does not stop the chain',
  )
  ok(
    res.every((m) => m.status !== 'match'),
    'a state centroid is refused outright, so it cannot win by arriving first',
  )
  ok(
    res.every((m) => m.lat === undefined || Math.abs(m.lat - 31.9685988) > 0.01),
    'and no result carries the centroid coordinates',
  )
}

/* --- but a guess never beats an honest answer ---------------------------- */
{
  stub({
    // A guessed rooftop: the top of the partial band.
    google: googleOk(30.9, { partial: true }),
    // The coarsest honest answer there is.
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(
    res.every((m) => m.provider === 'census' && m.partial !== true),
    'even a guessed rooftop loses to an unguessed interpolation',
  )
}

/* --- the ordering rule itself -------------------------------------------- */
//
// Asserted directly rather than through two providers, because there is only one
// provider left that guesses. This was covered by a scenario pitting MapTiler's
// guessed street against Google's guessed postcode; that scenario cannot be
// rebuilt from Google and Census, since Census does not guess.
//
// The rule is a pure function and the bug it encodes was real: a guessed street
// in the right county and a guessed centroid of a whole state used to rank
// identically, so whichever provider answered first won, and a pin landed 300
// miles out. Losing a provider must not lose the assertion.
{
  const guess = (precision) => ({ ref: 'x', status: 'match', precision, partial: true })
  const honest = (precision) => ({ ref: 'x', status: 'match', precision })

  ok(
    rank(guess('interpolated')) > rank(guess('approximate')),
    'a guessed street outranks a guessed centroid — guesses are ordered among themselves',
  )
  ok(
    rank(guess('rooftop')) > rank(guess('interpolated')),
    'and the ordering holds across the whole guessed band',
  )
  ok(
    rank(honest('approximate')) > rank(guess('rooftop')),
    'but the coarsest honest answer still beats the best guess',
  )
  ok(
    rank(honest('rooftop')) > rank(honest('interpolated')),
    'and honest answers are ordered among themselves too',
  )
  ok(
    rank({ ref: 'x', status: 'error', error: 'quota exceeded' }) >
      rank({ ref: 'x', status: 'no_match' }),
    'a specific failure outranks a bare no-match, so the reason survives',
  )
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocoder selection and fallback are correct')
process.exit(fails.length ? 1 : 0)
