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

  /*
    With no Google key, nothing is filled in — and nothing pretends to be.

    This is the state every gate runs in, and also the state of any deployment
    whose key does not have the Geocoding API switched on. The address prefill
    is allowed to be absent; what it is not allowed to do is claim it happened,
    or leave a half-filled field behind. `verify:address` covers the lookup
    itself, without a key.
  */
  {
    const value = await page.locator('input[autocomplete="street-address"]').inputValue()
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(value === '', 'with no geocoding available the address field is left empty', `"${value}"`)
    ok(
      !/Filled in from the map/.test(body) && !/Looking up the address/.test(body),
      'and the form does not claim an address it never got',
    )
  }

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
    /*
      Asked by a hook rather than by a button's words. This used to look for
      "View full profile", which moved into the sheet's footer and was renamed
      when the peek's actions were pinned there — so the assertion started
      failing for a reason that had nothing to do with what it was testing.
      A label is copy; a testid is the question.
    */
    ok(
      await page.getByTestId('property-peek').isVisible().catch(() => false),
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
    // A name and a number too. The point of the next step is what comes back
    // when the rep taps this door again — and what must NOT come back when they
    // tap the next one. An assertion that the phone field is empty afterwards
    // is worth nothing if no phone was ever typed, which is how it first got
    // written.
    await page.locator('input[autocomplete="name"]').fill('Marcus Vance')
    await page.locator('input[autocomplete="tel"]').fill('512-555-0134')
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

    /* ===== 9. tapping it again says who and what it is ================== */
    //
    // Reported from a phone: a rep added a lead, tapped its marker, and the
    // sheet told them nothing about who lived there. The contact row rendered
    // only `if (contact || opportunityValue)`, and a lead added from the map
    // has neither — so its own "No contact" fallback was unreachable for
    // exactly the leads that needed it, and the sheet went from the status
    // pills straight to "Last visit never".
    if (made) {
      const box = await page
        .locator(`[data-marker="pin"][data-id="${made.id}"]`)
        .first()
        .boundingBox()
      ok(!!box, 'the new lead’s marker can be found to tap')
      if (box) {
        // Where a finger lands, not a synthetic event: the map listens for a
        // real click, and a dispatched one opens nothing.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(1000)

        const peek = page.getByTestId('property-peek')
        const opened = await peek.isVisible().catch(() => false)
        ok(opened, 'tapping the lead just recorded opens its own sheet')
        const text = opened ? (await peek.innerText()).replace(/\s+/g, ' ') : ''
        ok(/Marcus Vance/.test(text), 'which names the contact that was typed in', text.slice(0, 80))
        ok(
          /\bNew\b/.test(text),
          'and says what state the lead is in',
          text.match(/\b(New|Contacted|Follow up|Working|Appointment|Quoted|Won|Lost)\b/)?.[0],
        )
        /*
          Above the fold, not merely present. This sheet opens at 0.46 of the
          screen on a phone, and "in the DOM" is not the same claim as "the rep
          can see it" — which is the whole reason this was reported.
        */
        const seen = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="peek-contact"]')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), fold: window.innerHeight }
        })
        ok(
          !!seen && seen.top >= 0 && seen.bottom <= seen.fold,
          'without the rep having to drag the sheet up to find it',
          seen ? `y ${seen.top}-${seen.bottom} of ${seen.fold}` : 'no contact row at all',
        )
      }
    }

    /* ===== 10. and says so even when nobody was named =================== */
    //
    // The half that was actually broken. Leaving the optional name blank is the
    // common case for a door a rep has not knocked yet.
    {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      const spot2 = await tapOpenGround([
        [120, 300],
        [280, 320],
        [200, 260],
        [90, 380],
        [310, 460],
      ])
      ok(!!spot2, 'the form opens for a lead with no contact')
      if (spot2) {
        /*
          The draft is emptied between leads.

          `useLeadDraft` is called by MapScreen, so it outlives the sheet, and
          nothing used to clear it. Three separate defects came out of that and
          all three are on the most-used flow on this screen, so all three are
          asserted here rather than trusted to one of them standing in for the
          others.
        */
        const btns = await page.evaluate(() =>
          [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent?.trim()),
        )
        ok(
          btns.some((b) => /Save lead/.test(b ?? '')) && !btns.some((b) => /Saving/.test(b ?? '')),
          'a second lead can actually be saved — the button is not still "Saving…"',
          btns.filter((b) => /Sav/.test(b ?? '')).join(' | ') || 'no save button at all',
        )
        ok(
          (await page.locator('input[autocomplete="name"]').inputValue()) === '',
          'and it does not offer the previous homeowner’s name as this one’s',
          JSON.stringify(await page.locator('input[autocomplete="name"]').inputValue()),
        )
        ok(
          (await page.locator('input[autocomplete="tel"]').inputValue()) === '',
          'nor their phone number',
        )

        /*
          Guarded, because when this regresses the button is not merely
          disabled — it is a different button, and clicking a locator that
          matches nothing throws. An uncaught throw here ends the run and
          reports three real failures as no output at all, which is how the
          first version of this step behaved.
        */
        const saveAgain = page.getByRole('button', { name: /^Save lead$/ })
        const anon = (await saveAgain.count())
          ? await (async () => {
              await page.locator('input[autocomplete="street-address"]').fill('93 Nameless Row')
              await saveAgain.click()
              await page.waitForTimeout(1500)
              return (await leads()).find((p) => p.address1 === '93 Nameless Row')
            })()
          : undefined
        ok(!!anon, 'and saves it with no contact', anon ? `${anon.contacts.length} contacts` : 'not saved')
        if (anon) {
          const b = await page
            .locator(`[data-marker="pin"][data-id="${anon.id}"]`)
            .first()
            .boundingBox()
          if (b) {
            await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
            await page.waitForTimeout(1000)
          }
          const t = await page
            .getByTestId('property-peek')
            .innerText()
            .catch(() => '')
          ok(
            /No contact yet/.test(t),
            'a lead with nobody on it says so rather than showing nothing',
            t.replace(/\s+/g, ' ').slice(0, 90),
          )
          ok(
            /Add a name and number during your visit/.test(t),
            'and says what to do about it',
          )
          ok(/\bNew\b/.test(t), 'and still says what state it is in')
        }
      }
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
