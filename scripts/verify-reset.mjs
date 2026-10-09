import { invitePage, resetPage } from '../api/src/pages.ts'
import { emailChangedEmail, resetEmail } from '../api/src/mailTemplates.ts'
import { passwordPairError } from '../api/src/invites.ts'

/**
 * Forgot password, end to end, without a database.
 *
 * The self-service reset is three pure pieces wrapped around one route: the
 * email that carries the link, the page the link opens, and the rule that
 * decides whether two typed passwords are one. Each is driven here directly,
 * because each has a way of being wrong that a green build does not catch —
 * a page that says "Welcome" to someone resetting a password they have had
 * for a year, a mismatch that only the browser was checking, an email that
 * tells a stranger the address was real.
 *
 * The route itself (`/api/auth/forgot`) needs D1 and a mail provider, so its
 * contract — the same answer whether or not the address exists — is proved by
 * reading its source: no code path returns anything but `{ ok: true }` once a
 * valid address has passed the rate limit.
 */

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const APP = 'https://allstar.letlois.com'
const html = async (res) => await res.text()

console.log('--- two passwords, one rule ---')
ok(passwordPairError('short', 'short') !== null, 'a short password is refused before anything is compared')
ok(/at least 10/.test(passwordPairError('short', 'different') ?? ''), 'and the length is what it is told about, not the mismatch')
ok(/do not match/.test(passwordPairError('longenough1', 'longenough2') ?? ''), 'two different long passwords do not match')
ok(passwordPairError('longenough1', 'longenough1') === null, 'the same password twice is accepted')

console.log('\n--- the reset page ---')
const resetView = { email: 'rep@ridgeline.test', name: 'Marcus Vance', clientName: 'Ridgeline Roofing', kind: 'reset' }
const reset = await html(invitePage({ token: 't0k', invite: resetView, appUrl: APP }))
ok(/<h1>Reset your password<\/h1>/.test(reset), 'a reset link is headed as a reset, not a welcome')
ok(!/Welcome/.test(reset), 'and never says Welcome to somebody who has had an account for a year')
ok(/name="password"/.test(reset) && /name="confirm"/.test(reset), 'it asks for the password twice')
ok(/minlength="10"/.test(reset), 'with the same minimum the server enforces')
ok(/Change password<\/button>/.test(reset), 'and the button says what it does')
ok(/value="rep@ridgeline.test" readonly/.test(reset), 'the email is shown and cannot be edited')
ok(/data-kind="reset"/.test(reset), 'the form is marked as a reset for anything reading it')

console.log('\n--- the invitation page, unchanged in spirit ---')
const inviteView = { ...resetView, kind: 'invite' }
const invite = await html(invitePage({ token: 't0k', invite: inviteView, appUrl: APP }))
ok(/<h1>Create your account<\/h1>/.test(invite) && /Welcome, Marcus\./.test(invite), 'an invitation still welcomes the person by first name')
ok(/name="confirm"/.test(invite), 'and now asks for the password twice as well')
ok(/>Create account<\/button>/.test(invite) && !/Change password/.test(invite), 'with its own button')

console.log('\n--- what a mistake looks like ---')
const wrong = await html(invitePage({ token: 't0k', invite: resetView, error: passwordPairError('longenough1', 'longenough2'), appUrl: APP }))
ok(/<p class="alert" role="alert">The two passwords do not match/.test(wrong), 'a mismatch is shown on the page, as an alert')
ok(/name="password"/.test(wrong), 'with the form still there to try again')
const expired = await html(invitePage({ token: 'dead', appUrl: APP }))
ok(/This link has expired/.test(expired), 'a dead token says so')
ok(/two days/.test(expired) && /Forgot password\?/.test(expired), 'names the reset lifetime, and points back at the button that makes a new one')

console.log('\n--- done, either way ---')
const doneReset = await html(invitePage({ token: 't0k', appUrl: APP, done: true, kind: 'reset' }))
ok(/Password changed/.test(doneReset) && /old one no longer works/.test(doneReset), 'a finished reset says the old password is gone')
ok(new RegExp(`href="${APP}"`).test(doneReset), 'and sends the person to the app to sign in')
const doneInvite = await html(invitePage({ token: 't0k', appUrl: APP, done: true }))
ok(/You're in/.test(doneInvite), 'a finished invitation still reads as a welcome')

console.log('\n--- the email ---')
const mail = resetEmail({
  to: { email: 'rep@ridgeline.test', name: 'Marcus Vance' },
  clientName: 'Ridgeline Roofing',
  url: 'https://allstar-api.example.workers.dev/reset#t0k',
  expiresAt: Date.UTC(2026, 8, 26, 15, 30),
  appUrl: APP,
})
ok(/Ridgeline Roofing/.test(mail.subject), 'the subject names the company, because one address can have several')
ok(mail.text.includes('/reset#t0k') && mail.html.includes('/reset#t0k'), 'the link is in both the text and the HTML')
ok(/works once/.test(mail.text) && /expires on/.test(mail.text), 'it says the link is single-use and when it dies')
ok(/current password keeps working/.test(mail.text), 'and that nothing has changed yet')
ok(/ignore/.test(mail.text), 'and tells somebody who did not ask to ignore it')
ok(!/no account|not found|does not exist|unknown/i.test(mail.text + mail.html), 'and never hints at whether an address was known')
ok(!/<script/i.test(mail.html), 'no script in the mail')

const fromAdmin = resetEmail({
  to: { email: 'rep@ridgeline.test', name: 'Marcus Vance' },
  clientName: 'Ridgeline Roofing',
  url: 'https://allstar-api.example.workers.dev/reset#t0k',
  expiresAt: Date.UTC(2026, 8, 26, 15, 30),
  appUrl: APP,
  requestedBy: 'Nadia Petrov',
})
ok(/Nadia Petrov, an administrator at Ridgeline Roofing, sent you this link/.test(fromAdmin.text) && /Nadia Petrov/.test(fromAdmin.html), 'sent from Team → Manage, it names the admin who sent it')
ok(!/hopefully you/.test(fromAdmin.text) && /let Nadia Petrov know/.test(fromAdmin.text), 'and does not pretend the person asked for it')
const hostile = resetEmail({ to: { email: 'x@y.z' }, clientName: '<b>Co</b>', url: 'https://a.example/reset#t', expiresAt: 0, appUrl: APP, requestedBy: '<img src=x onerror=alert(1)>' })
ok(!/<img src=x/.test(hostile.html) && !/<b>Co<\/b>/.test(hostile.html) && /&lt;img src=x/.test(hostile.html), 'and escapes the names it prints')

console.log('\n--- the sign-in email changed ---')
const common = { clientName: 'Ridgeline Roofing', changedBy: 'Nadia Petrov', previous: 'old@ridgeline.test', next: 'new@ridgeline.test', appUrl: APP }
const toOld = emailChangedEmail({ ...common, to: { email: 'old@ridgeline.test', name: 'Marcus Vance' }, side: 'previous' })
const toNew = emailChangedEmail({ ...common, to: { email: 'new@ridgeline.test', name: 'Marcus Vance' }, side: 'next' })
ok(/was changed/.test(toOld.subject) && /new@ridgeline\.test/.test(toOld.text) && /Nadia Petrov/.test(toOld.text), 'the old address is told the new one and who changed it')
ok(/didn't expect this/.test(toOld.text), 'and what to do if it was not expected')
ok(/now signs in with this address/.test(toNew.text) && /password has not changed/i.test(toNew.text), 'the new address is told it is the sign-in now, password unchanged')
ok(![toOld, toNew].some((m) => /\/invite\/|\/reset#|confirm your/i.test(m.text + m.html)), 'neither carries a link to act on or asks for a confirmation')

console.log('\n--- the page a reset email opens ---')
const shell = await html(resetPage({ appUrl: APP }))
ok(/<h1>Reset your password<\/h1>/.test(shell) && /id="reset-form"[^>]*hidden/.test(shell), 'it arrives as a reset page with the form held back until the link is checked')
ok(/<form method="POST" action="\/reset"/.test(shell) && /type="hidden" name="token"/.test(shell), 'the form posts to /reset with the token in its body')
ok(/location\.hash/.test(shell) && /history\.replaceState/.test(shell), 'the token is read from the fragment and cleared from the address bar')
ok(/fetch\('\/api\/reset\/check', \{ method: 'POST'/.test(shell), 'and checked with a POST, never a URL')
ok(/<noscript>/.test(shell), 'without JavaScript it says why it cannot work')
const retry = await html(invitePage({ token: 't0k', invite: resetView, appUrl: APP, error: 'The two passwords do not match.', viaReset: true }))
ok(/<form method="POST" action="\/reset"/.test(retry) && /name="token" value="t0k"/.test(retry), 'a retry after a typo keeps the token in the body, not the address')

console.log('\n--- the route keeps its one answer ---')
const { readFileSync } = await import('node:fs')
const { resolve } = await import('node:path')
const root = resolve(new URL('..', import.meta.url).pathname)
const invites = readFileSync(resolve(root, 'api/src/invites.ts'), 'utf8')
const fn = invites.slice(invites.indexOf('export async function requestPasswordReset'))
const successes = [...fn.matchAll(/status: 200/g)].length
ok(successes === 1 && /body: \{ ok: true \}/.test(fn), 'requestPasswordReset has exactly one success shape, with nothing about the address in it')
ok(/recordFailure\(env, email, ip\)/.test(fn) && /checkLoginRate\(env, email, ip\)/.test(fn), 'and spends a sign-in attempt before looking anything up')
ok(/password_hash IS NOT NULL/.test(fn), 'and only resets accounts that have a password — an invitee keeps their invitation')
ok(/revokeLiveInvites\(env, row\.id, 'reset'\)/.test(fn), 'and leaves one live link per account')
const index = readFileSync(resolve(root, 'api/src/index.ts'), 'utf8')
ok(/path === '\/api\/auth\/forgot' && req\.method === 'POST'/.test(index), 'the route exists')
ok(/passwordPairError\(password, String\(form\.get\('confirm'\)/.test(index), 'and the invite page compares both boxes on the server')

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== forgot password: the link, the page and the rule all agree ===')
