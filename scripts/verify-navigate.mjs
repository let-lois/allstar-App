import { chromium } from 'playwright'

/**
 * Getting to the door.
 *
 * The drawn line needs Maps JS and a real key, so what is asserted here is
 * everything around it — which is where a rep actually gets stranded. Four
 * states, and each has to say which one it is:
 *
 *   - the Navigate button stays inside the app rather than opening a tab
 *   - no location: both fixes named, including the one needing no permission
 *   - no signal: the straight-line distance, labelled as such
 *   - the demo account: no server to ask, and no invented path
 *
 * The last one matters more than it sounds. A road distance and a straight-line
 * distance can differ by a factor of three, so a screen that shows one and
 * implies the other sends a rep round a fence. Which number is on screen is
 * always stated.
 *
 * **Every** Navigate is checked, not one of them. The first version of this gate
 * asserted the button on the lead screen and generalised — while Today and the
 * route screen carried their own copies that still opened a tab. The same button
 * doing two different things depending on where you found it is worse than it
 * doing the wrong thing everywhere, so the invariant is now stated as one: no
 * screen may offer a Navigate that leaves the app.
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

async function toLead(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    ...opts,
  })
  const page = await ctx.newPage()
  // The map itself is not what is under test here.
  await page.route(/\/maps\/api\/js/, (r) => r.abort())
  await page.route(/\/maps\/api\/streetview/, (r) => r.abort())

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(1800)
  await page.locator('a[href="/leads"]:visible').first().click()
  await page.waitForTimeout(1200)
  await page.locator('a[href^="/property/"], button').filter({ hasText: /\d+\s+\w/ }).first().click()
  await page.waitForTimeout(1500)
  return { ctx, page }
}

/* --- Navigate stays in the app -------------------------------------------- */
//
// The complaint that started this: it opened another tab, and the visit gets
// logged in *this* app, so a rep who left had to find their way back first.
{
  const { ctx, page } = await toLead({
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5083, longitude: -97.6789 },
  })

  const navigate = page.getByRole('link', { name: /^Navigate$/ })
  ok(await navigate.count() > 0, 'the lead screen still offers Navigate')
  ok(
    (await navigate.first().getAttribute('target')) === null,
    'and it no longer opens a new tab',
  )
  const href = await navigate.first().getAttribute('href')
  ok(
    /^\/navigate\//.test(href ?? ''),
    `it points at an in-app route (${href})`,
  )

  await navigate.first().click()
  await page.waitForTimeout(1500)
  ok(/\/navigate\//.test(page.url()), `tapping it stays in the app (${page.url()})`)

  const body = await page.locator('body').innerText()
  ok(/Walking route/i.test(body), 'the screen says what it is')
  ok(
    /Google Maps/i.test(body),
    'and still offers the hand-off, which is the only way to get spoken directions',
  )
  ok(/Start visit/i.test(body), 'with the visit one tap away, which is the point of staying here')

  // The demo account has no server to ask; inventing a path would be the one
  // dishonest thing this screen could do.
  ok(
    /demo shows the straight-line distance|straight-line/i.test(body),
    'the demo says its distance is straight-line rather than implying a road route',
  )
  ok(/direct distance/i.test(body), 'and the number on screen is labelled')
  await ctx.close()
}

/* --- no location permission ----------------------------------------------- */
{
  const { ctx, page } = await toLead({ permissions: [] })
  await page.getByRole('link', { name: /^Navigate$/ }).first().click()
  await page.waitForTimeout(1800)

  const body = await page.locator('body').innerText()
  ok(
    /don’t know where you are|do not know where you are/i.test(body),
    'a rep with no location is told so plainly',
  )
  ok(
    /padlock|browser settings/i.test(body),
    'and told where the switch is, not just that one exists',
  )
  ok(
    /Google Maps/i.test(body),
    'plus the fix that needs no permission from us at all',
  )
  // A real assertion, not a tautology: with no position there is no map, no
  // line and no distance, so the whole route panel — Start visit included — must
  // be absent rather than showing controls for a route that does not exist.
  ok(
    (await page.getByRole('button', { name: /Start visit/i }).count()) === 0,
    'the route panel is absent rather than offering controls for a route it has not got',
  )
  ok(
    !/direct distance|along the roads/i.test(body),
    'and no distance is claimed at all',
  )
  await ctx.close()
}

/* --- every Navigate, not just the one I happened to test ------------------ */
//
// The bug this exists for: the lead screen was converted, Today and the route
// screen were not, and Today is the first screen a rep opens each morning.
{
  const { ctx, page } = await toLead({
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5083, longitude: -97.6789 },
  })

  for (const path of ['/today', '/route']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)

    // A Navigate anywhere must be an in-app link.
    const navs = page.getByRole('link', { name: /Navigate/i })
    const count = await navs.count()
    for (let i = 0; i < count; i++) {
      const href = await navs.nth(i).getAttribute('href')
      const target = await navs.nth(i).getAttribute('target')
      ok(
        /^\/navigate\//.test(href ?? ''),
        `${path}: Navigate points in-app (${href})`,
      )
      ok(target === null, `${path}: and does not open a tab`)
    }

    /*
      And the invariant, which does not depend on finding the right control: no
      screen may contain a link that leaves for a maps site. Stated this way it
      catches the next copy of this button too, wherever somebody adds it.
    */
    const escapes = await page.evaluate(() =>
      [...document.querySelectorAll('a[target="_blank"]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /google\.[a-z.]+\/maps|maps\.apple\.com|geo:/.test(h)),
    )
    ok(
      escapes.length === 0,
      `${path}: nothing on this screen escapes to an external map (${escapes.length ? escapes[0] : 'none'})`,
    )
  }
  await ctx.close()
}

/* --- the lead is not on this device --------------------------------------- */
{
  const { ctx, page } = await toLead({
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5083, longitude: -97.6789 },
  })
  await page.goto(`${BASE}/navigate/p_does_not_exist`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const body = await page.locator('body').innerText()
  ok(
    /not on this device/i.test(body),
    'an unknown lead says so rather than rendering an empty map',
  )
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== navigate OK ===')
process.exit(fails.length ? 1 : 0)
