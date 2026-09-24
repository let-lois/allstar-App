import { readFileSync } from 'node:fs'
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

/* --- fixtures for the server's half --------------------------------------
 *
 * A house, and Google's car on the kerb thirty metres due south of it. The
 * numbers are chosen so the answers are checkable by hand: 0.00027° of latitude
 * is 30 m, and a camera due south of a house is a bearing of 0°.
 */
const HOUSE = { lat: 30.5, lng: -97.6 }
const KERB = {
  pano_id: 'pano-on-the-kerb',
  location: { lat: 30.5 - 0.00027, lng: -97.6 },
}
/** A panorama standing on the property itself — no usable bearing to take. */
const ON_THE_SPOT = { pano_id: 'pano-on-the-spot', location: { lat: 30.5, lng: -97.6 } }

/** The route's own source, for the one assertion that is about what it logs. */
const ROUTE = readFileSync(new URL('../api/src/index.ts', import.meta.url), 'utf8')

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
    const { streetViewAt, useStreetViewBase, classifyMetadata, SEARCH_RADIUS_M } =
      await import('../api/src/streetview.ts')

    const calls = []
    const realFetch = globalThis.fetch
    /**
     * @param meta        what the metadata endpoint reports as `status`
     * @param imageStatus HTTP status for the image request
     * @param extra       the rest of the metadata body — `location`, `pano_id`,
     *                    `error_message`. Defaulted to a camera on the kerb so
     *                    the ordinary case exercises the pano/heading path
     *                    rather than the degraded one.
     * @param metaStatus  HTTP status for the metadata request itself
     */
    const stub = (meta, imageStatus = 200, extra = KERB, metaStatus = 200) => {
      globalThis.fetch = async (u) => {
        const url = String(u)
        calls.push(url)
        if (url.includes('/metadata')) {
          return new Response(metaStatus === 200 ? JSON.stringify({ status: meta, ...extra }) : '', {
            status: metaStatus,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(imageStatus === 200 ? new Uint8Array([1, 2, 3]) : null, {
          status: imageStatus,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
    }
    const param = (url, name) => new URL(url).searchParams.get(name)
    // A stand-in endpoint, so nothing here can reach Google even by accident.
    useStreetViewBase('https://streetview.invalid/x')

    try {
      calls.length = 0
      const none = await streetViewAt(undefined, HOUSE.lat, HOUSE.lng)
      ok(none.kind === 'unconfigured', 'with no key the server says so rather than guessing')
      ok(none.code === 'NOT_CONFIGURED', 'with the code that names it a setting')
      ok(calls.length === 0, 'and asks Google nothing at all')

      /* --- the radius, which is the whole first half of the bug ---------- */
      //
      // Without it Google searches 50 m from the point we hold for the
      // *building*, and a house up a drive, a corner plot indexed to its far
      // side, or any Census-interpolated coordinate is outside that. Every one
      // of them came back ZERO_RESULTS and the screen blamed the street.
      calls.length = 0
      stub('OK')
      await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      const meta = calls.find((c) => c.includes('/metadata'))
      ok(
        Number(param(meta, 'radius')) === SEARCH_RADIUS_M,
        `the coverage check is given an explicit radius (${param(meta, 'radius')} m)`,
      )
      ok(SEARCH_RADIUS_M >= 100 && SEARCH_RADIUS_M <= 150, `and it is ${SEARCH_RADIUS_M} m`)
      ok(param(meta, 'location') === `${HOUSE.lat},${HOUSE.lng}`, 'centred on the property')

      /* --- a panorama found within the radius ---------------------------- */
      //
      // The second half. The camera is 30 m south of the house; the image must
      // be taken *from the camera* and aimed *at the house*, which is a bearing
      // of due north. Sending the house's own coordinate as the location — what
      // this used to do — asks Google to find a pano all over again and points
      // it wherever the car happened to be facing.
      calls.length = 0
      stub('OK')
      const near = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(near.kind === 'image' && near.bytes.byteLength === 3, 'a covered point returns bytes')
      ok(near.code === 'AVAILABLE', 'coded AVAILABLE')
      ok(
        near.pano.lat === KERB.location.lat && near.pano.lng === KERB.location.lng,
        'the panorama coordinate is reported, and is not the property coordinate',
        `${near.pano.lat},${near.pano.lng}`,
      )
      ok(Math.round(near.metres) === 30, `the camera is measured at ${Math.round(near.metres)} m away`)
      ok(
        near.heading !== null && Math.abs(near.heading) < 0.5,
        `and the heading points north, at the house (${near.heading})`,
      )
      const img = calls.find((c) => !c.includes('/metadata'))
      ok(
        param(img, 'pano') === KERB.pano_id,
        'the image is addressed by pano id, so no second search can pick another camera',
      )
      ok(param(img, 'location') === null, 'and never by the house coordinate')
      ok(
        Math.abs(Number(param(img, 'heading'))) < 0.5,
        `with the heading on the request (${param(img, 'heading')})`,
      )
      ok(
        calls.every((c) => c.includes('key=')),
        'and the key travels on every request the server makes',
      )
      ok(
        calls.some((c) => c.includes('/metadata')) && calls.some((c) => !c.includes('/metadata')),
        'having checked coverage first',
      )

      /* --- an exact hit: the camera is on the house ---------------------- */
      //
      // A bearing taken over a couple of metres is rounding error pointed at
      // the sky. Google's own default heading for the panorama is a better
      // answer than one we invented, so none is sent.
      calls.length = 0
      stub('OK', 200, ON_THE_SPOT)
      const exact = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(exact.kind === 'image', 'a panorama at the property itself still returns bytes')
      ok(exact.heading === null, 'with no heading invented from a zero-length baseline')
      ok(
        param(calls.find((c) => !c.includes('/metadata')), 'heading') === null,
        'and none on the request either',
      )

      /* --- a stand-in that reports no location --------------------------- */
      //
      // Not something Google does, but the degraded path has to be the old
      // behaviour rather than a crash: aim at the property and let Google search.
      calls.length = 0
      stub('OK', 200, {})
      const bare = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(bare.kind === 'image', 'a metadata reply with no location still yields a photo')
      ok(bare.heading === null, 'and claims no heading it cannot compute')

      /* --- no coverage --------------------------------------------------- */
      for (const status of ['ZERO_RESULTS', 'NOT_FOUND']) {
        calls.length = 0
        stub(status)
        const gap = await streetViewAt('k', 0, 0)
        ok(gap.kind === 'none' && gap.code === 'NO_COVERAGE', `${status} is NO_COVERAGE`)
        /*
          The assertion this section is for. The image endpoint is billed and
          returns a grey placeholder with a 200 for a street it has nothing on —
          so one request per uncovered lead is money spent on a picture of
          nothing, at scale, forever.
        */
        ok(
          calls.length === 1 && calls[0].includes('/metadata'),
          `${status}: without paying for an image of it`,
          `${calls.length} request(s)`,
        )
      }

      /* --- the four ways an account is broken ---------------------------- */
      //
      // Each one is a different person's afternoon: a key to re-issue, an API to
      // tick on, a card to add, a cap to raise. They all used to arrive as "no
      // photo of this house yet".
      for (const [status, message, expect, why] of [
        ['REQUEST_DENIED', undefined, 'API_KEY_ERROR', 'a refused key'],
        [
          'REQUEST_DENIED',
          'This API project is not authorized to use this API.',
          'API_NOT_ENABLED',
          'an API nobody enabled',
        ],
        [
          'REQUEST_DENIED',
          'Street View Static API has not been used in project 42 before or it is disabled.',
          'API_NOT_ENABLED',
          "Google's other wording for the same thing",
        ],
        [
          'REQUEST_DENIED',
          'You must enable Billing on the Google Cloud Project.',
          'BILLING_ERROR',
          'an account with no card on it',
        ],
        ['OVER_QUERY_LIMIT', undefined, 'QUOTA_ERROR', 'a spent quota'],
        [
          'OVER_QUERY_LIMIT',
          'Billing has not been enabled on this project.',
          'BILLING_ERROR',
          'unpaid, arriving under the quota status',
        ],
        ['INVALID_REQUEST', undefined, 'UPSTREAM_ERROR', 'a request Google would not take'],
        ['UNKNOWN_ERROR', undefined, 'UPSTREAM_ERROR', 'a server-side fault'],
        ['SOMETHING_NEW', undefined, 'UPSTREAM_ERROR', 'a status this code has never seen'],
      ]) {
        calls.length = 0
        stub(status, 200, message ? { error_message: message } : {})
        const bad = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
        ok(bad.kind === 'error', `${why}: is an error, not an empty street`)
        ok(bad.code === expect, `${why}: coded ${expect}`, bad.code)
        ok(
          calls.length === 1,
          `${why}: and nothing billable is attempted`,
          `${calls.length} request(s)`,
        )
        // The classifier is also checked directly, so a change to it is caught
        // even if the call path stops reaching it.
        ok(classifyMetadata(status, message) === expect, `${why}: classified the same in isolation`)
      }

      /* --- HTTP-level failures, where there is no status string ---------- */
      for (const [code, expect, why] of [
        [403, 'API_KEY_ERROR', 'a key refused at the edge'],
        [401, 'API_KEY_ERROR', 'an unauthenticated request'],
        [429, 'QUOTA_ERROR', 'a rate limit'],
        [500, 'UPSTREAM_ERROR', 'a bad day at Google'],
      ]) {
        calls.length = 0
        stub('OK', 200, KERB, code)
        const bad = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
        ok(bad.kind === 'error' && bad.code === expect, `metadata HTTP ${code}: ${why} → ${expect}`, bad.code)
      }

      calls.length = 0
      stub('OK', 403)
      const refusedImage = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(
        refusedImage.kind === 'error' && refusedImage.code === 'API_KEY_ERROR',
        'an image the endpoint would not serve is an error too',
        refusedImage.code,
      )

      calls.length = 0
      stub('OK', 500)
      const brokenImage = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(
        brokenImage.kind === 'error' && brokenImage.code === 'UPSTREAM_ERROR',
        'and a 500 on the image is upstream, not the key',
        brokenImage.code,
      )

      /* --- no network at all --------------------------------------------- */
      //
      // Its own code, because it is the one failure that is about the phone
      // rather than the account — and the one a rep in a dead zone produces all
      // day. Telling an office to check their billing because a rep walked into
      // a basement is exactly the wrong-subject bug this file is about.
      calls.length = 0
      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch')
      }
      const offline = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(
        offline.kind === 'error' && offline.code === 'NETWORK_ERROR',
        'an unreachable Google is NETWORK_ERROR',
        offline.code,
      )

      /* --- the detail never goes on the wire ----------------------------- */
      calls.length = 0
      stub('REQUEST_DENIED', 200, { error_message: 'The provided API key is expired.' })
      const denied = await streetViewAt('k', HOUSE.lat, HOUSE.lng)
      ok(
        denied.detail.includes('expired'),
        "Google's own words are kept for the Worker log",
        denied.detail,
      )
      /*
        Exactly one reader, and it is the log. Counted rather than pattern-
        matched on the happy shape, because the failure worth catching is a
        *second* use appearing later — somebody adding `detail` to the JSON body
        to make debugging easier, and shipping Google's prose about the
        customer's project to every signed-in phone.

        Comments stripped first. They discuss `shot.detail` by name, at length,
        including the sentence explaining why it must never be sent — and a gate
        that counts prose would have failed on the documentation of the rule it
        is enforcing. (It did, once, which is how this line got written.)
      */
      const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
      const uses = code.split('shot.detail').length - 1
      ok(uses === 1, `the route reads it once (${uses})`)
      const line = code.split('\n').find((l) => l.includes('shot.detail')) ?? ''
      const before = code.split('\n').slice(0, code.split('\n').indexOf(line)).join(' ')
      ok(
        /\$\{shot\.detail\}`/.test(line) && /console\.error\(\s*$/.test(before.slice(-40)),
        'from inside the console.error, never the response body',
        line.trim(),
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

  /*
    The header the Worker sends, and the CORS grant that makes it readable.

    Both, because leaving the second out is a failure mode rather than a
    simplification: the header arrives, the browser strips it, and the app
    quietly falls back to the coarse answer. The stub therefore mirrors what
    `corsHeaders` actually sends — see the `x-streetview-code` entry in
    `access-control-expose-headers` — and one case below deliberately omits it.
  */
  const sent = (code) => ({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-streetview-code',
    'x-streetview-code': code,
  })

  /** What each answer put on screen, collected for the cross-checks below. */
  const said = {}

  for (const [label, reply, expect] of [
    ['a photo', { status: 200, contentType: 'image/png', body: PIXEL, headers: sent('AVAILABLE') }, 'photo'],
    [
      'no coverage',
      { status: 204, headers: sent('NO_COVERAGE') },
      /No Street View imagery is available near this property/i,
    ],
    [
      'no key configured',
      {
        status: 501,
        contentType: 'application/json',
        body: '{"code":"no_streetview_key"}',
        headers: sent('NOT_CONFIGURED'),
      },
      /isn’t switched on/i,
    ],
    [
      'an API nobody enabled',
      {
        status: 502,
        contentType: 'application/json',
        body: '{"code":"streetview_unavailable"}',
        headers: sent('API_NOT_ENABLED'),
      },
      /temporarily unavailable/i,
    ],
    [
      'an unpaid account',
      {
        status: 502,
        contentType: 'application/json',
        body: '{"code":"streetview_unavailable"}',
        headers: sent('BILLING_ERROR'),
      },
      /temporarily unavailable/i,
    ],
    [
      // The header stripped, as an older Worker or a missing CORS grant would
      // leave it. The status alone still has to produce the right sentence.
      'a failure with no code header',
      {
        status: 502,
        contentType: 'application/json',
        body: '{"code":"streetview_unavailable"}',
        headers: { 'access-control-allow-origin': '*' },
      },
      /temporarily unavailable/i,
    ],
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
      return r.fulfill(reply)
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
      const text = (await frame.count()) ? (await frame.innerText()).replace(/\s+/g, ' ') : '(no frame)'
      said[label] = text
      ok(expect.test(text), `${label}: the frame says so`, text)
    }
    await ctx.close()
  }

  /* --- the distinction, stated as a difference ---------------------------- */
  //
  // The bug was never that a sentence was missing. It was that one sentence
  // covered two facts: a street Google has not photographed, and an account
  // that cannot ask. The first is nobody's to fix and the second is a tick-box,
  // and a company whose Street View API had never been enabled was told, on
  // every lead they own, that their whole territory was unphotographed.
  //
  // So this is asserted as an inequality rather than by matching copy. Reworded
  // sentences keep passing; a future collapse back into one does not.
  ok(
    said['no coverage'] !== said['an API nobody enabled'],
    'no coverage and a broken account do not say the same thing',
    `${said['no coverage']} / ${said['an API nobody enabled']}`,
  )
  ok(
    !/no street view imagery|no photo of this house/i.test(said['an API nobody enabled'] ?? ''),
    'and a configuration failure makes no claim about the street',
    said['an API nobody enabled'],
  )
  ok(
    said['no key configured'] !== said['an API nobody enabled'],
    'a missing key and a refused one are told apart too',
  )
  ok(
    said['an unpaid account'] === said['an API nobody enabled'] &&
      said['a failure with no code header'] === said['an API nobody enabled'],
    'while every system failure gets the one sentence, header or no header',
  )
}

/* --- the two code lists are the same list --------------------------------- */
//
// The Worker names the failures and the client re-states them, because the web
// bundle does not reach into the Worker's package. That is a fine trade only
// while the copies cannot drift: a code added on one side and forgotten on the
// other falls through to "unavailable" silently, and the next person to look at
// it is reading a support ticket a year later.
{
  const server = readFileSync(new URL('../api/src/streetview.ts', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/lib/http.ts', import.meta.url), 'utf8')
  const codes = (src, after) => {
    const from = src.indexOf(after)
    const block = src.slice(from, src.indexOf('\n\n', from))
    return [...block.matchAll(/'([A-Z_]{4,})'/g)].map((m) => m[1]).sort()
  }
  const a = codes(server, 'export type StreetViewCode =')
  const b = codes(client, 'export type StreetViewCode =')
  ok(a.length >= 8, `the Worker names ${a.length} outcomes`, a.join(','))
  ok(a.join(',') === b.join(','), 'and the client knows exactly the same ones', b.join(','))
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
