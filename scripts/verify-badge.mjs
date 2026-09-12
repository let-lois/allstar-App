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
 *   the QR code encodes the company's website, and only when there is one;
 *     with none, the badge says what is missing rather than showing nothing
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
/* The badge step draws the real badge: logo, QR to the website, status         */
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
  ok((await page.getByTestId('badge-company').innerText()) === 'Ridgeline Roofing', 'and the company name')
  ok((await page.getByTestId('badge-name').innerText()) === 'Marcus Vance', 'the name from both halves')
  ok(/#32143567/.test(await page.getByTestId('badge-id').innerText()), 'the id', await page.getByTestId('badge-id').innerText())
  ok((await badge.getAttribute('data-status')) === 'awaiting_confirmation' && /awaiting confirmation/i.test(await page.getByTestId('badge-status').innerText()), 'unconfirmed reads as awaiting confirmation', await badge.getAttribute('data-status'))
  const qrEl = page.getByTestId('badge-qr')
  ok((await qrEl.count()) === 1 && (await qrEl.getAttribute('data-target')) === SITE && (await qrEl.getAttribute('href')) === SITE, 'the QR code targets the company website', await qrEl.getAttribute('data-target'))
  const want = expectedQr(SITE)
  const got = await drawnQr(page)
  ok(got && got.n === want.n && got.dark === want.dark && got.dark > 0, 'and what is drawn is the encoder’s grid for that URL — same size, same dark cells', `${got?.n}x${got?.n}, ${got?.dark} dark vs ${want.n}x${want.n}, ${want.dark}`)
  ok((await page.getByTestId('badge-qr-missing').count()) === 0, 'no missing-website message when there is a website')
  const box = await qrEl.boundingBox()
  ok(box && box.width >= 44 && box.height >= 44, 'the code is big enough to scan and to tap', `${Math.round(box?.width ?? 0)}px`)
  await page.getByTestId('badge-confirm').click()
  await page.waitForTimeout(800)
  ok(s.badge?.confirmedAt != null && (await page.getByTestId('onboarding').getAttribute('data-step')) === 'checklist', 'confirming records it and moves on')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* No website, no logo: the badge says so instead of encoding nothing          */
/* ========================================================================== */
{
  const s = readyForBadge({ website: null, logoUrl: null })
  const ctx = await phone()
  const page = await ctx.newPage()
  await mockApi(page, s)
  await signIn(page, s.email)
  await page.waitForTimeout(600)
  ok((await page.getByTestId('badge-qr').count()) === 0, 'no QR code without a website')
  const missing = page.getByTestId('badge-qr-missing')
  ok((await missing.count()) === 1 && /website/i.test(await missing.innerText()) && /admin/i.test(await missing.innerText()), 'and the badge says what is missing and who can fix it', await missing.innerText())
  ok((await page.getByTestId('badge-logo').count()) === 0 && (await page.getByTestId('badge-lockup').innerText()) === 'R', 'a lettered lockup stands in for a logo', await page.getByTestId('badge-lockup').innerText())
  ok(!(await page.getByTestId('badge-confirm').isDisabled()), 'neither gap blocks confirming — the badge is still valid without them')
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

await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== the team badge: drawn once, minted once, renewed and edited from More ===')
