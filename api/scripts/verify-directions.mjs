/**
 * The one walking route the Worker will fetch.
 *
 * `fetch` is stubbed rather than Routes API being called: this is about what the
 * endpoint accepts, what it refuses, and how it reads a response — and a test
 * that spends routing quota per run is a test somebody switches off.
 *
 * Three things are pinned here.
 *
 * **What it refuses.** This endpoint spends the account's money, and every input
 * it accepts is an input somebody authenticated but bored can spend it on. Bad
 * coordinates, an unknown travel mode and an absurd distance are all rejected
 * *before* a request is made, which is the only refusal that actually saves
 * anything.
 *
 * **The field mask.** Routes API requires one, and it is also the cost control —
 * asking for everything moves the request into a dearer tier. So the mask is
 * asserted, not assumed.
 *
 * **The duration parse.** Google returns a protobuf duration string, "372s", not
 * a number. Read straight into arithmetic it becomes NaN, and a walking time of
 * NaN minutes reaches a rep before anyone notices.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'dir-')), 'directions.mjs')
await build({
  entryPoints: ['src/directions.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
})
const { directions } = await import(out)

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const ENV = { GOOGLE_MAPS_API_KEY: 'test-routing-key' }
/** Round Rock to a door about 600m away. */
const FROM = { lat: 30.5083, lng: -97.6789 }
const TO = { lat: 30.5121, lng: -97.6752 }

let calls = []
function stub(handler) {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(init)
  }
}
const routeOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    routes: [
      {
        distanceMeters: 812,
        duration: '641s',
        polyline: { encodedPolyline: 'ay~vHkjqRnBuC|@sA' },
      },
    ],
  }),
})

/* --- the happy path ------------------------------------------------------- */
{
  stub(routeOk)
  const res = await directions(ENV, { from: FROM, to: TO, mode: 'WALK' })
  ok(res.ok, 'a valid request returns a route')
  ok(res.leg?.distanceMeters === 812, `the real road distance comes through (${res.leg?.distanceMeters}m)`)
  ok(
    res.leg?.seconds === 641,
    `the protobuf duration "641s" is parsed to a number (${res.leg?.seconds})`,
  )
  ok(
    Number.isFinite(res.leg?.seconds),
    'and it is finite — read naively this field becomes NaN minutes on a rep’s screen',
  )
  ok(res.leg?.polyline === 'ay~vHkjqRnBuC|@sA', 'the encoded polyline is passed through untouched')

  const sent = JSON.parse(calls[0].init.body)
  ok(sent.travelMode === 'WALK', 'the travel mode is sent as asked')
  ok(
    sent.origin.location.latLng.latitude === FROM.lat &&
      sent.destination.location.latLng.longitude === TO.lng,
    'origin and destination are not transposed — the classic lat/lng swap',
  )
  ok(
    calls[0].init.headers['x-goog-api-key'] === 'test-routing-key',
    'the key travels in the header, not the URL, so it stays out of logs',
  )
  const mask = calls[0].init.headers['x-goog-fieldmask']
  ok(
    mask === 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    `the field mask asks for exactly three fields, which is the cost control (${mask})`,
  )
  ok(!/\*/.test(mask), 'and never a wildcard, which is the expensive tier')
}

/* --- driving asks for traffic, walking does not --------------------------- */
{
  stub(routeOk)
  await directions(ENV, { from: FROM, to: TO, mode: 'DRIVE' })
  ok(
    JSON.parse(calls[0].init.body).routingPreference === 'TRAFFIC_AWARE',
    'driving asks for a traffic-aware route',
  )
  stub(routeOk)
  await directions(ENV, { from: FROM, to: TO, mode: 'WALK' })
  ok(
    JSON.parse(calls[0].init.body).routingPreference === undefined,
    'and walking does not, because it is meaningless on foot',
  )
}

/* --- what it refuses, before spending anything ---------------------------- */
{
  const bad = [
    [{ from: FROM }, 'a missing destination'],
    [{ from: FROM, to: { lat: 'x', lng: 2 } }, 'a non-numeric coordinate'],
    [{ from: FROM, to: { lat: 200, lng: 2 } }, 'an impossible latitude'],
    [{ from: FROM, to: TO, mode: 'TELEPORT' }, 'an unknown travel mode'],
    [{ from: FROM, to: { lat: 51.5, lng: -0.12 } }, 'a route across an ocean'],
  ]
  for (const [body, what] of bad) {
    stub(routeOk)
    const res = await directions(ENV, body)
    ok(!res.ok, `${what} is refused`)
    ok(calls.length === 0, `  ...and costs nothing — no request was made`)
  }
}

/* --- no key configured ---------------------------------------------------- */
{
  stub(routeOk)
  const res = await directions({}, { from: FROM, to: TO })
  ok(!res.ok && res.status === 503, 'with no key it reports unconfigured rather than crashing')
  ok(calls.length === 0, 'and makes no request')
}

/* --- the provider says no ------------------------------------------------- */
{
  stub(() => ({ ok: false, status: 403, text: async () => 'PERMISSION_DENIED: Routes API' }))
  const res = await directions(ENV, { from: FROM, to: TO })
  ok(!res.ok, 'a rejected request fails rather than returning an empty route')
  ok(
    /403/.test(res.error) && /Routes API/.test(res.error),
    `and carries the provider's own words, which is what makes it diagnosable (${res.error?.slice(0, 60)})`,
  )
}
{
  // A 200 with no route: there is genuinely no walkable path. An answer, not a
  // failure, and the client draws the direct line instead of nothing.
  stub(() => ({ ok: true, status: 200, json: async () => ({ routes: [] }) }))
  const res = await directions(ENV, { from: FROM, to: TO })
  ok(!res.ok && res.status === 404, 'no available route is reported as not-found, not as an error')
}
{
  stub(() => {
    throw new Error('network down')
  })
  const res = await directions(ENV, { from: FROM, to: TO })
  ok(!res.ok && /network down/.test(res.error), 'a thrown fetch is caught and named')
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nthe directions endpoint is correct')
process.exit(fails.length ? 1 : 0)
