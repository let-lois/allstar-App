import { chromium } from 'playwright'
import qrcode from 'qrcode-generator'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'
import { DAY, makeState, mockApi, body, phone as newPhone, signIn as signInAt, targets } from './lib/onboarding-mock.mjs'

/**
 * The team member badge, everywhere it appears on the phone.
 *
 * One component draws it — in the onboarding step, in More → My badge — so
 * this pins the component's promises once and the two screens' own behaviour
 * around it:
 *   the QR code encodes the badge's own verification URL, as soon as there
 *     is a badge; the company website is a link on that page, not the target
 *   the company's logo heads the badge when set; a lettered lockup when not
 *   viewing a badge never mints one — the id is minted once and read forever
 *   an expired badge offers Renew, and renewal asks for confirmation again
 *   someone from before badges existed can create theirs from More, once
 *   Edit profile changes what the badge prints and nothing the admin owns
 *
 * The API is the same stateful mock the onboarding gate runs on.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const phone = (extra = {}) => newPhone(browser, extra)
const signIn = (page, email) => signInAt(page, BASE, email)
const errorsOf = (page) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

const SITE = 'https://ridgelineroofing.com'
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** What the encoder says the code for this text looks like. */
function expectedQr(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let dark = 0
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark += 1
  return { n, dark }
}
/** What the page drew: grid size from the viewBox, dark cells from the path's runs. */
async function drawnQr(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="badge-qr"] svg')
    if (!svg) return null
    const [, , w] = (svg.getAttribute('viewBox') || '').split(' ').map(Number)
    const d = svg.querySelector('path')?.getAttribute('d') || ''
    const dark = [...d.matchAll(/h(\d+)v1/g)].reduce((s, m) => s + Number(m[1]), 0)
    return { n: w, dark }
  })
}

const readyForBadge = (over = {}) =>
  makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, setupAt: Date.now() - DAY, location: 'granted', walkAt: Date.now() - DAY,
    step: 'badge', started: true, website: SITE, logoUrl: LOGO, ...over,
  })

/* ========================================================================== */
/* The badge step draws the real badge: logo, QR to its own check, status       */
/* ========================================================================== */
{
  const s = readyForBadge()
  const ctx = await phone()
  const page = await ctx.newPage()
  const errors = errorsOf(page)
  await mockApi(page, s)
  await signIn(page, s.email)
  const badge = page.getByTestId('team-badge')
  await page.waitForTimeout(600)
  ok((await page.getByTestId('onboarding').getAttribute('data-step')) === 'badge' && (await badge.count()) === 1, 'the badge step shows the team badge')
  ok((await page.getByTestId('badge-logo').count()) === 1 && (await page.getByTestId('badge-lockup').count()) === 0, 'headed by the company logo when the admin set one')
  ok((await page.getByTestId('badge-company').textContent()) === 'Ridgeline Roofing', 'and the company name')
  const kind = (await page.getByTestId('badge-kind').count()) ? (await page.getByTestId('badge-kind').innerText()).trim() : '(none)'
  ok(/^team member$/i.test(kind), 'headed TEAM MEMBER on the blue band', kind)
  ok((await page.getByTestId('badge-photo').getAttribute('data-state')) === 'present', 'the face on the card is the profile photo', await page.getByTestId('badge-photo').getAttribute('data-state'))
  ok(/^sales representative$/i.test((await page.getByTestId('badge-title').innerText()).trim()), 'title under the name')
  {
    const issued = await page.getByTestId('badge-issued').innerText()
    const expires = await page.getByTestId('badge-expires').innerText()
    const yearOf = (t) => Number(t.split('/')[2])
    ok(/^\d{2}\/\d{2}\/\d{4}$/.test(issued) && /^\d{2}\/\d{2}\/\d{4}$/.test(expires) && yearOf(expires) - yearOf(issued) === 1, 'ISSUED and EXPIRES are dated, a year apart', `${issued} → ${expires}`)
  }
  {
    const card = await badge.boundingBox()
    const bg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor)
    ok(card && card.height > card.width * 1.35 && bg === 'rgb(255, 255, 255)', 'the card is a white portrait', `${Math.round(card?.width ?? 0)}x${Math.round(card?.height ?? 0)} ${bg}`)
  }
  ok((await page.getByTestId('badge-name').textContent()) === 'Marcus Vance', 'the name from both halves')
  ok(/#32143567/.test(await page.getByTestId('badge-id').innerText()), 'the id', await page.getByTestId('badge-id').innerText())
  ok((await badge.getAttribute('data-status')) === 'awaiting_confirmation' && /awaiting confirmation/i.test(await page.getByTestId('badge-status').innerText()), 'unconfirmed reads as awaiting confirmation', await badge.getAttribute('data-status'))
  const qrEl = page.getByTestId('badge-qr')
  const VERIFY = `${BASE}/verify/32143567`
  ok((await qrEl.count()) === 1 && (await qrEl.getAttribute('data-target')) === VERIFY && (await qrEl.getAttribute('href')) === VERIFY, 'with no company QR link set, the QR code targets this badge’s own verification page', await qrEl.getAttribute('data-target'))
  ok((await qrEl.getAttribute('data-target-kind')) === 'verify', 'and says so', await qrEl.getAttribute('data-target-kind'))
  const want = expectedQr(VERIFY)
  const got = await drawnQr(page)
  ok(got && got.n === want.n && got.dark === want.dark && got.dark > 0, 'and what is drawn is the encoder’s grid for that URL — same size, same dark cells', `${got?.n}x${got?.n}, ${got?.dark} dark vs ${want.n}x${want.n}, ${want.dark}`)
  ok((await page.getByTestId('badge-qr-missing').count()) === 0, 'no placeholder once there is a badge')
  const box = await qrEl.boundingBox()
  ok(box && box.width >= 44 && box.height >= 44, 'the code is big enough to scan and to tap', `${Math.round(box?.width ?? 0)}px`)
  await page.getByTestId('badge-confirm').click()
  await page.waitForTimeout(800)
  ok(s.badge?.confirmedAt != null && (await page.getByTestId('onboarding').getAttribute('data-step')) === 'checklist', 'confirming records it and moves on')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* No website, no logo: the code still works, because it never needed either  */
/* ========================================================================== */
{
  const s = readyForBadge({ website: null, logoUrl: null })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await page.waitForTimeout(600)
  ok((await page.getByTestId('badge-qr').count()) === 1 && (await page.getByTestId('badge-qr').getAttribute('data-target')) === `${BASE}/verify/32143567`, 'the QR code is there with no website — it points at the badge’s check, not at a site')
  ok((await page.getByTestId('badge-qr-missing').count()) === 0, 'and no placeholder')
  ok((await page.getByTestId('badge-logo').count()) === 0 && (await page.getByTestId('badge-lockup').textContent()) === 'Ridgeline Roofing', 'the company name, in the official lockup, stands in for a logo', await page.getByTestId('badge-lockup').textContent())
  ok(!(await page.getByTestId('badge-confirm').isDisabled()), 'neither gap blocks confirming — the badge is valid without them')
  await ctx.close()
}

/* ========================================================================== */
/* The company's own QR code: once the admin pastes its link, every badge      */
/* draws that code — the one the company already runs, scans counted there   */
/* ========================================================================== */
{
  const COMPANY_QR = 'https://link.ridgeline.test/qr/8f2k1'
  const s = readyForBadge({ badgeQrUrl: COMPANY_QR })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await page.waitForTimeout(600)
  const qrEl = page.getByTestId('badge-qr')
  ok((await qrEl.count()) === 1 && (await qrEl.getAttribute('data-target')) === COMPANY_QR && (await qrEl.getAttribute('href')) === COMPANY_QR, 'the QR code targets the company’s link, not the verification page', await qrEl.getAttribute('data-target'))
  ok((await qrEl.getAttribute('data-target-kind')) === 'company', 'and says whose it is', await qrEl.getAttribute('data-target-kind'))
  const want = expectedQr(COMPANY_QR)
  const got = await drawnQr(page)
  ok(got && got.n === want.n && got.dark === want.dark && got.dark > 0, 'and what is drawn is the encoder’s grid for that link', `${got?.n}x${got?.n}, ${got?.dark} dark vs ${want.n}x${want.n}, ${want.dark}`)
  ok(/Ridgeline Roofing/.test((await qrEl.getAttribute('aria-label')) ?? ''), 'the code is labelled as the company’s for screen readers', await qrEl.getAttribute('aria-label'))
  ok(/#32143567/.test(await page.getByTestId('badge-id').innerText()), 'the id is still printed, so the badge can still be looked up by number')
  await ctx.close()
}

/* ========================================================================== */
/* No photo: the card shows where the face goes, and will not be confirmed    */
/* ========================================================================== */
{
  const s = readyForBadge({ hasPhoto: false })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await page.waitForTimeout(600)
  ok((await page.getByTestId('badge-photo').getAttribute('data-state')) === 'missing', 'with no photo the card shows a placeholder where the face goes', await page.getByTestId('badge-photo').getAttribute('data-state'))
  ok((await page.getByTestId('badge-needs-photo').count()) === 1, 'and says a photo is needed before confirming')
  ok(await page.getByTestId('badge-confirm').isDisabled(), 'Confirm badge information is disabled')
  await page.getByTestId('badge-confirm').click({ force: true }).catch(() => {})
  await page.waitForTimeout(300)
  ok(s.badge?.confirmedAt == null, 'and forcing a tap on it confirms nothing')
  const addPhoto = page.getByTestId('badge-add-photo')
  ok((await addPhoto.count()) === 1, 'and offers Add your photo')
  await ((await addPhoto.count()) ? addPhoto : page.getByRole('button', { name: /Fix your name or title/ })).click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(400)
  ok((await page.getByTestId('onboarding').getAttribute('data-step')) === 'profile', 'Add your photo goes to the profile, where the picker is')
  await ctx.close()
}

/* ========================================================================== */
/* The verification page: a stranger with a phone, no account, five answers   */
/* ========================================================================== */
{
  const people = {
    32143567: { status: 'active', badge: { id: '32143567', issuedAt: Date.now() - 2 * DAY, expiresAt: Date.now() + 363 * DAY }, person: { name: 'Marcus Vance', title: 'Sales Representative', photoUrl: LOGO }, company: { name: 'Ridgeline Roofing', logoUrl: LOGO, website: SITE } },
    41234567: { status: 'expired', badge: { id: '41234567', issuedAt: Date.now() - 400 * DAY, expiresAt: Date.now() - 35 * DAY }, person: { name: 'Sam Okafor', title: 'Sales Representative' }, company: { name: 'Ridgeline Roofing' } },
    51234567: { status: 'pending', badge: { id: '51234567', issuedAt: Date.now() - DAY, expiresAt: Date.now() + 364 * DAY }, person: { name: 'Dana Whitfield' }, company: { name: 'Ridgeline Roofing' } },
    61234567: { status: 'inactive', badge: { id: '61234567', issuedAt: Date.now() - 200 * DAY, expiresAt: Date.now() + 165 * DAY }, person: { name: 'Lee Tran' }, company: { name: 'Ridgeline Roofing' } },
  }
  let lookups = 0
  const ctx = await phone()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Sign in.' }) }))
  await page.route('**/api/verify?*', (r) => {
    lookups += 1
    const id = new URL(r.request().url()).searchParams.get('badge')
    if (id === '99999999') return r.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '600' }, body: JSON.stringify({ error: 'Too many lookups.' }) })
    const hit = people[id]
    return r.fulfill(hit ? { status: 200, contentType: 'application/json', body: JSON.stringify(hit) } : { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No badge with that number.' }) })
  })
  const open = async (id) => {
    await page.goto(`${BASE}/verify/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    return page.getByTestId('verify-page')
  }
  let v = await open('32143567')
  ok((await v.count()) === 1 && (await page.getByTestId('onboarding').count()) === 0 && (await page.locator('input[type="email"]').count()) === 0, 'the page renders with no sign-in and no app around it')
  ok(lookups === 1 && (await v.getAttribute('data-state')) === 'active' && /valid/i.test(await page.getByTestId('verify-verdict').innerText()), 'an active badge is called valid', await v.getAttribute('data-state'))
  ok((await page.getByTestId('badge-name').textContent()) === 'Marcus Vance' && /Ridgeline Roofing/.test(await body(page)) && /#32143567/.test(await page.getByTestId('badge-id').innerText()), 'with the name, the company and the number to compare against the badge in hand')
  ok((await page.getByTestId('badge-qr').count()) === 0, 'and no QR code — a code to the page you are on is noise')
  ok((await page.getByTestId('verify-website').count()) === 1 && (await page.getByTestId('verify-website').getAttribute('href')) === SITE, 'the company website is a link when the company set one')
  const small = await targets(page)
  ok(small.length === 0, 'every target is at least 44px', small.join(', '))
  v = await open('41234567')
  ok((await v.getAttribute('data-state')) === 'expired' && /expired/i.test(await page.getByTestId('verify-verdict').innerText()) && (await page.getByTestId('verify-website').count()) === 0, 'an expired badge says so, and no website link when none is set')
  v = await open('51234567')
  ok((await v.getAttribute('data-state')) === 'pending' && /not active yet/i.test(await page.getByTestId('verify-verdict').innerText()), 'an unconfirmed badge reads as not active yet')
  v = await open('61234567')
  ok((await v.getAttribute('data-state')) === 'inactive' && /no longer/i.test(await page.getByTestId('verify-verdict').innerText()) && (await page.getByTestId('badge-name').textContent()) === 'Lee Tran', 'a removed team member’s badge reads as no longer valid, with the name')
  v = await open('71234567')
  ok((await v.getAttribute('data-state')) === 'unknown' && /no badge with this number/i.test(await page.getByTestId('verify-verdict').innerText()) && (await page.getByTestId('team-badge').count()) === 0, 'a number nobody holds says so and draws no badge')
  v = await open('99999999')
  ok((await v.getAttribute('data-state')) === 'limited' && /too many/i.test(await page.getByTestId('verify-verdict').innerText()), 'a rate-limited caller is told to wait, not shown an error')
  await page.goto(`${BASE}/verify/abc`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  ok((await page.getByTestId('verify-page').count()) === 0, 'a malformed path is not the verification page')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* More → My badge: reading never mints                                        */
/* ========================================================================== */
{
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - DAY, version: 1, step: null, started: true, website: SITE,
    badge: { id: '32143567', issuedAt: Date.now() - 2 * DAY, expiresAt: Date.now() + 363 * DAY, confirmedAt: Date.now() - DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  const errors = errorsOf(page)
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  const link = page.getByRole('button', { name: /^My badge$/ })
  ok((await link.count()) === 1, 'More offers My badge to a signed-in rep')
  await link.click()
  await page.waitForTimeout(700)
  ok(/\/badge$/.test(page.url()), 'which opens the badge screen', page.url())
  const badge = page.getByTestId('team-badge')
  ok((await badge.getAttribute('data-status')) === 'active' && /#32143567/.test(await page.getByTestId('badge-id').innerText()), 'showing the active badge with its id', await badge.getAttribute('data-status'))
  ok(s.mints === 0, 'and looking at it minted nothing', `${s.mints}`)
  ok((await page.getByTestId('badge-active-copy').count()) === 1 && (await page.getByTestId('badge-create').count()) === 0 && (await page.getByTestId('badge-renew').count()) === 0, 'an active badge offers no button — there is nothing to do to it')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok(s.mints === 0 && /#32143567/.test(await page.getByTestId('badge-id').innerText()), 'reopening reads the same id and still mints nothing', `${s.mints}`)
  const small = await targets(page)
  ok(small.length === 0, 'every target on the badge screen is at least 44px', small.join(', '))
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* An expired badge: Renew keeps the id, then asks for confirmation again      */
/* ========================================================================== */
{
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - 400 * DAY, version: 1, step: null, started: true, website: SITE,
    badge: { id: '32143567', issuedAt: Date.now() - 400 * DAY, expiresAt: Date.now() - 35 * DAY, confirmedAt: Date.now() - 399 * DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  ok((await page.getByTestId('onboarding').count()) === 0, 'an expired badge does not reopen onboarding — that is a badge matter, not a setup one')
  await dismissTour(page)
  await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const badge = page.getByTestId('team-badge')
  ok((await badge.getAttribute('data-status')) === 'expired' && /expired/i.test(await page.getByTestId('badge-status').innerText()), 'the badge reads as expired', await badge.getAttribute('data-status'))
  ok((await page.getByTestId('badge-renew').count()) === 1 && (await page.getByTestId('badge-confirm').count()) === 0, 'and offers Renew, not Confirm')
  await page.getByTestId('badge-renew').click()
  await page.waitForTimeout(900)
  ok(s.renews === 1 && s.badge.id === '32143567', 'renewing kept the id', `${s.renews} renew, #${s.badge.id}`)
  ok((await badge.getAttribute('data-status')) === 'awaiting_confirmation' && (await page.getByTestId('badge-confirm').count()) === 1, 'and the renewed badge waits to be confirmed again', await badge.getAttribute('data-status'))
  await page.getByTestId('badge-confirm').click()
  await page.waitForTimeout(900)
  ok((await badge.getAttribute('data-status')) === 'active' && s.mints === 0, 'confirmed — active again, with nothing minted along the way', `${s.mints} mints`)
  await ctx.close()
}

/* ========================================================================== */
/* Someone from before badges: create it from More, once                      */
/* ========================================================================== */
{
  const s = makeState({
    firstName: 'Dana', lastName: 'Whitfield', hasPhoto: true, completedAt: Date.now() - 200 * DAY, version: 1, step: null, started: true, website: SITE, badge: null,
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  ok((await page.getByTestId('onboarding').count()) === 0, 'a backfilled account is not sent through onboarding for want of a badge')
  await dismissTour(page)
  await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const badge = page.getByTestId('team-badge')
  ok((await badge.getAttribute('data-status')) === 'none' && /no badge yet/i.test(await page.getByTestId('badge-id').innerText()), 'the screen shows there is no badge yet', await page.getByTestId('badge-id').innerText())
  ok(s.mints === 0 && (await page.getByTestId('badge-create').count()) === 1, 'opening the screen minted nothing; a button offers to')
  await page.getByTestId('badge-create').click()
  await page.waitForTimeout(900)
  ok(s.mints === 1 && (await badge.getAttribute('data-status')) === 'awaiting_confirmation' && /#32143567/.test(await page.getByTestId('badge-id').innerText()), 'Create mints once and shows the id', `${s.mints}`)
  await page.getByTestId('badge-confirm').click()
  await page.waitForTimeout(900)
  ok((await badge.getAttribute('data-status')) === 'active' && s.badge.confirmedAt != null, 'and confirming activates it')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok(s.mints === 1, 'reopening does not mint again', `${s.mints}`)
  await ctx.close()
}

/* ========================================================================== */
/* Edit profile: what the badge prints is theirs; the rest is the admin's     */
/* ========================================================================== */
{
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - DAY, version: 1, step: null, started: true, website: SITE,
    badge: { id: '32143567', issuedAt: Date.now() - 2 * DAY, expiresAt: Date.now() + 363 * DAY, confirmedAt: Date.now() - DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  const errors = errorsOf(page)
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByTestId('badge-edit-profile').click()
  await page.waitForTimeout(700)
  ok(/\/profile$/.test(page.url()) && (await page.getByTestId('profile-form').count()) === 1, 'the badge screen hands off to Edit profile', page.url())
  const locked = page.getByTestId('profile-locked')
  const lockedText = await locked.innerText()
  ok(/Email/.test(lockedText) && /marcus@ridgeline\.test/.test(lockedText) && /Role/.test(lockedText) && /Field Rep/.test(lockedText) && /Austin/.test(lockedText), 'email, role and team are shown as facts', lockedText.replace(/\s+/g, ' '))
  ok((await page.locator('input[type="email"]').count()) === 0 && (await locked.locator('input, select').count()) === 0, 'and none of them is a field')
  ok((await page.getByTestId('profile-first').inputValue()) === 'Marcus' && (await page.getByTestId('profile-title').inputValue()) === 'Sales Representative', 'the editable fields arrive filled in')
  await page.getByTestId('profile-title').fill('Senior Sales Representative')
  await page.getByTestId('profile-save').click()
  await page.waitForTimeout(900)
  ok(s.profilePatches.length === 1 && s.profilePatches[0].jobTitle === 'Senior Sales Representative' && s.profilePatches[0].firstName === 'Marcus', 'Save sends the four editable fields to the profile endpoint', JSON.stringify(s.profilePatches[0]))
  ok(!('email' in (s.profilePatches[0] ?? {})) && !('role' in (s.profilePatches[0] ?? {})), 'and nothing the admin owns')
  ok((await page.getByTestId('profile-saved').count()) === 1, 'and says it took')
  await page.getByRole('button', { name: /See my badge/ }).click()
  await page.waitForTimeout(800)
  ok(/senior sales representative/i.test(await page.getByTestId('badge-title').innerText()), 'the badge prints the new title', await page.getByTestId('badge-title').innerText())
  const small = await targets(page)
  ok(small.length === 0, 'every target on the profile screen is at least 44px', small.join(', '))
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  void body
  await ctx.close()
}

/* ========================================================================== */
/* Today nudges someone from before badges, once, and remembers "not now"      */
/* ========================================================================== */
{
  const s = makeState({
    firstName: 'Dana', lastName: 'Whitfield', hasPhoto: true, completedAt: Date.now() - 200 * DAY, version: 1, step: null, started: true, website: SITE, badge: null,
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.waitForTimeout(500)
  const nudge = page.getByTestId('badge-nudge')
  // Absence is a failure to report, not a locator to wait thirty seconds on.
  const shown = (await nudge.count()) === 1
  ok(shown && (await nudge.getAttribute('data-reason')) === 'none' && /Create your team badge/.test(await body(page)), 'Today tells a backfilled rep they have no badge yet', shown ? await nudge.getAttribute('data-reason') : 'no card')
  ok(s.mints === 0, 'and the card itself minted nothing', `${s.mints}`)
  if (shown) {
  await nudge.getByTestId('badge-nudge-go').click()
  await page.waitForTimeout(700)
  ok(/\/badge$/.test(page.url()) && (await page.getByTestId('badge-create').count()) === 1, 'its button opens My badge, where Create is', page.url())
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await nudge.getByTestId('badge-nudge-dismiss').click()
  await page.waitForTimeout(400)
  ok((await nudge.count()) === 0, 'Not now removes the card')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok((await nudge.count()) === 0, 'and it stays gone after a reload — a rep is not asked every morning')
  // The reason changes: the badge exists but has since expired. That is a new fact, and a new card.
  s.badge = { id: '32143567', issuedAt: Date.now() - 400 * DAY, expiresAt: Date.now() - DAY, confirmedAt: Date.now() - 399 * DAY }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const back = (await nudge.count()) === 1
  ok(back && (await nudge.getAttribute('data-reason')) === 'expired' && /expired/i.test(await nudge.innerText()), 'an expired badge is a new reason, so the card returns and says why', back ? await nudge.getAttribute('data-reason') : 'no card')
  }
  await ctx.close()
}

/* Someone with an active badge is never nudged. */
{
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - DAY, version: 1, step: null, started: true, website: SITE,
    badge: { id: '32143567', issuedAt: Date.now() - 2 * DAY, expiresAt: Date.now() + 363 * DAY, confirmedAt: Date.now() - DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.waitForTimeout(500)
  ok((await page.getByTestId('badge-nudge').count()) === 0, 'no card for someone whose badge is active')
  await ctx.close()
}

/* ========== the badge as a card, and as a file ============================ */
//
// A badge is a CR80 card — 2.125 by 3.375 inches, the plastic every ID
// printer is built for — and the screen and the download are the same card
// at different sizes. The preview is measured for its ratio and for the code
// being between three-quarters of an inch and an inch of it; the file is
// captured on its way to the download, decoded, measured at 300 dpi, and its
// code is found where the drawing put it, on whole pixels, with the three
// finder patterns a scanner locks onto.
{
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: true, completedAt: Date.now() - 30 * DAY, version: 1, step: null, started: true,
    badge: { id: '32143567', issuedAt: Date.now() - 30 * DAY, expiresAt: Date.now() + 335 * DAY, confirmedAt: Date.now() - 30 * DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  const errors = errorsOf(page)
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const card = await page.getByTestId('team-badge').boundingBox()
  const ratio = card ? card.height / card.width : 0
  ok(Math.abs(ratio - 3.375 / 2.125) < 0.02, 'the preview is a CR80 card — 2.125 by 3.375, portrait', ratio.toFixed(3))
  const qrBox = await page.getByTestId('badge-qr').boundingBox()
  const qrIn = card && qrBox ? (qrBox.width / card.width) * 2.125 : 0
  ok(qrIn >= 0.75 && qrIn <= 1.0, 'the code is between three-quarters of an inch and an inch of the card', `${qrIn.toFixed(2)}in of 2.125`)
  ok(!!qrBox && Math.abs(qrBox.width - qrBox.height) < 1, 'and square', qrBox ? `${Math.round(qrBox.width)}×${Math.round(qrBox.height)}` : 'none')

  // Catch the file on its way out: the blob at createObjectURL, the name at
  // the anchor's click, and no real download in a headless browser.
  await page.evaluate(() => {
    const orig = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b) => {
      window.__badgeBlob = b
      return orig(b)
    }
    HTMLAnchorElement.prototype.click = function () {
      window.__badgeName = this.download
    }
  })
  const dl = page.getByTestId('badge-download')
  ok((await dl.count()) === 1 && /Download badge/.test(await dl.innerText()), 'Download badge is offered')
  await dl.click()
  await page.waitForFunction(() => !!window.__badgeName, null, { timeout: 15_000 }).catch(() => {})

  const VERIFY = `${BASE}/verify/32143567`
  const qr = qrcode(0, 'M')
  qr.addData(VERIFY)
  qr.make()
  const n = qr.getModuleCount()
  // The code's own zone on the file (badge-image.ts): up to 0.89in on whole
  // pixels, never under 0.75in, 0.15in from the right and 0.08in from the
  // bottom — below the rule that ends the name and title.
  const fit = Math.floor(267 / (n + 8))
  const cell = fit * (n + 8) >= 225 ? fit : Math.ceil(225 / (n + 8))
  const size = cell * (n + 8)
  const geometry = { n, cell, size, qx: 638 - 45 - size, qy: 1013 - 24 - size, origin: 4 * cell }
  const png = await page.evaluate(async (g) => {
    const b = window.__badgeBlob
    if (!b) return null
    const bmp = await createImageBitmap(b)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx2 = c.getContext('2d')
    ctx2.drawImage(bmp, 0, 0)
    const at = (x, y) => ctx2.getImageData(Math.round(x), Math.round(y), 1, 1).data
    const dark = (x, y) => {
      const d = at(x, y)
      return d[0] < 90 && d[1] < 90 && d[2] < 90
    }
    const white = (x, y) => {
      const d = at(x, y)
      return d[0] > 230 && d[1] > 230 && d[2] > 230
    }
    const m = (col, row) => [g.qx + g.origin + (col + 0.5) * g.cell, g.qy + g.origin + (row + 0.5) * g.cell]
    const last = g.n - 1
    return {
      type: b.type,
      w: bmp.width,
      h: bmp.height,
      name: window.__badgeName,
      cornerClear: at(0, 0)[3] === 0,
      quiet: white(g.qx + g.cell / 2, g.qy + g.cell / 2) && white(g.qx + g.size - g.cell / 2, g.qy + g.size - g.cell / 2),
      finders: dark(...m(0, 0)) && dark(...m(last, 0)) && dark(...m(0, last)),
      rings: white(...m(1, 1)) && white(...m(last - 1, 1)) && white(...m(1, last - 1)),
      centres: dark(...m(3, 3)) && dark(...m(last - 3, 3)) && dark(...m(3, last - 3)),
      band: (() => {
        const d = at(60, 40) // left of the slot pill, which is white
        return d[0] < 60 && d[1] < 140 && d[2] > 180
      })(),
    }
  }, geometry)
  ok(png?.type === 'image/png' && /^allstar-badge-32143567\.png$/.test(png?.name ?? ''), 'a PNG, named after the badge', png?.name)
  ok(png?.w === 638 && png?.h === 1013, 'at CR80 size — 2.125 by 3.375 inches at 300 dpi', `${png?.w}×${png?.h}`)
  ok(!!png?.cornerClear, 'with the corners cut, so it prints as a card and not a rectangle')
  ok(!!png?.band, 'the blue band is across the top')
  ok(size / 300 >= 0.75 && size / 300 <= 1.0, 'the code on the file is between three-quarters of an inch and an inch', `${(size / 300).toFixed(2)}in, ${cell}px cells`)
  ok(!!png?.quiet, 'with a white quiet zone around it')
  ok(!!png?.finders && !!png?.rings && !!png?.centres, 'and all three finder patterns where a scanner looks for them', JSON.stringify({ finders: png?.finders, rings: png?.rings, centres: png?.centres }))
  ok(errors.length === 0, 'no page errors making the file', errors.join(' | '))
  await ctx.close()
}
{
  // No photo yet: the placeholder's initials sit in a true circle, on the
  // screen at any width. A stretched circle is the first thing a stretched
  // card gives away.
  const s = makeState({
    firstName: 'Marcus', lastName: 'Vance', hasPhoto: false, completedAt: Date.now() - 30 * DAY, version: 1, step: null, started: true,
    badge: { id: '32143567', issuedAt: Date.now() - 30 * DAY, expiresAt: Date.now() + 335 * DAY },
  })
  for (const width of [320, 390, 430]) {
    const ctx = await phone({ viewport: { width, height: 844 } })
    const page = await ctx.newPage()
    await mockApi(page, s)
    await signIn(page, s.email)
    await dismissTour(page)
    await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    const circle = await page.getByTestId('badge-initials').boundingBox()
    const card = await page.getByTestId('team-badge').boundingBox()
    ok(
      !!circle && Math.abs(circle.width - circle.height) < 1 && !!card && Math.abs(card.height / card.width - 3.375 / 2.125) < 0.02,
      `at ${width}px the initials are a circle and the card is still a card`,
      circle ? `${Math.round(circle.width)}×${Math.round(circle.height)}, ratio ${(card.height / card.width).toFixed(3)}` : 'no circle',
    )
    const qrBox = await page.getByTestId('badge-qr').boundingBox()
    ok(!!qrBox && qrBox.width >= 44, `and the code stays tappable and scannable at ${width}px`, qrBox ? `${Math.round(qrBox.width)}px` : 'none')
    await ctx.close()
  }
}

/* ========================================================================== */
/* Nothing overlaps: the code keeps to its own zone, whatever the name         */
/* ========================================================================== */
{
  /*
    The code was pinned to the bottom-right corner across the name and the
    title, so any name long enough to reach it ran underneath. Every width a
    phone comes in, a short and a long and a very long name, a long title, with
    and without a photo — and on the saved file as well as the screen.
  */
  const people = [
    { firstName: 'Al', lastName: 'Ng', jobTitle: 'Rep', hasPhoto: true, tag: 'short name' },
    { firstName: 'Marcus', lastName: 'Vance-Whitfield', jobTitle: 'Senior Sales Representative', hasPhoto: true, tag: 'long name, long title' },
    { firstName: 'Bartholomew', lastName: 'Montgomery-Fitzwilliams', jobTitle: 'Regional Director of Residential Exterior Sales Operations', hasPhoto: false, tag: 'very long name and title, no photo' },
  ]
  const intersects = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  for (const person of people) {
    const s = makeState({
      ...person, completedAt: Date.now() - 30 * DAY, version: 1, step: null, started: true,
      badge: { id: '32143567', issuedAt: Date.now() - 30 * DAY, expiresAt: Date.now() + 335 * DAY },
    })
    const problems = []
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
      const ctx = await phone({ viewport: { width, height } })
      const page = await ctx.newPage()
      await mockApi(page, s)
      await signIn(page, s.email)
      await dismissTour(page)
      await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)
      const box = async (id) => page.getByTestId(id).boundingBox()
      const [card, qr, nm, ttl, rule, details, photo] = await Promise.all(['team-badge', 'badge-qr', 'badge-name', 'badge-title', 'badge-rule', 'badge-details', 'badge-photo'].map(box))
      const text = await page.evaluate(() => {
        const read = (id) => {
          const e = document.querySelector(`[data-testid="${id}"]`)
          return { font: Number(e?.dataset.fontCqw), clipped: !!e && e.scrollWidth > e.clientWidth + 1, px: e ? parseFloat(getComputedStyle(e).fontSize) : 0 }
        }
        return { name: read('badge-name'), title: read('badge-title') }
      })
      const at = `${width}×${height}`
      if (!qr || !card) { problems.push(`${at}: no code`); await ctx.close(); continue }
      if (intersects(qr, nm)) problems.push(`${at}: code over the name`)
      if (intersects(qr, ttl)) problems.push(`${at}: code over the title`)
      if (intersects(qr, photo)) problems.push(`${at}: code over the photo`)
      if (rule && qr.y < rule.y) problems.push(`${at}: code starts above the rule`)
      if (qr.x < card.x || qr.x + qr.width > card.x + card.width + 0.5 || qr.y + qr.height > card.y + card.height + 0.5) problems.push(`${at}: code leaves the card`)
      if (details && intersects(qr, details)) problems.push(`${at}: code over the ID and dates`)
      if (nm && ttl && nm.y + nm.height > ttl.y + 0.5) problems.push(`${at}: name runs into the title`)
      if (nm && nm.x + nm.width > card.x + card.width) problems.push(`${at}: name leaves the card`)
      const qrIn = (qr.width / card.width) * 2.125
      if (qrIn < 0.75) problems.push(`${at}: code only ${qrIn.toFixed(2)}in`)
      // Readable: a name shrinks before it is cut, and never below the floor.
      if (text.name.px < 11) problems.push(`${at}: name at ${text.name.px}px`)
      if (text.title.px < 8) problems.push(`${at}: title at ${text.title.px}px`)
      if (person.tag === 'short name' && text.name.clipped) problems.push(`${at}: a short name was cut`)
      await ctx.close()
    }
    ok(problems.length === 0, `${person.tag}: at 320, 375, 390 and 430 the code keeps to its own zone, clear of the name, title, photo and dates, at 0.75in or more`, problems.join(' | ') || 'clean')
  }

  // The saved file: the name and title end above the code, and the code is whole.
  const s = makeState({
    firstName: 'Bartholomew', lastName: 'Montgomery-Fitzwilliams', jobTitle: 'Regional Director of Residential Exterior Sales Operations', hasPhoto: true,
    completedAt: Date.now() - 30 * DAY, version: 1, step: null, started: true,
    badge: { id: '32143567', issuedAt: Date.now() - 30 * DAY, expiresAt: Date.now() + 335 * DAY },
  })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await dismissTour(page)
  await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const orig = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b) => { window.__badgeBlob = b; return orig(b) }
    HTMLAnchorElement.prototype.click = function () { window.__badgeName = this.download }
  })
  await page.getByTestId('badge-download').click()
  await page.waitForFunction(() => !!window.__badgeName, null, { timeout: 15_000 }).catch(() => {})
  const VERIFY = `${BASE}/verify/32143567`
  const q = qrcode(0, 'M'); q.addData(VERIFY); q.make()
  const n = q.getModuleCount()
  const fit = Math.floor(267 / (n + 8))
  const cell = fit * (n + 8) >= 225 ? fit : Math.ceil(225 / (n + 8))
  const size = cell * (n + 8)
  const g = { qx: 638 - 45 - size, qy: 1013 - 24 - size, size }
  const file = await page.evaluate(async (g) => {
    const b = window.__badgeBlob
    if (!b) return null
    const bmp = await createImageBitmap(b)
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0)
    // Ink in the name and title band (2.05–2.36in), and whether any of it
    // reaches as low as the code's top edge or into its columns.
    const ink = (x0, y0, x1, y1) => {
      const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 120 && d[i + 1] < 160) n++
      return n
    }
    return {
      nameInk: ink(60, 615, 578, 710),
      // The strip between the rule and the code, across the code's columns: nothing drawn there.
      aboveCode: ink(g.qx, 718, g.qx + g.size, g.qy),
      // The code's own quiet zone, top row of it: white.
      quietTop: ink(g.qx, g.qy, g.qx + g.size, g.qy + 4 * Math.max(1, Math.floor(g.size / 50))),
    }
  }, g)
  ok(!!file && file.nameInk > 500, 'the saved badge draws the name and title in their band', JSON.stringify(file))
  ok(!!file && g.qy >= 718, 'and the code starts below the rule that ends them', `code top at ${(g.qy / 300).toFixed(2)}in`)
  ok(!!file && file.aboveCode === 0 && file.quietTop === 0, 'with nothing drawn between the rule and the code, or in its quiet zone', JSON.stringify(file))
  ok(size / 300 >= 0.75 && size / 300 <= 1.0, 'at a scannable size', `${(size / 300).toFixed(2)}in`)
  await ctx.close()
}

await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== the team badge: drawn once, minted once, checked by a stranger, renewed and edited from More ===')
