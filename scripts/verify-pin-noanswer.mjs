import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * A door already knocked does not look like a door nobody has walked up to.
 *
 * `no_answer` deliberately does not move a lead's status — a miss is not
 * pipeline progress, and that rule is kept. What nobody had noticed is what it
 * cost on the map: pins are coloured by status, so a house knocked three times
 * rendered identically to one never visited. For somebody working a street that
 * is close to the most useful thing a pin can say, and it was the one thing it
 * could not.
 *
 * Status and visit history now use two channels: colour still answers "where
 * does this lead stand", and a bar across the dot answers "have I been here".
 * The bar is the glyph the outcome grid already uses for No Answer, and being a
 * shape rather than a shade it survives sunlight and colourblindness.
 *
 * ## Why this is three passes rather than one fixture
 *
 * The obvious shape — seed three leads in three states, count the marks — took
 * four attempts and never worked, for reasons worth writing down because each
 * one produced a *passing* gate:
 *
 *   - Seeding by array position labelled another rep's leads. The map is scoped
 *     to the signed-in rep, so the assertions measured pins nobody had touched.
 *   - The map opens on "My route", not "All", so it showed the route rather than
 *     the fixture.
 *   - Moving every other lead far away to isolate three of them moved the
 *     *majority*, so the map's opening viewport followed them and the fixture
 *     itself went off-screen.
 *
 * Each of those made "0 marked pins" look like a fact about the code. So this
 * gate stops trying to control which pins are visible. It sets every one of the
 * rep's leads to the same state, three times over, and asserts how the whole
 * screen changes. Whichever pins are on screen, the answer is decisive:
 *
 *   nothing visited      → no pin may carry a mark
 *   all unanswered       → every pin must
 *   all visited and sold → no pin may, and this is the one that kills a rule
 *                          written as "has been visited" instead of "was not
 *                          answered"
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
  // Blocked so a cached bundle can never be what gets tested.
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/**
 * Who is signed in, read on its own and read-only.
 *
 * Separate from the writes below, and read-only, because declaring `meta`
 * readwrite just to look at one key holds a write lock on the store the app
 * reads its own session from during boot. The app could not get it, concluded
 * nobody was signed in, and navigated to the login screen — every write then
 * died with "execution context was destroyed" and this gate hung rather than
 * failed.
 *
 * Both session shapes: a demo session is `{ mode, userId }`, a live one is
 * `{ mode, token, user }`.
 */
const whoami = () =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const r = req.result
            .transaction('meta', 'readonly')
            .objectStore('meta')
            .get('allstar.session.v2')
          r.onsuccess = () => res(r.result?.userId ?? r.result?.user?.id ?? null)
          r.onerror = () => rej(new Error('no session'))
        }
      }),
  )

/**
 * Put every one of this rep's leads into the same visit state.
 *
 * Reads back before reporting success: the demo installs itself asynchronously
 * on first sign-in, and a write that lands while that is still going gets partly
 * overwritten. That is not a clean failure — it leaves a half-seeded database
 * that looks seeded — so it is turned into a retry.
 */
const setAll = (me, state) =>
  page.evaluate(
    ({ me, state }) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('properties', 'readwrite')
          const store = tx.objectStore('properties')
          const getAll = store.getAll()
          getAll.onsuccess = () => {
            const mine = getAll.result.filter((r) => r.assignedRepId === me)
            if (mine.length < 4) return rej(new Error(`only ${mine.length} leads for this rep`))
            for (const row of mine) {
              // An estimated position draws its own dashed ring; cleared so a
              // count of marks cannot pick one up by accident.
              delete row.geoPrecision
              if (state.status) row.status = state.status
              if (state.lastOutcome) row.lastOutcome = state.lastOutcome
              else delete row.lastOutcome
              if (state.lastVisitAt) row.lastVisitAt = Date.now() - state.lastVisitAt
              else delete row.lastVisitAt
              store.put(row)
            }
            tx.oncomplete = () => {
              const check = db
                .transaction('properties', 'readonly')
                .objectStore('properties')
                .get(mine[0].id)
              check.onsuccess = () =>
                check.result?.lastOutcome === state.lastOutcome
                  ? res(mine.length)
                  : rej(
                      new Error(
                        `read-back: wanted ${String(state.lastOutcome)}, got ${String(check.result?.lastOutcome)}`,
                      ),
                    )
              check.onerror = () => rej(new Error('read-back failed'))
            }
            tx.onerror = () => rej(new Error('write failed'))
          }
          getAll.onerror = () => rej(new Error('read failed'))
        }
      }),
    { me, state },
  )

/** Every lead into one state, then the map counted. */
async function pass(me, state) {
  let n = null
  for (let attempt = 0; attempt < 4 && n === null; attempt++) {
    await page.waitForTimeout(1200)
    n = await setAll(me, state).catch((err) => {
      console.log(`    write attempt ${attempt + 1}: ${String(err).slice(0, 100)}`)
      return null
    })
  }
  if (n === null) throw new Error('could not write the fixture')

  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  // "All" because the map opens on "My route" whenever the rep has a day
  // planned — which showed the route instead of the fixture.
  await page.getByRole('button', { name: /^All$/ }).click()
  await page.waitForTimeout(600)
  // Zoomed in, or nearby pins merge into counts and there is no marker to read.
  const zoomIn = page.getByLabel('Zoom in')
  for (let i = 0; i < 8; i++) await zoomIn.click({ force: true }).catch(() => {})
  await page.waitForTimeout(900)

  return page.evaluate(() => {
    const pins = [...document.querySelectorAll('[data-marker="pin"]')]
    return { pins: pins.length, marked: pins.filter((g) => g.querySelector('line')).length }
  })
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)

  const me = await whoami()
  ok(!!me, 'the signed-in rep is known, so the fixture targets their own leads', String(me))

  /* ===== 1. nothing knocked ============================================= */
  {
    const r = await pass(me, {})
    ok(r.pins > 0, 'pins are on screen to measure', `${r.pins} pins`)
    ok(r.marked === 0, 'with nothing visited, no pin claims to have been knocked', `${r.marked} marked`)
  }

  /* ===== 2. every door unanswered ======================================= */
  {
    const r = await pass(me, { lastOutcome: 'no_answer', lastVisitAt: 3_600_000 })
    ok(r.pins > 0, 'pins are on screen to measure', `${r.pins} pins`)
    ok(
      r.marked === r.pins,
      'with every door unanswered, every pin says so',
      `${r.marked} of ${r.pins}`,
    )
  }

  /* ===== 3. every door answered, and closed ============================= */
  //
  // The control, and the reason this file exists in this shape. Every lead here
  // has been visited — so a rule written as "has been visited" marks all of
  // them, and a rule written as "was not answered" marks none. Nothing else in
  // the gate separates those two.
  {
    const r = await pass(me, { status: 'won', lastOutcome: 'sold', lastVisitAt: 86_400_000 })
    ok(r.pins > 0, 'pins are on screen to measure', `${r.pins} pins`)
    ok(
      r.marked === 0,
      'a door that was answered and closed carries no come-back mark, though it was visited',
      `${r.marked} of ${r.pins} marked`,
    )
  }

  /* ===== 4. the filter agrees with the marking ========================== */
  {
    /*
      Status reset to `new` as well as the outcome, and that is not tidying.

      The filter deliberately excludes won, lost and Do Not Contact — an
      unanswered door that has since been sold is not unfinished business. The
      previous pass left every lead at `won`, so asking for unanswered doors
      correctly returned nothing, and this assertion failed on the fixture's
      leftovers rather than on the filter. States do not carry over here.
    */
    await pass(me, { status: 'new', lastOutcome: 'no_answer', lastVisitAt: 3_600_000 })
    await page.getByRole('button', { name: /^No answer$/ }).click()
    await page.waitForTimeout(900)
    const open = await page.evaluate(() => {
      const pins = [...document.querySelectorAll('[data-marker="pin"]')]
      return { pins: pins.length, unmarked: pins.filter((g) => !g.querySelector('line')).length }
    })
    ok(open.pins > 0, 'the No answer filter finds the doors worth going back to', `${open.pins} pins`)
    // `pins > 0` is repeated inside this one on purpose: "none of them is
    // unmarked" is trivially true of an empty screen, which is exactly the state
    // the line above just failed on.
    ok(
      open.pins > 0 && open.unmarked === 0,
      'and every one of them carries the mark',
      `${open.unmarked} unmarked of ${open.pins}`,
    )

    // And the other way: with nothing unanswered, the filter is empty rather
        // than quietly showing everything.
    await pass(me, { status: 'won', lastOutcome: 'sold', lastVisitAt: 86_400_000 })
    await page.getByRole('button', { name: /^No answer$/ }).click()
    await page.waitForTimeout(900)
    const none = await page.evaluate(
      () => document.querySelectorAll('[data-marker="pin"],[data-marker="cluster"]').length,
    )
    ok(none === 0, 'and with no unanswered doors it shows nothing at all', `${none} markers`)
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
console.log('=== a knocked door does not look untouched ===')
