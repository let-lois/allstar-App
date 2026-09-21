/**
 * The allowlist, from the browser's side of the glass.
 *
 * This started as the other half of a client-side fix. When a deployment's
 * address is missing from `ALLOWED_ORIGINS` the API answers every request
 * perfectly and the browser discards every reply, so the app reported a network
 * problem and nobody looked at the configuration for an afternoon. The field
 * app now tells those two apart; these assertions hold up the premise it relies
 * on — that a refused origin is a *served* request, not a failed one — and
 * cover the allowlist itself, which nothing tested until now.
 *
 * Worth stating plainly, because it is easy to over-read: CORS is a rule
 * browsers apply to themselves. `curl` ignores all of this, so none of it is a
 * defence against a script. What it buys is written out at `corsHeaders` in
 * src/index.ts; what it must never become is a wildcard, and that is the one
 * assertion here with teeth.
 */

import { readFileSync } from 'node:fs'

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'

/**
 * Every HTTP method the field app and the console actually send.
 *
 * Read out of the client rather than listed here, because a hand-written list
 * is exactly what failed: this file asserted POST and DELETE, the app grew a
 * PUT (assign a list to a rep) and a PATCH (rename or archive one), and the
 * preflight went on advertising the old pair. The browser refused both, and
 * the app could only report them as a lost connection. Derived, the test
 * tightens by itself the next time somebody adds a method.
 */
const CLIENT_METHODS = (() => {
  const src = readFileSync(new URL('../../src/lib/http.ts', import.meta.url), 'utf8')
  const found = new Set(['GET'])
  for (const m of src.matchAll(/method:\s*'([A-Z]+)'/g)) found.add(m[1])
  return [...found].sort()
})()

// From wrangler.toml's ALLOWED_ORIGINS. The dev server's own address, which is
// why sign-in works locally at all.
const ALLOWED = 'http://localhost:5173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const head = async (origin, method = 'GET') => {
  const res = await fetch(`${BASE}/api/health`, {
    method,
    headers: origin ? { origin } : {},
  })
  return { res, allow: res.headers.get('access-control-allow-origin') }
}

/* --- an address on the list is answered readably ------------------------- */
{
  const { res, allow } = await head(ALLOWED)
  ok(allow === ALLOWED, 'an allowed origin is echoed back exactly', allow ?? '(none)')
  ok(allow !== '*', 'and never as a wildcard')
  ok(
    (res.headers.get('vary') ?? '').toLowerCase().includes('origin'),
    'the reply says it varies by origin, so a cache cannot hand it to another one',
  )
}

/* --- the packaged app, which has no web address -------------------------- */
//
// A shipped iOS or Android build is not served from a website. The same bundle
// is loaded off the device, and the WebView stamps its own scheme on every
// request: `capacitor://localhost` from WKWebView, `https://localhost` from
// Android's. Those are the origins this Worker sees from a phone.
//
// Left off the list it is the silent failure the allowlist already exists to
// prevent, except worse, because the website keeps working: the Worker answers
// every request perfectly, the WebView throws every reply away, and the app can
// only say it lost the connection. Nothing goes red anywhere. Asserted here so
// a shell build cannot ship against a Worker that will not talk to it.
//
// These two exactly, because they are the Capacitor defaults — `iosScheme:
// 'capacitor'` and `androidScheme: 'https'`. A shell that changes either has to
// change ALLOWED_ORIGINS with it.
for (const origin of ['capacitor://localhost', 'https://localhost']) {
  const { allow } = await head(origin)
  ok(allow === origin, `the packaged app is allowed: ${origin}`, allow ?? '(none)')
  // And the preflight, which is the half that fails invisibly: refused there,
  // the browser never sends the real request at all, so the server logs nothing.
  const pre = await head(origin, 'OPTIONS')
  ok(pre.allow === origin, `and its preflight is granted: ${origin}`, pre.allow ?? '(none)')
}

/* --- one that is not, is refused, and refused *exactly* ------------------ */
//
// A prefix or substring comparison would pass every check above and quietly
// admit `http://localhost:5173.attacker.example`. Three near misses, because
// each is a different way of getting the comparison wrong.
for (const near of [
  'https://localhost:5173',
  'http://localhost:51730',
  'http://localhost:5173.evil.example',
  // The native pair has the same near misses, and one of them is a domain
  // anybody can register. `localhost.evil.example` resolves wherever its owner
  // points it, so a prefix comparison would hand the API to a stranger.
  'https://localhost.evil.example',
  'capacitor://localhost.evil.example',
  // Plain http on the default port is nobody's shell — Capacitor has served
  // Android over https since v3. Admitting it would widen the list to every
  // unencrypted local server on the machine for nothing.
  'http://localhost',
]) {
  const { allow } = await head(near)
  ok(!allow, `refused: ${near}`, allow ?? 'no allow-origin header')
}

/* --- and the refusal is the browser's, not the server's ----------------- */
//
// The premise the field app's message now rests on. If a refused origin got a
// 5xx or a dropped connection, "reached the server, but the browser refused its
// reply" would be a lie, and the probe that decides between the two messages
// would have nothing to find.
{
  const { res, allow } = await head('https://not-on-the-list.example')
  ok(!allow, 'a foreign origin gets no allow-origin header')
  ok(res.status === 200, 'yet the request itself is served normally', `status ${res.status}`)
  // Read defensively: when this assertion first failed it was because the
  // server had started returning a 403 with a plain-text body, and `res.json()`
  // threw a parse error over the top of the failure it was meant to describe.
  const body = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    /* left null, and printed below */
  }
  ok(
    parsed !== null && typeof parsed.ok !== 'undefined',
    'body and all — the reply exists, and only the browser throws it away',
    body.slice(0, 60),
  )
}

/* --- preflight agrees with the same list -------------------------------- */
//
// A preflight answered 204 with no headers is the failure that looks like
// nothing: the browser never sends the real request, so the server logs no
// error and the app sees only a rejected promise.
{
  const { res, allow } = await head(ALLOWED, 'OPTIONS')
  ok(res.status === 204, 'a preflight from an allowed origin is answered', `status ${res.status}`)
  ok(allow === ALLOWED, 'with the origin echoed')
  const methods = res.headers.get('access-control-allow-methods') ?? ''
  const headers = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  const advertised = methods.split(',').map((m) => m.trim().toUpperCase())
  const missing = CLIENT_METHODS.filter((m) => !advertised.includes(m))
  ok(
    missing.length === 0,
    `listing every method the client sends (${CLIENT_METHODS.join(', ')})`,
    missing.length ? `missing ${missing.join(', ')} — the browser will refuse those` : methods,
  )
  // Every signed-in call carries both. Omitting either fails the preflight and
  // breaks the whole app while leaving sign-out and health working.
  ok(
    headers.includes('authorization') && headers.includes('content-type'),
    'and the headers every authenticated call sends',
    headers,
  )
}
{
  const { allow } = await head('https://not-on-the-list.example', 'OPTIONS')
  ok(!allow, 'a preflight from anywhere else is not granted')
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the allowlist is exact, and a refusal is still a served reply ===')
