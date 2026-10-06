import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The App Store build hides the testing aids; every other build keeps them.
 *
 * Apple's review checklist: no demo or placeholder data, and no testing
 * features in the shipped app. The phone shell tells the web app it is a store
 * build (`__allstarShell.storeBuild`, set for any channel that is not one of
 * ours — see apps/mobile/src/lib/inspectable.ts). There the login screen has
 * no "Try the demo" and More has no "Simulate no signal". A browser, and the
 * TestFlight and preview builds, keep both.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}
const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []
const page = async (store) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  if (store) await ctx.addInitScript(() => { window.__allstarShell = { storeBuild: true } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(String(e)))
  await p.route('**://maps.googleapis.com/**', (r) => r.abort())
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1200)
  return { ctx, p }
}
const demoButton = (p) => p.getByRole('button', { name: /Try the demo/ })
const go = (p, to) => p.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, to)
const fieldTesting = async (p) => {
  await go(p, '/more')
  await p.waitForTimeout(900)
  return p.getByText('Field testing', { exact: true }).count()
}

try {
  {
    const { ctx, p } = await page(true)
    ok((await demoButton(p).count()) === 0, 'the store build has no "Try the demo" on the login screen')
    ok((await p.getByRole('link', { name: 'Terms' }).count()) === 1, 'and links the terms of use beside the privacy policy')
    await ctx.close()
  }
  {
    const { ctx, p } = await page(false)
    ok((await demoButton(p).count()) === 1, 'a browser (and TestFlight) keeps the demo')
    await demoButton(p).click()
    await p.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(p)
    await p.waitForTimeout(1000)
    ok((await fieldTesting(p)) === 1, 'and "Field testing" in More')
    ok((await p.getByRole('link', { name: 'Terms of use' }).count()) === 1, 'More links the terms of use')
    // The same session, told it is a store build: the switch goes.
    await p.evaluate(() => { window.__allstarShell = { ...window.__allstarShell, storeBuild: true } })
    await go(p, '/today')
    await p.waitForTimeout(500)
    ok((await fieldTesting(p)) === 0, 'the store build has no "Field testing" / "Simulate no signal"')
    await ctx.close()
  }
} finally {
  await browser.close()
}
ok(errors.length === 0, 'no page errors', errors[0])
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== the store build ships without its testing aids ===')
