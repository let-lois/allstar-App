/**
 * Which geocoder answers, and what happens when one of them doesn't.
 *
 * `fetch` is stubbed rather than any service being called: this is about the
 * decision logic, and a test that depends on a metered API being up is a test
 * that stops being run. The parsing itself is covered by verify-geocode.
 *
 * Two behaviours are pinned here. Precision is preferred but never required — an
 * expired key, an exhausted quota or an outage has to degrade the import to the
 * next provider rather than fail it. And the chain is ordered: each provider only
 * ever sees what the one before it could not place, so nothing is billed twice.
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

const googleOk = (lat) => (address) => ({
  status: 'OK',
  results: [{
    formatted_address: address.toUpperCase(),
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

/* --- the request itself --------------------------------------------------- */
//
// This is the check that would have caught the first release. `street` is not a
// MapTiler place type; sending it makes the request invalid, MapTiler rejects
// every address, and the chain degrades so gracefully that the only symptom is
// results arriving from Census instead.
{
  let asked = ''
  globalThis.fetch = async (url) => {
    const href = String(url)
    // Only the MapTiler request is under test. The chain falls through to Census
    // after a no-match, and capturing every URL would leave us asserting against
    // whichever one happened to be last.
    if (href.includes('api.maptiler.com')) asked = href
    if (href.includes('census.gov')) return { ok: true, status: 200, text: async () => '' }
    return { ok: true, status: 200, json: async () => ({ features: [] }) }
  }
  await geocode([ROWS[0]], { maptiler: 'k' }).catch(() => {})
  ok(/types=address%2Croad|types=address,road/.test(asked), "the request asks for MapTiler's own type names")
  ok(!/street/.test(asked), "and never sends 'street', which MapTiler does not accept")
  ok(/country=us/.test(asked) && /limit=1/.test(asked), 'scoped to one US result')
}

/* --- the trace makes a rejecting provider visible ------------------------- */
//
// The chain's strength is its blind spot: a dead provider degrades silently, so
// a misconfigured key is indistinguishable from a provider with nothing to add.
{
  stub({
    maptiler: () => ({ message: 'Bad request' }),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs),
  })
  const trace = []
  const res = await geocode(ROWS, { maptiler: 'k' }, trace)
  ok(res.every((m) => m.status === 'match'), 'the import still succeeds')
  ok(trace.length === 2, 'both providers that were asked are recorded')
  const tiler = trace.find((t) => t.provider === 'maptiler')
  ok(tiler.asked === 3 && tiler.matched === 0, 'MapTiler is shown as having placed nothing')
  ok(/bad request/i.test(tiler.firstError ?? ''), "and its own reason is carried through")
  const census = trace.find((t) => t.provider === 'census')
  ok(census.matched === 3, 'while the fallback is shown doing the work')
}

/* --- MapTiler alone ------------------------------------------------------- */
{
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.3), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(calls.maptiler.length === 3, 'with a MapTiler key, every address goes to MapTiler')
  ok(calls.google.length === 0 && calls.census === 0, 'and nothing else is called when nothing needs it')
  ok(
    res.every((m) => m.provider === 'maptiler' && m.precision === 'rooftop'),
    'an address-level hit with a house number is a rooftop',
  )
}

/* --- MapTiler goes first when both paid keys are present ------------------ */
//
// The ordering is not about accuracy. The basemap comes from MapTiler, and
// Google's terms expect Google content on a Google map — so the provider that
// supplies the imagery is the one that should supply the coordinates.
{
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.9), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { maptiler: 'tiler-key', google: 'google-key' })
  ok(calls.maptiler.length === 3, 'MapTiler sees the batch first')
  ok(calls.google.length === 0, 'and Google is not billed for addresses already placed')
  ok(res.every((m) => m.provider === 'maptiler'), 'every result comes from MapTiler')
}

/* --- each link only sees what the last one missed ------------------------- */
{
  const calls = stub({
    maptiler: (q) => (q.startsWith('2 B') ? tilerNone() : tilerOk(30.3)(q)),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key', google: 'google-key' })
  ok(calls.maptiler.length === 3, 'MapTiler is asked for all three')
  ok(calls.google.length === 1 && /2 B/.test(calls.google[0]), 'Google is asked for exactly the one that missed')
  ok(calls.census === 0, 'and Census is not needed at all')
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'match' && b.provider === 'google', 'the missed address is placed by the next provider')
  ok(res.filter((m) => m.provider === 'maptiler').length === 2, 'while the rest keep their original results')
}

/* --- precision is reported, not flattered -------------------------------- */
//
// A street-level match is the road, not the building. Reporting it as a rooftop
// would make this whole change pointless: an operator would trust a pin that has
// not earned it.
{
  stub({
    maptiler: tilerOk(30.3, { types: ['road'], address: undefined }),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(
    res.every((m) => m.precision === 'interpolated'),
    'a road-level match is interpolated, never rooftop',
  )
}
{
  stub({
    maptiler: tilerOk(30.3, { relevance: 0.6 }),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { maptiler: 'tiler-key' })
  ok(res.every((m) => m.partial === true), 'a low-relevance hit is flagged as a guess')
}

/* --- THE case: a paid provider is down or its key has expired ------------ */
//
// An import must not fail because a paid dependency did. This is the reason the
// free geocoder is kept rather than deleted once a key exists.
{
  const calls = stub({
    maptiler: () => ({ message: 'Key is invalid' }),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { maptiler: 'dead-key' })
  ok(calls.census === 1, 'a dead MapTiler key sends the whole batch on to the next provider')
  ok(res.every((m) => m.status === 'match'), 'and every address still gets placed')
  ok(res.every((m) => m.provider === 'census'), 'on the free geocoder')
}
{
  const calls = stub({
    maptiler: () => ({ httpOk: false }),
    google: () => ({ httpOk: false }),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, { maptiler: 'k', google: 'k' })
  ok(res.every((m) => m.status === 'match'), 'both paid providers failing still degrades rather than fails')
  ok(calls.census === 1, 'via one fallback call')
}

/* --- Google alone still works, unchanged --------------------------------- */
{
  const calls = stub({ maptiler: tilerOk(30.3), google: googleOk(30.9), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, { google: 'google-key' })
  ok(calls.maptiler.length === 0, 'a Google-only config never touches MapTiler')
  ok(calls.google.length === 3, 'and Google answers the batch')
  ok(res.every((m) => m.provider === 'google'), 'as before this chain existed')
}

/* --- when nothing can place it ------------------------------------------- */
{
  stub({
    maptiler: tilerNone,
    google: () => ({ status: 'ZERO_RESULTS' }),
    census: (refs) => censusRows(refs, false),
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
    maptiler: () => ({ message: 'quota exceeded' }),
    google: googleOk(30.9),
    census: (refs) => censusRows(refs, false),
  })
  const res = await geocode(ROWS, { maptiler: 'k' })
  ok(
    res.every((m) => m.status === 'error' && /quota/i.test(m.error ?? '')),
    'when both fail, the more specific reason survives — "quota exceeded" beats "not found"',
  )
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocoder selection and fallback are correct')
process.exit(fails.length ? 1 : 0)
