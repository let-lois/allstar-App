import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The software keyboard, as iOS presents it to the page.
 *
 * WKWebView shrinks the *visual* viewport and leaves the layout viewport where
 * it was. Chromium's device emulation has no keyboard at all, so this stands one
 * in: `visualViewport.height` is overridden and a `resize` fired, which is the
 * exact signal the app listens to. Two things are asserted.
 *
 * 1. Sign-in stays scrollable to its top. It used to centre with
 *    `justify-content`, which overflows upward once the pane is shorter than the
 *    form — the logo and the email field went above the scroll origin, where no
 *    amount of scrolling reaches.
 * 2. The bottom dock gets out of the way while the keyboard is up, and comes
 *    back when it goes — on Add lead it had left room for about one field.
 *
 * Run against a production preview build (`npm run build && npm run preview`).
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (c, m, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${extra ? `  (${extra})` : ''}`)
  if (!c) fails.push(m)
}

/** Present (or withdraw) a keyboard that leaves `visible` px of viewport. */
async function keyboard(page, visible) {
  await page.evaluate((h) => {
    const vv = window.visualViewport
    if (h == null) delete vv.__h
    else vv.__h = h
    if (!vv.__patched) {
      const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height')
      Object.defineProperty(vv, 'height', {
        configurable: true,
        get() {
          return this.__h ?? own.get.call(this)
        },
      })
      vv.__patched = true
    }
    vv.dispatchEvent(new Event('resize'))
  }, visible)
  await page.waitForTimeout(150)
}

// An iPhone SE: 667 tall, and iOS's keyboard with its suggestion bar leaves
// roughly 400 of it.
const ctx = await browser.newContext({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

/* --- sign-in ---------------------------------------------------------------- */
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /Try the demo/ }).waitFor({ timeout: 15_000 })
await keyboard(page, 300)
const signIn = await page.evaluate(() => {
  const pane = document.querySelector('.app-shell .scroll-pane')
  const form = pane?.firstElementChild
  if (!pane || !form) return null
  pane.scrollTop = 0
  return {
    paneTop: pane.getBoundingClientRect().top,
    formTop: form.getBoundingClientRect().top,
    overflows: pane.scrollHeight > pane.clientHeight + 1,
  }
})
ok(!!signIn, 'the sign-in pane is found')
ok(!!signIn?.overflows, 'with the keyboard up, the sign-in form is taller than what is left', JSON.stringify(signIn))
ok(
  !!signIn && signIn.formTop >= signIn.paneTop - 1,
  'and its top is still reachable by scrolling, not pushed above the scroll origin',
  signIn ? `form ${Math.round(signIn.formTop)} vs pane ${Math.round(signIn.paneTop)}` : '',
)
await keyboard(page, null)

/* --- the dock on Add lead ---------------------------------------------------- */
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1200)
const dock = page.locator('nav.nav-dock')
ok(await dock.isVisible(), 'the dock is shown with no keyboard')

await page.evaluate(() => {
  history.pushState({}, '', '/lead/new')
  dispatchEvent(new PopStateEvent('popstate'))
})
await page.waitForTimeout(800)
await keyboard(page, 400)
ok(!(await dock.isVisible()), 'the dock steps aside while the keyboard is up')
ok(
  (await page.evaluate(() => document.documentElement.hasAttribute('data-kb'))) === true,
  'because the page knows the keyboard is there',
)
await keyboard(page, null)
ok(await dock.isVisible(), 'and comes back when the keyboard goes')

// A pinch-zoomed page also has a short visual viewport; that is not a keyboard.
await page.evaluate(() => {
  const vv = window.visualViewport
  Object.defineProperty(vv, 'scale', { configurable: true, get: () => 2 })
})
await keyboard(page, 330)
ok(await dock.isVisible(), 'a pinch zoom is not mistaken for the keyboard')
await keyboard(page, null)

ok(errors.length === 0, 'no page errors', errors.join(' | '))

await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\nkeyboard OK')
