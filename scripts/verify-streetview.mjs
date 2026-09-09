import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The house photo on the lead detail screen.
 *
 * The whole reason this component is more than an `<img>` tag is testable here,
 * because it is about a response rather than about imagery: asked for a location
 * it has no coverage for, the Street View Static API returns a grey placeholder
 * picture with status 200 reading "Sorry, we have no imagery here". Rendered
 * blindly, a rural lead shows a photo of nothing and looks broken.
 *
 * So all three cases are driven by stubbing the *metadata* endpoint, which is
 * what the component consults first — coverage, no coverage, and no network — and
 * only the first one may produce an image.
 *
 * Run against a build with placeholder Google values, or the component compiles
 * out along with the key:
 *
 *   VITE_GOOGLE_MAPS_KEY=dummy VITE_GOOGLE_MAP_ID=DEMO_MAP_ID npm run build
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

// 1x1 transparent PNG, standing in for a photo of a house.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

/**
 * Open the first lead on the map, which is the route a rep takes.
 * `metadata` decides what the coverage check answers: 'OK', 'ZERO_RESULTS', or
 * null to abort the request entirely.
 */
async function openLead(metadata) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  let imageRequests = 0
  let coverageChecks = 0

  /*
    Regexes, not globs. In a Playwright URL glob `?` matches any single
    character, so `streetview?*` also matches `streetview/metadata?...` — the
    image stub swallowed the coverage check and answered it with a PNG, the
    component correctly concluded there was no coverage, and the test blamed the
    component. Two patterns that overlap by accident are worse than no stub.
  */
  await page.route(/\/maps\/api\/streetview\/metadata/, (r) => {
    coverageChecks += 1
    return metadata === null
      ? r.abort()
      : r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ status: metadata }),
        })
  })
  await page.route(/\/maps\/api\/streetview\?/, (r) => {
    imageRequests += 1
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  // The map itself is not under test and would only add noise.
  await page.route(/\/maps\/api\/js/, (r) => r.abort())

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1800)
  await page.locator('a[href="/leads"]:visible').first().click()
  await page.waitForTimeout(1200)
  // First lead in the list.
  // The row itself, by its own hook. This used to be `button` filtered by "a
  // number followed by a word" — which matches an address and also matches
  // "Last 7 days", so a filter chip added to this screen was clicked instead.
  await page.getByTestId('lead-row').first().click()
  await page.waitForTimeout(1600)

  return { ctx, page, images: () => imageRequests, checks: () => coverageChecks }
}

/* --- coverage exists ------------------------------------------------------ */
{
  const { ctx, page, images, checks } = await openLead('OK')
  await page.waitForTimeout(1200)

  /*
    With no key in the build the component compiles out entirely and never asks
    about coverage — which is the correct behaviour for a deployment that does
    not use Google, not a failure. Detected by the absence of the coverage check
    rather than by inspecting the bundle, and reported as a skip so a clean build
    does not show a red gate for a feature it deliberately does not have.
  */
  if (checks() === 0) {
    ok(
      (await page.getByRole('img', { name: /Street view of/i }).count()) === 0,
      'no key configured: the photo is correctly absent and nothing is requested',
    )
    await ctx.close()
    await browser.close()
    console.log('\n=== street view OK (not configured) ===')
    process.exit(fails.length ? 1 : 0)
  }

  const photo = page.getByRole('img', { name: /Street view of/i })
  await photo.waitFor({ timeout: 10_000 }).catch(() => {})
  ok(await photo.isVisible(), 'the photo appears when Street View has coverage')
  ok(images() === 1, `and exactly one image is requested (${images()})`)

  const link = page.getByRole('link', { name: /Street view of .* opens in Google Maps/i })
  ok(await link.count() > 0, 'it is a link out to Google Maps for a proper look around')
  const href = await link.first().getAttribute('href')
  ok(
    /map_action=pano&viewpoint=-?\d+\.\d+,-?\d+\.\d+/.test(href ?? ''),
    `pointing at the panorama for this lead's coordinates (${href?.slice(0, 64)})`,
  )

  const box = await photo.boundingBox()
  ok((box?.width ?? 0) <= 390, `the photo stays inside the viewport (${Math.round(box?.width ?? 0)}px)`)
  ok((box?.height ?? 0) <= 200, `and does not push the porch details off screen (${Math.round(box?.height ?? 0)}px)`)
  await ctx.close()
}

/* --- no coverage: the grey-placeholder trap ------------------------------- */
{
  const { ctx, page, images } = await openLead('ZERO_RESULTS')
  await page.waitForTimeout(1500)
  ok(
    (await page.getByRole('img', { name: /Street view of/i }).count()) === 0,
    'no photo is rendered where Street View has nothing',
  )
  ok(
    images() === 0,
    `and no image is requested at all, so uncovered leads cost nothing (${images()})`,
  )
  // The rest of the screen has to be untouched by the absence.
  const body = await page.locator('body').innerText()
  ok(/Start visit/i.test(body), 'and the rest of the lead screen is unaffected')
  await ctx.close()
}

/* --- no signal ------------------------------------------------------------ */
{
  const { ctx, page, images } = await openLead(null)
  await page.waitForTimeout(1500)
  ok(
    (await page.getByRole('img', { name: /Street view of/i }).count()) === 0,
    'no photo when the coverage check cannot be made',
  )
  ok(images() === 0, 'and no image request is attempted')
  const body = await page.locator('body').innerText()
  ok(
    !/street view/i.test(body),
    'with no apology on screen either — everything else here works offline',
  )
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== street view OK ===')
process.exit(fails.length ? 1 : 0)
