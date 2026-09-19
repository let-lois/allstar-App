import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'
import { prefetchTiles, tileStorageAvailable } from '../src/lib/tiles.ts'

/**
 * Territory tile prefetch verification.
 *
 * The claim under test is the one a rep bets their morning on: tap download on
 * wi-fi, and the imagery for the area you are about to walk is on the device.
 * So this asserts the tiles actually land in Cache Storage — not that a progress
 * bar reached the end.
 *
 * It also asserts the failure path, which matters more than the happy one. The
 * prefetch requests tiles in CORS mode specifically so a rejected key or an
 * exhausted quota is visible; an image-style opaque fetch would report success
 * while filling the cache with error bodies, and a rep would find out on a
 * doorstep with no signal.
 *
 * Service workers are blocked here so the stub can intercept: Playwright does
 * not route worker-initiated requests. That is also the more interesting case —
 * it proves the prefetch writes to the cache itself rather than relying on the
 * worker to catch its fetches, which is what makes a download work on a device's
 * very first visit.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const TILE_CACHE = 'allstar-tiles-v1'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/* --- 0. a platform that cannot store imagery at all --------------------- */
//
// Run before the browser, and in Node deliberately: Node defines no `caches`,
// so this is the unsupported platform, for free and without faking anything.
//
// The case is real. Cache Storage is exposed only to a secure context, and the
// native shell's page is loaded from `file://` — an origin some engines treat
// as trustworthy and some do not. `cachedCount` asked the question and
// `clearTileCache` swallowed the answer, while `prefetchTiles`, the one a rep
// taps, called `caches.open` unguarded — into a caller with a `finally` and no
// `catch`. The button un-pressed, no note appeared, and a rep would walk out
// believing their territory was saved.
{
  const preFails = []
  const preOk = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
    if (!cond) preFails.push(msg)
  }

  preOk(!tileStorageAvailable(), 'Node has no Cache Storage, so this is the unsupported platform')

  const urls = ['https://api.maptiler.com/a.png', 'https://api.maptiler.com/b.png']
  let threw = null
  let result = null
  try { result = await prefetchTiles(urls) } catch (e) { threw = e }

  preOk(threw === null, `a download on such a platform does not throw${threw ? ` (threw ${threw.name})` : ''}`)
  preOk(result?.unsupported === true, 'it says the platform cannot store imagery')
  preOk(
    result?.done === 0 && result?.failed === urls.length && result?.total === urls.length,
    'and reports nothing saved rather than a silent success',
    )
  if (preFails.length) {
    console.log(`\n${preFails.length} check(s) failed before the browser started.`)
    process.exit(1)
  }
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

let served = 0
let failEveryNth = 0
await ctx.route('**://api.maptiler.com/**', async (route) => {
  served += 1
  if (failEveryNth && served % failEveryNth === 0) {
    await route.fulfill({ status: 429, body: 'rate limited' })
    return
  }
  await route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'access-control-allow-origin': '*' },
    body: PNG,
  })
})

const page = await ctx.newPage()
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1800)

await page.getByRole('link', { name: /^More$/ }).first().click()
await page.waitForTimeout(1200)

/* === the tap that crashed the app ======================================== */
/*
 * Reported from the field: "Hitting the offline map drop down forcefully resets
 * the app back to the Home Screen or in another instance crashes me from the
 * app entirely." Two symptoms, one cause, and it is arithmetic rather than
 * anything to do with maps.
 *
 * Opening the section mounts the panel, whose first act is `tilesForBounds` —
 * one string per tile, synchronously. `zoomsWithinBudget` was supposed to keep
 * that job small, but its loop stopped at `length > 1`, so it could never say
 * "none of this fits": for a state-sized spread it returned `[14]` and 291,551
 * tiles (2.6 GB, six times the budget it exists to enforce); for one lead
 * geocoded to 0,0 — an ordinary import failure — 6.5 *million*; against world
 * bounds, 267 million. A WebView renderer does not survive allocating that. It
 * restarts, which reads as the app throwing the rep back to the first screen,
 * or the process dies and takes the app with it.
 *
 * Checked as arithmetic, with no browser, because that is what it is. The
 * numbers below are the real ones — they are what the probe measured on the
 * day, and a regression would move them.
 */
async function budgetChecks() {
  // A fresh evaluation with a key present: the module reads it once, at load,
  // and the import at the top of this file ran before anything could set it.
  process.env.EXPO_PUBLIC_MAPTILER_KEY ||= 'gate-probe'
  const t = await import('../src/lib/tiles.ts?with-key')

  const CASES = [
    ['one street', { minLat: 30.5, maxLat: 30.51, minLng: -97.69, maxLng: -97.68 }, true],
    ['a town', { minLat: 30.4, maxLat: 30.6, minLng: -97.8, maxLng: -97.6 }, true],
    ['a state', { minLat: 26, maxLat: 36, minLng: -106, maxLng: -94 }, false],
    ['one lead at 0,0', { minLat: 0, maxLat: 30.51, minLng: -97.69, maxLng: 0 }, false],
    ['the whole world', { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 }, false],
  ]

  for (const [name, bounds, shouldOffer] of CASES) {
    const zooms = t.zoomsWithinBudget(bounds, 'streets')
    const bytes = t.estimateBytes(t.tileCountForBounds(bounds, 'streets', zooms), 'streets')
    const urls = t.tilesForBounds(bounds, 'streets', zooms)

    if (shouldOffer) {
      ok(zooms.length > 0 && urls.length > 0, `${name} is still offered as a download`)
      ok(
        bytes <= t.SAVE_BUDGET_BYTES,
        `and ${name} stays inside the budget (${(bytes / 1e6).toFixed(0)} MB)`,
      )
    } else {
      /*
        The assertion that matters is the second one. The first says the screen
        will not offer an impossible download; the second says that even if it
        somehow did, nothing allocates — which is the difference between a
        wrong number and a dead app.
      */
      ok(zooms.length === 0, `${name} is refused rather than offered`)
      ok(urls.length === 0, `and building ${name} allocates nothing`)
    }

    ok(
      urls.length <= t.MAX_PREFETCH_TILES,
      `${name} never builds more than the ceiling`,
      `${urls.length.toLocaleString()} of ${t.MAX_PREFETCH_TILES.toLocaleString()}`,
    )
  }

  /*
    And the ceiling holds even when the budget is told to allow anything, which
    is the point of having two of them: the budget is an estimate that can drift
    and the ceiling is a cap on the allocation itself.
  */
  const world = { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 }
  const forced = t.zoomsWithinBudget(world, 'streets', Number.MAX_SAFE_INTEGER)
  ok(forced.length > 0, 'a budget with no limit does offer every zoom')
  ok(
    t.tilesForBounds(world, 'streets', forced).length === 0,
    'and the ceiling still refuses to build 267 million strings for it',
  )
}

const card = page.getByRole('button', { name: /Offline maps/ })

// With no key the map draws its own basemap and already works offline, so the
// control must not appear at all — an "offline maps" download that fetches
// nothing would be a lie. That is the whole assertion in this mode.
if ((await card.count()) === 0) {
  ok(true, 'offline maps control is correctly hidden when no tile key is configured')
  await browser.close()
  // The budget arithmetic is not about this deployment's key — it is about what
  // the panel would allocate if somebody opened it. It runs in both modes, or
  // the crash it exists to prevent is only covered where imagery is configured.
  await budgetChecks()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== offline maps OK (imagery not configured) ===')
  process.exit(fails.length ? 1 : 0)
}

ok(true, 'offline maps control is offered when imagery is configured')
await card.click()
await page.waitForTimeout(800)

const tileCountText = await page.locator('dt', { hasText: 'Map tiles' }).locator('..').innerText()
const total = Number((tileCountText.match(/Map tiles\s+([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0)
ok(total > 100, `territory resolves to a real tile count (${total})`)

const download = page.getByRole('button', { name: /^Download [\d.]+ MB$/ })
ok((await download.count()) > 0, 'download button names the size before committing to it')

// ---- happy path -----------------------------------------------------------
await download.click()
await page.waitForFunction(
  () => /territory is saved|could not be downloaded|Stopped/.test(document.body.innerText),
  null,
  { timeout: 120_000 },
)
const note = await page.locator('[role="status"]').first().innerText()
ok(/territory is saved/.test(note), `download reports success (${note})`)

const cached = await page.evaluate(async (name) => {
  const c = await caches.open(name)
  return (await c.keys()).length
}, TILE_CACHE)
ok(cached >= total, `tiles are actually in Cache Storage (${cached} entries, expected >= ${total})`)

await page
  .locator('dt', { hasText: 'Already saved' })
  .locator('..')
  .filter({ hasText: String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ',') })
  .waitFor({ timeout: 30_000 })
  .catch(() => {})
const savedRow = await page.locator('dt', { hasText: 'Already saved' }).locator('..').innerText()
const saved = Number((savedRow.match(/Already saved\s+([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0)
ok(saved === total, `"already saved" matches the territory (${saved}/${total})`)
ok(
  (await page.getByRole('button', { name: /Territory saved/ }).count()) > 0,
  'button settles into a completed state rather than inviting a re-download',
)

// ---- re-running costs nothing --------------------------------------------
const before = served
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /Offline maps/ }).click()
await page.waitForTimeout(1500)
ok(served === before, `a second visit re-fetches nothing (${served - before} extra requests)`)

// ---- failure path ---------------------------------------------------------
page.once('dialog', (d) => d.accept())
await page.getByRole('button', { name: /^Clear$/ }).click()
await page.waitForTimeout(1500)
ok(
  (await page.getByRole('button', { name: /^Download [\d.]+ MB$/ }).count()) > 0,
  'clearing returns the card to an offerable download',
)

failEveryNth = 4
await page.getByRole('button', { name: /^Download [\d.]+ MB$/ }).click()
await page.waitForFunction(
  () => /could not be downloaded|territory is saved/.test(document.body.innerText),
  null,
  { timeout: 120_000 },
)
const failNote = await page.locator('[role="status"]').first().innerText()
ok(
  /could not be downloaded/.test(failNote),
  `rejected tiles are reported, not silently cached (${failNote})`,
)

/* --- a wide territory must not freeze the More screen -------------------- */
//
// The bug this exists for: `OfflineMaps` built the *full* tile URL list on mount
// so the collapsed header could show a size. For a rep whose leads span eighty
// miles that is 1.39 million strings and a Set to match — 2.8 seconds on a
// desktop CPU, several times that on a phone — every single time More was
// opened, whether or not anybody touched the section.
//
// So this plants one lead far from the rest, which is all it takes to blow the
// bounding box up, and then times the screen. A count is arithmetic; if the
// component goes back to enumerating, this goes red.
{
  const wide = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page2 = await wide.newPage()
  await page2.route('**/api.maptiler.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  )
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(1200)
  await page2.getByRole('button', { name: /Try the demo/ }).click()
  await page2.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page2)
  await page2.waitForTimeout(2500)

  // One lead ~90 miles from the others, written straight into the store the app
  // hydrates from. A single bad geocode does exactly this in the real world.
  const planted = await page2.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('allstar-field')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const one = await new Promise((resolve) => {
      const tx = db.transaction('properties', 'readonly')
      const req = tx.objectStore('properties').getAll()
      req.onsuccess = () => resolve(req.result[0])
    })
    if (!one) return false
    await new Promise((resolve, reject) => {
      const tx = db.transaction('properties', 'readwrite')
      tx.objectStore('properties').put({
        ...one,
        id: 'p_far_away',
        address1: '1 Far Away Rd',
        lat: one.lat + 1.3,
        lng: one.lng - 1.3,
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return true
  })
  ok(planted, 'a distant lead can be planted to widen the territory')

  await page2.reload({ waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(2500)

  const t0 = Date.now()
  await page2.locator('a[href="/more"]:visible').first().click()
  await page2.getByRole('heading', { name: 'Sync & offline' }).waitFor({ timeout: 30_000 })
  /*
    The Offline maps header specifically, not any text ending in MB — the first
    attempt matched the "App storage 0.1 / 1077 MB" row two sections above and
    measured nothing. The header's size is rendered by the component that used to
    enumerate, so waiting for *it* is what makes this a measurement.
  */
  const offlineHeader = page2.getByRole('button', { name: /Offline maps/ })
  await offlineHeader.waitFor({ timeout: 30_000 })
  const ms = Date.now() - t0

  ok(ms < 1500, `More opens promptly with a wide territory (${ms}ms)`)

  /*
    And the size on offer stays inside the budget. Nothing good happens when an
    app tries to write twelve gigabytes to a phone — it fails slowly, or it
    succeeds and fills the device.
  */
  const label = (await offlineHeader.innerText()).replace(/\s+/g, ' ').trim()
  const mb = Number((label.match(/([\d,]+)\s*MB/) ?? [])[1]?.replace(/,/g, '') ?? '0')
  ok(
    mb > 0 && mb <= 400,
    `the offered download is capped rather than unbounded (${label})`,
  )
  await wide.close()
}

await browser.close()
await budgetChecks()

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== offline maps OK ===')
process.exit(fails.length ? 1 : 0)
