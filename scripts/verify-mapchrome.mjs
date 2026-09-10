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
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input')) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue
      if (parseFloat(cs.opacity) < 0.05) continue
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 34)
      out.push({ name, x: r.x, y: r.y, w: r.width, h: r.height })
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
      const all = await controls(page)
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
      const small = (await controls(page)).filter((c) => Math.min(c.w, c.h) < 44)
      ok(
        small.length === 0,
        'every control clears the 44px tap floor',
        small.length
          ? small.map((c) => `${c.name} ${Math.round(c.w)}x${Math.round(c.h)}`).slice(0, 3).join('; ')
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
