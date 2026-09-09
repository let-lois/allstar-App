import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Tap a house, get a pin, get a form — and nothing in the database until Save.
 *
 * A rep standing in front of a house that is not in the app had to open a
 * menu, find "Add lead", and type an address for the place they were looking
 * at. The map is the screen they are already on and the house is already under
 * their thumb, so the tap became the way in.
 *
 * Three things this has to prove, in order of how badly they would be missed:
 *
 * **The pin is where the finger was.** It is the whole confirmation. A pin that
 * lands somewhere else, or slides to the middle of the screen when the sheet
 * opens, is worse than no pin at all — the rep has no way to tell which house
 * they are about to save.
 *
 * **Nothing is created by tapping.** Panning a map while walking is the most
 * common thing anybody does on this screen. If a stray tap wrote a row, a
 * week's use would leave a territory full of blank leads nobody put there.
 *
 * **Existing leads still open.** The tap gesture already meant "open this
 * lead" for the pins on the map, and that meaning had to survive.
 *
 * ## What this exercises, and what it cannot
 *
 * The self-rendered map. In production, where a Google key is configured, the
 * Google renderer draws instead — and its happy path is not testable here for
 * the same reason `verify:googlemap` says: it needs a real key on an allowed
 * origin, and a key that works in CI is a key committed somewhere. The picking
 * logic is deliberately shared (`pick` is one prop with one meaning on both
 * renderers, and the pin is one shape from one module), so what is left
 * untested there is the wiring: a `click` listener, a `gmp-click` branch and an
 * advanced marker. Verified by reading, and written down here rather than left
 * as an assumed pass.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})
const page = await ctx.newPage()

/** Every lead on the device, straight out of IndexedDB. */
const leads = () =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          // Read-only: a readwrite transaction on a store the app reads during
          // boot has hung a gate on this project before.
          const r = req.result.transaction('properties', 'readonly').objectStore('properties').getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(new Error('no properties'))
        }
      }),
  )

const pinBox = async () => {
  const pin = page.locator('[data-testid="location-pin"]')
  if ((await pin.count()) === 0) return null
  return pin.first().boundingBox()
}

/**
 * Where the pin's point actually is, in screen coordinates.
 *
 * Not its bounding box, which is the union of the ink and the stroke around it
 * and sits several pixels below the point — enough to let a pin anchored by the
 * wrong part of itself pass a loose comparison. This asks the SVG where the
 * (12, 23) of the pin's own drawing lands, which is the claim the shape makes.
 */
const pinTip = () =>
  page.evaluate(() => {
    const g = document.querySelector('[data-testid="location-pin"]')
    if (!g) return null
    const m = g.getScreenCTM()
    if (!m) return null
    return { x: m.a * 12 + m.c * 23 + m.e, y: m.b * 12 + m.d * 23 + m.f }
  })

const readout = async () => {
  const el = page.locator('[data-testid="lead-pin-readout"]')
  return (await el.count()) ? (await el.innerText()).replace(/\s+/g, ' ') : ''
}

/**
 * Tap the map somewhere that is not a lead.
 *
 * Which points are free depends on the demo data and the viewport, so this
 * tries a few and reports where it landed rather than hard-coding a spot that
 * a future fixture change would silently turn into a pin tap.
 */
async function tapOpenGround(candidates) {
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y)
    await page.waitForTimeout(700)
    if (await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)) {
      return { x, y }
    }
    // A lead's own sheet came up instead — that tap found a house. Put it away
    // and try elsewhere.
    const close = page.getByRole('button', { name: /All properties/ })
    if (await close.isVisible().catch(() => false)) await close.click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  return null
}

try {
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1500)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1500)

  const before = (await leads()).length
  ok(before > 0, 'the demo map has leads on it to begin with', `${before} leads`)
  ok((await pinBox()) === null, 'and no location pin until somebody taps one')

  /* ===== 1. a tap puts a pin under the finger and opens the form ========= */
  const at = await tapOpenGround([
    [200, 430],
    [110, 470],
    [300, 380],
    [150, 350],
    [250, 500],
  ])
  ok(!!at, 'tapping open ground opens the Add-lead sheet', at ? `at ${at.x},${at.y}` : 'never opened')
  if (!at) throw new Error('no free map space found in five tries — the fixture may have changed')

  ok((await pinBox()) !== null, 'and drops a location pin')
  {
    /*
      The pin's *point* is the claim it makes, so that is what is measured — not
      its centre, which sits a pin-height above it and would let a pin anchored
      by its middle pass while pointing at the wrong house. Two pixels, because
      this is arithmetic rather than layout: anything looser would tolerate the
      off-by-a-nav-bar error this assertion was written to catch.
    */
    const tip = await pinTip()
    ok(
      !!tip && Math.abs(tip.x - at.x) <= 2 && Math.abs(tip.y - at.y) <= 2,
      'with its point exactly where the finger was',
      tip ? `tip ${tip.x.toFixed(1)},${tip.y.toFixed(1)} vs tap ${at.x},${at.y}` : 'no pin',
    )
  }
  ok(/tapped/i.test(await readout()), 'and the form says the pin came from the tap', await readout())

  /* ===== 2. the map is still the screen ================================= */
  //
  // The reason this is a sheet and not the full-screen Add-lead form: a rep
  // needs to keep seeing which house they are naming.
  {
    const sheet = await page
      .locator('[data-testid="add-lead-sheet"]')
      .evaluate((el) => {
        /*
          The sheet's own panel. Not `[role="dialog"]`, which is on the
          full-viewport wrapper the panel sits inside — measuring that reports
          844px of "sheet" whatever height the sheet actually is, and this
          assertion would then never fail.
        */
        const panel = el.closest('.anim-sheet') ?? el.parentElement
        return panel.getBoundingClientRect().height
      })
    ok(sheet <= 844 * 0.62, 'the sheet leaves most of the map visible', `${Math.round(sheet)}px of 844`)
    const stillThere = await pinBox()
    ok(!!stillThere, 'and the pin stays up while the form is open')

    /*
      Save has to be reachable without scrolling the sheet.

      It shipped below the fold the first time: the sheet opens at under half
      the screen, the form is three fields tall, and the button was under the
      third one. Measured rather than eyeballed — in the viewport, inside the
      sheet, and a full thumb target.
    */
    const save = page.getByRole('button', { name: /Save lead/ })
    const sb = await save.boundingBox()
    ok(
      !!sb && sb.y + sb.height <= 844 && sb.y >= 0,
      'the Save button is on screen without scrolling the sheet',
      sb ? `bottom at ${Math.round(sb.y + sb.height)} of 844` : 'no button',
    )
    ok(!!sb && sb.height >= 44, 'and is a full thumb target', sb ? `${Math.round(sb.height)}px tall` : '')
  }

  /* ===== 3. nothing has been written ==================================== */
  ok((await leads()).length === before, 'tapping the map created no lead', `${(await leads()).length} leads`)

  /* ===== 4. a second tap moves the same pin ============================= */
  {
    const first = await pinBox()
    const firstText = await readout()
    await page.mouse.click(at.x + 60, at.y - 70)
    await page.waitForTimeout(600)
    const pins = await page.locator('[data-testid="location-pin"]').count()
    const second = await pinBox()
    ok(pins === 1, 'a second tap leaves one pin, not two', `${pins} pins`)
    ok(
      !!second && Math.abs(second.x - first.x) > 20,
      'and moves it to the new spot',
      second ? `${Math.round(first.x)} → ${Math.round(second.x)}` : 'no pin',
    )
    ok((await readout()) !== firstText, 'with the coordinates updated to match', await readout())
    ok((await leads()).length === before, 'and still nothing written', `${(await leads()).length} leads`)
  }

  /* ===== 5. cancel takes the pin away =================================== */
  {
    await page.getByRole('button', { name: /^Cancel$/ }).click()
    await page.waitForTimeout(600)
    ok((await pinBox()) === null, 'cancelling removes the location pin')
    ok(
      !(await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)),
      'and closes the form',
    )
    ok((await leads()).length === before, 'having created nothing', `${(await leads()).length} leads`)
  }

  /* ===== 6. a drag is not a tap ========================================= */
  //
  // The single most common gesture on this screen. If it opened a form, the app
  // would be unusable while walking.
  {
    await page.mouse.move(200, 500)
    await page.mouse.down()
    for (const step of [1, 2, 3, 4, 5, 6]) await page.mouse.move(200 - step * 12, 500 - step * 8)
    await page.mouse.up()
    await page.waitForTimeout(600)
    ok(
      !(await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)),
      'dragging the map does not open the form',
    )
    ok((await pinBox()) === null, 'and places no pin')
  }

  /* ===== 7. an existing lead still opens ================================ */
  //
  // The control. Every assertion above would pass just as well if the tap
  // handler had simply stopped selecting leads — which would be a worse bug
  // than the one being fixed.
  {
    const pin = page.locator('[data-marker="pin"]').first()
    await pin.click({ force: true })
    await page.waitForTimeout(800)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(
      /View full profile/.test(body),
      'tapping a lead on the map still opens that lead, not the Add-lead form',
    )
    ok(
      !(await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)),
      'and the Add-lead form stays shut',
    )
  }

  /* ===== 8. saving is what creates the lead ============================= */
  {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const spot = await tapOpenGround([
      [200, 430],
      [110, 470],
      [300, 380],
      [150, 350],
      [250, 500],
    ])
    ok(!!spot, 'the form opens again for the save')
    /*
      The coordinates the form is showing, read off the screen before saving.

      Checked against the stored row afterwards rather than against a screen
      position: the map deliberately flies to the new lead so it is not
      swallowed by a cluster, so pixels move — but the house must not. A lead
      saved at coordinates a street away from the pin would satisfy every other
      assertion in this gate.
    */
    const shownCoords = /(-?\d+\.\d+), (-?\d+\.\d+)/.exec(await readout())
    ok(!!shownCoords, 'the form shows the pin’s coordinates', shownCoords?.[0])
    await page.locator('input[autocomplete="street-address"]').fill('91 Verified Way')
    await page.getByRole('button', { name: /Save lead/ }).click()
    await page.waitForTimeout(1500)

    const after = await leads()
    const made = after.find((p) => p.address1 === '91 Verified Way')
    ok(after.length === before + 1, 'saving creates exactly one lead', `${after.length} leads`)
    ok(!!made, 'with the address that was typed')
    ok((await pinBox()) === null, 'and the temporary pin is gone')
    /*
      The coordinates are the point of the whole flow, so they are checked
      against the pin that was on screen rather than merely being present.
      Projected back through the same viewport: a lead saved a street away from
      where the rep tapped would satisfy every other assertion here.
    */
    if (made && shownCoords) {
      ok(
        made.lat.toFixed(5) === shownCoords[1] && made.lng.toFixed(5) === shownCoords[2],
        'saved at the coordinates the pin was standing on',
        `stored ${made.lat.toFixed(5)}, ${made.lng.toFixed(5)} vs shown ${shownCoords[1]}, ${shownCoords[2]}`,
      )
      const marker = await page.evaluate(
        (id) => !!document.querySelector(`[data-marker="pin"][data-id="${id}"]`),
        made.id,
      )
      ok(marker, 'and drawn on the map as an ordinary lead marker of its own')
    }
  }
} finally {
  const shot = process.env.SHOT
  if (shot) await page.screenshot({ path: shot })
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== a tap is a pin and a form; only Save is a lead ===')
