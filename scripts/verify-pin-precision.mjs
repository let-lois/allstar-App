import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * A pin the app is guessing about does not look like one it knows.
 *
 * The geocoders have always reported this — Google returns a rooftop and says
 * so, the Census geocoder estimates a house number along a block — and the map
 * drew every pin identically. That is the version of an inaccurate pin that
 * actually costs somebody something: not "the dot is in the wrong place", but
 * "the dot is in the wrong place and looks exactly as certain as the right
 * ones". A rep walks to it, knocks, and finds out at the door.
 *
 * Two signals, tested here because neither can be checked from the server:
 *
 *   - **On the map**, an estimated pin is hollow with a dashed ring roughly the
 *     width of the doubt. Enough to notice; not enough to act on.
 *   - **On the lead screen**, it says so in words, next to the Street View image
 *     a rep would use to settle it. That is the screen where somebody decides
 *     which door to knock, so that is where the sentence belongs.
 *
 * ## The control that makes this mean anything
 *
 * Every assertion is paired. A rooftop lead must render with none of it, and an
 * unknown lead — imported before any of this was recorded — must also render
 * with none of it. That second pairing is the one worth having: treating "we
 * have not checked" as "we are guessing" would put a warning on thousands of
 * pins that may well be exact, which is a different false claim in the opposite
 * direction.
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
  // Blocked so a cached bundle from an earlier run can never be what gets
  // tested. This gate is about what the current code renders.
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/**
 * Stamp a precision onto every demo lead, alternating, and hand back the first
 * three.
 *
 * Every lead rather than three, because of how the map behaves: it opens on the
 * rep's own patch, so labelling three leads chosen by array order and then
 * looking at whatever is on screen found two pins and neither of them was one
 * of the three. Alternating across the whole set means any viewport at any zoom
 * holds a mix, which is what the map assertion actually needs — while indices
 * 0, 1 and 2 are still pinned to known values for the lead-screen checks.
 */
const label = () =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction('properties', 'readwrite')
          const store = tx.objectStore('properties')
          const getAll = store.getAll()
          getAll.onsuccess = () => {
            const rows = getAll.result
            if (rows.length < 4) return rej(new Error(`only ${rows.length} leads`))
            const picked = []
            rows.forEach((row, i) => {
              // Index 2 is the never-checked case: undefined is a real state —
              // a lead that predates the column — so it is applied by deleting
              // the key rather than by setting it to a string.
              const p = i === 2 ? null : i % 2 === 0 ? 'interpolated' : 'rooftop'
              if (p === null) delete row.geoPrecision
              else row.geoPrecision = p
              store.put(row)
              if (i < 3) picked.push({ id: row.id, address1: row.address1, precision: p })
            })
            tx.oncomplete = () => res(picked)
            tx.onerror = () => rej(new Error('write failed'))
          }
          getAll.onerror = () => rej(new Error('read failed'))
        }
      }),
  )

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  // The demo seeds itself on first run and is the only mode that needs no
  // server, which is what makes it the right fixture for a rendering question.
  // Both clicks are required and neither is swallowed: a silent failure here
  // would leave an empty database and the label step would blame the fixture.
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)

  const [interp, rooftop, unknown] = await label()
  ok(!!interp && !!rooftop && !!unknown, 'three demo leads are labelled to render against',
    [interp?.address1, rooftop?.address1, unknown?.address1].join(' | '))

  /* ===== 1. the lead screen says it in words ============================ */
  for (const [lead, expected] of [[interp, true], [rooftop, false], [unknown, false]]) {
    await page.goto(`${BASE}/property/${lead.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const shown = await page.getByTestId('pin-estimated').count()
    ok(
      expected ? shown === 1 : shown === 0,
      expected
        ? 'an estimated lead warns the rep to check the house number'
        : `a ${lead.precision ?? 'never-checked'} lead does not`,
      `${shown} notice(s)`,
    )
  }

  /* ===== 2. the map draws the doubt ===================================== */
  //
  // Zoomed all the way in first, because below a threshold nearby pins merge
  // into counts and there would be no individual marker to inspect — a version
  // of this that skipped the zoom would be asserting against clusters and
  // finding zero of everything.
  {
    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const zoomIn = page.getByLabel('Zoom in')
    for (let i = 0; i < 8; i++) await zoomIn.click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)

    const counts = await page.evaluate(() => {
      const pins = [...document.querySelectorAll('[data-marker="pin"]')]
      return {
        pins: pins.length,
        dashed: pins.filter((g) => g.querySelector('circle[stroke-dasharray]')).length,
      }
    })
    ok(counts.pins > 0, 'individual pins are on screen rather than clusters', `${counts.pins} pins`)
    // Leads alternate, so any viewport holds a mix. "Some but not all" is the
    // assertion that fails in both broken directions: none dashed means the
    // precision never reached the map, all dashed means it is being ignored and
    // every pin is drawn as a guess.
    ok(
      counts.dashed >= 1 && counts.dashed < counts.pins,
      'some pins are drawn as estimates and not all of them',
      `${counts.dashed} of ${counts.pins} dashed`,
    )
  }

  ok(errors.length === 0, 'and the app threw nothing doing it', errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== a guessed pin looks guessed ===')
