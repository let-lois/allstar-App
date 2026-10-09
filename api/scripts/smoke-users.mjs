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
  body: new URLSearchParams({ password: REP.password, confirm: REP.password }),
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
    body: JSON.stringify({ password: 'a-rep-should-not-manage-admins', confirm: 'a-rep-should-not-manage-admins' }),
  }, repSession.token)).status === 403,
  'a field rep cannot set anyone’s password',
)
ok(
  (await call(`/api/users/${admin.user.id}`, { method: 'DELETE' }, repSession.token)).status === 403,
  'a field rep cannot delete an account',
)
ok(
  (await call('/api/users/u_from_another_company/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-my-tenant@example.com' }),
  })).status === 404,
  'a user in another tenant reads as not found, not as forbidden — existence is not leaked',
)

/* --- an admin never sets somebody else's password ------------------------- */
//
// The admin's tool is a reset email (smoke-user-admin drives it against a
// stand-in mail provider). Typing a password for somebody else is refused
// outright, whatever it is, and changes nothing.
{
  const refused = await call(`/api/users/${repId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-chose-this-one', confirm: 'admin-chose-this-one' }),
  })
  ok(refused.status === 403 && refused.body.code === 'not_self', 'an admin cannot set a rep’s password', `${refused.status} ${refused.body.code}`)
  ok(/reset email/i.test(refused.body.error ?? ''), 'and is pointed at the reset email instead')
  ok(!(await login(REP.email, 'admin-chose-this-one')).ok, 'the password the admin typed does not work')
  ok((await login(REP.email, REP.password)).ok, 'and the rep’s own password is untouched')
}
{
  // This smoke runs without an email provider: the honest answer is that a
  // reset email cannot be sent, not a promise that one was.
  const r = await call(`/api/users/${repId}/reset-email`, { method: 'POST' })
  ok(r.status === 501 && r.body.code === 'mail_not_configured', 'with no email set up, a reset email is refused rather than promised', `${r.status} ${r.body.code}`)
  ok(!('url' in r.body) && !JSON.stringify(r.body).includes('/invite/'), 'and no link comes back to the admin either way')
}

/* --- the rep changes their own ------------------------------------------- */
ok(
  (await call(`/api/users/${repId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: 'short', confirm: 'short' }),
  }, repSession.token)).status === 400,
  'a too-short password is refused',
)

const CHOSEN = 'the-rep-chose-this-one'
ok(
  (await call(`/api/users/${repId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password: CHOSEN, confirm: CHOSEN }),
  }, repSession.token)).status === 200,
  'a rep can change their own password',
)
const chosen = await login(REP.email, CHOSEN)
ok(chosen.ok, 'the rep can sign in with the new password')
ok(!(await login(REP.email, REP.password)).ok, 'the old password stops working')

/* --- THE assertion: a change must end the sessions it replaces ----------- */
//
// This is the whole reason a password is changed in a hurry: a phone went
// missing in a customer's hedge. If the session on that phone survives, the
// change achieved nothing at all.
ok(
  (await api('/api/bootstrap', {}, repSession.token)).status === 401,
  'the session held before the change is dead — a lost phone loses access immediately',
)
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
  body: new URLSearchParams({ password: second.password, confirm: second.password }),
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
    body: new URLSearchParams({ password: SELF.password, confirm: SELF.password }),
  })
  const me = await (await login(SELF.email, SELF.password)).json()

  const CHANGED = 'i-changed-it-myself'
  ok(
    (await call(`/api/users/${me.user.id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: CHANGED, confirm: CHANGED }),
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
      body: JSON.stringify({ password: 'trying-to-take-over', confirm: 'trying-to-take-over' }),
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
    body: new URLSearchParams({ password: TARGET.password, confirm: TARGET.password }),
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
    body: new URLSearchParams({ password: CLEAN.password, confirm: CLEAN.password }),
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

/* --- role changes --------------------------------------------------------- */
{
  const R = { email: `roles-${stamp}@example.com`, name: 'Role Target', password: 'role-target-pass' }
  const inv = await (
    await api('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ email: R.email, name: R.name, role: 'field_rep' }),
    }, admin.token)
  ).json()
  await fetch(inv.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: R.password, confirm: R.password }),
  })
  const theirs = await (await login(R.email, R.password)).json()
  const list = await (await api('/api/users', {}, admin.token)).json()
  const rid = list.users.find((u) => u.email === R.email).id

  ok(
    (await call(`/api/users/${rid}/role`, { method: 'POST', body: JSON.stringify({ role: 'manager' }) }))
      .status === 200,
    'an admin can promote a rep to manager',
  )
  const promoted = await (await api('/api/users', {}, admin.token)).json()
  ok(
    promoted.users.find((u) => u.id === rid).role === 'manager',
    'and the change sticks',
  )
  ok(
    (await api('/api/bootstrap', {}, theirs.token)).status === 401,
    'their session is revoked — a demotion takes effect on the phone in their hand',
  )

  ok(
    (await call(`/api/users/${rid}/role`, { method: 'POST', body: JSON.stringify({ role: 'wizard' }) }))
      .status === 400,
    'an unknown role is refused',
  )
  ok(
    (await call(`/api/users/${admin.user.id}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'field_rep' }),
    })).status === 400,
    'an admin cannot change their own role — that is a lockout or an escalation',
  )

  const back = await (await login(R.email, R.password)).json()
  ok(
    (await call(`/api/users/${admin.user.id}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'field_rep' }),
    }, back.token)).status === 403,
    'a manager cannot change anybody’s role',
  )
}

/* --- the audit log -------------------------------------------------------- */
//
// The point of this table is the conversation that starts "I never did that",
// so the assertions are about whether the record survives and whether it says
// enough to settle the argument.
{
  const audit = await (await api('/api/audit?limit=200', {}, admin.token)).json()
  const actions = audit.entries.map((e) => e.action)

  ok(actions.includes('user.invited'), 'invites are recorded')
  ok(actions.includes('user.password_set'), 'password changes are recorded')
  ok(actions.includes('user.deactivated'), 'removals are recorded')
  ok(actions.includes('user.deleted'), 'deletions are recorded')
  ok(actions.includes('user.role_changed'), 'role changes are recorded')
  ok(actions.includes('territory.assigned'), 'lead assignment is recorded')

  const del = audit.entries.find((e) => e.action === 'user.deleted')
  ok(!!del?.actorName, 'a deletion names who did it')
  ok(
    del?.targetLabel === 'Managed Rep',
    `and names who it was done to, after that account no longer exists (${del?.targetLabel})`,
  )
  ok(!!del?.detail?.email, 'with enough detail to identify them later')

  const selfChange = audit.entries.find((e) => e.action === 'user.password_set' && e.detail?.self)
  const adminChange = audit.entries.find(
    (e) => e.action === 'user.password_set' && e.detail?.self === false,
  )
  ok(!!selfChange, 'a self-service change is marked as one')
  ok(
    !!adminChange,
    'and an admin setting someone else’s password is distinguishable from it',
  )

  ok(
    audit.entries.every((e, i) => i === 0 || audit.entries[i - 1].at >= e.at),
    'entries come back newest first',
  )

  /* ---- who may read it ---- */
  const anyRep = await (await login(`selfserve-${stamp}@example.com`, 'i-changed-it-myself')).json()
  ok(
    (await api('/api/audit', {}, anyRep.token)).status === 403,
    'a rep cannot read the audit log',
  )
  ok((await api('/api/audit')).status === 401, 'and neither can an anonymous caller')

  // There is no way to remove an entry. A log the accused can edit is not
  // evidence, and the person most likely to want a row gone is its subject.
  ok(
    (await api('/api/audit', { method: 'DELETE' }, admin.token)).status === 404,
    'there is no endpoint that deletes from the log',
  )
  const stillThere = await (await api('/api/audit?limit=200', {}, admin.token)).json()
  ok(
    stillThere.entries.length >= audit.entries.length,
    'and the log only grows',
  )
}

/* --- client settings ------------------------------------------------------ */
//
// The rule these assertions exist to protect: codes are structural, labels are
// not. A company renaming an outcome is changing a word on a button; it must not
// be able to change what a year of reporting means.
{
  const settings = (body, token = admin.token) =>
    api('/api/settings', { method: 'POST', body: JSON.stringify({ settings: body }) }, token).then(
      async (r) => ({ status: r.status, body: await r.json() }),
    )

  const saved = await settings({
    outcomes: [
      { code: 'quote_requested', label: 'Estimate requested', order: 0 },
      { code: 'sold', label: 'Closed', order: 1 },
    ],
    noteTemplates: ['Wants an estimate', 'Come back Saturday'],
    photoCategories: [{ key: 'roof', label: 'Roofline' }],
  })
  ok(saved.status === 200, 'an admin can save settings')
  ok(
    saved.body.settings.outcomes.find((o) => o.code === 'sold')?.label === 'Closed',
    'a relabelled outcome comes back relabelled',
  )

  const boot = await (await api('/api/bootstrap', {}, admin.token)).json()
  ok(!!boot.settings, 'settings ride along with bootstrap, so an offline phone has them')
  ok(
    boot.settings.noteTemplates?.[0] === 'Wants an estimate',
    'including the note templates',
  )

  /* ---- what must be refused ---- */
  const junk = await settings({
    outcomes: [
      { code: 'not_a_real_code', label: 'Invented' },
      { code: 'sold', label: 'Won' },
      // A duplicate would render the same button twice.
      { code: 'sold', label: 'Won again' },
    ],
    noteTemplates: ['ok', '', '   ', 42, null],
    photoCategories: [{ key: 'nonsense', label: 'Nope' }],
  })
  ok(
    !junk.body.settings.outcomes.some((o) => o.code === 'not_a_real_code'),
    'an invented outcome code is dropped, not stored — codes are structural',
  )
  ok(
    junk.body.settings.outcomes.filter((o) => o.code === 'sold').length === 1,
    'a duplicated code is collapsed rather than rendering the same button twice',
  )
  ok(
    junk.body.settings.noteTemplates.length === 1,
    `empty and non-string templates are dropped (${junk.body.settings.noteTemplates.length} kept)`,
  )
  ok(
    !junk.body.settings.photoCategories.some((c) => c.key === 'nonsense'),
    'an unknown photo category is dropped',
  )

  const long = await settings({ outcomes: [{ code: 'sold', label: 'x'.repeat(500) }] })
  ok(
    long.body.settings.outcomes[0].label.length <= 40,
    `an absurd label is truncated rather than stored (${long.body.settings.outcomes[0].label.length})`,
  )

  /* ---- who may write ---- */
  const anyRep = await (await login(`selfserve-${stamp}@example.com`, 'i-changed-it-myself')).json()
  ok(
    (await settings({ outcomes: [] }, anyRep.token)).status === 403,
    'a rep cannot change the company’s settings',
  )
  ok(
    (await api('/api/settings', {}, anyRep.token)).status === 200,
    'but can read them — the field app needs the labels',
  )

  const auditNow = await (await api('/api/audit?limit=200', {}, admin.token)).json()
  ok(
    auditNow.entries.some((e) => e.action === 'settings.changed'),
    'a settings change is recorded in the audit log',
  )
}

/* --- super admins ---------------------------------------------------------- */
//
// The rule: nobody creates or manages an account more powerful than their own.
// Before this, createInvite stored whatever role string arrived — the only thing
// between a client admin and a super admin account was the database's CHECK
// constraint, which `super_admin` passes.
{
  const invite = (body, token) =>
    api('/api/invites', { method: 'POST', body: JSON.stringify(body) }, token).then(
      async (r) => ({ status: r.status, body: await r.json() }),
    )

  // The owner from setup is a super admin, so this is the escalation path.
  const CA = { email: `ca-${stamp}@example.com`, name: 'Client Admin', password: 'client-admin-pw1' }
  const caInv = await invite(
    { email: CA.email, name: CA.name, role: 'client_admin' },
    admin.token,
  )
  await fetch(caInv.body.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: CA.password, confirm: CA.password }),
  })
  const ca = await (await login(CA.email, CA.password)).json()
  ok(ca.user.role === 'client_admin', 'a client admin exists to test against')

  const escalation = await invite(
    { email: `sneaky-${stamp}@example.com`, name: 'Sneaky', role: 'super_admin' },
    ca.token,
  )
  ok(
    escalation.status === 403,
    `a client admin cannot invite a super admin (${escalation.status})`,
  )
  ok(
    /super admin/i.test(escalation.body.error ?? ''),
    'and is told why rather than getting a generic refusal',
  )

  // The thing that was asked for.
  const SA = { email: `sa-${stamp}@example.com`, name: 'Second Super', password: 'super-admin-pw-1' }
  const saInv = await invite(
    { email: SA.email, name: SA.name, role: 'super_admin' },
    admin.token,
  )
  ok(saInv.status === 200, 'a super admin can invite another super admin')
  await fetch(saInv.body.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: SA.password, confirm: SA.password }),
  })
  const sa = await (await login(SA.email, SA.password)).json()
  ok(sa.user.role === 'super_admin', 'the invited account really is a super admin')

  /* ---- and cannot be managed from below ---- */
  const saId = sa.user.id
  ok(
    (await call(`/api/users/${saId}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'taking-this-account-over', confirm: 'taking-this-account-over' }),
    }, ca.token)).status === 403,
    'a client admin cannot reset a super admin’s password — that is a takeover, not administration',
  )
  ok(
    (await call(`/api/users/${saId}/active`, {
      method: 'POST',
      body: JSON.stringify({ active: false }),
    }, ca.token)).status === 403,
    'nor deactivate one',
  )
  ok(
    (await call(`/api/users/${saId}`, { method: 'DELETE' }, ca.token)).status === 403,
    'nor delete one',
  )
  ok(
    (await call(`/api/users/${saId}/reset-email`, { method: 'POST' }, ca.token)).status === 403,
    'nor send one a reset email',
  )
  ok(
    (await call(`/api/users/${saId}/email`, { method: 'POST', body: JSON.stringify({ email: `taken-over-${stamp}@example.com` }) }, ca.token)).status === 403,
    'nor change one’s sign-in email — that is a takeover by another road',
  )

  /* ---- promotion follows the same rule ---- */
  //
  // A third party, deliberately: promoting *yourself* is refused by the
  // no-acting-on-your-own-account rule, which would mask whether the role check
  // works at all.
  const PLAIN = { email: `plain-${stamp}@example.com`, name: 'Plain Rep', password: 'plain-rep-pw-1' }
  const plainInv = await invite(
    { email: PLAIN.email, name: PLAIN.name, role: 'field_rep' },
    admin.token,
  )
  await fetch(plainInv.body.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PLAIN.password, confirm: PLAIN.password }),
  })
  const roster = await (await api('/api/users', {}, admin.token)).json()
  const plainId = roster.users.find((u) => u.email === PLAIN.email).id

  ok(
    (await call(`/api/users/${plainId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'super_admin' }),
    }, ca.token)).status === 403,
    'a client admin cannot promote anybody to super admin',
  )
  ok(
    (await call(`/api/users/${plainId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'manager' }),
    }, ca.token)).status === 200,
    'but can still grant a role they hold themselves',
  )
  ok(
    (await call(`/api/users/${plainId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'super_admin' }),
    }, admin.token)).status === 200,
    'and a super admin can',
  )

  // And a super admin still cannot act on their own account, which is what
  // stops the whole scheme from ending in a locked-out company.
  ok(
    (await call(`/api/users/${sa.user.id}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'field_rep' }),
    }, sa.token)).status === 400,
    'a super admin cannot demote themselves',
  )

  // A super admin may still manage another super admin — otherwise the role
  // would be unmanageable the moment there were two of them.
  ok(
    (await call(`/api/users/${saId}/active`, {
      method: 'POST',
      body: JSON.stringify({ active: false }),
    }, admin.token)).status === 200,
    'one super admin can deactivate another',
  )
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nuser management smoke passed')
process.exit(fails.length ? 1 : 0)
