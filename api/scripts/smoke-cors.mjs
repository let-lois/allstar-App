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

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'

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

/* --- one that is not, is refused, and refused *exactly* ------------------ */
//
// A prefix or substring comparison would pass every check above and quietly
// admit `http://localhost:5173.attacker.example`. Three near misses, because
// each is a different way of getting the comparison wrong.
for (const near of [
  'https://localhost:5173',
  'http://localhost:51730',
  'http://localhost:5173.evil.example',
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
  ok(/POST/.test(methods) && /DELETE/.test(methods), 'listing the methods the app uses', methods)
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
