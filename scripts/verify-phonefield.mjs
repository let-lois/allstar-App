import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * What a rep found on a phone that no gate had asked about.
 *
 * Six things came back from the first day of device testing. Four of them are
 * here; the other two are `verify:offlinemaps` (the crash) and a copy change
 * covered by `verify:streetview`. What they share is that every one of them is
 * invisible to a gate driving a mouse on a desktop — they are gestures, flex
 * heights and a shell the browser is not running in.
 *
 * The one that cost the most was the pinch. "Can't zoom in or out without
 * having a pop up for a new pin": every two-finger zoom ended with the Add-lead
 * sheet open over the map, on a house nobody had asked about. A pinch never
 * accumulated pan distance — the two-finger branch of `onPointerMove` returns
 * before the arithmetic — so the last finger up looked exactly like a tap.
 * Nothing caught it because Playwright's default pointer has one finger.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

/**
 * A rep on a phone, with a position — the ordinary state of this screen.
 *
 * The size is a parameter because one of these bugs only exists on a small
 * one. 390×844 is an iPhone 14; 375×667 is an SE, which is still the phone a
 * company hands a new rep, and 180 fewer pixels is the difference between a
 * sheet that fits its contents and one that clips the last row of them.
 */
async function phone(size = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({
    viewport: size,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5083, longitude: -97.6789, accuracy: 12 },
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  return { ctx, page, errors }
}

try {
  /* ===== 1. a pinch is not a tap ========================================= */
  {
    const { ctx, page } = await phone()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(page)
    await page.waitForTimeout(2000)
    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)

    const map = page.getByRole('application', { name: /Map of your leads/ })
    ok((await map.count()) > 0, 'the map is on screen to pinch')
    const box = await map.boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    /*
      Two real pointers, because that is the whole bug. `page.touchscreen.tap`
      and `mouse` both send one, and one finger can never reproduce this.
      Dispatched through CDP so the events carry genuine pointerIds and the
      component's own pointer bookkeeping is what is under test.
      
      The fingers move apart — a zoom-in — and are then lifted one at a time,
      which is the order a hand actually does it and the order that produced
      the stray pin: the first lift was suppressed, the second was not.
    */
    const pinch = async (page, cx, cy, from, to) => {
      const cdp = await page.context().newCDPSession(page)
      const touch = (type, pts) =>
        cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })),
        })
      await touch('touchStart', [[cx - from, cy], [cx + from, cy]])
      for (let i = 1; i <= 6; i++) {
        const d = from + ((to - from) * i) / 6
        await touch('touchMove', [[cx - d, cy], [cx + d, cy]])
        await page.waitForTimeout(40)
      }
      // One finger at a time. Lifting both together hides the bug entirely.
      await touch('touchEnd', [[cx + to, cy]])
      await page.waitForTimeout(60)
      await touch('touchEnd', [])
      await cdp.detach()
    }

    await pinch(page, cx, cy, 40, 150)
    await page.waitForTimeout(900)

    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(
      (await page.getByTestId('add-lead-sheet').count()) === 0 &&
        (await page.getByTestId('detected-add-lead').count()) === 0,
      'pinching to zoom does not open the Add-lead sheet',
      body.slice(0, 90),
    )
    ok(!/New property|Add lead/i.test(body), 'and nothing else offers to make a lead either',
      body.match(/New property|Add lead/)?.[0] ?? '')

    // The control: a genuine single tap must still work, or the fix above is
    // just "taps are broken now" wearing a passing gate.
    await page.touchscreen.tap(cx, cy)
    await page.waitForTimeout(900)
    ok(
      /New property|Add lead|Start visit|Open full profile/i.test(
        await page.locator('body').innerText(),
      ),
      'while a single tap on the map still does',
    )

    /*
      And the frame where a photo of the house would be is present and honest.

      The demo has no company and therefore no stored key, so the truthful
      answer here is that Street View is not switched on — not that the street
      has no imagery. Those were the same sentence until `StreetView` learned to
      tell four kinds of nothing apart; the signed-in versions of each are
      driven against real status codes in `verify:streetview`.

      What matters on *this* screen is that the frame exists at all and says
      something: it is what stops the address jumping up the sheet when a photo
      arrives a second later, and it is where a rep looks to recognise the house
      they tapped. Which sentence is not this gate's business, which is why it
      asserts length rather than wording.
    */
    const frame = page.getByTestId('property-image').first()
    ok((await frame.count()) > 0, 'the sheet keeps a frame where the photo of the house goes')
    if ((await frame.count()) > 0) {
      const said = (await frame.innerText()).replace(/\s+/g, ' ').trim()
      ok(said.length > 0, 'and says something rather than sitting empty', said)
    }
    await ctx.close()
  }

  /* ===== 2. every photo category is reachable without a gesture ========= */
  {
    // On the small phone deliberately. At 844px tall the old 62% detent still
    // just fit the grid, which is why this was reported from the field and not
    // from a gate — the failure lives on the shorter screen.
    const { ctx, page } = await phone({ width: 375, height: 667 })
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(page)
    await page.waitForTimeout(2200)

    // Any lead will do; the categoriser is the same sheet everywhere.
    const first = await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('allstar-field')
          req.onerror = () => rej(new Error('no db'))
          req.onsuccess = () => {
            const tx = req.result.transaction('properties', 'readonly')
            const all = tx.objectStore('properties').getAll()
            all.onsuccess = () => res(all.result[0]?.id ?? null)
            all.onerror = () => rej(new Error('no properties'))
          }
        }),
    )
    ok(!!first, 'a lead to photograph')
    await page.goto(`${BASE}/property/${first}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    /*
      A real file through a real file chooser. `openCamera` builds the input,
      clicks it and removes it on change, so there is no element to target —
      intercepting the chooser is the only way in, and it exercises the same
      compress-then-show path a rep's photo takes.
    */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    // Photos live behind a collapsed section on a lead with none yet.
    const photos = page.getByRole('button', { name: /^Photos/ }).first()
    if ((await photos.count()) > 0) {
      await photos.click()
      await page.waitForTimeout(500)
    }

    const camera = page.getByRole('button', { name: /^Take photo$/ }).first()
    if ((await camera.count()) === 0) {
      ok(false, 'the property screen offers a camera button')
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
        camera.click(),
      ])
      if (!chooser) {
        ok(false, 'tapping the camera opens a file chooser')
      } else {
        await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })
        await page.waitForTimeout(1800)

        const sheet = page.locator('[role="dialog"] .anim-sheet').first()
        ok((await sheet.count()) > 0, 'the categorize sheet opens after a shot')

        /*
          The assertion is about the *last* category, because that is the one
          that was off the bottom — "Before" and "After" sat below the edge of a
          62%-tall sheet and the only way to them was a drag the sheet ignored.

          Measured against the sheet's own box rather than the viewport: a
          button inside a scrolling pane can be within the window and still
          below the fold, which is exactly the failure.
        */
        const m = await sheet.evaluate((el) => {
          const buttons = [...el.querySelectorAll('button')].filter(
            (b) => b.offsetHeight >= 56,
          )
          const box = el.getBoundingClientRect()
          const last = buttons[buttons.length - 1]?.getBoundingClientRect()
          return {
            count: buttons.length,
            sheetBottom: box.bottom,
            lastBottom: last?.bottom ?? 0,
            lastLabel: buttons[buttons.length - 1]?.textContent?.trim() ?? '',
            vh: window.innerHeight,
          }
        })
        ok(m.count >= 7, `every category is rendered (${m.count})`)
        ok(
          m.lastBottom > 0 && m.lastBottom <= m.sheetBottom,
          'and the last one is inside the sheet rather than below its edge',
          `“${m.lastLabel}” ends at ${m.lastBottom.toFixed(0)}, sheet ends at ${m.sheetBottom.toFixed(0)}`,
        )
        ok(
          m.sheetBottom <= m.vh + 2,
          'with the sheet itself inside the screen',
          `${m.sheetBottom.toFixed(0)} of ${m.vh}`,
        )
      }
    }
    await ctx.close()
  }

  /* ===== 3. the admin console is offered to office roles, everywhere ===== */
  {
    const { ctx, page } = await phone()
    // A manager, who is the only role offered the console at all.
    await page.getByRole('button', { name: /Nadia Petrov/ }).click()
    await dismissTour(page)
    await page.waitForTimeout(2000)
    await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)

    // On the web it is there, because on the web it works.
    ok(
      (await page.getByRole('button', { name: /Admin console/ }).count()) > 0,
      'a manager in a browser is offered the admin console',
    )

    /*
      Now the same screen, believing it is inside the native shell.

      `isNativeShell()` reads `process.env.EXPO_DOM_HOST_OS`, which Expo's DOM
      runtime assigns at registration — a runtime read under Metro, not a
      build-time constant. Vite folds the branch away, so this cannot be tested
      by loading the page: the check is against the source, which is where the
      condition lives.
    */
    await ctx.close()
  }

  ok(true, 'and the shell case is checked against the source below')
} finally {
  await browser.close()
}

/* --- the shell branch, read rather than rendered -------------------------- */
{
  const { readFileSync } = await import('node:fs')

  /*
    One detent is not a choice. Dragging a single-detent sheet upward resists
    and springs back — `onPointerUp` clamps to `detents.length - 1` — so a rep
    who could not see the bottom row lifted the sheet, read it, and watched it
    drop again. Asserted on the source because a second detent is a capability,
    and a capability nobody exercises does not render.
  */
  const strip = readFileSync(
    new URL('../src/components/visit/PhotoStrip.tsx', import.meta.url),
    'utf8',
  )
  const detents = /detents=\{\[([^\]]*)\]\}/.exec(strip.replace(/\/\*[\s\S]*?\*\//g, ''))
  ok(
    !!detents && detents[1].split(',').length > 1,
    'the categorize sheet can be raised, so the drag a rep reaches for does something',
    detents ? `[${detents[1].trim()}]` : '(none found)',
  )

  const src = readFileSync(new URL('../src/screens/More.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  ok(
    /user\?\.role !== 'field_rep' && \(\s*<(?:>|MoreGroup\b)[\s\S]*?<MoreLink label="Admin console"/.test(code) && !/isNativeShell/.test(code),
    'and the native shell is offered the console too — by role alone, now that its bundle carries it',
  )
  ok(!/admin console is desktop software/i.test(code), 'with no leftover sentence sending the manager to a computer')
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the phone gestures, the sheet heights, and the console in the shell ===')
