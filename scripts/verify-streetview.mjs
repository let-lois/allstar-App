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
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}


/**
 * The signed-in path, which is the one a rep and the native app both take.
 *
 * Two halves, because the bug this fixes had two:
 *
 *   - **The server never sends the key.** `streetViewAt` is exercised directly
 *     with a stubbed endpoint, which is where the money lives: the metadata
 *     call is free and the image call is billed, so asking the image endpoint
 *     about a street with no coverage would pay for a picture of grey. That
 *     ordering has to be a fact, not a comment.
 *   - **The screen says which kind of nothing it is.** A company with no key
 *     and a street with no imagery are different sentences, and until this
 *     existed the app could only say the second — so every rep on a phone was
 *     told their whole territory had no coverage.
 */
async function proxyChecks() {
  /* --- 1. the server, as arithmetic ------------------------------------- */
  {
    const { streetViewAt, useStreetViewBase } = await import('../api/src/streetview.ts')

    const calls = []
    const realFetch = globalThis.fetch
    const stub = (meta, imageStatus = 200) => {
      globalThis.fetch = async (u) => {
        const url = String(u)
        calls.push(url)
        if (url.includes('/metadata')) {
          return new Response(JSON.stringify({ status: meta }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(imageStatus === 200 ? new Uint8Array([1, 2, 3]) : null, {
          status: imageStatus,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
    }
    // A stand-in endpoint, so nothing here can reach Google even by accident.
    useStreetViewBase('https://streetview.invalid/x')

    try {
      calls.length = 0
      ok(
        (await streetViewAt(undefined, 30.5, -97.6)).kind === 'unconfigured',
        'with no key the server says so rather than guessing',
      )
      ok(calls.length === 0, 'and asks Google nothing at all')

      calls.length = 0
      stub('OK')
      const hit = await streetViewAt('k', 30.5, -97.6)
      ok(hit.kind === 'image' && hit.bytes.byteLength === 3, 'a covered point returns bytes')
      ok(
        calls.some((c) => c.includes('/metadata')) && calls.some((c) => !c.includes('/metadata')),
        'having checked coverage first',
      )
      ok(
        !calls.some((c) => c.includes('key=') === false),
        'and the key travels on the request the server makes',
      )

      calls.length = 0
      stub('ZERO_RESULTS')
      ok((await streetViewAt('k', 0, 0)).kind === 'none', 'an uncovered point answers "none"')
      /*
        The assertion this section is for. The image endpoint is billed and
        returns a grey placeholder with a 200 for a street it has nothing on —
        so one request per uncovered lead is money spent on a picture of
        nothing, at scale, forever.
      */
      ok(
        calls.length === 1 && calls[0].includes('/metadata'),
        'without paying for an image of it',
        `${calls.length} request(s)`,
      )

      calls.length = 0
      stub('REQUEST_DENIED')
      ok(
        (await streetViewAt('k', 30.5, -97.6)).kind === 'error',
        'a refused key is an error, not an empty street',
      )

      calls.length = 0
      stub('OK', 403)
      ok(
        (await streetViewAt('k', 30.5, -97.6)).kind === 'error',
        'and so is an image the endpoint would not serve',
      )
    } finally {
      globalThis.fetch = realFetch
      useStreetViewBase(undefined)
    }
  }

  /* --- 2. the screen, for each answer ------------------------------------ */
  const USER = {
    id: 'u_rep', clientId: 'c_live', clientName: 'Ridgeline Roofing',
    email: 'rep@ridgeline.test', name: 'Marcus Vance', role: 'field_rep',
  }
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  for (const [label, reply, expect] of [
    ['a photo', { status: 200, contentType: 'image/png', body: PIXEL }, 'photo'],
    ['no coverage', { status: 204 }, /No photo of this house/i],
    ['no key configured', { status: 501, contentType: 'application/json', body: '{"code":"no_streetview_key"}' }, /isn’t switched on/i],
    ['a lookup that failed', { status: 502, contentType: 'application/json', body: '{"code":"streetview_unavailable"}' }, /No photo of this house/i],
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
    })
    const page = await ctx.newPage()
    let asked = 0
    const json = (body) => (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

    // Catch-all first: Playwright matches handlers in reverse registration
    // order, so one added last silently wins over every specific route above.
    await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.route('**/api/auth/login', json({ token: 'tok_sv', user: USER }))
    await page.route('**/api/bootstrap', json({
      user: USER,
      properties: [{
        id: 'p_1', clientId: 'c_live', address1: '1 Gate Way', city: 'Round Rock',
        state: 'TX', zip: '78664', lat: 30.5083, lng: -97.6789, status: 'new', updatedAt: Date.now(),
        // Assigned, or the map shows "No leads on this device yet": a rep's map
        // is scoped to their own leads, and an unassigned one reaches the
        // profile by URL but never appears as a pin.
        assignedRepId: 'u_rep',
        // `PropertyDetail` reads `property.contacts.find(...)` unguarded, so a
        // lead without the array takes the screen down. The real API always
        // sends it; a mock that leaves it out is testing a shape that does not
        // occur, and spends an afternoon proving it.
        contacts: [],
      }],
      routes: [], appointments: [], tasks: [], activity: [], dailyStats: [],
      // Every optional collection, present and empty. An older Worker omits
      // some of these and the app reads that as "none" — but a screen that
      // calls `.find` on one still needs an array to call it on, and the lead
      // profile is the screen with the most of them.
      territories: [], leadLists: [], notes: [], team: [],
      serverTime: Date.now(),
    }))
    await page.route(/\/api\/streetview/, (r) => {
      asked += 1
      return r.fulfill({ ...reply, headers: { 'access-control-allow-origin': '*' } })
    })
    // Nothing here may reach Google; the point is that the app no longer tries.
    let direct = 0
    await page.route(/maps\.googleapis\.com/, (r) => {
      direct += 1
      return r.abort()
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.locator('input[type="email"]').fill(USER.email)
    await page.locator('input[autocomplete="current-password"]').fill('pw')
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    await page.waitForTimeout(1500)
    await dismissTour(page)
    await page.goto(`${BASE}/property/p_1`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    ok(asked > 0, `${label}: the app asks our server for the photo`)
    ok(direct === 0, `${label}: and never calls Google from the client`)

    if (expect === 'photo') {
      ok(
        (await page.getByRole('img', { name: /Street view of/i }).count()) > 0,
        `${label}: the photo is rendered`,
      )
      const src = await page.getByRole('img', { name: /Street view of/i }).first().getAttribute('src')
      /*
        A blob URL, not a link to the API. An `<img>` cannot send an
        Authorization header, so a `src` pointing at an authenticated endpoint
        would 401 — the bytes have to arrive through a request the app makes
        itself and be handed over as an object URL.
      */
      ok(/^blob:/.test(src ?? ''), `${label}: from bytes the app fetched, not an unauthenticated src`, src?.slice(0, 40))
    } else {
      /*
        The frame only speaks on the map's sheet — on the profile the component
        renders nothing when there is no photo, because that screen is complete
        without one and an apology would only take the room. So: open the map
        and tap the pin, which is the gesture that puts a house on screen.
      */
      await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2200)
      const pin = page.locator('[data-marker="pin"]').first()
      if ((await pin.count()) > 0) {
        const at = await pin.locator('circle').first().boundingBox()
        if (at) await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2)
        await page.waitForTimeout(1600)
      }
      const frame = page.getByTestId('property-image').first()
      const said = (await frame.count()) ? (await frame.innerText()).replace(/\s+/g, ' ') : '(no frame)'
      ok(expect.test(said), `${label}: the frame says so`, said)
    }
    await ctx.close()
  }
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
    // The proxy is not about this build's key — it is about what a signed-in
    // client does. It runs in both modes, or the phone's path is only covered
    // where a browser key happens to be configured.
    await proxyChecks()
    await browser.close()
    console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== street view OK (not configured) ===')
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

await proxyChecks()
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== street view OK ===')
process.exit(fails.length ? 1 : 0)
