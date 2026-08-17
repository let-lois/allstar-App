/**
 * API smoke test.
 *
 * Exercises the contract the offline client depends on, against a running
 * Worker (`wrangler dev --local` by default).
 *
 * The important assertion is idempotency: the client's outbox retries, so the
 * same mutation *will* arrive twice, and the second arrival must change
 * nothing. Everything else here is table stakes; that one is the reason the
 * ledger exists.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const PASSWORD = process.env.SEED_PASSWORD || 'allstar-demo'

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const call = async (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })

/* --- health --------------------------------------------------------------- */
ok((await call('/api/health')).ok, 'health responds')

/* --- auth ----------------------------------------------------------------- */
const bad = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'dana@summitexteriors.com', password: 'wrong' }),
})
ok(bad.status === 401, 'wrong password is rejected')

const ghost = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'nobody@nowhere.com', password: 'wrong' }),
})
ok(ghost.status === 401, 'unknown email is rejected')
ok(
  (await ghost.clone().json()).error === (await bad.clone().json()).error,
  'unknown email and wrong password are indistinguishable',
)

const res = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'dana@summitexteriors.com', password: PASSWORD }),
})
ok(res.ok, 'correct password signs in')
const { token, user } = await res.json()
ok(!!token, 'a session token is issued')
ok(user?.role === 'field_rep', `session carries the role (${user?.role})`)

/* --- authorization -------------------------------------------------------- */
ok((await call('/api/bootstrap')).status === 401, 'bootstrap requires a session')
ok(
  (await call('/api/bootstrap', {}, 'not-a-real-token')).status === 401,
  'a forged token is rejected',
)

const boot = await (await call('/api/bootstrap', {}, token)).json()
ok(Array.isArray(boot.properties), 'bootstrap returns properties')
ok(Array.isArray(boot.dailyStats), 'bootstrap returns reporting history')

/* --- writes: tenant isolation --------------------------------------------- */
const foreign = await (
  await call(
    '/api/mutations',
    {
      method: 'POST',
      body: JSON.stringify({
        mutations: [
          {
            id: `mut_foreign_${Date.now()}`,
            kind: 'note.create',
            createdAt: Date.now(),
            payload: { id: 'n_x', propertyId: 'p_belongs_to_someone_else', body: 'hi' },
          },
        ],
      }),
    },
    token,
  )
).json()
ok(
  foreign.results[0].status === 'rejected',
  'a write against another tenant’s property is rejected',
)

/* --- writes: create a property, then a visit ------------------------------ */
const propId = `p_smoke_${Date.now()}`
const send = (mutations) =>
  call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations }) }, token).then((r) =>
    r.json(),
  )

const createProp = {
  id: `mut_prop_${Date.now()}`,
  kind: 'property.status',
  createdAt: Date.now(),
  payload: { id: propId, created: true, address1: '1 Smoke Test Ln', lat: 30.5, lng: -97.6 },
}
ok((await send([createProp])).results[0].status === 'applied', 'a lead added in the field is created')

const visitId = `v_smoke_${Date.now()}`
const completeVisit = {
  id: `mut_visit_${Date.now()}`,
  kind: 'visit.complete',
  createdAt: Date.now(),
  payload: {
    id: visitId,
    propertyId: propId,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    outcome: 'sold',
    durationMs: 60_000,
  },
}
ok((await send([completeVisit])).results[0].status === 'applied', 'a completed visit is applied')

/* --- THE assertion: replay must be a no-op -------------------------------- */
const replay = await send([completeVisit])
ok(replay.results[0].status === 'duplicate', 'a replayed mutation reports as duplicate')

const after = await (await call('/api/bootstrap', {}, token)).json()
const visitsForProp = after.activity.filter((a) => a.propertyId === propId)
const soldProps = after.properties.filter((p) => p.id === propId && p.status === 'won')
ok(soldProps.length === 1, 'the outcome moved the lead exactly once')

const stat = after.dailyStats.find((s) => s.repId === 'u_rep')
ok(!!stat && stat.knocks >= 1, `reporting roll-up updated (knocks=${stat?.knocks})`)
ok(stat?.sold === 1, `a replayed sale counts once, not twice (sold=${stat?.sold})`)
void visitsForProp

/* --- batch behaviour ------------------------------------------------------ */
const mixed = await send([
  { id: `mut_ok_${Date.now()}`, kind: 'task.create', createdAt: Date.now(), payload: { id: `t_${Date.now()}`, title: 'Smoke task', dueAt: Date.now() } },
  { id: `mut_bad_${Date.now()}`, kind: 'nonsense.kind', createdAt: Date.now(), payload: {} },
])
ok(
  mixed.results[0].status === 'applied' && mixed.results[1].status === 'rejected',
  'one bad mutation does not wedge the rest of the batch',
)

/* --- logout revokes ------------------------------------------------------- */
await call('/api/auth/logout', { method: 'POST' }, token)
ok((await call('/api/bootstrap', {}, token)).status === 401, 'logout revokes the session')

console.log(fails.length ? `\n${fails.length} FAILURES` : '\napi smoke passed')
process.exit(fails.length ? 1 : 0)
