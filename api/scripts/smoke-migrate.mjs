/**
 * Self-applying migrations.
 *
 * Run against a database that has the *original* schema only — no
 * `login_attempts`, no `audit_log`. If the Worker cannot bring it up to date on
 * its own, the features that depend on those tables are silently dead on any
 * deployment where somebody forgot to paste the DDL.
 *
 * Which is the whole point: the failure this prevents is invisible. The deploy
 * succeeds, the API answers, and one feature just doesn't work.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const health = await (await fetch(`${BASE}/api/health`)).json()

ok(health.ok, 'the API answers')
ok(
  health.config?.migrations?.state === 'ok',
  `migrations applied themselves on first request (state=${health.config?.migrations?.state})`,
)
ok(
  health.config?.migrations?.error === null,
  `and reported no error (${health.config?.migrations?.error})`,
)

/* --- the tables the migrations create are actually usable ---------------- */
//
// Asserted through behaviour rather than by inspecting the schema: a table that
// exists but isn't reachable from the code is no better than a missing one.

// login_attempts — repeated failures must eventually be refused.
let limited = false
for (let i = 0; i < 12; i++) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@migration.test', password: `guess-${i}` }),
  })
  if (res.status === 429) {
    limited = true
    break
  }
}
ok(limited, 'rate limiting works, so login_attempts was created and is being written')

// audit_log — needs an admin, so this only runs where one exists.
const admin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.ADMIN_EMAIL || 'owner@example.com',
    password: process.env.ADMIN_PASSWORD || 'correct-horse-battery',
  }),
})
if (admin.ok) {
  const { token } = await admin.json()
  const res = await fetch(`${BASE}/api/audit`, { headers: { authorization: `Bearer ${token}` } })
  ok(res.ok, 'the audit log is readable, so audit_log was created')
  ok(Array.isArray((await res.json()).entries), 'and returns entries')
} else {
  console.log('SKIP  audit read — no administrator on this database yet')
}

/* --- running twice changes nothing --------------------------------------- */
const again = await (await fetch(`${BASE}/api/health`)).json()
ok(again.config?.migrations?.state === 'ok', 'a second request finds nothing left to do')

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nmigrations apply themselves')
process.exit(fails.length ? 1 : 0)
