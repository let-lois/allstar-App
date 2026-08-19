/**
 * Which geocoder answers, and what happens when one of them doesn't.
 *
 * `fetch` is stubbed rather than either service being called: this is about the
 * decision logic, and a test that depends on Google being up (and billed) is a
 * test that stops being run. The parsing itself is covered by verify-geocode.
 *
 * The behaviour being pinned is that precision is preferred but never required —
 * an expired key, an exhausted quota or an outage has to degrade the import to
 * the free geocoder, not fail it.
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
function stub({ google, census }) {
  const calls = { google: [], census: 0 }
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
      // The upload is a CSV whose first column is the ref.
      const file = init?.body
      const text = typeof file?.get === 'function' ? await file.get('addressFile').text() : ''
      const refs = text.split('\n').filter(Boolean).map((l) => l.split(',')[0].replace(/"/g, ''))
      return { ok: true, status: 200, text: async () => census(refs) }
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  return calls
}

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

/* --- no key: the free geocoder, and nothing else -------------------------- */
{
  const calls = stub({ google: googleOk(30.3), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS)
  ok(calls.google.length === 0, 'with no key, Google is never called — no key means no bill')
  ok(calls.census === 1, 'Census answers instead, in one batched call')
  ok(res.every((m) => m.status === 'match'), 'and every address is placed')
  ok(
    res.every((m) => m.provider === 'census' && m.precision === 'interpolated'),
    'attributed honestly, without claiming rooftop precision',
  )
}

/* --- key present: precision by default ------------------------------------ */
{
  const calls = stub({ google: googleOk(30.3), census: (refs) => censusRows(refs) })
  const res = await geocode(ROWS, 'test-key')
  ok(calls.google.length === 3, 'with a key, every address goes to Google')
  ok(calls.census === 0, 'and the fallback is not called when nothing needs it')
  ok(
    res.every((m) => m.provider === 'google' && m.precision === 'rooftop'),
    'every result is a rooftop',
  )
}

/* --- one address Google can't place --------------------------------------- */
{
  const calls = stub({
    google: (address) =>
      address.startsWith('2 B') ? { status: 'ZERO_RESULTS' } : googleOk(30.3)(address),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, 'test-key')
  ok(calls.census === 1, 'the free geocoder gets a second look at what Google missed')
  ok(
    calls.google.length === 3,
    'and only the unresolved one is retried — the other two are not re-billed',
  )
  const b = res.find((m) => m.ref === 'b')
  ok(b.status === 'match' && b.provider === 'census', 'the missed address is placed by the fallback')
  ok(
    res.filter((m) => m.provider === 'google').length === 2,
    'while the rest keep their rooftop results',
  )
  ok(res.every((m) => m.status === 'match'), 'so the whole batch lands')
}

/* --- THE case: Google is down or the key has expired ---------------------- */
//
// An import must not fail because a paid dependency did. This is the reason the
// free geocoder is kept rather than deleted once a key exists.
{
  const calls = stub({
    google: () => ({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' }),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, 'expired-key')
  ok(calls.census === 1, 'a dead key sends the whole batch to the fallback')
  ok(res.every((m) => m.status === 'match'), 'and every address still gets placed')
  ok(res.every((m) => m.provider === 'census'), 'on the free geocoder')
}
{
  const calls = stub({
    google: () => ({ httpOk: false }),
    census: (refs) => censusRows(refs),
  })
  const res = await geocode(ROWS, 'test-key')
  ok(res.every((m) => m.status === 'match'), 'an HTTP failure from Google degrades rather than fails')
  ok(calls.census === 1, 'via one fallback call')
}

/* --- when neither can place it -------------------------------------------- */
{
  stub({
    google: () => ({ status: 'ZERO_RESULTS' }),
    census: (refs) => censusRows(refs, false),
  })
  const res = await geocode(ROWS, 'test-key')
  ok(
    res.every((m) => m.status !== 'match'),
    'an address neither can find is reported as unplaced rather than invented',
  )
  ok(res.length === ROWS.length, 'and every row still comes back — none are silently dropped')
}

/* --- a fallback no-match must not overwrite a real reason ----------------- */
{
  stub({
    google: () => ({ status: 'OVER_QUERY_LIMIT', error_message: 'quota exceeded' }),
    census: (refs) => censusRows(refs, false),
  })
  const res = await geocode(ROWS, 'test-key')
  ok(
    res.every((m) => m.status === 'error' && /quota/i.test(m.error ?? '')),
    'when both fail, the more specific reason survives — "quota exceeded" beats "not found"',
  )
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocoder selection and fallback are correct')
process.exit(fails.length ? 1 : 0)
