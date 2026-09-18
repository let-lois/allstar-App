import { createServer } from 'node:http'
import { googleReverseGeocode, useGoogleBase } from '../api/src/geocode-google.ts'

/**
 * The address under a point, as the Worker asks for it.
 *
 * This is the map's Add-lead step: a rep taps the house in front of them and
 * the form opens with the address already in it. It runs on the server for the
 * native shell because it cannot run anywhere else — a DOM component's page is
 * loaded from `file://` so it sends no `Referer`, and an HTTP-referrer
 * restriction is the only application restriction the Maps JavaScript API
 * offers. See `googleReverseGeocode`.
 *
 * ## The distinction this gate exists for
 *
 * "Google was asked and there is nothing at that point" and "Google could not
 * be asked" must not look alike, because the client treats them oppositely:
 * the first is cached, the second deliberately is not. Get it the wrong way
 * round and a rep who taps a house while passing through a dead zone leaves
 * that house blank for the rest of their shift — with nothing on screen and
 * nothing in a log to say why.
 *
 * `REQUEST_DENIED` is the case that matters most, and it is also the likeliest:
 * the Geocoding API is a separate switch in the Cloud console from Maps
 * JavaScript and Places, and it is easy to miss when the map itself is plainly
 * working. It has to reach the console with Google's own words, because a
 * revoked key, a disabled API and an exhausted quota all arrive as the same
 * status and only the message tells them apart.
 *
 * Driven against a real HTTP server on localhost rather than a stubbed
 * `fetch`, through the `GOOGLE_GEOCODE_BASE_URL` seam the forward geocoder
 * already uses — so the request shape, the query string and the JSON parsing
 * are the real ones.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/** What the fake Google answers next, and what it was asked. */
let reply = { status: 200, body: {} }
const asked = []

const server = createServer((req, res) => {
  asked.push(req.url)
  res.writeHead(reply.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(reply.body))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/geocode`
useGoogleBase(base)

const AT = { lat: 30.5083, lng: -97.6789 }

/* --- 1. the request Google actually receives ----------------------------- */
{
  reply = {
    status: 200,
    body: {
      status: 'OK',
      results: [
        {
          address_components: [{ types: ['street_number'], long_name: '1302' }],
          geometry: { location_type: 'ROOFTOP' },
        },
      ],
    },
  }
  asked.length = 0
  const got = await googleReverseGeocode(AT, 'test-key')
  const url = asked[0] ?? ''
  ok(url.includes('latlng=30.5083%2C-97.6789'), 'the point is sent as latlng', url.slice(0, 60))
  ok(url.includes('key=test-key'), 'and the key goes with it')
  ok(!url.includes('address='), 'and it is not sent as a forward lookup')

  /* --- 2. the answer is handed on raw ------------------------------------ */
  //
  // Deliberately untouched: `address.ts` on the client already knows which
  // component is a street number, and a second opinion here would diverge from
  // the browser path that reps already use.
  ok(
    Array.isArray(got?.parts) && got.parts[0]?.long_name === '1302',
    'address_components come back exactly as Google sent them',
  )
  ok(got?.locationType === 'ROOFTOP', 'and location_type with them, so the client can judge the text')
}

/* --- 3. nothing there is an answer, and is allowed to be cached ---------- */
{
  reply = { status: 200, body: { status: 'ZERO_RESULTS', results: [] } }
  const got = await googleReverseGeocode(AT, 'test-key')
  ok(got === null, 'ZERO_RESULTS is null — a tap in a field, not a failure')
}

/* --- 4. every other status is a failure, and must throw ------------------ */
//
// The heart of it. A refusal returned as `null` would be cached as "no address
// here" and the house would stay blank for the session.
for (const [status, message] of [
  ['REQUEST_DENIED', 'This API project is not authorized to use this API.'],
  ['OVER_QUERY_LIMIT', 'You have exceeded your daily request quota.'],
  ['INVALID_REQUEST', undefined],
  ['UNKNOWN_ERROR', undefined],
]) {
  reply = { status: 200, body: { status, error_message: message } }
  let threw = null
  try { await googleReverseGeocode(AT, 'test-key') } catch (e) { threw = e }
  ok(threw !== null, `${status} throws rather than reading as "no address here"`)
  if (threw && message) {
    ok(
      threw.message.includes(message),
      `and carries Google's own words, so the right switch gets flipped`,
      threw.message.slice(0, 70),
    )
  }
}

/* --- 5. an HTTP failure is a failure too --------------------------------- */
{
  reply = { status: 503, body: {} }
  let threw = null
  try { await googleReverseGeocode(AT, 'test-key') } catch (e) { threw = e }
  ok(threw !== null && /503/.test(threw.message), 'a 503 from the geocoder throws', threw?.message)
}

/* --- 6. OK with no components is nothing, not a crash ------------------- */
//
// Google has answered OK with a result carrying no `address_components` in the
// wild. Reading `parts` off it unchecked would hand the client `undefined` and
// fail inside the address parser, a long way from here.
{
  reply = { status: 200, body: { status: 'OK', results: [{ geometry: {} }] } }
  const got = await googleReverseGeocode(AT, 'test-key')
  ok(got === null, 'an OK with no address components is nothing rather than a crash')
}

/* --- 7. a coarse answer is NOT discarded here --------------------------- */
//
// Opposite of the forward path, on purpose. Forward, a coarse answer means
// Google failed to parse the address and handed back the middle of a state — a
// pin 300 miles away. Reverse, the coordinates are the rep's own finger and are
// exact by definition, and `location_type` describes only the text. Dropping it
// here would lose the town for a house whose street Google cannot name.
{
  reply = {
    status: 200,
    body: {
      status: 'OK',
      results: [
        {
          address_components: [{ types: ['locality'], long_name: 'Round Rock' }],
          geometry: { location_type: 'APPROXIMATE' },
          types: ['administrative_area_level_1'],
        },
      ],
    },
  }
  const got = await googleReverseGeocode(AT, 'test-key')
  ok(
    got?.locationType === 'APPROXIMATE' && got.parts.length === 1,
    'an approximate answer is kept and flagged, not thrown away as too coarse',
  )
}

server.close()

console.log(
  fails.length
    ? `\n${fails.length} check(s) failed:\n  - ${fails.join('\n  - ')}`
    : '\n=== "could not ask" never reads as "nothing here" ===',
)
process.exit(fails.length ? 1 : 0)
