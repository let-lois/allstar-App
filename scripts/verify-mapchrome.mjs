import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Nothing on the map sits on top of anything else a rep can tap.
 *
 * Written because two buttons did, for months, and no gate could see it. The
 * "Street" shortcut and the "Nearest door" shortcut were both `absolute left-3`
 * at `bottom: calc(96px + safe-area)` — the same point — so whenever a rep had
 * a GPS fix and no lead selected, which is the ordinary state of this screen in
 * the field, one was drawn directly over the other.
 *
 * It survived a fifty-six gate suite because every one of those gates runs
 * without a geolocation permission. "Nearest door" needs a position to exist at
 * all, so in a test only ever one of the pair was on screen, and the collision
 * was invisible to exactly the thing meant to catch it. This gate grants a
 * position first, which is the entire reason it exists.
 *
 * Rather than assert about those two buttons, it asks the general question: of
 * everything on this screen a thumb can hit, does any pair occupy the same
 * pixels? That catches the next one too, which the specific version would not.
 *
 * Also here, because they are the same walk: every control clears the tap
 * floor, and an empty map says which kind of empty it is. The second is its own
 * small history — a rep whose filters matched nothing and a rep whose company
 * had imported nothing saw the identical blank screen, and neither could tell
 * it from a map that had failed to draw.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

/**
 * A rep on the map, with a position — which is the part that matters.
 *
 * Without `permissions` and `geolocation` the map renders a strictly smaller
 * set of controls than a real phone does, and the missing ones are exactly
 * where this class of bug lives.
 */
async function repOnMap(width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
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
  await page.waitForTimeout(1100)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1800)
  return { ctx, page, errors }
}

/**
 * Every control a thumb can hit, with its box.
 *
 * Visible and hit-testable only: a `pointer-events-none` wrapper is not a
 * target however large it is, and a zero-sized or hidden element is not on
 * screen. Both of those would otherwise flood the comparison with pairs that
 * cannot collide because one of them is not really there.
 */
const controls = (page) =>
  page.evaluate(() => {
    const out = []
    /*
      `[data-marker]` is in this list because it was not, and two real
      undersized targets hid in the gap: the map's cluster bubbles are SVG
      groups rather than buttons, so a selector written in terms of HTML
      controls could not see the one marker standing for the most doors.
    */
    for (const el of document.querySelectorAll(
      'button, a[href], [role="button"], input, [data-marker]',
    )) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue
      if (parseFloat(cs.opacity) < 0.05) continue
      /*
        Only what is wholly on screen. A map marker half past the edge of the
        viewport has a clipped bounding box, and judging that as an undersized
        target is measuring the window rather than the control — the first run
        of this reported two 44x44 pins as failures for exactly that reason.
      */
      if (r.left < -0.5 || r.top < -0.5) continue
      if (r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) continue
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 34)
      out.push({ name, x: r.x, y: r.y, w: r.width, h: r.height, marker: !!el.dataset.marker })
    }
    return out
  })

const overlap = (a, b) => {
  const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return x > 2 && y > 2 ? Math.round(x) * Math.round(y) : 0
}

try {
  for (const [width, height] of [
    [320, 720],
    [390, 844],
    [768, 1024],
  ]) {
    console.log(`\n--- ${width}x${height} ---`)
    const { ctx, page, errors } = await repOnMap(width, height)

    /* ===== 1. nothing tappable covers anything else tappable =========== */
    {
      /*
        Chrome only. Two houses forty feet apart have overlapping 44px hit
        circles and always will — that is what clustering exists to manage, not
        a defect — and the chrome deliberately floats over the markers. The
        question worth asking is whether two *controls* cover each other, which
        is what "Street" and "Nearest door" were doing.
      */
      const all = (await controls(page)).filter((c) => !c.marker)
      const clashes = []
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const area = overlap(all[i], all[j])
          if (area) clashes.push(`"${all[i].name}" over "${all[j].name}" (${area}px²)`)
        }
      }
      ok(all.length > 4, 'the map has controls on it to compare', `${all.length} controls`)
      ok(
        clashes.length === 0,
        'no two controls on the map occupy the same pixels',
        clashes.length ? clashes.slice(0, 3).join('; ') : 'none of them overlap',
      )
    }

    /* ===== 2. and every one of them is big enough to hit ============== */
    {
      /*
        Type first. The search field's clear button does not exist until there
        is something to clear, so a sweep of the resting screen never saw it —
        and it was 36x36. A control that appears only in a state nobody
        measured is exactly where an undersized target survives.
      */
      await page.getByRole('searchbox', { name: /Search leads and addresses/i }).fill('main')
      await page.waitForTimeout(500)
      /*
        A hundredth of a pixel of slack.

        SVG markers measure 43.999999 rather than 44 — the transform arithmetic
        does not land on an integer — and reporting that as an undersized target
        sends the next person hunting through map geometry for a pixel that is
        not missing. Anything genuinely short is short by whole pixels: the two
        real ones this gate found were 36 and 38.
      */
      const small = (await controls(page)).filter((c) => Math.min(c.w, c.h) < 44 - 0.01)
      /*
        Put it back. The next check measures this field's resting width, and a
        field still holding text from this one is already expanded — which is
        how that assertion first reported 211px resting and 211px typing and
        failed against itself.
      */
      await page.getByRole('searchbox', { name: /Search leads and addresses/i }).fill('')
      await page.keyboard.press('Escape')
      await page.mouse.click(10, 300)
      await page.waitForTimeout(450)
      ok(
        small.length === 0,
        'every control clears the 44px tap floor',
        small.length
          ? small.map((c) => `${c.name} ${c.w.toFixed(2)}x${c.h.toFixed(2)}`).slice(0, 3).join('; ')
          : 'all of them',
      )
    }

    /* ===== 3. the nearest-door shortcut is there, and clear of things == */
    //
    // The control this gate was written for. It only exists with a position,
    // which is why every other gate on this screen has never seen it.
    {
      const near = page.getByRole('button', { name: /Nearest door/ })
      ok((await near.count()) > 0, 'with a position, the nearest-door shortcut is offered')
      const street = page.getByRole('button', { name: /^Street$/ })
      /*
        `boundingBox()` returns width/height; `overlap` reads w/h. The first
        draft of this passed the box straight through, so both were undefined,
        every comparison was NaN, and the assertion could not fail — it sat
        green next to the general check reporting 2904px² of overlap between
        these very two buttons. Renamed at the boundary rather than trusted.
      */
      const box = async (loc) => {
        const r = await loc.first().boundingBox()
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
      }
      const a = await box(near)
      const b = await box(street)
      ok(
        !!a && !!b && overlap(a, b) === 0,
        'and it does not sit on top of the Street shortcut',
        a && b ? `nearest ${Math.round(a.y)}-${Math.round(a.y + a.h)}, street ${Math.round(b.y)}-${Math.round(b.y + b.h)}` : 'one is missing',
      )
    }

    /* --- and the search is usable once somebody is using it ----------- */
    //
    // At 320px this row is [search | sync | map/list] and the search was left
    // 98px of it. Typing made it worse rather than better: the clear button
    // appears and took the input down to thirteen pixels — one character of an
    // address, on the screen where a rep looks one up.
    {
      const field = page.locator('input[type="search"]').first()
      const fieldWidth = async () => (await field.boundingBox())?.width ?? 0
      const resting = await fieldWidth()
      await field.fill('main')
      await page.waitForTimeout(450)
      const typing = await fieldWidth()
      /*
        Wide enough to read what you are typing — measured while typing, which
        is the state that was broken.

        Not "it grows on focus": that was the first fix and it was wrong. The
        row re-laid out at the moment a rep reached for a result and the panel
        moved out from under their thumb, which `verify:mapsearch` caught as a
        result that could not be chosen. The assertion moved with the fix.

        The floor is 56px — about seven characters, which is a house number and
        the start of a street. Not a target, a floor: at 390 this measures 127
        and at 768 109. It is set by 320px, where three controls share one row
        and there is no arrangement that gives the field more without taking
        something else off the screen. Written down rather than rounded up,
        because a floor nobody can meet gets deleted by the next person.

        The number that matters is the one this replaced: 13px.
      */
      ok(
        typing >= 56,
        'the search field stays usable while somebody is typing in it',
        `${Math.round(resting)}px resting, ${Math.round(typing)}px typing`,
      )
      await field.fill('')
      await page.waitForTimeout(300)
    }

    ok(errors.length === 0, 'and the app threw nothing drawing any of it', errors[0]?.slice(0, 120) ?? 'none')
    await ctx.close()
  }

  /* ===== 4. an empty map says which kind of empty ====================== */
  {
    const { ctx, page } = await repOnMap(390, 844)

    // Filtered to nothing: something the rep did, and can undo.
    await page.getByTestId('map-filters').click()
    await page.waitForTimeout(450)
    await page.getByRole('button', { name: /^Do Not Contact$/ }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /^Show \d+ leads?$/ }).click()
    await page.waitForTimeout(600)
    const filtered = await page.getByTestId('no-matches').innerText()
    ok(/match/i.test(filtered), 'a filter that matches nothing says so', filtered.replace(/\s+/g, ' ').slice(0, 60))
    ok(
      (await page.getByRole('button', { name: /^Show all$/ }).count()) > 0,
      'and offers the one tap that undoes it',
    )

    /*
      And nothing at all: not something the rep did, so it must not be offered
      a filter to clear. Two different nothings that used to look identical —
      and both used to look exactly like a map that had failed to draw.
    */
    /*
      Assigned to somebody else rather than deleted.

      Emptying the properties store looks like the direct way to test "this rep
      has no leads" and is not: the demo re-seeds itself on boot, so the rows
      come straight back and the assertion waits thirty seconds for a strip that
      never appears. It is also the less realistic state. A rep opening the app
      on their first morning has a full database and nothing in it that is
      theirs, which is exactly what this writes.
    */
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('allstar-field')
          req.onerror = () => rej(new Error('no db'))
          req.onsuccess = () => {
            const db = req.result
            const tx = db.transaction(['properties', 'routes'], 'readwrite')
            const store = tx.objectStore('properties')
            const all = store.getAll()
            all.onsuccess = () => {
              for (const row of all.result) {
                row.assignedRepId = 'u_somebody_else'
                store.put(row)
              }
            }
            tx.objectStore('routes').clear()
            tx.oncomplete = () => res()
            tx.onerror = () => rej(new Error('write failed'))
          }
        }),
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const bare = await page.getByTestId('no-matches').innerText()
    ok(/no leads on this device/i.test(bare), 'an empty device says that instead', bare.replace(/\s+/g, ' ').slice(0, 60))
    ok(
      (await page.getByRole('button', { name: /^Show all$/ }).count()) === 0,
      'and does not offer to clear a filter nobody set',
    )
    await ctx.close()
  }

  /* ===== 5. a worked-out territory is not an empty device ============== */
  //
  // The third nothing, and the one an earlier draft of this strip got wrong: a
  // rep whose every door is won or lost has leads — they are just all finished.
  // Telling them the office has not sent them anything is false and
  // unactionable at the same time, and it is what they see at the end of a good
  // week.
  {
    const { ctx, page } = await repOnMap(390, 844)
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('allstar-field')
          req.onerror = () => rej(new Error('no db'))
          req.onsuccess = () => {
            const db = req.result
            const tx = db.transaction(['properties', 'routes'], 'readwrite')
            const store = tx.objectStore('properties')
            const all = store.getAll()
            all.onsuccess = () => {
              for (const row of all.result) {
                row.status = 'won'
                store.put(row)
              }
            }
            tx.objectStore('routes').clear()
            tx.oncomplete = () => res()
            tx.onerror = () => rej(new Error('write failed'))
          }
        }),
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const worked = await page.getByTestId('no-matches').innerText()
    ok(/finished/i.test(worked), 'a territory that is all won says it is finished', worked.replace(/\s+/g, ' ').slice(0, 70))
    ok(
      !/no leads on this device/i.test(worked),
      'and does not claim the office has sent them nothing',
    )
    ok(
      (await page.getByRole('button', { name: /^Show all$/ }).count()) > 0,
      'and offers the tap that shows them anyway',
    )
    await ctx.close()
  }

  /* ===== 6. a save that fails says so ================================== */
  //
  // The button read "Saving…" for ever: no path back, a disabled control, an
  // open sheet, and no lead. The likeliest cause is a full phone — reps
  // photograph roofs all week — and silently losing the lead they just typed is
  // the worst thing this form could do.
  {
    const { ctx, page } = await repOnMap(390, 844)
    await page.addInitScript(() => {
      const real = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'properties') throw new Error('StorageFull: simulated')
        return real.apply(this, args)
      }
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
    await page.mouse.click(200, 430)
    await page.waitForTimeout(800)
    if (await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)) {
      // The sheet opens on the house; the form is behind Add lead. See verify:mapadd.
      const addLead = page.getByTestId('detected-add-lead')
      if ((await addLead.count()) > 0) {
        await addLead.click()
        await page.waitForTimeout(400)
      }
      await page.locator('input[autocomplete="street-address"]').fill('1 Unsaveable Way')
      await page.getByRole('button', { name: /Save lead/ }).click()
      await page.waitForTimeout(1200)
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      ok(/out of space|could not be saved/i.test(body), 'a write that fails tells the rep', body.match(/[^.]*saved[^.]*\./)?.[0]?.slice(0, 80) ?? '(nothing said)')
      const btn = await page.getByRole('button', { name: /Save lead|Saving/ }).innerText()
      ok(!/Saving/.test(btn), 'and the button stops saying "Saving…" for ever', btn)
    } else {
      ok(false, 'the Add-lead sheet opened so a failing save could be tested')
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== nothing covers anything, everything is thumb-sized, and empty says which empty ===')
