import { chromium } from 'playwright'

/**
 * Search on the map screen.
 *
 * The lead half is the half that has to work, and it is the half that can be
 * tested honestly: it runs against what is already on the device, so it needs no
 * key, no signal and no network stubbing. The address half needs a real Places
 * key on an allowed origin and is not covered here, for the same reason as the
 * map and the add-lead field.
 *
 * The layout assertions are not padding. This search box took the space a small
 * pill used to occupy, on a row that also carries the sync badge and the
 * map/list switch, over a full-bleed map at 320px. That is exactly the kind of
 * change that looks fine on a laptop and breaks the narrowest real phone.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

for (const width of [320, 390, 1024]) {
  const ctx = await browser.newContext({
    viewport: { width, height: 800 },
    isMobile: width < 700,
    hasTouch: width < 700,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Google can never answer: the lead search must be entirely independent of it.
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.route('**://places.googleapis.com/**', (r) => r.abort())

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(1800)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1500)

  const search = page.getByRole('searchbox', { name: /Search leads and addresses/i })
  ok(await search.isVisible(), `[${width}] the search field is on the map screen`)

  // The count lost its own pill, so the placeholder has to still carry it.
  const placeholder = await search.getAttribute('placeholder')
  ok(
    /Search \d+ leads?/.test(placeholder ?? ''),
    `[${width}] the placeholder still reports the lead count ("${placeholder}")`,
  )

  const box = await search.boundingBox()
  ok((box?.height ?? 0) >= 40, `[${width}] the field is thumb-sized (${Math.round(box?.height ?? 0)}px)`)

  // Nothing may push the map screen sideways.
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  ok(scrollW <= width + 1, `[${width}] the row does not overflow (${scrollW} <= ${width})`)
  ok(
    await page.getByRole('button', { name: /^list$/i }).isVisible(),
    `[${width}] the map/list switch still fits beside it`,
  )

  /* --- searching leads, with Google unreachable -------------------------- */
  // Taken from the address of a lead the demo always has.
  const firstAddress = await page
    .getByRole('list', { name: 'Route stops' })
    .count()
    .then(() => null)
    .catch(() => null)
  void firstAddress

  await search.fill('Cypress')
  await page.waitForTimeout(700)

  const matches = page.getByRole('list', { name: 'Matching leads' })
  ok(await matches.isVisible(), `[${width}] typing a street name finds leads with no network`)
  const rows = await matches.getByRole('button').count()
  ok(rows > 0 && rows <= 6, `[${width}] results are capped rather than dumping the list (${rows})`)

  const firstRow = matches.getByRole('button').first()
  const rowBox = await firstRow.boundingBox()
  ok((rowBox?.height ?? 0) >= 44, `[${width}] result rows clear the tap floor (${Math.round(rowBox?.height ?? 0)}px)`)

  /* --- picking one ------------------------------------------------------- */
  await firstRow.click()
  await page.waitForTimeout(900)
  ok(
    (await matches.count()) === 0,
    `[${width}] choosing a result closes the list`,
  )
  // A picked lead is selected, which on a phone raises the peek sheet and on a
  // wide screen fills the side pane.
  const body = await page.locator('body').innerText()
  ok(/Start visit|Open full profile|View full profile/i.test(body), `[${width}] and the lead is opened`)

  /* --- a query that matches nothing -------------------------------------- */
  await search.fill('zzzzqqq')
  await page.waitForTimeout(700)
  const empty = await page.locator('body').innerText()
  ok(/No lead matches that/i.test(empty), `[${width}] a miss says so rather than showing an empty box`)

  /* --- clearing ---------------------------------------------------------- */
  await page.getByRole('button', { name: /Clear search/i }).click()
  await page.waitForTimeout(400)
  ok((await search.inputValue()) === '', `[${width}] clear empties the field`)
  ok(
    (await page.getByRole('list', { name: 'Matching leads' }).count()) === 0,
    `[${width}] and dismisses the results`,
  )

  ok(errors.length === 0, `[${width}] no page errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== map search OK ===')
process.exit(fails.length ? 1 : 0)
