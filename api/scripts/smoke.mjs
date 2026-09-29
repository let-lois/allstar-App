/**
 * API smoke test — the write path.
 *
 * Exercises the contract the offline client depends on, against a running
 * Worker (`wrangler dev --local` by default).
 *
 * Self-bootstrapping: it creates its own rep through the real invite flow
 * rather than depending on hand-seeded rows, so there is no fixture to keep in
 * sync and it can run against any environment that has an administrator.
 * Run `npm run smoke:onboarding` first on a fresh database to create one.
 *
 * The assertion that matters is idempotency. The client's outbox retries, so
 * the same mutation *will* arrive twice, and the second arrival must change
 * nothing. Everything else is table stakes; that one is why the ledger exists.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'owner@example.com',
  password: process.env.ADMIN_PASSWORD || 'correct-horse-battery',
}

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const api = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })

/* --- health --------------------------------------------------------------- */
ok((await api('/api/health')).ok, 'health responds')

/* --- bootstrap a rep for this run ----------------------------------------- */
const adminRes = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })
if (!adminRes.ok) {
  console.error(
    `\nCould not sign in as ${ADMIN.email}. Run \`npm run smoke:onboarding\` against a fresh` +
      ` database first, or set ADMIN_EMAIL / ADMIN_PASSWORD.`,
  )
  process.exit(1)
}
const admin = await adminRes.json()

const stamp = Date.now()
const REP = { email: `smoke-${stamp}@example.com`, name: 'Smoke Rep', password: 'smoke-password-1' }

const invite = await (
  await api(
    '/api/invites',
    { method: 'POST', body: JSON.stringify({ email: REP.email, name: REP.name, role: 'field_rep' }) },
    admin.token,
  )
).json()
ok(!!invite.url, 'a rep can be invited for this run')

await fetch(invite.url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: REP.password, confirm: REP.password }),
})

/* --- auth ----------------------------------------------------------------- */
const bad = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: REP.email, password: 'wrong' }),
})
ok(bad.status === 401, 'wrong password is rejected')

const ghost = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'nobody@nowhere.example', password: 'wrong' }),
})
ok(ghost.status === 401, 'unknown email is rejected')
ok(
  (await ghost.json()).error === (await bad.json()).error,
  'unknown email and wrong password are indistinguishable',
)

const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(REP) })
ok(res.ok, 'correct password signs in')
const { token, user } = await res.json()
ok(!!token, 'a session token is issued')
ok(user?.role === 'field_rep', `session carries the role (${user?.role})`)

/* --- authorization -------------------------------------------------------- */
ok((await api('/api/bootstrap')).status === 401, 'bootstrap requires a session')
ok((await api('/api/bootstrap', {}, 'not-a-real-token')).status === 401, 'a forged token is rejected')

const boot = await (await api('/api/bootstrap', {}, token)).json()
ok(Array.isArray(boot.properties), 'bootstrap returns properties')
ok(Array.isArray(boot.dailyStats), 'bootstrap returns reporting history')

/* --- writes --------------------------------------------------------------- */
const send = (mutations) =>
  api('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations }) }, token).then((r) =>
    r.json(),
  )

const foreign = await send([
  {
    id: `mut_foreign_${stamp}`,
    kind: 'note.create',
    createdAt: Date.now(),
    payload: { id: 'n_x', propertyId: 'p_belongs_to_someone_else', body: 'hi' },
  },
])
ok(foreign.results[0].status === 'rejected', 'a write against another tenant’s property is rejected')

const propId = `p_smoke_${stamp}`
ok(
  (
    await send([
      {
        id: `mut_prop_${stamp}`,
        kind: 'property.status',
        createdAt: Date.now(),
        payload: {
          id: propId, created: true, address1: '1 Smoke Test Ln', lat: 30.5, lng: -97.6,
          contacts: [{ id: `ct_smoke_${stamp}`, name: 'Pat Homeowner', phone: '512-555-0100', isPrimary: true }],
        },
      },
    ])
  ).results[0].status === 'applied',
  'a lead added in the field is created',
)
{
  // The homeowner typed at the door must reach the office, not stay on the phone.
  const made = (await (await api('/api/bootstrap', {}, token)).json()).properties.find((p) => p.id === propId)
  ok(made?.address1 === '1 Smoke Test Ln' && made?.lat === 30.5, 'with the address and the pin the rep saved', `${made?.address1} @ ${made?.lat}`)
  ok(made?.contacts?.[0]?.name === 'Pat Homeowner' && made?.contacts?.[0]?.phone === '512-555-0100', 'and the contact they typed', JSON.stringify(made?.contacts))

  // Corrected at the door: the number off the house, and a second phone number.
  const fix = await send([{
    id: `mut_fix_${stamp}`, kind: 'property.update', createdAt: Date.now(),
    payload: {
      id: propId, address1: '1B Smoke Test Ln', city: 'Round Rock', state: 'TX', zip: '78664',
      contacts: [{ id: `ct_smoke_${stamp}`, name: 'Pat Homeowner-Reyes', phone: '512-555-0199', email: 'pat@example.com', isPrimary: true }],
    },
  }])
  ok(fix.results[0].status === 'applied', 'a rep can correct the details of their own lead', fix.results[0].error)
  const fixed = (await (await api('/api/bootstrap', {}, token)).json()).properties.find((p) => p.id === propId)
  ok(fixed?.address1 === '1B Smoke Test Ln' && fixed?.zip === '78664', 'the address is corrected on the server', `${fixed?.address1} ${fixed?.zip}`)
  ok(fixed?.contacts?.length === 1 && fixed?.contacts?.[0]?.email === 'pat@example.com' && fixed?.contacts?.[0]?.phone === '512-555-0199', 'and the contact is updated in place, not duplicated', JSON.stringify(fixed?.contacts))
  ok(fixed?.status === 'new', 'while the status, which follows from a visit, is untouched', fixed?.status)

  // What the rep wrote reaches the office: a note rides bootstrap now.
  const noted = await send([{
    id: `mut_note_${stamp}`, kind: 'note.create', createdAt: Date.now(),
    payload: { id: `n_smoke_${stamp}`, propertyId: propId, body: 'Dog in yard, knock on side door', tags: ['homeowner'] },
  }])
  ok(noted.results[0].status === 'applied', 'a rep leaves a note')
  const office = await (await api('/api/bootstrap', {}, admin.token)).json()
  const seen = (office.notes ?? []).find((n) => n.id === `n_smoke_${stamp}`)
  ok(!!seen && seen.body === 'Dog in yard, knock on side door' && seen.authorId === user.id && seen.propertyId === propId, 'and the office reads it in its own bootstrap, signed by the rep', JSON.stringify(seen))
  ok(Array.isArray(seen?.tags) && seen.tags[0] === 'homeowner', 'tags and all')
}

const completeVisit = {
  id: `mut_visit_${stamp}`,
  kind: 'visit.complete',
  createdAt: Date.now(),
  payload: {
    id: `v_smoke_${stamp}`,
    propertyId: propId,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    outcome: 'sold',
    durationMs: 60_000,
  },
}
ok((await send([completeVisit])).results[0].status === 'applied', 'a completed visit is applied')

/* --- THE assertion: replay must be a no-op -------------------------------- */
ok((await send([completeVisit])).results[0].status === 'duplicate', 'a replayed mutation reports as duplicate')

const after = await (await api('/api/bootstrap', {}, token)).json()
ok(
  after.properties.filter((p) => p.id === propId && p.status === 'won').length === 1,
  'the outcome moved the lead exactly once',
)

// The feed is what a manager reads to see the day happening, and it has to
// survive the phone re-bootstrapping — the client's local copy of this event is
// wiped by every refresh, so the server has to hold its own.
const visitEvents = after.activity.filter(
  (a) => a.propertyId === propId && a.type === 'visit',
)
ok(visitEvents.length === 1, `the visit appears once in the activity feed (${visitEvents.length})`)
ok(visitEvents[0]?.outcome === 'sold', 'the feed entry carries the outcome')

const stat = after.dailyStats.find((s) => s.repId === user.id)
ok(!!stat && stat.knocks === 1, `reporting counted one knock, not two (knocks=${stat?.knocks})`)
ok(stat?.sold === 1, `a replayed sale counts once (sold=${stat?.sold})`)

/* --- batch behaviour ------------------------------------------------------ */
const mixed = await send([
  {
    id: `mut_ok_${stamp}`,
    kind: 'task.create',
    createdAt: Date.now(),
    payload: { id: `t_${stamp}`, title: 'Smoke task', dueAt: Date.now() },
  },
  { id: `mut_bad_${stamp}`, kind: 'nonsense.kind', createdAt: Date.now(), payload: {} },
])
ok(
  mixed.results[0].status === 'applied' && mixed.results[1].status === 'rejected',
  'one bad mutation does not wedge the rest of the batch',
)

/* --- logout revokes ------------------------------------------------------- */
await api('/api/auth/logout', { method: 'POST' }, token)
ok((await api('/api/bootstrap', {}, token)).status === 401, 'logout revokes the session')

console.log(fails.length ? `\n${fails.length} FAILURES` : '\napi smoke passed')
process.exit(fails.length ? 1 : 0)
