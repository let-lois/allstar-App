/**
 * Account management — passwords, access, deletion.
 *
 * Most of these assertions are about what the API *refuses*. Every operation
 * here can lock a company out of its own account or destroy its reporting
 * history, and the interesting question is never "does the happy path work" —
 * it's whether the last administrator can delete themselves at 6pm on a Friday.
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

const login = (email, password) =>
  api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

const adminRes = await login(ADMIN.email, ADMIN.password)
if (!adminRes.ok) {
  console.error(`\nCould not sign in as ${ADMIN.email}. Run \`npm run smoke:onboarding\` first.`)
  process.exit(1)
}
const admin = await adminRes.json()
const stamp = Date.now()

/* --- a rep to manage ------------------------------------------------------ */
const REP = { email: `manage-${stamp}@example.com`, name: 'Managed Rep', password: 'manage-password-1' }
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
const repSession = await (await login(REP.email, REP.password)).json()
const roster = await (await api('/api/users', {}, admin.token)).json()
const repId = roster.users.find((u) => u.email === REP.email).id

const call = (path, opts = {}, token = admin.token) =>
  api(path, opts, token).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))

/* --- who may do any of this ---------------------------------------------- */
ok(
  (await call(`/api/users/${admin.user.id}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: 'a-rep-should-not-manage-admins' }),
  }, repSession.token)).status === 403,
  'a field rep cannot set anyone’s password',
)
ok(
  (await call(`/api/users/${admin.user.id}`, { method: 'DELETE' }, repSession.token)).status === 403,
  'a field rep cannot delete an account',
)
ok(
  (await call('/api/users/u_from_another_company/password', {
    method: 'POST',
    body: JSON.stringify({ password: 'not-my-tenant-at-all' }),
  })).status === 404,
  'a user in another tenant reads as not found, not as forbidden — existence is not leaked',
)

/* --- setting a password --------------------------------------------------- */
ok(
  (await call(`/api/users/${repId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: 'short' }),
  })).status === 400,
  'a too-short password is refused',
)

const NEW_PASSWORD = 'admin-chose-this-one'
ok(
  (await call(`/api/users/${repId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: NEW_PASSWORD }),
  })).status === 200,
  'an admin can set a rep’s password',
)
ok((await login(REP.email, NEW_PASSWORD)).ok, 'the rep can sign in with the new password')
ok(!(await login(REP.email, REP.password)).ok, 'the old password stops working')

/* --- THE assertion: a reset must end the sessions it replaces ------------ */
//
// This is the whole reason an admin resets a password: a phone went missing in
// a customer's hedge. If the session on that phone survives, the reset achieved
// nothing at all.
ok(
  (await api('/api/bootstrap', {}, repSession.token)).status === 401,
  'the session held before the reset is dead — a lost phone loses access immediately',
)

/* --- a reset link the admin never reads ---------------------------------- */
const linkRes = await call(`/api/users/${repId}/reset-link`, { method: 'POST' })
ok(linkRes.status === 200 && !!linkRes.body.url, 'an admin can create a reset link')
const CHOSEN = 'the-rep-chose-this-one'
await fetch(linkRes.body.url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: CHOSEN }),
})
const chosen = await login(REP.email, CHOSEN)
ok(chosen.ok, 'the rep sets their own password through the link')
ok(!(await login(REP.email, NEW_PASSWORD)).ok, 'the password the admin set no longer works')
const repSession2 = await chosen.json()

/* --- access -------------------------------------------------------------- */
ok(
  (await call(`/api/users/${repId}/active`, { method: 'POST', body: JSON.stringify({ active: false }) }))
    .status === 200,
  'an admin can deactivate a rep',
)
ok(!(await login(REP.email, CHOSEN)).ok, 'a deactivated rep cannot sign in')
ok(
  (await api('/api/bootstrap', {}, repSession2.token)).status === 401,
  'deactivating ends the session they are holding right now',
)
ok(
  (await call(`/api/users/${repId}/active`, { method: 'POST', body: JSON.stringify({ active: true }) }))
    .status === 200,
  'access can be restored',
)
ok((await login(REP.email, CHOSEN)).ok, 'and they keep the password they chose')

/* --- the footguns -------------------------------------------------------- */
ok(
  (await call(`/api/users/${admin.user.id}/active`, {
    method: 'POST',
    body: JSON.stringify({ active: false }),
  })).status === 400,
  'an admin cannot deactivate their own account',
)
ok(
  (await call(`/api/users/${admin.user.id}`, { method: 'DELETE' })).status === 400,
  'an admin cannot delete their own account',
)

// Promote nobody: this admin is the only one. Deleting the last administrator
// leaves a tenant nobody can administer.
const second = { email: `admin2-${stamp}@example.com`, name: 'Second Admin', password: 'second-admin-pass' }
const inv2 = await (
  await api(
    '/api/invites',
    { method: 'POST', body: JSON.stringify({ email: second.email, name: second.name, role: 'client_admin' }) },
    admin.token,
  )
).json()
await fetch(inv2.url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: second.password }),
})
const admin2 = await (await login(second.email, second.password)).json()
const roster2 = await (await api('/api/users', {}, admin.token)).json()
const admin2Id = roster2.users.find((u) => u.email === second.email).id

// With two admins, one can be removed.
ok(
  (await call(`/api/users/${admin2Id}/active`, {
    method: 'POST',
    body: JSON.stringify({ active: false }),
  }, admin.token)).status === 200,
  'one of two admins can be deactivated',
)
ok(
  (await api('/api/bootstrap', {}, admin2.token)).status === 401,
  'the deactivated admin’s session dies with the switch',
)

/*
  The invariant that matters is that a tenant can never end up with nobody who
  can administer it. Two rules hold it: an admin cannot act on their own account,
  and the last administrator cannot be removed — the second expressed as part of
  the write rather than a check before it, so two admins deactivating each other
  at the same moment cannot both slip through.

  Which is why there is no direct test for a 400 here: with the self-rule in
  place, the only actor who could target the last admin is that admin. So the
  property is asserted instead — after all of the above, the tenant still has a
  working administrator.
*/
const stillAdmin = await login(ADMIN.email, ADMIN.password)
ok(stillAdmin.ok, 'the tenant still has an administrator who can sign in')
ok(
  (await api('/api/users', {}, (await stillAdmin.json()).token)).status === 200,
  'and who can still administer it',
)

/* --- the footprint, before the fact -------------------------------------- */
const foot = await call(`/api/users/${repId}/footprint`)
ok(foot.status === 200, 'the footprint of a delete can be counted first')
ok(
  typeof foot.body.visits === 'number' && typeof foot.body.assignedProperties === 'number',
  'it reports what would be destroyed and what would survive',
)

/* --- delete --------------------------------------------------------------- */
// Give the rep a lead first, to prove leads outlive the person holding them.
const propId = `p_owned_${stamp}`
await api(
  '/api/mutations',
  {
    method: 'POST',
    body: JSON.stringify({
      mutations: [
        {
          id: `mut_own_${stamp}`,
          kind: 'property.status',
          createdAt: Date.now(),
          payload: { id: propId, created: true, address1: `1 Owned Way ${stamp}`, lat: 30.5, lng: -97.6 },
        },
      ],
    }),
  },
  admin.token,
).then((r) => r.json())
await call('/api/territories/assign', {
  method: 'POST',
  body: JSON.stringify({ territoryId: null, repId }),
})

ok((await call(`/api/users/${repId}`, { method: 'DELETE' })).status === 200, 'a rep can be deleted')
ok(!(await login(REP.email, CHOSEN)).ok, 'a deleted account cannot sign in')
const rosterAfter = await (await api('/api/users', {}, admin.token)).json()
ok(
  !rosterAfter.users.some((u) => u.id === repId),
  'and they are gone from the roster',
)

// The leads must not go with them — ON DELETE SET NULL, not CASCADE.
const boot = await (await api('/api/bootstrap', {}, admin.token)).json()
const survived = boot.properties.find((p) => p.id === propId)
ok(!!survived, 'leads survive the deletion of the rep who held them')
ok(
  !survived?.assignedRepId,
  'and fall back to unassigned rather than pointing at a person who no longer exists',
)

/* --- a rep manages their own password, without an admin ------------------ */
//
// Routing every forgotten password through the office is a support call for
// something the rep can do on a doorstep in ten seconds.
{
  const SELF = { email: `selfserve-${stamp}@example.com`, name: 'Self Serve', password: 'first-password-here' }
  const inv = await (
    await api(
      '/api/invites',
      { method: 'POST', body: JSON.stringify({ email: SELF.email, name: SELF.name, role: 'field_rep' }) },
      admin.token,
    )
  ).json()
  await fetch(inv.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: SELF.password }),
  })
  const me = await (await login(SELF.email, SELF.password)).json()

  const CHANGED = 'i-changed-it-myself'
  ok(
    (await call(`/api/users/${me.user.id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: CHANGED }),
    }, me.token)).status === 200,
    'a rep can change their own password',
  )
  const after = await login(SELF.email, CHANGED)
  ok(after.ok, 'and the new one works')

  // A fresh session, because changing a password revokes every session that
  // user holds — including the one that made the change. Reusing the old token
  // here would test the revocation, not the permission.
  const me2 = await after.json()
  ok(
    (await api('/api/bootstrap', {}, me.token)).status === 401,
    'the session that changed the password is itself revoked',
  )

  // Self-service must not become a way around the permission model.
  const other = await (await api('/api/users', {}, admin.token)).json()
  const someoneElse = other.users.find((u) => u.email === ADMIN.email).id
  ok(
    (await call(`/api/users/${someoneElse}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'trying-to-take-over' }),
    }, me2.token)).status === 403,
    'but not anyone else’s — self-service is not a permission escalation',
  )
  ok(
    (await call(`/api/users/${someoneElse}`, { method: 'DELETE' }, me2.token)).status === 403,
    'and still cannot delete anybody',
  )
}

/* --- sign-in is rate limited --------------------------------------------- */
//
// Hashing is slow, which raises the cost of a guess but does not bound the
// total. An attacker gets unlimited attempts and this Worker pays CPU for every
// one of them.
{
  const TARGET = { email: `ratelimit-${stamp}@example.com`, name: 'Rate Limited', password: 'the-real-password' }
  const inv = await (
    await api(
      '/api/invites',
      { method: 'POST', body: JSON.stringify({ email: TARGET.email, name: TARGET.name, role: 'field_rep' }) },
      admin.token,
    )
  ).json()
  await fetch(inv.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: TARGET.password }),
  })

  let blockedAt = null
  for (let i = 1; i <= 12; i++) {
    const res = await login(TARGET.email, `wrong-guess-${i}`)
    if (res.status === 429) {
      blockedAt = i
      ok(!!res.headers.get('retry-after'), 'a blocked attempt says when to try again')
      const body = await res.json()
      ok(body.code === 'rate_limited', 'and is distinguishable from a wrong password')
      break
    }
  }
  ok(blockedAt !== null, `repeated wrong passwords are eventually refused (blocked at attempt ${blockedAt})`)
  ok(blockedAt <= 10, `the limit bites before it costs much (attempt ${blockedAt})`)

  // The correct password is refused too while blocked — otherwise the limit is
  // trivially bypassed by the very thing it's protecting.
  ok(
    (await login(TARGET.email, TARGET.password)).status === 429,
    'the block holds even for the correct password',
  )

  // But it must be per-account, not global: one rep locking themselves out
  // cannot take the rest of the company down with them.
  ok(
    (await login(ADMIN.email, ADMIN.password)).ok,
    'another account signs in normally — the limit is per account, not global',
  )
}

/* --- a successful sign-in clears the count ------------------------------- */
{
  const CLEAN = { email: `clears-${stamp}@example.com`, name: 'Clears', password: 'clean-password-here' }
  const inv = await (
    await api(
      '/api/invites',
      { method: 'POST', body: JSON.stringify({ email: CLEAN.email, name: CLEAN.name, role: 'field_rep' }) },
      admin.token,
    )
  ).json()
  await fetch(inv.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: CLEAN.password }),
  })

  for (let i = 0; i < 5; i++) await login(CLEAN.email, 'nope')
  ok((await login(CLEAN.email, CLEAN.password)).ok, 'a correct password still works below the limit')
  // Having proved who they are, the count must not still be primed against them.
  for (let i = 0; i < 5; i++) await login(CLEAN.email, 'nope')
  ok(
    (await login(CLEAN.email, CLEAN.password)).ok,
    'a successful sign-in resets the count rather than leaving it primed',
  )
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nuser management smoke passed')
process.exit(fails.length ? 1 : 0)
