import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Where an office role lands, and what the header tells them.
 *
 * Two things, both reported from a real phone.
 *
 * Signing in used to leave you wherever the address bar happened to be. Nothing
 * navigated: the app re-rendered around a user and kept the current URL. Sign
 * out from More and back in and you arrive on More; open a bookmarked lead after
 * a session lapses and you arrive there. For a rep that is odd. For an office
 * role it means missing the Overview entirely — the one screen the role is
 * built around.
 *
 * And the header spent its width on the screen's own name and the date, which
 * is the least useful thing it could hold: an admin knows which app they
 * opened. What a phone shows nowhere else is *which account they are signed in
 * as*, which matters most for the roles that can be signed into more than one.
 *
 * The heading itself is the part worth guarding. Swapping a visible h1 for a
 * person's name would take "Platform" out of the document outline, and the
 * outline is how somebody navigating by heading finds out what screen they are
 * on — so it is still there, and still says the same thing.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const errors = []

/** Sign in as an office role, starting from `from` rather than the root. */
async function signIn(from, match) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${BASE}${from}`, { waitUntil: 'networkidle' })
  await pick(page, match)
  return { ctx, page }
}

/**
 * Sign out from the foot of More, and confirm.
 *
 * It sat in the header on the two home screens for a while, beside the sync
 * chip; the redesign moved it back to the bottom of More, where the menu ends,
 * in words and the destructive colour. It still asks first — see
 * `SignOutButton` for why that is not decoration.
 */
async function signOut(page) {
  await page.locator('a[href="/more"]:visible').first().click()
  await page.waitForTimeout(1000)
  await page.getByTestId('sign-out').click()
  await page.waitForTimeout(800)

  /*
    Checked rather than assumed.

    This used to reach straight for the sheet's button, so a build with no
    confirmation at all made Playwright wait thirty seconds and then throw —
    killing the run with a stack trace instead of a named failure, before a
    single assertion had been recorded. The exit code was still non-zero, but
    "the suite crashed" and "sign-out stopped asking" are not the same message,
    and only one of them tells you what broke.
  */
  const sheet = page.locator('[role="dialog"]').getByRole('button', { name: /^Sign out$/ })
  if ((await sheet.count()) === 0) {
    ok(false, 'signing out asks for confirmation before it acts')
    return
  }
  await sheet.last().click()
  await page.waitForTimeout(1400)
}

async function pick(page, match) {
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button').filter({ hasText: match }).first().click()
  await page.waitForTimeout(1700)
}

/* --- where you land --------------------------------------------------------- */

console.log('--- signing in lands on the home tab ---')

/*
 * Signed out and back in, rather than a cold first run.
 *
 * A first run is useless for this: the walkthrough navigates to its own first
 * step, which is on the home tab, so the URL ends up right whether or not
 * signing in put it there. The first version of this file measured exactly that
 * and passed with the fix taken out.
 *
 * Signing out and back in is also the case somebody actually hits — the
 * walkthrough is done, the address bar still says `/more`, and until this was
 * fixed that is where they came back to.
 */
for (const from of ['/more', '/leads', '/pipeline']) {
  const { ctx, page } = await signIn('/', /Client Admin|Petrov|Admin/)
  await dismissTour(page)
  await page.waitForTimeout(900)

  await signOut(page)

  await page.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await pick(page, /Client Admin|Petrov|Admin/)

  const landed = page.url().replace(BASE, '') || '/'
  ok(landed === '/today', `signing back in from ${from} lands on the home tab`, landed)

  // And it is the Overview, not merely the right URL.
  const body = await page.locator('body').innerText()
  ok(/Open pipeline|Deals won/.test(body), `and the Overview is what renders (${from})`)

  await ctx.close()
}

/* --- signing out lives in the header ----------------------------------------- */

console.log('\n--- sign out ---')

{
  const { ctx, page } = await signIn('/', /Client Admin|Petrov|Admin/)
  await dismissTour(page)
  await page.waitForTimeout(1000)

  // Not in the home header any more: that holds the sync chip and Help.
  const header = page.locator('header').first()
  ok((await header.getByRole('button', { name: 'Sign out', exact: true }).count()) === 0, 'the home header no longer carries sign out, beside the sync chip')
  ok((await header.getByTestId('help-button').count()) === 1, 'and carries Help instead')

  // At the foot of More: named in words, thumb-sized, in the destructive colour.
  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const out = page.getByTestId('sign-out')
  ok((await out.count()) === 1, 'More offers it, once')
  const shape = await out.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const rows = [...document.querySelectorAll('[data-testid], a, button')].filter((x) => x.getBoundingClientRect().height > 0)
    return { h: r.height, text: el.textContent?.trim() ?? '', last: rows.every((x) => x === el || x.contains(el) || x.getBoundingClientRect().top <= r.top + 1 || !x.closest('.content-col')), icons: el.querySelectorAll('svg').length }
  })
  ok(shape.h >= 44, 'at a size a thumb can hit in a truck', `${Math.round(shape.h)}px tall`)
  ok(shape.text === 'Sign out', 'saying what it does in words', shape.text)
  ok(shape.last, 'as the last control in the menu, below everything that is not destructive')

  /*
    It asks. Signing out clears photos that have not uploaded, so the
    confirmation is the assertion that matters wherever the button sits.
  */
  await out.click()
  await page.waitForTimeout(800)
  const asking = await page.locator('body').innerText()
  ok(/Sign out\?/.test(asking), 'and asks before doing it')
  ok(/photos/i.test(asking), 'saying what signing out clears', 'visits, notes and photos')
  ok(
    (await page.getByRole('button', { name: /Stay signed in/ }).count()) > 0,
    'with a way to back out',
  )

  // Backing out leaves you signed in.
  await page.getByRole('button', { name: /Stay signed in/ }).click()
  await page.waitForTimeout(900)
  ok(
    (await page.locator('body').innerText()).includes('Petrov'),
    'and backing out keeps you signed in',
  )

  await ctx.close()
}

/* --- what the header says ---------------------------------------------------- */

console.log('\n--- the header ---')

{
  const { ctx, page } = await signIn('/', /Client Admin|Petrov|Admin/)
  await dismissTour(page)
  await page.waitForTimeout(1200)

  const header = await page.locator('header').first().innerText()

  ok(/Petrov|Nadia/.test(header), 'the header says who is signed in', header.split('\n')[0])
  ok(
    /Client Admin/.test(header) && /Summit Exteriors/.test(header),
    'with their role and the account it belongs to',
  )

  /*
    The date left the header. It is not gone — it moved down to sit opposite
    "Today", where it labels the numbers under it instead of being chrome.
  */
  const dated = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  ok(!header.includes(dated), 'and the date is no longer in it', dated)

  const body = await page.locator('body').innerText()
  ok(body.includes(dated), 'but is still on the screen', dated)

  /*
    Opposite "Today" specifically, not merely somewhere on the page — the whole
    point was to give the number block a date rather than to hide one.
  */
  const sameRow = await page.evaluate((d) => {
    const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent?.trim().startsWith('Today'))
    if (!heading) return false
    const row = heading.parentElement
    return !!row && (row.textContent ?? '').includes(d)
  }, dated)
  ok(sameRow, 'sitting opposite the Today heading')

  /* --- the outline survived --------------------------------------------------- */
  const h1 = await page.evaluate(() => {
    const el = document.querySelector('main h1, header h1')
    return el ? { text: el.textContent?.trim() ?? '', visible: el.getBoundingClientRect().width > 1 } : null
  })
  ok(!!h1, 'the screen still has a heading')
  ok(
    /Summit Exteriors|Platform|Overview/.test(h1?.text ?? ''),
    'naming the screen rather than the person',
    h1?.text,
  )
  ok(h1?.visible === false, 'and it is for screen readers, since the header now shows a face')

  ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors[0]}` : ''}`)
  await ctx.close()
}

/* ========================================================================== */
/* The super admin's own home screen names one account: the real one          */
/* ========================================================================== */
{
  /*
    Three invented companies used to sit here — Summit Exteriors, Bright Path
    Solar and Redline Roofing — inline in the JSX, behind nothing but the role
    check, with rep counts and health labels and no disclaimer. Setup makes the
    first administrator of any deployment a super admin, so this was the first
    screen a new operator saw, and two thirds of their customer list was
    fiction.

    The rule it broke is an old one: no hardcoded users, lists or map data. The
    assertion below is the rule, expressed as a measurement.
  */
  const { ctx, page } = await signIn('/', /Curtis|Super/)
  await page.waitForTimeout(1200)

  const accounts = page.getByTestId('overview-accounts')
  ok((await accounts.count()) === 1, 'a super admin sees an accounts section')
  const rowCount = await accounts.locator('li').count()
  ok(rowCount === 1, 'holding exactly one account — the one this deployment has', `${rowCount} rows`)

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  for (const invented of ['Bright Path Solar', 'Redline Roofing']) {
    ok(!body.includes(invented), `and no invented customer: ${invented} appears nowhere`)
  }
  ok(/people on the team|person on the team/.test(await accounts.innerText()), 'the row counts real people rather than sold seats', (await accounts.innerText()).replace(/\s+/g, ' '))
  await ctx.close()
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== overview OK ===')
