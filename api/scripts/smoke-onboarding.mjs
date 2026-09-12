/**
 * Onboarding smoke test.
 *
 * Walks the path a real customer takes on an empty database: first
 * administrator via /setup, then an invited rep who sets their own password,
 * then that rep signing in and writing.
 *
 * The point of this flow is that no password hash is ever generated, typed, or
 * transported by a human — so the assertions here are as much about what
 * *cannot* happen (setup running twice, an invite being reused, a manager
 * inviting) as about the happy path.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const SETUP_TOKEN = process.env.SETUP_TOKEN || 'local-setup-token'

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const form = (obj) =>
  fetch(obj.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj.body),
    redirect: 'manual',
  })

const api = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })

const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery' }
const REP = { email: 'newrep@example.com', name: 'Jordan Vale', password: 'another-good-one' }

/* --- the setup page is open on an empty database -------------------------- */
{
  const html = await (await fetch(`${BASE}/setup`)).text()
  ok(/Set up Allstar/.test(html), 'setup page is available before any user exists')
}

/* --- a wrong setup token is refused --------------------------------------- */
{
  const res = await form({
    url: `${BASE}/setup`,
    body: { token: 'wrong', clientName: 'X', name: 'X', email: 'x@x.com', password: 'aaaaaaaaaa' },
  })
  const html = await res.text()
  ok(/Setup token is incorrect/.test(html), 'a wrong setup token is refused')
}

/* --- a short password is refused ------------------------------------------ */
{
  const res = await form({
    url: `${BASE}/setup`,
    body: { token: SETUP_TOKEN, clientName: 'X', name: 'X', email: 'x@x.com', password: 'short' },
  })
  ok(/at least 10 characters/.test(await res.text()), 'a too-short password is refused')
}

/* --- first administrator -------------------------------------------------- */
{
  const res = await form({
    url: `${BASE}/setup`,
    body: {
      token: SETUP_TOKEN,
      clientName: 'Example Roofing',
      name: 'Owner Person',
      email: ADMIN.email,
      password: ADMIN.password,
    },
  })
  ok(/You're set up|You&#39;re set up/.test(await res.text()), 'first administrator is created')
}

/* --- setup disables itself ------------------------------------------------ */
{
  const html = await (await fetch(`${BASE}/setup`)).text()
  ok(/set up/i.test(html) && !/Setup token<\/span>/.test(html), 'setup page disables itself once used')

  const res = await form({
    url: `${BASE}/setup`,
    body: {
      token: SETUP_TOKEN,
      clientName: 'Hijack Co',
      name: 'Attacker',
      email: 'attacker@example.com',
      password: 'aaaaaaaaaaaa',
    },
  })
  const html2 = await res.text()
  ok(
    !/Hijack/.test(html2),
    'setup cannot be run a second time even with the correct token',
  )
}

/* --- the admin signs in --------------------------------------------------- */
const adminLogin = await (
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })
).json()
ok(!!adminLogin.token, 'the new administrator can sign in')
ok(adminLogin.user?.role === 'super_admin', 'the first user is an administrator')
ok(adminLogin.user?.onboarding?.status === 'complete', 'and is onboarded from the start — the founder is not walked through a rep’s setup', adminLogin.user?.onboarding?.status)

/* --- the admin invites a rep ---------------------------------------------- */
const invite = await (
  await api(
    '/api/invites',
    { method: 'POST', body: JSON.stringify({ email: REP.email, name: REP.name, role: 'field_rep' }) },
    adminLogin.token,
  )
).json()
ok(!!invite.url, 'an invite link is created')

const token = invite.url.split('/invite/')[1]

/* --- the invited rep cannot sign in yet ----------------------------------- */
ok(
  (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: REP.email, password: REP.password }) }))
    .status === 401,
  'an invited rep cannot sign in before accepting',
)

/* --- the rep sets their own password -------------------------------------- */
{
  const html = await (await fetch(`${BASE}/invite/${token}`)).text()
  ok(/Set your password|Welcome/.test(html), 'the invite page renders for a valid token')
  ok(html.includes(REP.email), 'the invite page shows the invited email')
}
{
  const res = await form({ url: `${BASE}/invite/${token}`, body: { password: REP.password } })
  ok(/You're in|You&#39;re in/.test(await res.text()), 'the rep sets their own password')
}

/* --- the invite is single-use --------------------------------------------- */
//
// Assert the security property, not the page copy: replaying the link must not
// change the password. Anyone holding a forwarded invite email could otherwise
// lock the real owner out of their own account.
{
  const HIJACK = 'a-different-one-entirely'
  const res = await form({ url: `${BASE}/invite/${token}`, body: { password: HIJACK } })
  const html = await res.text()
  ok(!/You're in|You&#39;re in/.test(html), 'reusing the invite does not report success')

  const hijacked = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: REP.email, password: HIJACK }),
  })
  ok(hijacked.status === 401, 'a replayed invite cannot set a new password')

  const original = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: REP.email, password: REP.password }),
  })
  ok(original.ok, 'the password the rep chose still works after a replay attempt')
}

/* --- the rep can now work -------------------------------------------------- */
const repLogin = await (
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: REP.email, password: REP.password }) })
).json()
ok(!!repLogin.token, 'the rep can sign in with the password they chose')
ok(repLogin.user?.role === 'field_rep', 'the rep has the role the admin assigned')
ok((await api('/api/bootstrap', {}, repLogin.token)).ok, 'the rep can load their data')

/* --- a rep cannot invite --------------------------------------------------- */
ok(
  (
    await api(
      '/api/invites',
      { method: 'POST', body: JSON.stringify({ email: 'x@y.com', name: 'X', role: 'client_admin' }) },
      repLogin.token,
    )
  ).status === 403,
  'a field rep cannot create accounts',
)

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nonboarding smoke passed')
process.exit(fails.length ? 1 : 0)
