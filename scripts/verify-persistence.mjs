import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The app asks the browser to keep its data.
 *
 * Without it everything cached here is best-effort storage: a browser short of
 * disk may evict it, and iOS Safari clears script-writable storage after seven
 * days of not opening a site that is not installed. For a field app that is a
 * rep back from a week off finding an app that looks freshly installed — leads
 * re-download, and anything still in the outbox does not, because the server
 * never heard of it.
 *
 * `navigator.storage.persist()` is stubbed rather than driven for real, because
 * a headless Chromium's answer is a property of the harness and not of this
 * code. What is worth asserting is our side of it: that we ask, that we ask
 * once rather than on a loop, that we do not re-ask something already granted,
 * that a refusal is survivable, and that the screen reports the answer it got
 * instead of the answer it wanted.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const errors = []

/**
 * A page whose storage manager answers however this test needs, and counts.
 *
 * Installed before any app code runs, so the very first call is captured —
 * asking at boot is the whole point and a stub attached afterwards would miss
 * it entirely.
 */
async function open({ granted, alreadyPersisted = false, throws = false }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.addInitScript(
    ({ granted, alreadyPersisted, throws }) => {
      window.__persistCalls = 0
      window.__persistedCalls = 0
      let state = alreadyPersisted
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          persist: async () => {
            window.__persistCalls += 1
            if (throws) throw new DOMException('denied', 'SecurityError')
            state = granted
            return granted
          },
          persisted: async () => {
            window.__persistedCalls += 1
            if (throws) throw new DOMException('denied', 'SecurityError')
            return state
          },
          estimate: async () => ({ usage: 700_000, quota: 1_036_000_000 }),
        },
      })
    },
    { granted, alreadyPersisted, throws },
  )

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.waitForTimeout(700)
  const who = page.getByRole('button').filter({ hasText: /Admin|Rep|Manager|Whitfield|Vance/ })
  if (await who.count()) await who.first().click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  return { ctx, page }
}

const calls = (page) => page.evaluate(() => window.__persistCalls)
const checks = (page) => page.evaluate(() => window.__persistedCalls)

/* --- it asks, and the browser says yes -------------------------------------- */
{
  const { ctx, page } = await open({ granted: true })
  ok((await calls(page)) >= 1, 'the app asks the browser to keep its data')

  // Not on a loop. A permission call per render, or per navigation, is the kind
  // of thing that prompts a person repeatedly in the browsers that prompt.
  const after = await calls(page)
  await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok((await calls(page)) === after, 'and does not keep asking as the rep moves around',
     `${await calls(page)} call(s) total`)

  const saved = page.getByRole('button', { name: /Saved on this phone/ })
  if ((await saved.count()) && (await saved.first().getAttribute('aria-expanded')) === 'false') {
    await saved.first().click()
    await page.waitForTimeout(400)
  }
  const body = await page.locator('dl').first().innerText()
  ok(/Storage/.test(body) && /Kept/.test(body), `the screen reports it as kept — "${
    body.split('\n').find((l) => /Kept|May be cleared/.test(l)) ?? body.slice(0, 40)
  }"`)

  await ctx.close()
}

/* --- already granted: do not ask again -------------------------------------- */
//
// `persist()` can prompt. A browser that has already promised must not be asked
// a second time, which means checking `persisted()` first.
{
  const { ctx, page } = await open({ granted: true, alreadyPersisted: true })
  ok((await checks(page)) >= 1, 'it checks whether the promise already exists')
  ok((await calls(page)) === 0, 'and does not re-ask a browser that already agreed')
  await ctx.close()
}

/* --- refused ---------------------------------------------------------------- */
//
// The common case on a phone the rep has not installed. It must not break
// anything, and it must not be reported as if it had worked.
{
  const { ctx, page } = await open({ granted: false })
  ok((await calls(page)) >= 1, 'a refusal still comes from having asked')

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const saved = page.getByRole('button', { name: /Saved on this phone/ })
  if ((await saved.count()) && (await saved.first().getAttribute('aria-expanded')) === 'false') {
    await saved.first().click()
    await page.waitForTimeout(400)
  }
  const text = await page.locator('.scroll-pane').first().innerText()
  ok(/May be cleared/.test(text), 'the screen says the data may be cleared rather than claiming it is safe')
  ok(
    /home screen/i.test(text),
    'and says what to do about it, since installing is what actually fixes it',
  )
  ok(
    /already uploaded is safe/i.test(text),
    'and does not overstate the risk — what reached the server is not at stake',
  )

  // The app still works. A refused permission is not an error state.
  await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  ok(
    (await page.locator('button').count()) > 3,
    'and the app carries on working normally after being told no',
  )
  await ctx.close()
}

/* --- the browser throws instead of answering -------------------------------- */
//
// Private browsing on some engines. Not being able to ask is the same outcome
// as being told no, and neither is a crash.
{
  const { ctx, page } = await open({ granted: false, throws: true })
  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok(errors.length === 0, `a storage manager that throws does not break the app${
    errors.length ? ` — ${errors[0]}` : ''
  }`)
  await ctx.close()
}

ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors[0]}` : ''}`)

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== storage persistence OK ===')
