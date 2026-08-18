/**
 * Failures that can be found afterwards.
 *
 * Before this, an error did two things: returned a generic 500 and wrote a stack
 * trace nowhere anybody reads. You learn about an outage from a phone call, and
 * a support message says "it broke" with nothing to search on.
 *
 * These assertions are about traceability, not about causing errors: every
 * response carries an id, the id is readable from a browser, and health can
 * answer "is it failing right now" without a log query.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/* --- every response is identifiable -------------------------------------- */
const health = await fetch(`${BASE}/api/health`)
const id = health.headers.get('x-request-id')
ok(!!id, `a successful response carries a request id (${id})`)
ok(/^[0-9a-f]{8}$/.test(id ?? ''), 'short enough to read aloud, long enough to be unique in a day')

const second = await fetch(`${BASE}/api/health`)
ok(second.headers.get('x-request-id') !== id, 'and a different one each time')

/* --- readable from a browser --------------------------------------------- */
//
// The header can exist and still be invisible to the app: cross-origin
// JavaScript only sees headers a server explicitly exposes, so without this the
// id is returned to nobody.
const cors = await fetch(`${BASE}/api/health`, {
  headers: { origin: 'http://localhost:5173' },
})
ok(
  (cors.headers.get('access-control-expose-headers') ?? '').includes('x-request-id'),
  'the id is exposed to cross-origin JavaScript, not merely present',
)

/* --- errors are identifiable too ----------------------------------------- */
const notFound = await fetch(`${BASE}/api/definitely-not-a-route`, {
  headers: { authorization: 'Bearer nope' },
})
ok(!!notFound.headers.get('x-request-id'), 'a failed response carries one as well')

/* --- health answers "is it broken right now" ----------------------------- */
const body = await (await fetch(`${BASE}/api/health`)).json()
ok(
  typeof body.config?.recentFailures?.count === 'number',
  'health reports a recent failure count',
)
ok(
  body.config.recentFailures.approximate === true,
  'and marks it approximate rather than implying it is authoritative',
)
ok(
  body.config.recentFailures.count === 0,
  `which reads zero on a healthy deployment (${body.config?.recentFailures?.count})`,
)
ok(
  typeof body.config?.migrations?.state === 'string',
  'and reports whether the schema is up to date',
)

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nfailures are traceable')
process.exit(fails.length ? 1 : 0)
