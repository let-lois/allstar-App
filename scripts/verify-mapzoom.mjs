import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The wheel zooms the map.
 *
 * Reported from the console, about drawing a territory: "Zooming is difficult
 * and you have to use the + and − buttons." The wheel handler existed the whole
 * time, which is why nothing caught it — it was wired up and it was wrong, in
 * two ways that compound.
 *
 *   - **Too slow to read as movement.** `deltaY * 0.002` gives a fifth of a
 *     zoom level per mouse notch: five notches to move one step. Worse, it
 *     assumes `deltaY` is pixels. `deltaMode` says otherwise on Firefox and on
 *     some Windows setups, where a notch is reported as *three lines* — 0.006
 *     of a zoom level, a wheel that does nothing whatsoever. Somebody on that
 *     configuration is not exaggerating when they say it does not work.
 *   - **The page scrolled instead.** React registers `wheel` at the root as a
 *     passive listener, so `preventDefault()` from an `onWheel` prop is a
 *     silent no-op. The console scrolled away under the cursor while the map
 *     crept.
 *
 * Both are invisible to a gate that only asks "is there a wheel handler", so
 * this one measures the outcome instead: the distance between two named pins,
 * which is a direct function of zoom and is computed by the renderer rather
 * than by the code under test. Zooming in by one level doubles it.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
// A desktop viewport with a mouse, because a wheel is the gesture under test
// and the report came from somebody drawing territories at a desk.
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.route('**://maps.googleapis.com/**', (r) => r.abort())

/**
 * How far apart two pins are drawn, in pixels.
 *
 * The pair is chosen once and then followed by id, so the measurement is of the
 * same two houses throughout — picking "the first two pins" again after a zoom
 * would silently compare different leads.
 */
const spread = (a, b) =>
  page.evaluate(
    ([idA, idB]) => {
      const at = (id) => {
        const g = document.querySelector(`[data-marker="pin"][data-id="${CSS.escape(id)}"] circle`)
        if (!g) return null
        const r = g.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      const p = at(idA)
      const q = at(idB)
      if (!p || !q) return null
      return Math.hypot(p.x - q.x, p.y - q.y)
    },
    [a, b],
  )

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)
  // Signing in lands on Today; the map is a route away.
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const map = page.getByRole('application', { name: /Map of your leads/ })
  ok((await map.count()) > 0, 'the map is on screen to zoom')
  const box = await map.boundingBox()
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  /*
    Two pins far enough apart that a ratio between them is a measurement rather
    than rounding. Widely separated on purpose: two dots six pixels apart give
    the same ratio for a working wheel and a broken one once the renderer has
    rounded them.
  */
  const pair = await page.evaluate(() => {
    const pins = [...document.querySelectorAll('[data-marker="pin"]')].map((g) => {
      const c = g.querySelector('circle').getBoundingClientRect()
      return { id: g.getAttribute('data-id'), x: c.x + c.width / 2, y: c.y + c.height / 2 }
    })
    let best = null
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const d = Math.hypot(pins[i].x - pins[j].x, pins[i].y - pins[j].y)
        if (!best || d > best.d) best = { a: pins[i].id, b: pins[j].id, d }
      }
    }
    return best
  })
  ok(!!pair && pair.d > 40, 'two pins are drawn far enough apart to measure a zoom against',
    pair ? `${pair.d.toFixed(0)}px apart` : '(no pins)')
  if (!pair) throw new Error('no pins to measure')

  /* --- 1. one notch of a mouse wheel is worth doing ---------------------- */
  const before = await spread(pair.a, pair.b)
  await page.mouse.move(centre.x, centre.y)
  // Negative deltaY is the direction a wheel goes when a hand pushes forward,
  // which everywhere else on a map means "closer".
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(600)
  const after = await spread(pair.a, pair.b)

  /*
    A zoom level doubles the separation, so the ratio *is* the movement: 1.41 is
    half a level, 1.15 is the fifth of a level the old rate gave. The bar sits
    between them deliberately — a wheel a person has to spin five times to cross
    one step is the complaint, not a near miss of it.
  */
  const ratio = after && before ? after / before : 0
  ok(ratio >= 1.3, 'one notch of the wheel moves the map a visible amount',
    `${before?.toFixed(0)}px → ${after?.toFixed(0)}px, ×${ratio.toFixed(2)}`)
  ok(ratio > 1, 'and zooms in rather than out', `×${ratio.toFixed(2)}`)

  /* --- 2. the map claims the gesture ------------------------------------- */
  /*
    `dispatchEvent` returns false when something called `preventDefault`. A
    passive listener cannot, so this is also the check that the handler is
    registered natively with `{ passive: false }` rather than through React's
    root — which is the whole reason it is an effect and not a prop.
  */
  const claimed = await page.evaluate(() => {
    const el = document.querySelector('[role="application"]')
    // Zero delta on purpose: this asks whether the gesture is claimed, and a
    // check that also moved the map would leave the next one measuring from
    // somewhere it did not choose.
    const e = new WheelEvent('wheel', { deltaY: 0, bubbles: true, cancelable: true })
    return !el.dispatchEvent(e)
  })
  ok(claimed, 'the map takes the wheel rather than letting the page scroll under it')

  /* --- 3. a browser that counts lines, not pixels ------------------------- */
  /*
    `deltaMode: 1` is what Firefox and some Windows configurations send: a notch
    is 3, not 100. Under the old handler that was 0.006 of a zoom level and the
    wheel was inert. The same notch has to move the map the same distance here.

    Outward rather than inward, which is not a weaker test — the rate is the
    same in both directions and it is the *magnitude* being checked. It also
    puts the map back where it started, so the two gestures are measured over
    the same ground instead of the second one running off the end of the first.
  */
  const beforeLines = await spread(pair.a, pair.b)
  await page.evaluate(() => {
    document.querySelector('[role="application"]').dispatchEvent(
      new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }),
    )
  })
  await page.waitForTimeout(600)
  const afterLines = await spread(pair.a, pair.b)
  const lineRatio = afterLines && beforeLines ? beforeLines / afterLines : 0
  ok(lineRatio >= 1.3, 'a browser that reports lines rather than pixels zooms by the same notch',
    `${beforeLines?.toFixed(0)}px → ${afterLines?.toFixed(0)}px, ×${lineRatio.toFixed(2)} the other way`)

  ok(errors.length === 0, 'and nothing threw while doing it', errors.join(' | '))
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the wheel zooms the map, in whatever units the browser reports ===')
