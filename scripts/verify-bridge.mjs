/**
 * The native API bridge, exercised without a phone.
 *
 * Every screen in the native shell now depends on this one function. The
 * webview is loaded with `loadFileURL`, so its origin is `file://`, every
 * cross-origin request carries `Origin: null`, and the Worker answers a
 * non-allowlisted origin with no CORS headers at all — so without the bridge
 * nothing reaches the API and signing in fails with the right password. That
 * makes it the least testable and most load-bearing code in the project, which
 * is a bad combination to leave to a phone.
 *
 * So the shim is a plain module (`apps/mobile/src/lib/api-bridge.ts`) rather
 * than a closure inside the `'use dom'` component, and this drives it against
 * a fake native side. It is Node's own `fetch`, `Headers` and `Response` —
 * the same WHATWG classes a webview has — so the parts under test are real.
 *
 * This gate earned itself immediately: the first run caught
 * `new Response('', { status: 204 })` throwing `Invalid response status code`,
 * because 204, 205 and 304 are defined as having no body. Nothing returns 204
 * today except the CORS preflight a native fetch never sends, so it was a trap
 * set for whichever endpoint returned one first.
 */
import { installApiProxy } from '../apps/mobile/src/lib/api-bridge.ts'

const API = 'https://api.example.test'
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/** A fake native side: records what it was handed, returns what it is told to. */
function harness(response) {
  const seen = { req: null, browser: [] }
  const target = {
    fetch: async (input) => {
      seen.browser.push(String(input))
      return new Response('from the webview')
    },
  }
  installApiProxy(
    async (req) => {
      seen.req = req
      return response
    },
    API,
    target,
  )
  return { seen, fetch: target.fetch }
}

const text = (body, extra = {}) => ({
  status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
  body, isBase64: false, ...extra,
})

/* --- 1. only the API is diverted ----------------------------------------- */
{
  const h = harness(text('{}'))
  await h.fetch('https://api.maptiler.com/tiles/1/2/3.png')
  ok(h.seen.browser.length === 1, 'a map tile keeps the webview fetch', h.seen.browser[0])
  ok(h.seen.req === null, 'and never crosses the bridge')
  await h.fetch(`${API}/api/health`)
  ok(h.seen.req !== null, 'an API call does cross')
  ok(h.seen.browser.length === 1, 'and does not also hit the webview fetch')
}

/* --- 2. a sign-in survives the crossing ---------------------------------- */
{
  const h = harness(text('{"token":"tok","user":{"name":"Dana"}}'))
  const res = await h.fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer abc' },
    body: JSON.stringify({ email: 'dana@example.test', password: 'secret' }),
  })
  ok(h.seen.req.url === `${API}/api/auth/login`, 'the URL arrives intact')
  ok(h.seen.req.method === 'POST', 'the method arrives')
  ok(h.seen.req.headers.authorization === 'Bearer abc', 'the Authorization header arrives')
  ok(h.seen.req.body === '{"email":"dana@example.test","password":"secret"}',
     'the JSON body arrives as a string')
  ok(res.status === 200, 'the status comes back')
  ok((await res.json()).token === 'tok', 'and the web side can parse the body')
}

/* --- 3. photo bytes round-trip through base64 ---------------------------- */
{
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe])
  const h = harness({
    status: 200, statusText: 'OK', headers: { 'content-type': 'image/jpeg' },
    body: Buffer.from(bytes).toString('base64'), isBase64: true,
  })
  const got = new Uint8Array(await (await h.fetch(`${API}/api/photos/x`)).arrayBuffer())
  ok(got.length === bytes.length && got.every((b, i) => b === bytes[i]),
     'photo bytes survive base64 in both directions', `${got.length} bytes, byte-for-byte`)
}

/* --- 4. the statuses that must not carry a body -------------------------- */
//
// The bug this gate was written around. The bridge always holds a string, so
// an empty one reaching `new Response` on a 204 throws inside `fetch`.
for (const status of [204, 205, 304]) {
  const h = harness(text('', { status, statusText: 'No Content' }))
  let res = null, threw = null
  try { res = await h.fetch(`${API}/api/thing`) } catch (e) { threw = e }
  ok(threw === null && res?.status === status,
     `${status} comes back as a response rather than throwing`,
     threw ? threw.message : `status ${res.status}`)
}

/* --- 5. a body that cannot cross says so --------------------------------- */
{
  const h = harness(text('{}'))
  let threw = null
  try {
    await h.fetch(`${API}/api/x`, { method: 'POST', body: new Blob(['bytes']) })
  } catch (e) { threw = e }
  ok(threw instanceof TypeError && /string body/.test(threw.message),
     'a non-string body throws an explanatory TypeError rather than going out empty')
}

/* --- 6. a Request object, not only a string ------------------------------ */
{
  const h = harness(text('{}'))
  await h.fetch(new Request(`${API}/api/health`, { headers: { 'x-trace': '1' } }))
  ok(h.seen.req?.url === `${API}/api/health`, 'a Request object is unwrapped')
  ok(h.seen.req?.headers['x-trace'] === '1', 'and its headers are read')
}

console.log(
  fails.length
    ? `\n${fails.length} check(s) failed:\n  - ${fails.join('\n  - ')}`
    : '\n=== the native API bridge is sound ===',
)
process.exit(fails.length ? 1 : 0)
