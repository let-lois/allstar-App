import { chromium } from 'playwright'
import { dismissTour } from './lib/tour.mjs'

/**
 * The app asks for location once, not on every screen.
 *
 * Reported from a real browser: the permission prompt kept reappearing while
 * moving around the app. The cause is not one bug but an absence — every call
 * to `getCurrentPosition` is its own permission request, a browser prompts on
 * each one until somebody makes a *persistent* choice, and four places were
 * asking independently. A rep who taps "Allow this time", or dismisses the bar,
 * gets asked again on the next screen.
 *
 * So what is counted here is **requests to the browser**, not prompts. Playwright
 * grants geolocation up front and never shows a prompt, which is exactly why
 * counting prompts would be untestable and counting requests is not: one request
 * is one prompt on the browser the person was actually using.
 *
 * `navigator.geolocation` is wrapped before any app code runs, so the very first
 * call on boot is caught too.
 *
 * Every move between screens is made **through the app**, never with
 * `page.goto`. A `goto` is a document load: the init script runs again and the
 * counters reset, so a before-and-after comparison spanning one is comparing two
 * different pages and cannot fail. The first version of this file did exactly
 * that, and passed with all three bugs put back.
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

/**
 * A page that counts every geolocation request, and can pretend to be denied.
 *
 * The stub moves the reported position on each fix, so a rep who is walking is
 * modelled rather than a phone sitting still — the effect loop this exists to
 * catch was driven by the position *changing*.
 */
async function open({ denied = false, permission = 'granted' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: denied ? [] : ['geolocation'],
    geolocation: { latitude: 30.5083, longitude: -97.6789, accuracy: 12 },
  })
  const page = await ctx.newPage()

  await page.addInitScript(
    ({ denied, permission }) => {
      window.__geo = { current: 0, watch: 0 }
      let drift = 0
      const fix = () => ({
        coords: {
          latitude: 30.5083 + (drift += 0.0002),
          longitude: -97.6789,
          accuracy: 12,
        },
        timestamp: Date.now(),
      })
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (success, error) => {
            window.__geo.current += 1
            if (denied) {
              error?.({ code: 1, message: 'denied' })
              return
            }
            setTimeout(() => success(fix()), 10)
          },
          watchPosition: (success) => {
            window.__geo.watch += 1
            if (denied) return 1
            // A walking rep: a new fix every second, which is what made the
            // new-lead form ask again and again.
            setTimeout(() => success(fix()), 10)
            return window.setInterval(() => success(fix()), 1000)
          },
          clearWatch: (id) => window.clearInterval(id),
        },
      })
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: async () => ({ state: permission, onchange: null }) },
      })
    },
    { denied, permission },
  )

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.waitForTimeout(700)
  const who = page.getByRole('button').filter({ hasText: /Whitfield|Vance|Rep/ })
  if (await who.count()) await who.first().click()
  await dismissTour(page)
  await page.waitForTimeout(1500)
  return { ctx, page }
}

const counts = (page) => page.evaluate(() => ({ ...window.__geo }))

/**
 * Reach the new-lead form the way a rep does — the quick-action button, then
 * "Add lead". In-app routing keeps the page alive, which keeps the counters
 * meaningful.
 */
async function openNewLead(page) {
  await page.getByRole('button', { name: /Quick actions|Add/i }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /Add a lead|Add lead/i }).first().click()
  await page.waitForTimeout(1400)
  if (!page.url().includes('/lead/new')) throw new Error(`did not reach the form: ${page.url()}`)
}

/* --- moving around the app -------------------------------------------------- */
{
  const { ctx, page } = await open()
  const afterBoot = await counts(page)

  ok(afterBoot.watch === 1, 'one shared watcher for the whole app', `${afterBoot.watch}`)
  ok(
    afterBoot.current <= 1,
    'and at most one one-shot fix on the way in',
    `${afterBoot.current}`,
  )

  /*
    The reported symptom. Every tab, twice around, while the watcher keeps
    producing new fixes underneath.
  */
  for (const round of [1, 2]) {
    for (const tab of ['Map', 'Leads', 'Pipeline', 'More', 'Today']) {
      await page.getByRole('link', { name: tab, exact: true }).click().catch(async () => {
        await page.getByRole('button', { name: tab, exact: true }).click()
      })
      await page.waitForTimeout(600)
    }
    void round
  }

  const afterTabs = await counts(page)
  ok(
    afterTabs.current === afterBoot.current,
    'moving around the app asks the browser for nothing new',
    `${afterTabs.current} one-shot fixes, unchanged`,
  )
  ok(afterTabs.watch === 1, 'and does not start a second watcher', `${afterTabs.watch}`)

  /* --- the screen that asks for a fix ---------------------------------------- */
  //
  // Adding a lead genuinely wants to know where the rep is standing. It should
  // cost at most one request, and — the bug this catches — must not ask again
  // every time the walking rep's position updates underneath it.
  await openNewLead(page)
  const onOpen = await counts(page)
  await page.waitForTimeout(4000)
  const afterWaiting = await counts(page)

  ok(
    afterWaiting.current === onOpen.current,
    'sitting on the new-lead form does not re-ask as the rep walks',
    `${afterWaiting.current - onOpen.current} extra requests in 4s`,
  )
  ok(
    onOpen.current - afterTabs.current <= 1,
    'and opening it costs at most one request',
    `${onOpen.current - afterTabs.current}`,
  )

  /*
    Two leads in a row, which is an ordinary morning.

    The second open must cost nothing: the shared watcher has been feeding the
    cache the whole time, so the answer is already here. Without that cache each
    visit to this form is its own request — and on the browser the complaint came
    from, its own prompt.
  */
  await page.getByRole('button', { name: /^Back|Cancel/i }).first().click()
  await page.waitForTimeout(800)
  const beforeSecond = await counts(page)
  await openNewLead(page)
  const afterSecond = await counts(page)
  ok(
    afterSecond.current === beforeSecond.current,
    'adding a second lead reuses the fix rather than asking again',
    `${afterSecond.current - beforeSecond.current} extra requests`,
  )

  await ctx.close()
}

/* --- refused ---------------------------------------------------------------- */
//
// Somebody who said no. Calling anyway earns nothing, and on the browsers that
// re-ask it costs another prompt — which is the exact complaint.
{
  const { ctx, page } = await open({ denied: true, permission: 'denied' })
  const start = await counts(page)

  await openNewLead(page)
  await page.waitForTimeout(500)
  const after = await counts(page)

  ok(
    after.current === start.current,
    'a refused permission is not asked again',
    `${after.current - start.current} requests after "no"`,
  )

  // And the app still works. A rep who declined location must still be able to
  // add a lead by typing the address.
  const body = await page.locator('body').innerText()
  ok(/address/i.test(body), 'and the form still works without it')

  await ctx.close()
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== location OK ===')
