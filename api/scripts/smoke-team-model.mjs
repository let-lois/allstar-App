/**
 * The team member model: teams, titles, the company's badge identity, and the
 * three statuses the roster derives — against a real Worker with a real D1.
 *
 * Runs on the shared Worker after `smoke:onboarding` has created the
 * administrator. Most of what is asserted is what the API *refuses*: a rep
 * naming a team, a rep rewriting the company website, a title long enough to
 * be a paragraph, a team id from nowhere. The happy path is short; the edges
 * are the product.
 *
 * Nothing here exercises onboarding *progress* — no step is taken, no badge
 * minted. That is the next step's smoke. This pins the shape everything else
 * will stand on: what `/api/me` says, what `/api/users` says, and that both
 * say the same thing about the same person.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'owner@example.com',
  password: process.env.ADMIN_PASSWORD || 'correct-horse-battery',
}

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
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
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
const login = (email, password) =>
  api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

const adminRes = await login(ADMIN.email, ADMIN.password)
if (!adminRes.ok) {
  console.error(`\nCould not sign in as ${ADMIN.email}. Run \`npm run smoke:onboarding\` first.`)
  process.exit(1)
}
const admin = await adminRes.json()
const A = admin.token
const stamp = Date.now()

/* ===== 1. sign-in returns the whole person ================================= */
{
  const u = admin.user
  ok(u.id && u.role && u.clientName, 'the login payload still carries the session fields every client reads')
  ok(u.onboarding && typeof u.onboarding.status === 'string', 'and now says where this person is in onboarding', u.onboarding?.status)
  ok(u.badge === null, 'a person with no badge has badge: null, not a half-filled object')
  ok(u.company?.name === u.clientName, 'and carries the company as it will appear on a badge', u.company?.name)
  ok(typeof u.createdAt === 'number', 'with when the account was made')
  ok(typeof u.lastSeenAt === 'number' && Date.now() - u.lastSeenAt < 60_000, 'signing in is being here: last seen is now', new Date(u.lastSeenAt ?? 0).toISOString())
  /*
    The first administrator came through /setup after the migrations, so no
    backfill touched them. They have never onboarded, and the payload says so —
    the setup admin gets the flow like everyone else.
  */
  ok(u.onboarding.status === 'not_started', 'the setup administrator has not onboarded, and is told so rather than assumed complete', u.onboarding.status)
}

const me = await (await api('/api/me', {}, A)).json()
ok(me.user?.onboarding?.status === admin.user.onboarding.status, '/api/me and the login payload agree')

/* ===== 2. a rep, to be refused things ===================================== */
const REP = { email: `model-rep-${stamp}@example.com`, name: 'Model Rep', password: 'model-rep-password-1' }
const invite = await (await api('/api/invites', { method: 'POST', body: JSON.stringify({ email: REP.email, name: REP.name, role: 'field_rep' }) }, A)).json()
await fetch(invite.url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: REP.password }),
})
ok(invite.emailed === false && !invite.mailError, 'with no mail secrets, an invitation is honestly not emailed and that is not an error')
const rep = await (await login(REP.email, REP.password)).json()
const R = rep.token
ok(!!R, 'a rep is signed in')
ok(rep.user.onboarding.status === 'not_started', 'a freshly invited rep has not started onboarding')

/* ===== 3. teams ============================================================ */
let austin, north
{
  ok((await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Austin' }) }, R)).status === 403, 'a rep cannot create a team')

  let r = await j(await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: '  Austin  ' }) }, A))
  ok(r.status === 201 && r.body.name === 'Austin', 'an admin creates a team, and the name is trimmed', `${r.status} ${r.body.name}`)
  austin = r.body

  r = await j(await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'austin' }) }, A))
  ok(r.status === 409, 'the same name in another case is the same team, and is refused', `${r.status} ${r.body.error ?? ''}`)

  r = await j(await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: '' }) }, A))
  ok(r.status === 400, 'a blank name is refused')
  r = await j(await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(61) }) }, A))
  ok(r.status === 400, 'a name over the limit is refused')

  r = await j(await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'North crew' }) }, A))
  north = r.body

  const list = await (await api('/api/teams', {}, R)).json()
  ok(Array.isArray(list.teams) && list.teams.some((t) => t.id === austin.id), 'a rep may read the team list — their badge names their team')
  ok(list.teams.every((t) => typeof t.memberCount === 'number'), 'with a member count on each')

  r = await j(await api(`/api/teams/${austin.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Austin office' }) }, A))
  ok(r.status === 200 && r.body.name === 'Austin office', 'an admin renames a team', `${r.status}`)
  ok((await api(`/api/teams/${austin.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Nope' }) }, R)).status === 403, 'a rep cannot rename one')
  ok((await api(`/api/teams/t_doesnotexist`, { method: 'PATCH', body: JSON.stringify({ name: 'Ghost' }) }, A)).status === 404, 'an unknown team id is not found')
}

/* ===== 4. a person on a team, with a title ================================= */
const repId = rep.user.id
{
  let r = await j(await api(`/api/users/${repId}/team`, { method: 'POST', body: JSON.stringify({ teamId: austin.id }) }, R))
  ok(r.status === 403, 'a rep cannot move themselves onto a team', `${r.status}`)

  r = await j(await api(`/api/users/${repId}/team`, { method: 'POST', body: JSON.stringify({ teamId: austin.id }) }, A))
  ok(r.status === 200 && r.body.teamName === 'Austin office', 'an admin puts a rep on a team', `${r.status} ${r.body.teamName}`)

  r = await j(await api(`/api/users/${repId}/team`, { method: 'POST', body: JSON.stringify({ teamId: 't_elsewhere' }) }, A))
  ok(r.status === 404, 'a team id from nowhere is "no such team", not a write', `${r.status}`)

  r = await j(await api(`/api/users/${repId}/title`, { method: 'POST', body: JSON.stringify({ jobTitle: '  Sales   Representative ' }) }, A))
  ok(r.status === 200 && r.body.jobTitle === 'Sales Representative', 'an admin sets a title, and inner whitespace is collapsed', r.body.jobTitle)
  r = await j(await api(`/api/users/${repId}/title`, { method: 'POST', body: JSON.stringify({ jobTitle: 'x'.repeat(61) }) }, A))
  ok(r.status === 400, 'a title over the limit is refused')
  ok((await api(`/api/users/${repId}/title`, { method: 'POST', body: JSON.stringify({ jobTitle: 'CEO' }) }, R)).status === 403, 'a rep cannot set a title through the admin route')

  const mine = await (await api('/api/me', {}, R)).json()
  ok(mine.user.teamId === austin.id && mine.user.teamName === 'Austin office', 'the rep sees their team on /api/me', mine.user.teamName)
  ok(mine.user.jobTitle === 'Sales Representative', 'and their title')

  const teams = await (await api('/api/teams', {}, A)).json()
  ok(teams.teams.find((t) => t.id === austin.id)?.memberCount === 1, 'the team counts its one member')
}

/* ===== 5. the roster says the same things ================================= */
{
  const roster = await (await api('/api/users', {}, A)).json()
  const row = roster.users.find((u) => u.id === repId)
  ok(!!row, 'the rep is on the roster')
  ok(row.teamName === 'Austin office' && row.jobTitle === 'Sales Representative', 'with team and title', `${row.teamName} / ${row.jobTitle}`)
  ok(row.invitation === 'accepted', 'their invitation reads accepted', row.invitation)
  ok(row.onboarding === 'not_started', 'their onboarding reads not started', row.onboarding)
  ok(row.badge === 'none', 'and no badge', row.badge)
  ok(typeof row.createdAt === 'number' && typeof row.lastSeenAt === 'number', 'with date added and last seen')
  ok(row.pending === false, 'and they are no longer pending, having set a password')

  const owner = roster.users.find((u) => u.id === admin.user.id)
  ok(owner.invitation === 'not_sent', 'the setup administrator was never invited, and the roster says not sent rather than inventing a token', owner.invitation)

  ok((await api('/api/users', {}, R)).status === 403, 'a rep still cannot read the roster')

  // A pending invitee, for the status the console most needs.
  const PENDING = `model-pending-${stamp}@example.com`
  await api('/api/invites', { method: 'POST', body: JSON.stringify({ email: PENDING, name: 'Never Opened', role: 'field_rep' }) }, A)
  const again = await (await api('/api/users', {}, A)).json()
  const p = again.users.find((u) => u.email === PENDING)
  ok(p?.pending === true && p?.invitation === 'pending', 'someone who has not opened their link is pending on both counts', `${p?.pending} / ${p?.invitation}`)
  ok(p?.onboarding === 'not_started', 'and has not started onboarding')
}

/* ===== 6. the company on the badge ========================================= */
{
  ok((await api('/api/company', { method: 'POST', body: JSON.stringify({ website: 'https://example.com' }) }, R)).status === 403, 'a rep cannot change the company website')

  let r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ website: 'summitexteriors.com/about' }) }, A))
  ok(r.status === 200 && r.body.company?.website === 'https://summitexteriors.com/about', 'an admin sets the website, and https:// is assumed when omitted', r.body.company?.website)

  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ website: 'not a website' }) }, A))
  ok(r.status === 400, 'a non-address is refused', `${r.status} ${r.body.error ?? ''}`)
  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ website: 'ftp://files.example.com' }) }, A))
  ok(r.status === 400, 'a non-web scheme is refused — this becomes a QR code people scan')
  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ website: 'https://user:pw@example.com' }) }, A))
  ok(r.status === 400, 'a login in the address is refused')

  const png = `data:image/png;base64,${'iVBORw0KGgo='.repeat(1)}`
  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ logo: png }) }, A))
  ok(r.status === 200 && r.body.company?.logoUrl === png, 'an admin sets a logo')
  ok(r.body.company?.website === 'https://summitexteriors.com/about', 'and setting the logo did not clear the website — absent means untouched')

  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ logo: 'data:text/html;base64,PGh0bWw+' }) }, A))
  ok(r.status === 400, 'a logo that is not an image is refused')
  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ logo: `data:image/png;base64,${'A'.repeat(70_000)}` }) }, A))
  ok(r.status === 400, 'an oversized logo is refused')
  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({}) }, A))
  ok(r.status === 400, 'an empty change is refused rather than silently succeeding')

  const mine = await (await api('/api/me', {}, R)).json()
  ok(mine.user.company.website === 'https://summitexteriors.com/about' && mine.user.company.logoUrl === png, 'a rep sees the company’s website and logo on /api/me — the badge needs both offline')

  r = await j(await api('/api/company', { method: 'POST', body: JSON.stringify({ logo: null }) }, A))
  ok(r.status === 200 && r.body.company?.logoUrl === undefined, 'null clears the logo')
}

/* ===== 7. deleting a team leaves the people ================================ */
{
  ok((await api(`/api/teams/${austin.id}`, { method: 'DELETE' }, R)).status === 403, 'a rep cannot delete a team')
  const r = await j(await api(`/api/teams/${austin.id}`, { method: 'DELETE' }, A))
  ok(r.status === 200 && r.body.unassigned === 1, 'an admin deletes a team, and is told how many people came off it', `${r.status} unassigned=${r.body.unassigned}`)
  const mine = await (await api('/api/me', {}, R)).json()
  ok(mine.user.teamId === undefined && mine.user.teamName === undefined, 'the rep is still here, on no team')
  ok(mine.user.jobTitle === 'Sales Representative', 'and kept their title')
  ok((await api(`/api/teams/${austin.id}`, { method: 'DELETE' }, A)).status === 404, 'deleting it again is not found')
  await api(`/api/teams/${north.id}`, { method: 'DELETE' }, A)
}

/* ===== 8. the audit log knows ============================================== */
{
  const { entries } = await (await api('/api/audit?limit=50', {}, A)).json()
  const actions = new Set(entries.map((e) => e.action))
  for (const a of ['team.created', 'team.renamed', 'team.deleted', 'user.team_changed', 'user.title_changed', 'company.changed']) {
    ok(actions.has(a), `${a} was recorded`)
  }
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nteam member model OK')
process.exit(fails.length ? 1 : 0)
