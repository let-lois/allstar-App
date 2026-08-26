import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

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
  executablePath: chromiumPath(),
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
  await dismissTour(page)
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
  /*
    Which reason appears depends on the build: with placeholder Google values the
    demo account has no server to ask, and with none at all the feature is simply
    not configured. Both are honest and both are the point — the screen must say
    the number is not a road distance. Asserting only one made this gate depend
    on which build it happened to run against.
  */
  ok(
    /straight-line|not configured/i.test(body),
    'the number is labelled as not being a road distance',
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
    /padlock/i.test(body),
    'a rep with no location is told where the switch is, not just that one exists',
  )
  ok(
    /Google Maps/i.test(body),
    'plus the fix that needs no permission from us at all',
  )
  /*
    The map is still drawn. Reported from a real browser with location denied:
    the screen showed a paragraph and a link that left the app, which is exactly
    what it exists to prevent. Only the *line* needs a position; the door's
    coordinates are already on the device.

    This assertion replaces one that said the opposite — that with no position
    the whole panel should be absent — which was me encoding a design mistake as
    a requirement.
  */
  ok(
    (await page.getByRole('application', { name: /Map of your leads/i }).count()) > 0 ||
      (await page.locator('svg').count()) > 0,
    'a map is drawn even with no location permission',
  )
  ok(
    /Showing the door, not the walk/i.test(body),
    'and it says plainly that this is the door rather than the walk',
  )
  ok(
    !/along the roads/i.test(body),
    'without claiming a road distance it does not have',
  )
  ok(
    (await page.getByRole('button', { name: /Start visit/i }).count()) > 0,
    'the visit is still one tap away, which is the point of not leaving the app',
  )
  await ctx.close()
}

/* --- the rep is in another state ------------------------------------------ */
//
// Asked directly: does the line show if the user is in another state or country?
// It does not — there is no useful route across four hundred miles, and the
// server refuses over 80km. The bug was that its refusal arrived here as "no
// signal", telling somebody their connection was broken when their actual
// problem was being nowhere near the door. The distance is now checked locally,
// so the reason is honest and costs no request.
{
  const { ctx, page } = await toLead({
    permissions: ['geolocation'],
    // Chicago. The demo's leads are in Texas.
    geolocation: { latitude: 41.8781, longitude: -87.6298 },
  })
  await page.getByRole('link', { name: /^Navigate$/ }).first().click()
  await page.waitForTimeout(1800)

  const body = await page.locator('body').innerText()
  ok(/too far away to route/i.test(body), 'a rep in another state is told they are too far away')
  ok(
    !/No signal/i.test(body),
    'and not told their connection is broken, which is what it used to say',
  )
  ok(
    /direct distance/i.test(body),
    'the straight-line distance is still offered, and labelled as such',
  )
  /*
    The number, and the number it must not be beside. A walking time was quoted
    unconditionally, so a lead opened from another state read "963 mi · 18,639
    min" — arithmetic wearing the clothes of a plan. Three digits of minutes is
    the signature of that bug, and no distance anybody walks produces it.
  */
  ok(
    /\d{3,} mi|\d,\d{3} mi/.test(body),
    'the distance is shown in hundreds or thousands of miles',
  )
  ok(
    !/\d{3,}\s*min/.test(body),
    'and no walking time is invented for a distance nobody walks',
  )
  ok(
    !/along the roads/i.test(body),
    'nor a road distance claimed where there is no road route',
  )

  /*
    The arc itself, asserted — and this is the interesting part, because it needs
    no key. Maps JS is blocked in this gate, so what is on screen is the
    self-rendered map, which now takes the same `path` prop and frames it. The
    first version of this feature was Google-only: the offline renderer could not
    zoom out past a neighbourhood, so a rep on the wrong continent with no signal
    got a map of the door and nothing else. Two renderers that disagree about
    what they can show is exactly what the shared prop contract exists to stop.
  */
  const arc = page.locator('svg path[data-line="flight"]')
  ok(await arc.count() > 0, 'the direct line is drawn with no Google map at all')
  const d = (await arc.first().getAttribute('d')) ?? ''
  const vertices = (d.match(/[ML]/g) ?? []).length
  ok(
    vertices > 20,
    `it is a sampled arc rather than a two-point line (${vertices} vertices)`,
  )
  /*
    Both ends on screen. A line whose far end is off the edge is not a line
    anybody can read, and this is the assertion that would catch the view being
    left at street zoom — the failure the old minimum zoom guaranteed.
  */
  const lineBox = await arc.first().boundingBox()
  ok(
    lineBox != null && lineBox.width > 390 * 0.3 && lineBox.x > -40,
    `and it is framed rather than left at street zoom (${Math.round(lineBox?.width ?? 0)}px across a 390px screen, from x=${Math.round(lineBox?.x ?? 0)})`,
  )
  ok(
    (await page.locator('[data-plane="flight"]').count()) > 0,
    'with the plane on it, which is what says this is not a walk',
  )

  // Not an error state, and not described as one.
  ok(/dashed line/i.test(body), 'the sentence points at the line that is actually there')
  ok(/Direct line/i.test(body), 'and the screen is titled for what it is showing')
  ok(
    !/not configured|No signal/i.test(body),
    'without blaming configuration or the connection for a fact about geography',
  )
  ok(
    (await page.getByRole('button', { name: /Start visit/i }).count()) > 0,
    'and the screen stays usable rather than becoming an error page',
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
