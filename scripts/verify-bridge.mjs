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

/* --- 5. a missing native action names itself ----------------------------- */
//
// Without this the shim would call `undefined(...)`, every request would fail,
// and the web app's own diagnosis would blame the API's allowed-origins list —
// pointing at the wrong console for exactly the fault the bridge exists to fix.
{
  let threw = null
  try {
    installApiProxy(undefined, API, { fetch: async () => new Response('') })
  } catch (e) { threw = e }
  ok(threw instanceof TypeError && /native apiFetch action/.test(threw.message),
     'a missing native action throws at install rather than on every request')
}

/* --- 6. a photo goes UP as well as down ---------------------------------- */
//
// This is the one this gate got wrong the first time. It asserted that a Blob
// body throws, and the comment in the shim claimed nothing sends one — but
// `apiUploadPhoto` in the web app's `http.ts` passes exactly that as `raw`. So
// the gate was locking in a bug: every photo upload threw inside `fetch`.
//
// Bytes chosen to break a naive encoder: a JPEG magic number, a NUL, and bytes
// above 0x7f that do not survive being read as text.
{
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe])
  const h = harness(text('{"ok":true}'))
  await h.fetch(`${API}/api/photos/x`, {
    method: 'POST',
    body: new Blob([bytes], { type: 'image/jpeg' }),
  })
  ok(h.seen.req?.isBase64 === true, 'a Blob body is flagged as base64')
  const sent = Buffer.from(h.seen.req?.body ?? '', 'base64')
  ok(
    sent.length === bytes.length && [...sent].every((b, i) => b === bytes[i]),
    'and arrives byte-for-byte',
    `${sent.length} bytes`,
  )
}

/* --- 6b. a typed array onto part of a bigger buffer --------------------- */
//
// A `Uint8Array` can be a window onto a larger buffer. Base64'ing the whole
// buffer would upload whatever else is in it alongside the photo — a real
// disclosure, not just a wrong length.
{
  const backing = new Uint8Array([0, 0, 0, 0xca, 0xfe, 0xba, 0xbe, 0, 0])
  const view = backing.subarray(3, 7)
  const h = harness(text('{}'))
  await h.fetch(`${API}/api/photos/y`, { method: 'POST', body: view })
  const sent = Buffer.from(h.seen.req?.body ?? '', 'base64')
  ok(
    sent.length === 4 && [...sent].every((b, i) => b === view[i]),
    'a typed array is carried as its own window, not its whole backing buffer',
    `${sent.length} bytes, expected 4`,
  )
}

/* --- 6c. text bodies are still text ------------------------------------- */
//
// Base64 on every JSON body would be waste on the hot path, and would also
// hide a mistake: if this came back flagged, everything would still work and
// every request would be a third larger.
{
  const h = harness(text('{}'))
  await h.fetch(`${API}/api/x`, { method: 'POST', body: '{"a":1}' })
  ok(h.seen.req?.body === '{"a":1}' && !h.seen.req?.isBase64, 'a string body crosses as text')

  const h2 = harness(text('{}'))
  await h2.fetch(`${API}/api/x`, { method: 'POST', body: new URLSearchParams({ a: '1' }) })
  ok(h2.seen.req?.body === 'a=1' && !h2.seen.req?.isBase64, 'and so does URLSearchParams')
}

/* --- 6d. a body that genuinely cannot cross says so --------------------- */
//
// FormData would need a multipart boundary decided on the wrong side of the
// bridge. Nothing sends one — but a body that silently goes out empty comes
// back as a puzzling 400, so it has to name itself.
{
  const h = harness(text('{}'))
  let threw = null
  try {
    const form = new FormData()
    form.append('a', '1')
    await h.fetch(`${API}/api/x`, { method: 'POST', body: form })
  } catch (e) { threw = e }
  ok(
    threw instanceof TypeError && /FormData/.test(threw.message),
    'a FormData body throws an explanatory TypeError rather than going out empty',
  )
}

/* --- 7. a Request object, not only a string ------------------------------ */
{
  const h = harness(text('{}'))
  await h.fetch(new Request(`${API}/api/health`, { headers: { 'x-trace': '1' } }))
  ok(h.seen.req?.url === `${API}/api/health`, 'a Request object is unwrapped')
  ok(h.seen.req?.headers['x-trace'] === '1', 'and its headers are read')
}

/* --- 7b. installing twice replaces, and does not stack ------------------- */
//
// The shell installs in the component body rather than an effect — it has to,
// because React renders a parent before its children and an effect would run
// after the first request had already gone out through the browser. The cost is
// that the DOM root re-renders whenever the native side emits props, so this
// runs again.
//
// It used to wrap whatever was in `target.fetch` at the time, which on a second
// call is the *previous proxy*. So each install retained the one before it and
// every request that is not the API — which means every map tile, the hot path
// while a rep pans — walked the whole chain first. Measured at two shim frames
// per install before the fix.
{
  let depth = 0
  const real = async () => {
    depth = (new Error().stack.match(/api-bridge/g) || []).length
    return new Response('webview')
  }
  const send = async () => text('{}')

  const seen = []
  for (const n of [1, 2, 10]) {
    const t = { fetch: real }
    for (let i = 0; i < n; i++) installApiProxy(send, API, t)
    await t.fetch('https://tiles.example.test/1.png')
    seen.push({ n, depth })
  }
  ok(
    seen.every((s) => s.depth === seen[0].depth),
    'a tile request costs the same however many times the proxy was installed',
    seen.map((s) => `${s.n}× install → ${s.depth} frame(s)`).join(', '),
  )

  // And the thing it is proxying still works after a re-install.
  const t = { fetch: real }
  installApiProxy(send, API, t)
  installApiProxy(send, API, t)
  const res = await t.fetch(`${API}/api/x`)
  ok(res.status === 200, 'and the API still crosses the bridge after a re-install')
}

/* --- 8. the caller's deadline is honoured -------------------------------- */
//
// `request()` in the web app gives every call a deadline — 20s normally, 45s
// for a photo down, 60s for one up — and arms it with `signal`. A signal is a
// live object and cannot cross a JSON bridge, so the shim used to drop it: none
// of those deadlines existed on a phone, and a stalled cellular request hung
// the screen forever instead of failing. It must reject with the same
// `AbortError` a browser raises, because `answeredButBlocked` in `http.ts`
// branches on that name to avoid calling a timeout a CORS problem.
{
  // A native side that never answers, which is the case worth testing.
  const target = { fetch: async () => new Response('') }
  installApiProxy(() => new Promise(() => {}), API, target)

  const ctrl = new AbortController()
  const call = target.fetch(`${API}/api/slow`, { signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 20)
  let threw = null
  try { await call } catch (e) { threw = e }
  ok(
    threw?.name === 'AbortError',
    'an aborted request rejects rather than hanging forever',
    threw ? `${threw.name}: ${threw.message}` : 'it resolved or hung',
  )
}

/* --- 8b. a signal already aborted before the call ----------------------- */
//
// `AbortSignal` fires `abort` once. Subscribing to a signal that has already
// fired waits for an event that will never come, so the pre-aborted case has to
// be checked separately or it hangs — the exact bug being fixed, reintroduced
// at the other end.
{
  const target = { fetch: async () => new Response('') }
  installApiProxy(() => new Promise(() => {}), API, target)
  let threw = null
  try {
    await target.fetch(`${API}/api/slow`, { signal: AbortSignal.abort() })
  } catch (e) { threw = e }
  ok(threw?.name === 'AbortError', 'a signal that was already aborted rejects immediately')
}

/* --- 8c. and an unaborted signal does not interfere --------------------- */
{
  const h = harness(text('{"fine":true}'))
  const res = await h.fetch(`${API}/api/x`, { signal: new AbortController().signal })
  ok((await res.json()).fine === true, 'a signal that never fires leaves the response alone')
}

console.log(
  fails.length
    ? `\n${fails.length} check(s) failed:\n  - ${fails.join('\n  - ')}`
    : '\n=== the native API bridge is sound ===',
)
process.exit(fails.length ? 1 : 0)
