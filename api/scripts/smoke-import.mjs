/**
 * Lead import — end to end against a running Worker and D1.
 *
 * The assertion that matters most here isn't "did rows arrive". It's what happens
 * on the **second** import.
 *
 * Real lead lists get re-imported constantly: a vendor sends a refreshed file, a
 * manager isn't sure the first upload worked, someone's connection drops halfway.
 * If a re-import resets status, a lead a rep sold last week silently becomes a
 * fresh door and gets knocked again. That's not a cosmetic bug — it's lost
 * commission and an annoyed customer, and nothing anywhere throws an error.
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

const adminRes = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })
if (!adminRes.ok) {
  console.error(`\nCould not sign in as ${ADMIN.email}. Run \`npm run smoke:onboarding\` first.`)
  process.exit(1)
}
const admin = await adminRes.json()
const stamp = Date.now()

/* --- a rep to assign to --------------------------------------------------- */
const REP = { email: `import-rep-${stamp}@example.com`, name: 'Import Rep', password: 'import-password-1' }
const invite = await (
  await api(
    '/api/invites',
    { method: 'POST', body: JSON.stringify({ email: REP.email, name: REP.name, role: 'field_rep' }) },
    admin.token,
  )
).json()
await fetch(invite.url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: REP.password }),
})
const rep = await (
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify(REP) })
).json()

/* --- the roster ----------------------------------------------------------- */
const roster = await (await api('/api/users', {}, admin.token)).json()
ok(Array.isArray(roster.users), 'the console can read the team roster')
ok(
  roster.users.some((u) => u.email === REP.email && u.role === 'field_rep'),
  'the new rep is on the roster',
)
ok(
  (await api('/api/users', {}, rep.token)).status === 403,
  'a field rep cannot read the roster — colleagues’ accounts are not their business',
)

/* --- the import ----------------------------------------------------------- */
const street = `Import Test Way ${stamp}`
const rows = [
  { ref: 'L2', address1: `100 ${street}`, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51, lng: -97.68, ownerName: 'Ada Reyes', phone: '512-555-0101' },
  { ref: 'L3', address1: `102 ${street}`, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5101, lng: -97.6801 },
  { ref: 'L4', address1: `104 ${street}`, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5102, lng: -97.6802 },
  // Same house as L2 spelled differently — a vendor list with one row per owner.
  { ref: 'L5', address1: `100 ${street}.`, city: 'ROUND ROCK', state: 'tx', zip: '78664', lat: 30.51, lng: -97.68 },
  { ref: 'L6', address1: '', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51, lng: -97.68 },
]

const imp = (body, token = admin.token) =>
  api('/api/import/properties', { method: 'POST', body: JSON.stringify(body) }, token).then((r) =>
    r.json(),
  )

const first = await imp({
  rows,
  assignRepId: roster.users.find((u) => u.email === REP.email).id,
  territoryName: `Import Territory ${stamp}`,
})

ok(first.created === 3, `three distinct addresses were created (created=${first.created})`)
ok(first.updated === 0, 'nothing was updated on a first import')
ok(
  first.rejected.some((r) => r.ref === 'L5' && /duplicate/i.test(r.reason)),
  'a repeated address inside one file is rejected, not imported twice',
)
ok(
  first.rejected.some((r) => r.ref === 'L6' && /address/i.test(r.reason)),
  'a row with no street address is rejected with a reason',
)
ok(!!first.territoryId, 'the named territory was created')

/* --- the rep can see their leads ------------------------------------------ */
const repBoot = await (await api('/api/bootstrap', {}, rep.token)).json()
const mine = repBoot.properties.filter((p) => p.address1.includes(street))
ok(mine.length === 3, `the assigned rep sees the imported leads (${mine.length})`)
ok(
  mine.every((p) => p.lat !== 0 && p.lng !== 0),
  'coordinates survived the round trip — a lead at 0,0 is invisible on a map',
)
const withOwner = mine.find((p) => p.address1.startsWith(`100 `))
ok(
  withOwner?.contacts?.some((c) => c.name === 'Ada Reyes' && c.phone === '512-555-0101'),
  'the owner became a contact the rep can call',
)
ok(mine.every((p) => p.status === 'new'), 'imported leads start as new')

/* --- THE assertion: a re-import must not undo the field's work ------------ */
//
// Sell one of them, then import the identical file again.
const soldAddress = mine[0]
await api(
  '/api/mutations',
  {
    method: 'POST',
    body: JSON.stringify({
      mutations: [
        {
          id: `mut_sold_${stamp}`,
          kind: 'visit.complete',
          createdAt: Date.now(),
          payload: {
            id: `v_sold_${stamp}`,
            propertyId: soldAddress.id,
            startedAt: Date.now() - 60_000,
            endedAt: Date.now(),
            outcome: 'sold',
            durationMs: 60_000,
          },
        },
      ],
    }),
  },
  rep.token,
).then((r) => r.json())

const beforeSecond = await (await api('/api/bootstrap', {}, rep.token)).json()
ok(
  beforeSecond.properties.find((p) => p.id === soldAddress.id)?.status === 'won',
  'the lead is marked won after the sale',
)

const second = await imp({
  rows,
  assignRepId: roster.users.find((u) => u.email === REP.email).id,
  territoryName: `Import Territory ${stamp}`,
})
ok(second.created === 0, `re-importing creates nothing (created=${second.created})`)
ok(second.updated === 3, `re-importing updates in place (updated=${second.updated})`)

const afterSecond = await (await api('/api/bootstrap', {}, rep.token)).json()
const soldAfter = afterSecond.properties.find((p) => p.id === soldAddress.id)
ok(
  soldAfter?.status === 'won',
  `a re-import did NOT reset the sold lead to new (status=${soldAfter?.status})`,
)
ok(!!soldAfter?.lastVisitAt, 'the visit history survived the re-import')
ok(
  afterSecond.properties.filter((p) => p.address1.includes(street)).length === 3,
  'the territory did not double in size',
)

/* --- the same territory name is reused, not duplicated -------------------- */
ok(second.territoryId === first.territoryId, 'importing into an existing territory reuses it')

/* --- authorization -------------------------------------------------------- */
ok(
  (
    await api(
      '/api/import/properties',
      { method: 'POST', body: JSON.stringify({ rows: [rows[1]] }) },
      rep.token,
    )
  ).status === 403,
  'a field rep cannot import — that is an office action',
)
ok(
  (await imp({ rows: [rows[1]], assignRepId: 'u_someone_elses_rep' })).error !== undefined,
  'assigning to a user outside the tenant is refused',
)
ok((await imp({ rows: [] })).error !== undefined, 'an empty import is refused rather than reported as success')

/* --- the size ceiling ----------------------------------------------------- */
const tooMany = Array.from({ length: 501 }, (_, i) => ({
  ref: `X${i}`,
  address1: `${i} Overflow Ln ${stamp}`,
  lat: 30.5,
  lng: -97.6,
}))
ok((await imp({ rows: tooMany })).error !== undefined, 'a batch over the ceiling is refused, not truncated')

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nimport smoke passed')
process.exit(fails.length ? 1 : 0)
