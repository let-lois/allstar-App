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
 *
 * It also answers "is this even the current version", which was added after a
 * build token belonging to somebody who had left the organisation broke every
 * Worker deploy for nine days. Cloudflare Pages kept deploying, so the front end
 * moved and the API did not, and the only signal was a red checkmark beside a
 * green one — read, reasonably, as noise. A Worker cannot notice it is stale, so
 * something has to say which commit it is.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const api = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

/* --- health answers "which version is this" ------------------------------ */
//
// Two assertions, and they are deliberately about different halves of the same
// chain, because either half can break without the other showing it.
//
// The first is that the stamp reaches the endpoint: whatever `src/version.ts`
// holds is what /api/health reports. Compared against the file on disk rather
// than against `git rev-parse HEAD` — the file is written at install time, so
// after a few commits it is legitimately behind HEAD, and asserting HEAD here
// would fail on a stale install rather than on a broken feature.
//
// The second is that the stamp is reading the right thing, checked by running
// the script in `--print` mode, which writes nothing.
{
  let stamped = null
  try {
    stamped = readFileSync(resolve(api, 'src/version.ts'), 'utf8').match(
      /COMMIT[^=]*=\s*(?:"([0-9a-f]{7,40})"|null)/,
    )?.[1] ?? null
  } catch {
    /* never generated — the assertion below reports it */
  }

  ok(
    body.version !== undefined,
    'health says which version is running, so a stale deploy is visible from outside',
  )
  ok(
    body.version?.commit === stamped,
    `and it is the commit the running bundle was stamped with (${String(body.version?.commit).slice(0, 8)} vs ${String(stamped).slice(0, 8)})`,
  )
  ok(
    typeof body.version?.builtAt === 'string' && !Number.isNaN(Date.parse(body.version.builtAt)),
    'with a build time that parses',
  )
  ok(
    typeof body.version?.dirty === 'boolean',
    'and says whether it was deployed from a dirty tree, so the sha cannot quietly lie',
  )

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: api, encoding: 'utf8' }).trim()
  const printed = execFileSync(
    process.execPath,
    [resolve(api, 'scripts/stamp-version.mjs'), '--print'],
    { cwd: api, encoding: 'utf8' },
  ).trim()
  ok(printed === head, `the stamp reads the current commit (${printed.slice(0, 8)})`)
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nfailures are traceable')
process.exit(fails.length ? 1 : 0)
