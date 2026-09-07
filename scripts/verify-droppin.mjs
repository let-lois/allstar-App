import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Dropping a pin on a house from the map.
 *
 * The claims here are about the two things that make this safe to have on a
 * screen a rep pans and taps all day, plus the one that makes it worth having
 * at all.
 *
 * **A tap does not create a lead unless the rep armed it.** This is the whole
 * safety design. The map's ordinary behaviour — tap empty space, clear the
 * selection — has to survive the feature existing, because a mis-tap that
 * silently writes a property is worse than no tap-to-place at all.
 *
 * **The mode spends itself on one tap.** One tap, one pin, back to normal. A
 * mode left armed is the same bug as never having disarmed it.
 *
 * **The pin is where the rep tapped, and reverse geocoding cannot block it.**
 * Google is unreachable throughout this file — no key in CI, and a key that
 * worked in CI would be a key committed somewhere — so every run here exercises
 * the failure path on purpose. The lead still has to save, with the coordinate
 * intact and the address the rep typed.
 *
 * The stored row is read out of IndexedDB rather than off the screen, for the
 * same reason `verify:newlead` does it: the offline write is the truth, and
 * nothing on this path waits for a network.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

const propertyCount = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => reject(new Error('no db'))
        req.onsuccess = () => {
          const tx = req.result.transaction('properties', 'readonly')
          const all = tx.objectStore('properties').getAll()
          all.onsuccess = () => resolve(all.result.length)
          all.onerror = () => reject(new Error('read failed'))
        }
      }),
  )

const newestProperty = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => reject(new Error('no db'))
        req.onsuccess = () => {
          const tx = req.result.transaction('properties', 'readonly')
          const all = tx.objectStore('properties').getAll()
          all.onsuccess = () => {
            const rows = all.result.filter((p) => p.id.startsWith('p_'))
            resolve(rows[rows.length - 1] ?? null)
          }
          all.onerror = () => reject(new Error('read failed'))
        }
      }),
  )

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5083, longitude: -97.6789 },
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
// The condition every run tests: the lookup cannot answer.
await page.route('**://maps.googleapis.com/**', (r) => r.abort())
await page.route('**://places.googleapis.com/**', (r) => r.abort())

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1800)

await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)

const canvas = page.locator('[data-tour="map-canvas"]')
await canvas.waitFor({ state: 'visible' })
const box = await canvas.boundingBox()

/**
 * A point on the map with no pin under it.
 *
 * Not a fixed fraction of the viewport. The demo neighbourhood is dense, a
 * marker tap is deliberately *not* a pin drop — it opens the door that is
 * already there — and where the pins land depends on the viewport, so a hardcoded
 * spot makes this file pass or fail on the arrangement of the seed data rather
 * than on the feature. Both renderers mark their pins in the DOM, so the empty
 * space can be found rather than guessed.
 *
 * Bounded to the middle band: the filter rail and search float over the top of
 * the map and the thumb controls over the bottom, and a tap on either tests the
 * overlay instead of the map.
 */
async function emptySpot() {
  const pins = await page.evaluate(() =>
    [...document.querySelectorAll('[data-marker], .gm-style img[src], gmp-advanced-marker')].map(
      (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      },
    ),
  )
  const clear = (x, y) => pins.every((p) => Math.hypot(p.x - x, p.y - y) > 56)
  for (let fy = 0.3; fy <= 0.62; fy += 0.04) {
    for (let fx = 0.2; fx <= 0.8; fx += 0.05) {
      const x = box.x + box.width * fx
      const y = box.y + box.height * fy
      if (clear(x, y)) return { x, y }
    }
  }
  throw new Error('no clear space on the map to tap — the seed got denser')
}

const spot = await emptySpot()

/*
  Asserted before anything is tapped, because a tap that happens to land on a
  lead opens the property sheet and this control steps aside for it — which is
  correct behaviour and would read here as a missing button.
*/
ok(
  await page.getByRole('button', { name: /Drop a pin/i }).isVisible(),
  'the map offers a "Drop a pin" control in thumb reach',
)

/* --- an unarmed tap writes nothing --------------------------------------- */
const before = await propertyCount(page)
await page.mouse.click(spot.x, spot.y)
await page.waitForTimeout(900)
ok(
  (await propertyCount(page)) === before,
  'tapping the map without arming the mode creates nothing',
)
ok(
  !(await page.getByText(/New pin/i).isVisible().catch(() => false)),
  'and no confirmation sheet appears',
)

/*
  That tap may have landed on a lead and opened its sheet — the demo map is
  dense, and where the centre of the viewport falls is not this file's to
  control. Clearing it is setup, not an assertion.
*/
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

/* --- arming it, and one tap ---------------------------------------------- */
await page.getByRole('button', { name: /Drop a pin/i }).click()
await page.waitForTimeout(400)
ok(
  await page.getByText(/Tap the house/i).isVisible(),
  'arming it says what to do next rather than changing behaviour silently',
)

await page.mouse.click(spot.x, spot.y)
await page.waitForTimeout(1500)
ok(await page.getByText(/New pin/i).isVisible(), 'the tap opens the confirmation sheet')
ok(
  (await propertyCount(page)) === before,
  'and still nothing is written until the rep confirms',
)

/*
  The lookup could not answer, which must be said rather than left as an empty
  field. A rep looking at a blank address with no explanation reads it as a
  broken pin, and the pin is the part that is fine.
*/
ok(
  await page.getByText(/Couldn’t look it up|Couldn't look it up/i).isVisible(),
  'a failed lookup is named, and says the pin still saves',
)

/* --- the mode spent itself ------------------------------------------------ */
await page.getByRole('button', { name: /^Cancel$/ }).last().click()
await page.waitForTimeout(700)
ok(
  (await propertyCount(page)) === before,
  'cancelling the sheet throws the coordinate away',
)
await page.mouse.click(spot.x, spot.y)
await page.waitForTimeout(900)
ok(
  !(await page.getByText(/New pin/i).isVisible().catch(() => false)),
  'the mode spent itself on the first tap — a second tap is an ordinary tap',
)

/* --- saving --------------------------------------------------------------- */
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await page.getByRole('button', { name: /Drop a pin/i }).click()
await page.waitForTimeout(300)
await page.mouse.click(spot.x, spot.y)
await page.waitForTimeout(1500)

await page.getByPlaceholder(/Type the address/i).fill('4102 Avenue G')
await page.getByRole('button', { name: /Save & open/i }).click()
await page.waitForTimeout(2000)

const saved = await newestProperty(page)
ok(!!saved, 'the lead is written to the device')
ok(saved?.address1 === '4102 Avenue G', 'with the address the rep typed')
/*
  The coordinate is the assertion this whole feature exists for. Not checked
  against a fixed number — where the tap lands depends on the viewport and the
  map's centre — but against being real, and specifically against the 0,0 that a
  dropped coordinate degrades to.
*/
ok(
  Number.isFinite(saved?.lat) &&
    Number.isFinite(saved?.lng) &&
    saved.lat !== 0 &&
    saved.lng !== 0,
  'and a real coordinate rather than a lost one',
)
/*
  Blank, not guessed — the same rule the add-lead form follows. With no lookup
  there is no town, and a confidently wrong one is the thing that cost this
  codebase a section of its README.
*/
ok(
  saved?.city === '' && saved?.state === '' && saved?.zip === '',
  'city, state and ZIP stay blank rather than being invented',
)
ok(
  page.url().includes(`/property/${saved?.id}`),
  'and it opens the property, ready for the conversation',
)

ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`)

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== drop a pin OK ===')
