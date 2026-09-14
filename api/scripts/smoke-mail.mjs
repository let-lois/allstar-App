import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Invitations by email — against a real Worker and a stand-in provider.
 *
 * The provider is reached over HTTPS and cannot be reached from a sandbox, so
 * it is stood in for by a small server that records what the Worker sent it.
 * That is the right shape for this test anyway: the assertions are about the
 * *request* — who it went to, that the link is in it, that no password is —
 * and about what the API tells the console afterwards, which must be the
 * truth in all three states: sent, provider failed, not configured.
 *
 * Nothing here asserts a real email arrived. Nothing can, from here. What is
 * pinned is that a deployment with the two secrets set makes exactly the call
 * the provider documents — both providers, each in its own shape — that Resend
 * is chosen over MailChannels when both are configured, and that a deployment
 * without them, or with a provider having a bad day, still hands the admin a
 * working link and never claims otherwise.
 *
 * The 403 Resend returns before a domain is verified gets its own assertion,
 * because it is the failure every new setup meets and the one most likely to
 * be mistaken for a bug in this app.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8881)
const MAIL_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/mail-state')
const SETUP_TOKEN = 'local-setup-token'
const APP_URL = 'https://app.example.test'
const API_KEY = 'mc-test-key-not-real'
// The comma is the point: a display name containing one must survive as a
// single address, not split into two. It is also what a real company is called.
const FROM = 'Allstar, Inc. <no-reply@example.test>'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery' }

/* --- the stand-in provider ------------------------------------------------- */
let mode = 'accept' // or 'fail'
const received = []
const mail = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
    // One stand-in, two APIs, told apart by path — the same way the real
    // hostnames differ. Each answers in its own provider's shape, success and
    // failure alike, so the Worker's parsing is tested rather than assumed.
    const isResend = (req.url ?? '').startsWith('/emails')
    if (mode === 'fail') {
      if (isResend) {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          statusCode: 403,
          name: 'validation_error',
          message: `You can only send testing emails to your own email address (${ADMIN.email}). To send emails to other recipients, please verify a domain at resend.com/domains`,
        }))
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errors: ['Unauthorized: bad API key'] }))
    }
    if (isResend) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: '3f8c1a2e-stub' }))
    }
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'accepted' }))
  })
})
await new Promise((r) => mail.listen(MAIL_PORT, '127.0.0.1', r))

/* --- the Worker ------------------------------------------------------------- */
const wrangler = resolve(api, 'node_modules/.bin/wrangler')
function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const path = resolve(api, '.wrangler/mail.toml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return path
}
let child = null
let log = ''
async function start(config, vars) {
  child = spawn(
    wrangler,
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'info', ...vars.flatMap((v) => ['--var', v])],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  for (let i = 0; i < 90; i++) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return await res.json() } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}
async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null
}
const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } })
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
const form = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })


let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig()
  execFileSync(wrangler, ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'], { cwd: api, stdio: 'ignore' })

  const health = await start(config, [
    `SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `APP_URL:${APP_URL}`,
    `MAILCHANNELS_API_KEY:${API_KEY}`, `MAIL_FROM:${FROM}`, `MAIL_BASE_URL:http://127.0.0.1:${MAIL_PORT}`,
  ])
  ok(health.config?.mail === true, 'health reports that this deployment emails invitations', JSON.stringify(health.config?.mail))
  ok(health.config?.mailProvider === 'mailchannels', 'and names the provider carrying them', String(health.config?.mailProvider))

  await form(`${BASE}/setup`, { token: SETUP_TOKEN, clientName: 'Ridgeline Roofing', name: 'Nadia Petrov', email: ADMIN.email, password: ADMIN.password })
  const admin = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()
  const A = admin.token
  ok(!!A, 'the administrator signs in')

  /* ===== 1. an invitation goes out ============================================ */
  const REP = 'marcus.vance@example.test'
  let r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: REP, role: 'field_rep', firstName: 'Marcus', lastName: 'Vance' }) }, A))
  ok(r.status === 200 && r.body.emailed === true, 'the API says the invitation was emailed', `${r.status} emailed=${r.body.emailed}`)
  ok(!r.body.mailError, 'with no error attached')
  ok(/\/invite\//.test(r.body.url), 'and still returns the link — "I never got it" is a sentence every admin hears')

  ok(received.length === 1, 'exactly one request reached the provider', `${received.length}`)
  const sent = received[0]
  ok(sent?.method === 'POST' && sent?.url === '/tx/v1/send', 'at MailChannels’ transactional endpoint', `${sent?.method} ${sent?.url}`)
  ok(sent?.headers['x-api-key'] === API_KEY, 'carrying the API key as X-Api-Key')
  ok(sent?.body?.personalizations?.[0]?.to?.[0]?.email === REP, 'addressed to the invited person', sent?.body?.personalizations?.[0]?.to?.[0]?.email)
  ok(sent?.body?.personalizations?.[0]?.to?.[0]?.name === 'Marcus Vance', 'by name')
  ok(sent?.body?.from?.email === 'no-reply@example.test' && sent?.body?.from?.name === 'Allstar, Inc.', 'from the configured sender, name and address parsed apart', JSON.stringify(sent?.body?.from))
  ok(/You're invited to join Ridgeline Roofing on Allstar/.test(sent?.body?.subject ?? ''), 'the subject says where they are being invited', sent?.body?.subject)
  const text = sent?.body?.content?.find((c) => c.type === 'text/plain')?.value ?? ''
  const html = sent?.body?.content?.find((c) => c.type === 'text/html')?.value ?? ''
  ok(text.includes(r.body.url) && html.includes(r.body.url), 'both parts carry the link the API returned — the same one the admin sees')
  ok(/Hi Marcus,/.test(text), 'and greet them by first name')
  ok(text.includes(APP_URL) && /Add to Home Screen/.test(text), 'and say where the app is and how to install it')
  ok(/invited by Nadia Petrov/.test(text), 'and name the colleague who invited them — an invitation from nobody is phishing')
  ok(/Creating your Team Member Badge/.test(text) && /about a minute/.test(text), 'and say what setup is and how long it takes', text.match(/about a minute/)?.[0])
  ok(/already provided/.test(text), 'and promise that what the admin typed is not asked for again')
  // The link itself carries the invite token, so it is removed before looking
  // for anything token-shaped — the point is nothing ELSE secret is in there.
  const withoutLink = (text + html).split(r.body.url).join('')
  ok(!/password_hash|correct-horse|[0-9a-f]{40,}/.test(withoutLink), 'and contain no password, hash or token other than the link')
  ok(/expires on/.test(text), 'and say when the link expires')

  /* ===== 1b. the documented link shape reaches the same page ================== */
  const token = r.body.url.split('/invite/')[1]
  const alias = await fetch(`${BASE}/onboarding/invite?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  ok(alias.status === 302 && alias.headers.get('location') === `/invite/${token}`, 'a /onboarding/invite?token= link forwards to the one canonical invite page', `${alias.status} ${alias.headers.get('location')}`)
  const followed = await fetch(`${BASE}/onboarding/invite?token=${encodeURIComponent(token)}`)
  ok(followed.ok && /Set your password|Welcome/.test(await followed.text()), 'and following it lands on the page that sets the password')

  /* ===== 2. resend sends again, with a different subject ====================== */
  const roster = (await (await call('/api/users', {}, A)).json()).users
  const rep = roster.find((u) => u.email === REP)
  ok(typeof rep?.invitedAt === 'number', 'the roster records when they were first invited', new Date(rep?.invitedAt ?? 0).toISOString())
  ok(rep?.resentAt === undefined, 'and nothing about a chase, because there has not been one')
  r = await j(await call(`/api/invites/${rep.id}/resend`, { method: 'POST' }, A))
  ok(r.status === 200 && r.body.emailed === true, 'a resend is emailed too')
  ok(received.length === 2 && /again/.test(received[1]?.body?.subject ?? ''), 'and reads as a second copy, not a first', received[1]?.body?.subject)
  const after = (await (await call('/api/users', {}, A)).json()).users.find((u) => u.email === REP)
  ok(after?.invitedAt === rep.invitedAt, 'a resend does not rewrite when they were first asked — that is the date an admin is judging by')
  ok(typeof after?.resentAt === 'number' && after.resentAt >= rep.invitedAt, 'and it now carries when they were chased', new Date(after?.resentAt ?? 0).toISOString())

  /* ===== 3. an already-member invite sends nothing ============================ */
  await form(r.body.url, { password: 'marcus-chose-this-12' })
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: REP, role: 'field_rep' }) }, A))
  ok(r.status === 200 && r.body.alreadyMember === true, 'inviting a working account reports already a member')
  ok(received.length === 2, 'and emails nobody', `${received.length} requests`)

  /* ===== 4. the provider fails: the link still comes back, honestly ============ */
  mode = 'fail'
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: 'dana@example.test', role: 'field_rep' }) }, A))
  ok(r.status === 200, 'a provider failure does not fail the invitation', `${r.status}`)
  ok(r.body.emailed === false, 'the API says it was NOT emailed', `emailed=${r.body.emailed}`)
  ok(/could not be sent/.test(r.body.mailError ?? '') && /401/.test(r.body.mailError ?? ''), 'and says why, with the provider’s status', r.body.mailError)
  ok(/\/invite\//.test(r.body.url), 'and the link is there to send another way')
  ok(/Set your password|Welcome/.test(await (await fetch(r.body.url)).text()), 'and that link works')
  mode = 'accept'

  /* ===== 5. the audit log records whether it went ============================== */
  const { entries } = await (await call('/api/audit?limit=20', {}, A)).json()
  const invited = entries.filter((e) => e.action === 'user.invited')
  ok(invited.some((e) => e.detail?.emailed === true) && invited.some((e) => e.detail?.emailed === false), 'user.invited entries record whether the email went out')

  await stop()

  /* ===== 6. not configured: nothing is claimed ================================= */
  await start(config, [`SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `APP_URL:${APP_URL}`])
  const health2 = await (await fetch(`${BASE}/api/health`)).json()
  ok(health2.config?.mail === false && health2.config?.mailProvider === null, 'without the secrets, health reports no email and no provider', String(health2.config?.mailProvider))
  const admin2 = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()
  const before = received.length
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: 'sam@example.test', role: 'field_rep' }) }, admin2.token))
  ok(r.status === 200 && r.body.emailed === false && !r.body.mailError, 'an invitation is minted, reported not emailed, with no error — this is configuration, not failure')
  ok(received.length === before, 'and no request was attempted')

  /* ===== 7. half-configured is not configured =================================== */
  await stop()
  await start(config, [`SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `MAILCHANNELS_API_KEY:${API_KEY}`, 'MAIL_FROM:not an address'])
  const health3 = await (await fetch(`${BASE}/api/health`)).json()
  ok(health3.config?.mail === false, 'a key with an unusable MAIL_FROM reads as not configured, rather than sending from garbage')

  /* ===== 8. Resend: its own call shape, its own refusal ======================== */
  await stop()
  const RESEND_KEY = 're_test_key_not_real'
  await start(config, [
    `SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `APP_URL:${APP_URL}`,
    `RESEND_API_KEY:${RESEND_KEY}`, `RESEND_FROM_EMAIL:${FROM}`, `RESEND_BASE_URL:http://127.0.0.1:${MAIL_PORT}`,
  ])
  const health4 = await (await fetch(`${BASE}/api/health`)).json()
  ok(health4.config?.mail === true && health4.config?.mailProvider === 'resend', 'with only Resend configured, health names Resend', String(health4.config?.mailProvider))
  const admin4 = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()
  const A4 = admin4.token
  const RESEND_REP = 'priya@example.test'
  const at = received.length
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: RESEND_REP, role: 'field_rep', firstName: 'Priya', lastName: 'Natarajan' }) }, A4))
  ok(r.status === 200 && r.body.emailed === true, 'an invitation goes out through Resend', `${r.status} emailed=${r.body.emailed}`)
  ok(received.length === at + 1, 'exactly one request reached it', `${received.length - at}`)
  const rs = received[at]
  ok(rs?.method === 'POST' && rs?.url === '/emails', 'at Resend’s send endpoint', `${rs?.method} ${rs?.url}`)
  ok(rs?.headers?.authorization === `Bearer ${RESEND_KEY}`, 'carrying the key as a bearer token, which is the shape Resend takes')
  ok(!JSON.stringify(rs?.body ?? {}).includes(RESEND_KEY), 'and the key is nowhere in the body')
  ok(rs?.body?.from === '"Allstar, Inc." <no-reply@example.test>', 'from the configured sender, as one string with the display name quoted', rs?.body?.from)
  ok(Array.isArray(rs?.body?.to) && rs.body.to.length === 1, 'to exactly one recipient', JSON.stringify(rs?.body?.to))
  ok(rs?.body?.to?.[0] === '"Priya Natarajan" <priya@example.test>', 'addressed by name, so the rep sees who it is to and not their own address', rs?.body?.to?.[0])
  // The bug this pins: unquoted, `Allstar, Inc.` is two addresses, the first
  // of them invalid, and the mail is refused or sent from something else.
  ok((rs?.body?.from?.match(/@/g) ?? []).length === 1 && !/^[^"]*,/.test(rs?.body?.from ?? ''), 'and the comma in the company name does not split it into two senders', rs?.body?.from)
  ok(typeof rs?.body?.html === 'string' && typeof rs?.body?.text === 'string', 'with both a plain-text and an HTML part')
  ok(rs.body.html.includes(r.body.url) && rs.body.text.includes(r.body.url), 'both carrying the link the API returned')
  ok(/Hi Priya,/.test(rs.body.text), 'and greeting them by first name')
  const withoutLink4 = (rs.body.text + rs.body.html).split(r.body.url).join('')
  ok(!/password_hash|correct-horse|re_test_key|[0-9a-f]{40,}/.test(withoutLink4), 'and nothing secret beyond the link itself')

  const at2 = received.length
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: 'sam.okafor@example.test', role: 'field_rep', firstName: 'Sam', lastName: 'Okafor, Jr.' }) }, A4))
  ok(received[at2]?.body?.to?.[0] === '"Sam Okafor, Jr." <sam.okafor@example.test>', 'a rep whose own name carries a comma is one recipient too, not two', received[at2]?.body?.to?.[0])

  // The failure every new Resend account meets before its domain is verified.
  mode = 'fail'
  r = await j(await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: 'lee@example.test', role: 'field_rep' }) }, A4))
  ok(r.status === 200 && r.body.emailed === false, 'an unverified domain does not fail the invitation', `${r.status} emailed=${r.body.emailed}`)
  ok(/verify a domain/.test(r.body.mailError ?? '') && /403/.test(r.body.mailError ?? ''), 'and the console is told, in Resend’s own words, what to go and fix', r.body.mailError)
  ok(/\/invite\//.test(r.body.url), 'with the link still there to send by hand meanwhile')
  mode = 'accept'

  /* ===== 9. both configured: Resend wins ====================================== */
  await stop()
  await start(config, [
    `SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `APP_URL:${APP_URL}`,
    `RESEND_API_KEY:${RESEND_KEY}`, `RESEND_FROM_EMAIL:${FROM}`, `RESEND_BASE_URL:http://127.0.0.1:${MAIL_PORT}`,
    `MAILCHANNELS_API_KEY:${API_KEY}`, `MAIL_BASE_URL:http://127.0.0.1:${MAIL_PORT}`,
  ])
  const health5 = await (await fetch(`${BASE}/api/health`)).json()
  ok(health5.config?.mailProvider === 'resend', 'with both keys set, Resend is the one in use', String(health5.config?.mailProvider))
  const admin5 = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()
  const at5 = received.length
  await call('/api/invites', { method: 'POST', body: JSON.stringify({ email: 'jordan@example.test', role: 'field_rep' }) }, admin5.token)
  ok(received.length === at5 + 1 && received[at5]?.url === '/emails', 'and the send goes to Resend, not to both and not to the other one', received[at5]?.url)

  /* ===== 10. Resend with only the older from-name still works ================== */
  await stop()
  await start(config, [
    `SETUP_TOKEN:${SETUP_TOKEN}`, 'SESSION_PEPPER:local-mail-pepper', `APP_URL:${APP_URL}`,
    `RESEND_API_KEY:${RESEND_KEY}`, `MAIL_FROM:${FROM}`, `RESEND_BASE_URL:http://127.0.0.1:${MAIL_PORT}`,
  ])
  const health6 = await (await fetch(`${BASE}/api/health`)).json()
  ok(health6.config?.mail === true && health6.config?.mailProvider === 'resend', 'a deployment that set MAIL_FROM before Resend existed keeps sending', String(health6.config?.mailProvider))
} catch (err) {
  ok(false, `the run completed: ${err instanceof Error ? err.message : String(err)}`)
  if (log) console.log('\n--- worker log ---\n' + log.slice(-3000))
} finally {
  await stop().catch(() => {})
  mail.close()
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\n=== invitations are emailed when they can be, and say so when they cannot ===')
process.exit(fails.length ? 1 : 0)
