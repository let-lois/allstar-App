import { invitePage } from '../api/src/pages.ts'
import { resetEmail } from '../api/src/mailTemplates.ts'
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
  url: 'https://allstar-api.example.workers.dev/invite/t0k',
  expiresAt: Date.UTC(2026, 8, 26, 15, 30),
  appUrl: APP,
})
ok(/Ridgeline Roofing/.test(mail.subject), 'the subject names the company, because one address can have several')
ok(mail.text.includes('/invite/t0k') && mail.html.includes('/invite/t0k'), 'the link is in both the text and the HTML')
ok(/works once/.test(mail.text) && /expires on/.test(mail.text), 'it says the link is single-use and when it dies')
ok(/current password keeps working/.test(mail.text), 'and that nothing has changed yet')
ok(/ignore/.test(mail.text), 'and tells somebody who did not ask to ignore it')
ok(!/no account|not found|does not exist|unknown/i.test(mail.text + mail.html), 'and never hints at whether an address was known')
ok(!/<script/i.test(mail.html), 'no script in the mail')

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
