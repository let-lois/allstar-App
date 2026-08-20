import { chromium } from 'playwright'

/**
 * What the map screen does when Google Maps cannot load.
 *
 * The happy path is not testable here — it needs a real key on an allowed
 * origin, and a key that works in CI is a key committed somewhere. What *is*
 * testable, and matters more, is every way it fails. All three failures look
 * identical on screen if nothing handles them: a grey rectangle, which a rep
 * cannot tell from a map that is still loading. This asserts each one produces a
 * usable screen and a named reason instead.
 *
 * Run against a build made with placeholder Google values, since with the vars
 * unset Rollup proves the branch dead and strips the entire Google renderer from
 * the bundle — which is the correct behaviour for a deployment that does not use
 * it, and makes the code under test absent:
 *
 *   VITE_GOOGLE_MAPS_KEY=dummy VITE_GOOGLE_MAP_ID=DEMO_MAP_ID npm run build
 *
 * **Not covered, deliberately: the `undrawable` case.** A vector map that is
 * created successfully and then never paints — WebGL unavailable, or the
 * WebAssembly compile blocked — is watched for with a paint timeout in
 * GoogleFieldMap. Reproducing it needs a *working* Maps API with its WASM
 * blocked, which needs a real key; and faking the API convincingly enough for
 * the marker clusterer to run means maintaining a stub of Google's library,
 * which is a liability that can break on its own. So this one is verified by
 * reading, and it is written down here rather than left as an assumed pass.
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

/** Sign in to the demo and land on the map. */
async function toMap(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(1800)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1500)
}

/* --- the script never arrives: no signal ---------------------------------- */
//
// The case a rep actually hits, and the one where getting it wrong costs a
// morning. The list must appear on its own, without the rep knowing to ask.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await toMap(page)

  const note = page.getByRole('status').filter({ hasText: /Map unavailable/ })
  await note.waitFor({ timeout: 20_000 }).catch(() => {})
  ok(await note.isVisible(), 'an unreachable map is reported rather than left grey')
  const text = await note.innerText()
  ok(
    /No connection for map imagery/.test(text),
    `the reason names connectivity, not a stack trace (${text.replace(/\s+/g, ' ').slice(0, 70)})`,
  )
  ok(
    /saved on this phone/.test(text),
    'and tells the rep their logged work is safe, which is the thing they will worry about',
  )

  const list = page.getByRole('list', { name: 'Route stops' })
  ok(await list.isVisible(), 'the route falls back to a list automatically')
  ok((await list.getByRole('button').count()) > 0, 'with the stops still in it')

  // The rep must not be stranded in the fallback once signal returns.
  ok(
    await page.getByRole('button', { name: /^map$/i }).isVisible(),
    'and the map view is still offered rather than hidden',
  )
  await ctx.close()
}

/* --- the key is rejected -------------------------------------------------- */
//
// Google reports this by calling a global rather than by failing the request, so
// an unhooked app shows a blank map and no error at all. This is the single most
// likely thing to break on a new deployment: a referrer list that does not yet
// include the origin being loaded.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()

  // Stand in for Google's own rejection path: serve a script that calls the
  // failure global, exactly as the real API does for a bad key or referrer.
  await page.route('**://maps.googleapis.com/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.gm_authFailure && window.gm_authFailure();',
    }),
  )
  await toMap(page)

  const note = page.getByRole('status').filter({ hasText: /Map unavailable/ })
  await note.waitFor({ timeout: 20_000 }).catch(() => {})
  ok(await note.isVisible(), 'a rejected key is surfaced instead of showing an empty map')
  const text = await note.innerText()
  ok(
    /website restrictions/i.test(text),
    `and the message points at the actual fix (${text.replace(/\s+/g, ' ').slice(0, 80)})`,
  )
  ok(
    !/No connection/.test(text),
    'a rejected key is not misreported as being offline — different problem, different fix',
  )

  ok(
    await page.getByRole('list', { name: 'Route stops' }).isVisible(),
    'and the rep still gets their route',
  )
  await ctx.close()
}

/* --- a failure must not be permanent ------------------------------------- */
//
// A load that failed in a lift must not poison the screen for the rest of the
// day. Revisiting the map has to try again.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  let attempts = 0
  await page.route('**://maps.googleapis.com/**', (r) => {
    attempts += 1
    return r.abort()
  })
  await toMap(page)
  await page.getByRole('status').filter({ hasText: /Map unavailable/ }).waitFor({ timeout: 20_000 })
  const first = attempts

  // Leave the screen and come back, as a rep does all day.
  await page.locator('a[href="/today"]:visible').first().click()
  await page.waitForTimeout(800)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(2500)

  ok(
    attempts > first,
    `returning to the map retries the load (${first} then ${attempts} attempts)`,
  )
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== google map failure handling OK ===')
process.exit(fails.length ? 1 : 0)
