import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Team → Manage: account details, sign-in email and the password reset email.
 *
 * The API is mocked, so a failure here means the console is wrong. The server
 * half — who may, what is sent, what the link does — is
 * api/scripts/smoke-user-admin. What this pins is what an administrator sees
 * and can do:
 *
 *   - three clearly named actions: Edit name, Change email, Send password
 *     reset email — and no box to type somebody else's password;
 *   - the reset email is asked first, in a dialog that names the address, with
 *     focus on Cancel; Escape backs out without a request; a double click on
 *     Send makes one request; success and failure both say so, beside the
 *     button; no link or token is ever on screen;
 *   - the email change is validated as it is typed, reviewed in a dialog that
 *     says it takes effect immediately, and a duplicate is reported without
 *     losing what was typed;
 *   - a person with no password yet is not offered a reset email, and is told why;
 *   - on a phone the sheet and both dialogs fit, with no sideways scroll.
 *
 * Screenshots go to SHOTS_DIR (default: <tmp>/allstar-verify-shots/user-admin)
 * for review; nothing is written into the repository.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const SHOTS = resolve(process.env.SHOTS_DIR || resolve(tmpdir(), 'allstar-verify-shots/user-admin'))
mkdirSync(SHOTS, { recursive: true })

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured !== undefined ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ADMIN = { id: 'u_admin', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'admin@ridgeline.test', name: 'Nadia Petrov', role: 'client_admin' }

const browser = await chromium.launch({ executablePath: chromiumPath() })

async function session(viewport, label) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  const state = {
    roster: [
      { id: ADMIN.id, name: ADMIN.name, firstName: 'Nadia', lastName: 'Petrov', email: ADMIN.email, role: 'client_admin', active: true, pending: false },
      { id: 'u_jordan', name: 'Jordan Reyes', firstName: 'Jordan', lastName: 'Reyes', email: 'jordan@ridgeline.test', role: 'field_rep', active: true, pending: false, onboarding: 'complete', badge: 'active' },
      { id: 'u_sam', name: 'Sam Ortiz', firstName: 'Sam', lastName: 'Ortiz', email: 'sam@ridgeline.test', role: 'field_rep', active: true, pending: true, invitation: 'pending' },
    ],
    resetRequests: 0,
    resetMode: 'ok',
    emailPosts: [],
    namePosts: [],
    passwordPosts: 0,
  }
  await page.route('**/api/auth/login', json(200, { token: 'tok', user: ADMIN }))
  await page.route('**/api/bootstrap', json(200, { user: ADMIN, properties: [], routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], serverTime: Date.now() }))
  await page.route('**/api/users', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: state.roster }) }))
  await page.route('**/api/teams', json(200, { teams: [] }))
  await page.route('**/api/users/*/password', async (route) => {
    state.passwordPosts++
    await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"no","code":"not_self"}' })
  })
  await page.route('**/api/users/*/reset-email', async (route) => {
    state.resetRequests++
    await wait(700) // long enough for a second click to land while the first is in flight
    if (state.resetMode === 'mail_not_configured') {
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'Email is not set up on this deployment, so a reset email cannot be sent.', code: 'mail_not_configured' }) })
    }
    const id = route.request().url().split('/api/users/')[1].split('/')[0]
    const who = state.roster.find((u) => u.id === id)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, email: who.email, expiresAt: Date.now() + 2 * 86_400_000 }) })
  })
  await page.route('**/api/users/*/email', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    state.emailPosts.push(body.email)
    await wait(300)
    if (body.email.toLowerCase() === 'nadia@ridgeline.test' || body.email.toLowerCase() === ADMIN.email) {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Someone else on this team already signs in with that email.', code: 'email_taken' }) })
    }
    const id = route.request().url().split('/api/users/')[1].split('/')[0]
    const who = state.roster.find((u) => u.id === id)
    const previous = who.email
    who.email = body.email
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, email: body.email, previous, invitesRevoked: who.pending ? 1 : 0, notified: { previous: !who.pending, next: !who.pending } }) })
  })
  await page.route('**/api/users/*/name', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    state.namePosts.push(body)
    const id = route.request().url().split('/api/users/')[1].split('/')[0]
    const who = state.roster.find((u) => u.id === id)
    Object.assign(who, { firstName: body.firstName, lastName: body.lastName, name: [body.firstName, body.lastName].filter(Boolean).join(' ') })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, name: who.name, firstName: body.firstName, lastName: body.lastName }) })
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1400)
  await dismissTour(page)
  await page.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const open = async (name) => {
    // A table row's Manage button on a wide screen; the card itself on a phone.
    const inTable = page.locator('tbody tr').filter({ hasText: name }).getByRole('button', { name: /Manage/ })
    if (await inTable.count()) await inTable.first().click()
    else await page.getByRole('button', { name: `Manage ${name}` }).first().click()
    await page.getByTestId('manage-details').waitFor({ timeout: 5000 })
    await page.waitForTimeout(400)
  }
  const close = async () => {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  const shot = (name) => page.screenshot({ path: resolve(SHOTS, `${label}-${name}.png`) })
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  return { ctx, page, state, open, close, shot, noSideScroll }
}

/* ===== desktop ============================================================== */
{
  console.log('--- desktop ---')
  const { ctx, page, state, open, close, shot, noSideScroll } = await session({ width: 1440, height: 950 }, 'desktop')
  await open('Jordan Reyes')
  await shot('01-sheet')

  ok(/Account details/.test(await page.getByTestId('manage-details').innerText()), 'the sheet opens on Account details')
  ok((await page.getByTestId('manage-details-email').innerText()) === 'jordan@ridgeline.test', 'showing the sign-in email')
  for (const name of ['Edit name', 'Change email', 'Send password reset email']) {
    ok((await page.getByRole('button', { name, exact: true }).count()) === 1, `“${name}” is a clearly named button`)
  }
  ok((await page.locator('input[autocomplete="new-password"]').count()) === 0, 'there is no box to type Jordan’s password')
  ok((await page.getByRole('button', { name: /reset link/i }).count()) === 0, 'and no reset link to copy')

  /* ---- reset email: asked first ---- */
  await page.getByRole('button', { name: 'Send password reset email' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send a password reset email?' })
  await dialog.waitFor({ timeout: 3000 })
  await shot('02-reset-confirm')
  ok(/jordan@ridgeline\.test/.test(await dialog.innerText()), 'the confirmation names the address it will go to')
  ok(/won’t see the link or the password/.test(await dialog.innerText()), 'and says the admin never sees the link or the password')
  ok(await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Cancel'), 'focus starts on Cancel, so Enter does not send')
  ok(state.resetRequests === 0, 'opening the dialog sends nothing')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  ok((await dialog.count()) === 0 && state.resetRequests === 0, 'Escape backs out without a request')
  ok(await page.getByTestId('manage-details').isVisible(), 'and leaves the Manage sheet open')

  /* ---- reset email: sent once ---- */
  await page.getByRole('button', { name: 'Send password reset email' }).click()
  await dialog.waitFor({ timeout: 3000 })
  const send = page.getByTestId('manage-reset-confirm-confirm')
  await send.click()
  await send.click({ force: true, timeout: 1000 }).catch(() => {})
  await page.waitForTimeout(150)
  ok(/Sending…/.test(await send.innerText()) && (await send.isDisabled()), 'while it sends, the button reads Sending… and cannot be pressed again')
  await page.getByTestId('manage-reset-message').waitFor({ timeout: 5000 })
  ok(state.resetRequests === 1, 'a double click made exactly one request', state.resetRequests)
  const sentMsg = await page.getByTestId('manage-reset-message').innerText()
  ok(/Reset email sent to jordan@ridgeline\.test/.test(sentMsg) && /works once/.test(sentMsg), 'success is said beside the button, with the address and the expiry', sentMsg)
  ok((await page.getByTestId('manage-reset-message').getAttribute('role')) === 'status', 'announced politely to a screen reader')
  const visible = await page.locator('body').innerText()
  ok(!/\/(invite|reset)[/#]/.test(visible), 'no link or token is anywhere on screen')
  await shot('03-reset-sent')

  /* ---- reset email: failure is said too ---- */
  state.resetMode = 'mail_not_configured'
  await page.getByRole('button', { name: 'Send password reset email' }).click()
  await dialog.waitFor({ timeout: 3000 })
  await page.getByTestId('manage-reset-confirm-confirm').click()
  await page.waitForTimeout(1200)
  const failMsg = page.getByTestId('manage-reset-message')
  ok((await failMsg.getAttribute('role')) === 'alert' && /Email is not set up/.test(await failMsg.innerText()), 'a refusal is shown as an error, in the server’s words')
  state.resetMode = 'ok'

  /* ---- change email ---- */
  await page.getByRole('button', { name: 'Change email', exact: true }).click()
  const input = page.getByTestId('manage-email-input')
  ok((await input.inputValue()) === 'jordan@ridgeline.test', 'the email field starts with the current address')
  ok(/no verification step/.test(await page.getByTestId('manage-email-form').innerText()), 'and says up front that the change takes effect immediately')
  await input.fill('jordan@ridgeline')
  await input.blur()
  ok(/Enter a valid email address/.test(await page.getByTestId('manage-email-invalid').innerText()), 'a malformed address is caught as it is typed')
  ok(await page.getByTestId('manage-email-continue').isDisabled(), 'and cannot be submitted')
  ok((await input.getAttribute('aria-invalid')) === 'true', 'the field is marked invalid for assistive tech')
  await input.fill('Nadia@ridgeline.test')
  await page.getByTestId('manage-email-continue').click()
  const emailDialog = page.getByRole('dialog', { name: 'Change sign-in email?' })
  await emailDialog.waitFor({ timeout: 3000 })
  const reviewText = await emailDialog.innerText()
  ok(/jordan@ridgeline\.test/.test(reviewText) && /Nadia@ridgeline\.test/.test(reviewText), 'the review shows the old and the new address')
  ok(/takes effect immediately/.test(reviewText) && /password .* stay the same|password and everything else/.test(reviewText), 'and what happens: immediate, password unchanged')
  await shot('04-email-confirm')
  await page.getByTestId('manage-email-confirm-confirm').click()
  await page.getByTestId('manage-details-message').waitFor({ timeout: 5000 })
  ok(/already signs in with that email/.test(await page.getByTestId('manage-details-message').innerText()), 'a duplicate is reported in plain words')
  ok((await input.inputValue()) === 'Nadia@ridgeline.test', 'and what was typed is still there to fix')
  await input.fill('jordan.reyes@ridgeline.test')
  await page.getByTestId('manage-email-continue').click()
  await emailDialog.waitFor({ timeout: 3000 })
  await page.getByTestId('manage-email-confirm-confirm').click()
  await page.waitForTimeout(1200)
  ok(state.emailPosts.at(-1) === 'jordan.reyes@ridgeline.test', 'the new address reaches the server', state.emailPosts.join(', '))
  const changed = await page.getByTestId('manage-details-message').innerText()
  ok(/now signs in with jordan\.reyes@ridgeline\.test/.test(changed) && /password is unchanged/.test(changed) && /emailed both addresses/.test(changed), 'success says the new sign-in, the unchanged password, and that both were told', changed)
  ok((await page.getByTestId('manage-details-email').innerText()) === 'jordan.reyes@ridgeline.test', 'the sheet shows the new address')
  ok((await page.getByTestId('manage-email-form').count()) === 0, 'and the form has closed')
  await shot('05-email-changed')

  /* ---- edit name ---- */
  await page.getByRole('button', { name: 'Edit name', exact: true }).click()
  await page.getByTestId('manage-last-name').fill('Reyes-Garcia')
  await page.getByTestId('manage-name-save').click()
  await page.waitForTimeout(900)
  ok(state.namePosts.at(-1)?.firstName === 'Jordan' && state.namePosts.at(-1)?.lastName === 'Reyes-Garcia', 'first and last name reach the server')
  ok(/Jordan Reyes-Garcia/.test(await page.getByTestId('manage-details-message').innerText()), 'and the sheet confirms the new name')
  ok(state.passwordPosts === 0, 'nothing on this sheet ever posted somebody else’s password')
  ok(await noSideScroll(), 'no sideways scroll on desktop')
  await close()

  /* ---- a person with no password yet ---- */
  await open('Sam Ortiz')
  ok(await page.getByTestId('manage-reset-email').isDisabled(), 'someone still invited is not offered a reset email')
  ok(/hasn’t set a password yet — send their invitation instead/.test(await page.getByTestId('manage-reset-blocked').innerText()), 'and the sheet says to send their invitation instead')
  await page.getByRole('button', { name: 'Change email', exact: true }).click()
  ok(/invitation link stops working/.test(await page.getByTestId('manage-email-form').innerText()), 'changing an invitee’s email warns that their invitation link stops working')
  await shot('06-pending')
  await close()
  await ctx.close()
}

/* ===== phone ================================================================ */
{
  console.log('\n--- phone ---')
  const { ctx, page, open, shot, noSideScroll } = await session({ width: 390, height: 844 }, 'phone')
  await open('Jordan Reyes')
  await shot('01-sheet')
  ok(await noSideScroll(), 'the sheet fits a phone with no sideways scroll')
  const resetBtn = page.getByRole('button', { name: 'Send password reset email' })
  await resetBtn.scrollIntoViewIfNeeded()
  const box = await resetBtn.boundingBox()
  ok(box && box.height >= 36 && box.x >= 0 && box.x + box.width <= 390, 'the reset button is a full-size target inside the screen', box && `${Math.round(box.width)}×${Math.round(box.height)}`)
  await resetBtn.click()
  const dialog = page.getByRole('dialog', { name: 'Send a password reset email?' })
  await dialog.waitFor({ timeout: 3000 })
  const confirm = page.getByTestId('manage-reset-confirm-confirm')
  const cbox = await confirm.boundingBox()
  ok(cbox && cbox.y + cbox.height <= 844 && cbox.x >= 0 && cbox.x + cbox.width <= 390, 'its confirmation dialog fits, with Send on screen')
  await shot('02-reset-confirm')
  await page.getByTestId('manage-reset-confirm-cancel').click()
  await page.getByRole('button', { name: 'Change email', exact: true }).click()
  await page.getByTestId('manage-email-input').fill('j.reyes@ridgeline.test')
  await page.getByTestId('manage-email-continue').click()
  await page.getByRole('dialog', { name: 'Change sign-in email?' }).waitFor({ timeout: 3000 })
  ok(await noSideScroll(), 'the email review fits a phone too')
  await shot('03-email-confirm')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} user-admin check(s) failed` : '\nmanaging a person: named actions, asked first, sent once, nothing leaked')
process.exit(fails.length ? 1 : 0)
