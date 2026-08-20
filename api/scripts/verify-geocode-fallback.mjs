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
 * shipped broken: any `status: 'match'` used to end the search, so MapTiler's
 * fuzzy street guess — house number discarded, ZIP ignored, relevance 0.74 —
 * stopped Census from ever being asked, and a worse answer won because it
 * arrived first. A guessed match must never outrank an honest one.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'gc-')), 'geocode.mjs')
await build({ entryPoints: ['src/geocode.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const { geocode } = await import(out)

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

/** Counts what each provider was asked for, so "was it even called" is testable. */
function stub({ maptiler, google, census }) {
  const calls = { maptiler: [], google: [], census: 0 }
  globalThis.fetch = async (url, init) => {
    const href = String(url)

    if (href.includes('api.maptiler.com/geocoding')) {
      // The query sits in the path: /geocoding/{address}.json
      const path = new URL(href).pathname
      const address = decodeURIComponent(path.replace(/^\/geocoding\//, '').replace(/\.json$/, ''))
      calls.maptiler.push(address)
      const body = maptiler(address)
      return {
        ok: body.httpOk !== false,
        status: body.httpOk === false ? 500 : 200,
        json: async () => body,
      }
    }

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

    throw new Error(`unexpected fetch: ${href}`)
  }
  return calls
}

/* --- response builders ---------------------------------------------------- */

const tilerOk = (lat, { relevance = 1, types = ['address'], address = '10' } = {}) => (query) => ({
  features: [
    {
      place_name: query.toUpperCase(),
      place_type: types,
      relevance,
      // GeoJSON order: [longitude, latitude].
      center: [-97.7, lat],
      address,
    },
  ],
})
const tilerNone = () => ({ features: [] })

const googleOk = (lat, { partial = false } = {}) => (address) => ({
  status: 'OK',
  results: [{
    formatted_address: address.toUpperCase(),
    partial_match: partial || undefined,
    geometry: { location: { lat, lng: -97.7 }, location_type: 'ROOFTOP' },
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

/* --- no keys: the free geocoder, and nothing else ------------------------- */
{
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.3), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS)
  ok(calls.maptiler.length === 0, 'with no keys, MapTiler is never called — no key means no bill')
  ok(calls.google.length === 0, 'nor Google')
  ok(calls.census === 1, 'Census answers instead, in one batched call')
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
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.9), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { maptiler: 'tiler-key', google: 'google-key' })
  ok(calls.google.length === 3, 'Google sees the batch first')
  ok(calls.census === 0, 'and nothing below it is asked about addresses it placed')
  ok(calls.maptiler.length === 0, 'MapTiler included')
  ok(
    res.every((m) => m.provider === 'google' && m.precision === 'rooftop'),
    'every result is a rooftop from Google',
  )
}

/* --- Census still leads when there is no Google key ---------------------- */
//
// The free provider is never removed from the bottom of the chain, and with no
// paid key it is the whole chain. A deployment with no billing account is a
// working product, not a degraded one.
{
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.9), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(calls.census === 1, 'Census answers the batch')
  ok(calls.maptiler.length === 0, 'and the guesser below it is never reached')
  ok(res.every((m) => m.provider === 'census'), 'every result comes from the free provider')
}

/* --- a guessed match must not end the search ----------------------------- */
//
// The regression, pinned. A provider that answers a house with a street — or a
// street in another town — has guessed, and a guess must not stop a provider
// that can actually parse the address from being asked. Google leads now, so the
// guess is Google's and Census is the one that must still get a turn.
{
  const calls = stub({
    google: googleOk(30.9, { partial: true }),
    census: (refs) => censusRows(refs),
    maptiler: tilerOk(30.3),
  })
  const res = await geocode(ROWS, { google: 'google-key', maptiler: 'tiler-key' })
  ok(calls.google.length === 3, 'Google is asked first')
  ok(
    calls.census === 1,
    'and a guessed answer does not stop the next provider being asked about it',
  )
  ok(
    res.every((m) => m.provider === 'census' && m.partial !== true),
    'the confident answer wins over the guess that arrived first',
  )
  ok(calls.maptiler.length === 0, 'and once something confident exists, the chain stops')
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
    maptiler: tilerNone,
  })
  const res = await geocode(ROWS, { google: 'google-key', maptiler: 'tiler-key' })
  ok(
    res.every((m) => m.status === 'match' && m.partial === true),
    'when nothing confident exists, the flagged guess is still reported',
  )
}

/* --- each link only sees what the last one missed ------------------------- */
{
  const calls = stub({
    google: (address) => (/2 B/.test(address) ? { status: 'ZERO_RESULTS' } : googleOk(30.9)(address)),
    census: (refs) => censusRows(refs),
    maptiler: tilerOk(30.3),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key', google: 'google-key' })
  ok(calls.google.length === 3, 'Google is asked for all three')
  ok(calls.census === 1, 'Census is asked once, for what Google could not place')
  ok(calls.maptiler.length === 0, 'and MapTiler is not needed at all')
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'match' && b.provider === 'census', 'the missed address is placed by the next provider')
  ok(res.filter((m) => m.provider === 'google').length === 2, 'while the rest keep their original results')
}

/* --- precision is reported, not flattered -------------------------------- */
//
// A street-level match is the road, not the building. Reporting it as a rooftop
// would make this whole change pointless: an operator would trust a pin that has
// not earned it.
{
  stub({
    census: (refs) => censusRows(refs, false),
    maptiler: tilerOk(30.3, { types: ['road'], address: undefined }),
    google: googleOk(30.9),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(
    res.every((m) => m.precision === 'interpolated'),
    'a road-level match is interpolated, never rooftop',
  )
}
{
  stub({
    census: (refs) => censusRows(refs, false),
    maptiler: tilerOk(30.3, { relevance: 0.6 }),
    google: googleOk(30.9),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(res.every((m) => m.partial === true), 'a low-relevance hit is flagged as a guess')
}

/* --- a rooftop from a later provider still wins -------------------------- */
//
// The ordering forgoes a rooftop for rows Census placed, which is deliberate and
// documented. It must not also forgo one for a row Census missed.
{
  stub({ census: censusExcept('a'), google: googleOk(30.9), maptiler: tilerNone })
  const res = await geocode(ROWS, { google: 'google-key' })
  const a = res.find((m) => m.ref === 'a')
  ok(a.provider === 'google' && a.precision === 'rooftop', 'a rooftop is taken where Census could not parse the address')
}

/* --- the trace makes a rejecting provider visible ------------------------ */
//
// The chain's strength is its blind spot: a dead provider degrades silently, so
// a misconfigured key is indistinguishable from a provider with nothing to add.
{
  stub({
    census: (refs) => censusRows(refs, false),
    maptiler: () => ({ message: 'Bad request' }),
    google: googleOk(30.9),
  })
  const trace = []
  const res = await geocode(ROWS, { maptiler: 'k' }, trace)
  ok(trace.length === 2, 'both providers that were asked are recorded')
  const tiler = trace.find((t) => t.provider === 'maptiler')
  ok(tiler.asked === 3 && tiler.matched === 0, 'MapTiler is shown as having placed nothing')
  ok(/bad request/i.test(tiler.firstError ?? ''), "and its own reason is carried through")
  ok(
    res.every((m) => m.status === 'error' && /bad request/i.test(m.error ?? '')),
    'the failure reaches the caller rather than being flattened to "not found"',
  )
}
{
  stub({ census: (refs) => censusRows(refs), maptiler: tilerOk(30.3), google: googleOk(30.9) })
  const trace = []
  await geocode(ROWS, { maptiler: 'k', google: 'k' }, trace)
  ok(
    trace.length === 1 && trace[0].provider === 'google',
    'a provider that was never needed is not listed as having been asked',
  )
}

/* --- THE case: a paid provider is down or its key has expired ------------ */
//
// An import must not fail because a paid dependency did. Census is first now, so
// this matters for the rows Census could not parse — the ones that depend on a
// paid provider being alive.
{
  const calls = stub({
    census: censusExcept('b'),
    maptiler: () => ({ message: 'Key is invalid' }),
    google: googleOk(30.9),
  })
  const res = await geocode(ROWS, { maptiler: 'dead-key' })
  ok(calls.maptiler.length === 1, 'a dead key is still asked about the row nothing else could place')
  ok(
    res.filter((m) => m.status === 'match').length === 2,
    'and the rest of the import is unaffected',
  )
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'error' && /invalid/i.test(b.error ?? ''), 'the one row that needed it reports why it failed')
}
{
  stub({
    census: (refs) => censusRows(refs),
    maptiler: () => ({ httpOk: false }),
    google: () => ({ httpOk: false }),
  })
  const res = await geocode(ROWS, { maptiler: 'k', google: 'k' })
  ok(
    res.every((m) => m.status === 'match' && m.provider === 'census'),
    'both paid providers being down is invisible when the free one can answer',
  )
}

/* --- Google alone still works, unchanged --------------------------------- */
{
  const calls = stub({
    census: (refs) => censusRows(refs, false),
    maptiler: tilerOk(30.3),
    google: googleOk(30.9),
  })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(calls.maptiler.length === 0, 'a Google-only config never touches MapTiler')
  ok(calls.google.length === 3, 'and Google answers what Census could not')
  ok(res.every((m) => m.provider === 'google'), 'as before this chain existed')
}

/* --- when nothing can place it ------------------------------------------- */
{
  stub({
    census: (refs) => censusRows(refs, false),
    maptiler: tilerNone,
    google: () => ({ status: 'ZERO_RESULTS' }),
  })
  const res = await geocode(ROWS, { maptiler: 'k', google: 'k' })
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
    maptiler: () => ({ message: 'quota exceeded' }),
    google: () => ({ status: 'ZERO_RESULTS' }),
  })
  const res = await geocode(ROWS, { maptiler: 'k', google: 'k' })
  ok(
    res.every((m) => m.status === 'error' && /quota/i.test(m.error ?? '')),
    'when everything fails, the more specific reason survives — "quota exceeded" beats "not found"',
  )
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocoder selection and fallback are correct')
process.exit(fails.length ? 1 : 0)
