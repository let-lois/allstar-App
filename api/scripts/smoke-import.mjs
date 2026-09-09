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

/* --- a rep plans a route over their imported leads ------------------------ */
const routeId = `route_smoke_${stamp}`
const routeMut = (mutId, stops) => ({
  id: mutId,
  kind: 'route.create',
  createdAt: Date.now(),
  payload: { id: routeId, date: new Date().toISOString().slice(0, 10), name: 'Import Test Way', stops },
})
const send = (mutations, token) =>
  api('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations }) }, token).then((r) =>
    r.json(),
  )

const allStops = mine.map((p, i) => ({ propertyId: p.id, order: i, status: i === 0 ? 'active' : 'pending' }))
ok(
  (await send([routeMut(`mut_route_${stamp}`, allStops)], rep.token)).results[0].status === 'applied',
  'a rep can plan a route over their leads',
)

const withRoute = await (await api('/api/bootstrap', {}, rep.token)).json()
const saved = withRoute.routes.find((r) => r.id === routeId)
ok(!!saved, 'the route comes back in the rep’s bootstrap')
ok(saved?.stops?.length === 3, `every stop was stored (${saved?.stops?.length})`)
ok(
  saved?.stops?.every((s, i) => s.order === i),
  'stop order survives the round trip — a shuffled route is a route nobody follows',
)
ok(saved?.stops?.filter((s) => s.status === 'active').length === 1, 'exactly one stop comes back active')

// Re-planning the day must replace the route, not accumulate stops beside it.
ok(
  (await send([routeMut(`mut_route2_${stamp}`, allStops.slice(0, 2))], rep.token)).results[0].status ===
    'applied',
  're-planning the same day is accepted',
)
const replanned = await (await api('/api/bootstrap', {}, rep.token)).json()
const after = replanned.routes.find((r) => r.id === routeId)
ok(
  after?.stops?.length === 2,
  `re-planning replaces the stops rather than appending to them (${after?.stops?.length})`,
)

// A route is a list of this company's doors.
const foreignRoute = await send(
  [routeMut(`mut_route_bad_${stamp}`, [{ propertyId: 'p_another_tenant', order: 0, status: 'pending' }])],
  rep.token,
)
ok(
  foreignRoute.results[0].status === 'rejected',
  'a route referencing another tenant’s property is rejected',
)

/* --- territory assignment ------------------------------------------------- */
const assign = (body, token = admin.token) =>
  api('/api/territories/assign', { method: 'POST', body: JSON.stringify(body) }, token).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  )

const repId = roster.users.find((u) => u.email === REP.email).id

// Unassign the whole territory, then give it back — the round trip is what
// proves assignment is a real edit and not a one-way door.
const cleared = await assign({ territoryId: first.territoryId, repId: null })
ok(cleared.body.assigned === 3, `a territory can be unassigned (${cleared.body.assigned})`)
const afterClear = await (await api('/api/bootstrap', {}, rep.token)).json()
ok(
  afterClear.properties.filter((p) => p.address1.includes(street)).length === 0,
  'an unassigned rep stops seeing the leads — scoping is enforced on the server',
)

const given = await assign({ territoryId: first.territoryId, repId })
ok(given.body.assigned === 3, `a territory can be assigned to a rep (${given.body.assigned})`)
const afterGive = await (await api('/api/bootstrap', {}, rep.token)).json()
ok(
  afterGive.properties.filter((p) => p.address1.includes(street)).length === 3,
  'the rep sees the leads again once assigned',
)

// The unassigned bucket has to be addressable, or a plain import is
// unassignable except by re-importing.
const loose = `p_loose_${stamp}`
await send([
  {
    id: `mut_loose_${stamp}`,
    kind: 'property.status',
    createdAt: Date.now(),
    payload: { id: loose, created: true, address1: `9 Loose End ${stamp}`, lat: 30.5, lng: -97.6 },
  },
], admin.token)
await assign({ territoryId: null, repId: null })
const bucket = await assign({ territoryId: null, repId })
ok(
  bucket.body.assigned >= 1,
  `leads with no territory can be assigned as a bucket (${bucket.body.assigned})`,
)

/* --- and the boundaries it must not cross -------------------------------- */
ok(
  (await assign({ territoryId: first.territoryId, repId: 'u_from_another_company' })).status === 400,
  'assigning to somebody outside the tenant is refused',
)
ok(
  (await assign({ territoryId: 'terr_belongs_to_someone_else', repId })).status === 404,
  'assigning another tenant’s territory is refused',
)
ok(
  (await assign({ territoryId: first.territoryId, repId }, rep.token)).status === 403,
  'a field rep cannot reassign territory to themselves',
)

/* --- moving individual leads --------------------------------------------- */
//
// Territory assignment covers handing over a patch. What comes up daily is
// smaller: a rep is off sick, one street belongs with the next patch over.
const pick = mine.slice(0, 2).map((p) => p.id)
const assignSome = (body, token = admin.token) =>
  api('/api/properties/assign', { method: 'POST', body: JSON.stringify(body) }, token).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  )

const moved = await assignSome({ propertyIds: pick, repId: null })
ok(moved.body.assigned === 2, `named leads can be unassigned (${moved.body.assigned})`)
const afterMove = await (await api('/api/bootstrap', {}, rep.token)).json()
ok(
  afterMove.properties.filter((p) => p.address1.includes(street)).length === 1,
  'the rep keeps only the lead that was left with them',
)

ok((await assignSome({ propertyIds: pick, repId })).body.assigned === 2, 'and can be handed back')

/* --- and the boundaries ---------------------------------------------------- */
ok(
  (await assignSome({ propertyIds: [], repId })).status === 400,
  'an empty selection is refused rather than reported as a no-op success',
)
ok(
  (await assignSome({ propertyIds: pick, repId: 'u_from_another_company' })).status === 400,
  'assigning selected leads to somebody outside the tenant is refused',
)
ok(
  (await assignSome({ propertyIds: pick, repId }, rep.token)).status === 403,
  'a field rep cannot move leads to themselves',
)
{
  // An id from another tenant must match nothing rather than be trusted — the
  // client_id predicate is what enforces that, not a lookup.
  const res = await assignSome({ propertyIds: ['p_belongs_to_someone_else'], repId })
  ok(
    res.status === 200 && res.body.assigned === 0,
    `another tenant's property id changes nothing (${res.body.assigned})`,
  )
}
ok(
  (await assignSome({
    propertyIds: Array.from({ length: 501 }, (_, i) => `p_${i}`),
    repId,
  })).status === 413,
  'an oversized selection is refused, not truncated',
)

/* --- leads land in the patch they fall inside ------------------------------ */
//
// The gap this closes: before it, an import assigned a territory only if the
// operator typed one for the whole file, so every lead arrived unowned and
// somebody assigned them by hand. The geometry itself is gated separately —
// `npm run verify:geo-parity` at the repo root — so what is checked here is the
// wiring: that the import consults the drawn shapes at all, who inherits the
// rep, and what an explicit choice still overrides.
{
  const patchRep = roster.users.find((u) => u.email === REP.email).id

  // A city-wide patch with a downtown one carved out of it. Overlap is the
  // normal case, and the specific patch has to win.
  /*
    Each run gets its own corner of the map.

    The first version of this reused fixed coordinates, so a second run against
    the same database matched leads against the *previous* run's patches — the
    counts looked right and the ids were wrong, which is exactly the kind of
    green-but-meaningless a smoke test is supposed to avoid. Offsetting by the
    run's stamp keeps every run's geometry disjoint from every other's.
  */
  const off = ((stamp / 1000) % 40) * 0.5

  const created = async (body) =>
    (await (await api('/api/territories', { method: 'POST', body: JSON.stringify(body) }, admin.token)).json())
      .territory ?? {}

  const city = await created({
        name: `Geo City ${stamp}`,
        repId: null,
        boundary: [
          { lat: 30.40, lng: -97.80 - off },
          { lat: 30.40, lng: -97.50 - off },
          { lat: 30.70, lng: -97.50 - off },
          { lat: 30.70, lng: -97.80 - off },
        ],
  })
  const downtown = await created({
        name: `Geo Downtown ${stamp}`,
        repId: patchRep,
        boundary: [
          { lat: 30.50, lng: -97.70 - off },
          { lat: 30.50, lng: -97.66 - off },
          { lat: 30.53, lng: -97.66 - off },
          { lat: 30.53, lng: -97.70 - off },
        ],
  })
  ok(!!city.id && !!downtown.id, 'two overlapping territories exist to match against')

  const geoStreet = `Geo Match Way ${stamp}`
  const geoRows = [
    // Inside both patches — belongs to the smaller one.
    { ref: 'G1', address1: `1 ${geoStreet}`, lat: 30.51, lng: -97.68 - off },
    // Inside the city patch only.
    { ref: 'G2', address1: `2 ${geoStreet}`, lat: 30.60, lng: -97.55 - off },
    // Nowhere near either.
    { ref: 'G3', address1: `3 ${geoStreet}`, lat: 41.88, lng: -87.63 },
    // No coordinates at all — nothing to match, and not the territories' fault.
    { ref: 'G4', address1: `4 ${geoStreet}` },
  ]

  const geo = await imp({ rows: geoRows })
  ok(geo.created === 4, `all four rows imported (created=${geo.created})`)
  ok(geo.territoryMatched === 2, `two leads found a patch (matched=${geo.territoryMatched})`)
  ok(
    geo.territoryUnmatched === 1,
    `one lead with coordinates found none (unmatched=${geo.territoryUnmatched})`,
  )

  const boot = await (await api('/api/bootstrap', {}, admin.token)).json()
  const byRef = (n) => boot.properties.find((p) => p.address1 === `${n} ${geoStreet}`)

  ok(byRef(1)?.territoryId === downtown.id, 'a lead inside both patches goes to the smaller one')
  ok(byRef(2)?.territoryId === city.id, 'a lead inside one patch goes there')
  ok(!byRef(3)?.territoryId, 'a lead outside every patch is left unassigned, not pushed into one')
  ok(!byRef(4)?.territoryId, 'a lead with no coordinates cannot be matched and is not guessed at')

  // The part that removes the manual work: the patch's rep comes with it.
  ok(
    byRef(1)?.assignedRepId === patchRep,
    'and it inherits that territory\'s rep, so the lead arrives owned',
  )
  ok(
    !byRef(2)?.assignedRepId,
    'a patch with nobody assigned still leaves the lead unowned — it does not invent an owner',
  )

  /* --- an explicit choice still wins --------------------------------------- */
  const namedStreet = `Geo Named Way ${stamp}`
  const named = await imp({
    rows: [{ ref: 'N1', address1: `1 ${namedStreet}`, lat: 30.51, lng: -97.68 - off }],
    territoryName: `Geo Explicit ${stamp}`,
  })
  ok(
    named.territoryMatched === 0,
    'naming a territory skips matching entirely rather than competing with it',
  )
  const boot2 = await (await api('/api/bootstrap', {}, admin.token)).json()
  const namedLead = boot2.properties.find((p) => p.address1 === `1 ${namedStreet}`)
  ok(
    namedLead?.territoryId === named.territoryId && namedLead.territoryId !== downtown.id,
    'a lead sitting inside a drawn patch still goes to the territory the operator typed',
  )
}

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

/* --- the geocoder's verdict survives the save ------------------------------ */
//
// The geocoders have always reported how well they know a position, the import
// preview has always shown it, and it was dropped on the way into the database —
// so every pin then rendered with identical confidence and a rep walked to an
// estimate drawn like a certainty.
//
// Four rows, because the interesting cases are what happens to the values
// nobody validated: a real verdict, a different real verdict, an invented one,
// and none at all.
{
  const pStreet = `Precision Row ${stamp}`
  const res = await imp({
    rows: [
      { ref: 'P1', address1: `1 ${pStreet}`, lat: 30.51, lng: -97.68, precision: 'rooftop', geoProvider: 'google' },
      { ref: 'P2', address1: `2 ${pStreet}`, lat: 30.52, lng: -97.68, precision: 'interpolated', geoProvider: 'census' },
      // Not a value any geocoder can return. This one decides how confident the
      // map looks about a house, so an importer claiming 'exact' must not have
      // that rendered as certainty.
      { ref: 'P3', address1: `3 ${pStreet}`, lat: 30.53, lng: -97.68, precision: 'exact', geoProvider: 'x' },
      { ref: 'P4', address1: `4 ${pStreet}`, lat: 30.54, lng: -97.68 },
    ],
  })
  ok(res.created === 4, `four rows imported (created=${res.created})`)

  const boot = await (await api('/api/bootstrap', {}, admin.token)).json()
  const at = (n) => boot.properties.find((p) => p.address1 === `${n} ${pStreet}`)

  ok(at(1)?.geoPrecision === 'rooftop', 'a rooftop match reaches the device as rooftop', at(1)?.geoPrecision)
  ok(
    at(2)?.geoPrecision === 'interpolated',
    'and an interpolated one is not quietly upgraded',
    at(2)?.geoPrecision,
  )
  ok(
    at(3)?.geoPrecision === undefined,
    'a precision no geocoder can report is refused rather than stored',
    String(at(3)?.geoPrecision),
  )
  ok(
    at(4)?.geoPrecision === undefined,
    'and a row that never claimed one stays unknown, not "approximate"',
    String(at(4)?.geoPrecision),
  )

  /*
    A re-import with no coordinates must not erase what we knew.

    Coordinates already survive this — the upsert only overwrites lat/lng when
    the incoming pair is non-zero — and precision describes those coordinates,
    so it has to survive under exactly the same condition. Taking the new file's
    silence as "unknown" would blank the verdict on every lead in any vendor
    file that happens to omit coordinates.

    The re-import repeats the address *exactly*. A lead's id is derived from
    address1 plus city, state and zip, so adding or changing any of those makes
    a different id and a second lead — which is how the first version of this
    case fooled itself: it added a city, the import created a new row beside the
    old one, and the assertion read the untouched original and reported that the
    verdict had survived. The refreshed field is `roofAgeYears`, which is not
    part of the key, and the row count below is what would catch a repeat.
  */
  await imp({ rows: [{ ref: 'P1', address1: `1 ${pStreet}`, roofAgeYears: 17 }] })
  const after = await (await api('/api/bootstrap', {}, admin.token)).json()
  const all = after.properties.filter((p) => p.address1 === `1 ${pStreet}`)
  ok(all.length === 1, 'the re-import updated the lead rather than creating a second', `${all.length} rows`)
  const kept = all[0]
  ok(kept?.geoPrecision === 'rooftop', 'a re-import carrying no coordinates keeps the old verdict', kept?.geoPrecision)
  ok(kept?.roofAgeYears === 17, 'while still refreshing what it did carry', String(kept?.roofAgeYears))
}

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
