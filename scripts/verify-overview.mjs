import { chromium } from 'playwright'
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
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /^Sign out$/ }).click()
  await page.waitForTimeout(1200)

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

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== overview OK ===')
