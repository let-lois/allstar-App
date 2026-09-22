import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Basemap imagery verification.
 *
 * Runs in two modes, because the interesting property is conditional: imagery is
 * an enhancement and must never become a dependency. With a key configured this
 * asserts tiles render, the layer toggle works and attribution is present and
 * correct per layer. With no key it asserts the opposite — that nothing is
 * fetched from the tile host at all and the drawn basemap carries the screen.
 *
 * Google is blocked throughout, deliberately. `FieldMap` is now the *offline*
 * renderer — Google draws while it can and this takes over when it cannot — so
 * with Google reachable this screen would show Google's map and there would be
 * no MapTiler tiles to assert anything about. Blocking it is what puts the
 * component under test on screen, and it is also the condition a rep is in when
 * these tiles matter: no signal, saved imagery.
 *
 * Both modes end by killing the connection: the map has to survive it, because
 * that is the condition it is used in.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: chromiumPath(),
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})
const page = await ctx.newPage()
// See the header: Google must be absent for the offline renderer to appear.
await page.route(/maps\.googleapis\.com/, (r) => r.abort())
const reqs = []
page.on('request', (r) => {
  if (r.url().includes('/api/tiles/')) reqs.push(r.url())
})

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/*
  Imagery is a fact about the server now, not about the build: the MapTiler key
  is a Worker secret and the app asks /api/health whether one is set. So this
  gate stands in for the Worker — health says yes, and every /api/tiles request
  is answered with a real PNG — rather than reading a build-time variable the
  browser cannot see. `MODE=none` runs the other half: health says no, and
  nothing may be asked of the tile route at all.
*/
const MODE = process.env.MODE === 'none' ? 'none' : 'imagery'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
await page.route('**/api/health', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, config: { tiles: MODE === 'imagery' } }) }),
)
await page.route('**/api/tiles/**', (r) =>
  r.fulfill({ status: 200, contentType: r.request().url().endsWith('.jpg') ? 'image/jpeg' : 'image/png', body: PNG }),
)

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1800)
await page.getByRole('link', { name: /^Map$/ }).first().click()
await page.waitForTimeout(2500)

// The toggle only exists when a key is configured, so it is the signal for which
// mode the build is in — inferred from the page rather than from an env var the
// browser cannot see.
const configured = (await page.getByRole('button', { name: /Switch to satellite view/ }).count()) > 0
console.log(`\n--- imagery ${configured ? 'configured' : 'not configured'} ---\n`)
ok(configured === (MODE === 'imagery'), `the map believes what the server said (health tiles=${MODE === 'imagery'}, toggle ${configured ? 'shown' : 'hidden'})`)

if (configured) {
  ok((await page.locator('svg image').count()) > 0, 'imagery tiles are rendered')
  ok(reqs.some((u) => u.includes('/api/tiles/streets/')), 'streets tiles requested by default, from our own Worker')
  ok(
    (await page.locator('p', { hasText: 'OpenStreetMap contributors' }).count()) > 0,
    'streets attribution credits OpenStreetMap (ODbL requires it)',
  )

  await page.getByRole('button', { name: /Switch to satellite view/ }).click()
  await page.waitForTimeout(1500)
  ok(reqs.some((u) => u.includes('/api/tiles/satellite/')), 'satellite tiles requested after toggle')
  ok(
    (await page.getByRole('button', { name: /Switch to streets view/ }).count()) > 0,
    'toggle flips to offer the other layer',
  )
  const attr = await page.locator('p', { hasText: 'MapTiler' }).first().innerText()
  ok(/Planet|Landsat/.test(attr), `attribution changes with the layer (${attr})`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  ok(
    (await page.getByRole('button', { name: /Switch to streets view/ }).count()) > 0,
    'layer choice survives a reload',
  )
} else {
  ok(reqs.length === 0, 'nothing is asked of the tile route when the server has no imagery')
  ok((await page.locator('svg image').count()) === 0, 'no tile elements are rendered')
  ok(
    (await page.locator('p', { hasText: 'MapTiler' }).count()) === 0,
    'no attribution shown for imagery that is not being used',
  )
}

// ---- the condition it is actually used in ---------------------------------
await ctx.setOffline(true)
await page.evaluate(() => window.dispatchEvent(new Event('offline')))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

ok(page.url().includes('/map'), 'map screen loads with no connection')
const paths = await page.locator('svg path').count()
ok(paths > 0, `drawn basemap renders offline (${paths} paths) — imagery degrades to it`)
ok(
  (await page.getByRole('button', { name: /Zoom in/ }).count()) > 0,
  'map controls remain usable offline',
)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== map tiles OK ===')
process.exit(fails.length ? 1 : 0)
