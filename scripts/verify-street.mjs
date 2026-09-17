import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * One street, door by door, in the order it is walked.
 *
 * The map answers "where is the work" and the leads list answers "what is in
 * the pipeline". Neither answers the question a rep has standing on a pavement:
 * which of these houses have I done, and which is next up this side of the
 * road? On the map that is a scatter of dots whose numbers are not drawn; in
 * the list it is rows sorted by distance, which is not an order anyone walks.
 *
 * So the one thing this screen must get right is **house-number order**, and
 * that is the assertion below that would be easiest to fake: a list sorted by
 * anything at all looks sorted. The fixture therefore puts the numbers in an
 * order no other sort produces — the store order, the distance order and the
 * alphabetical order of the addresses are each deliberately different from the
 * numeric one, so only the intended sort passes.
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
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/**
 * Rewrite this rep's leads into two known streets.
 *
 * Read-only on `meta` and separate from the write, because taking a write lock
 * on the store the app reads its session from during boot makes the app decide
 * nobody is signed in and navigate to login.
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

/*
  House numbers deliberately out of every other order.

  Written to the store in this sequence, so "unsorted" is 30, 4, 118, 9, 21.
  Alphabetically by address the order is "118, 21, 30, 4, 9" — string sort, not
  numeric. Sorted the way a street is walked it is 4, 9, 21, 30, 118. All three
  differ, so a list that merely *looks* ordered cannot pass.

  Two of them are knocked, one of those with no answer. Two more doors sit on a
  second street, and **one of those is knocked too** — which is what makes the
  street-only counting testable at all. With the other street's history cleared,
  a count that spanned every street produced the same "2 knocked" as a correct
  one, and the sabotage that proved it went undetected.
*/
const DOORS = [
  { n: 30, knocked: true, outcome: 'interested', status: 'working' },
  { n: 4, knocked: false, status: 'new' },
  { n: 118, knocked: true, outcome: 'no_answer', status: 'new' },
  { n: 9, knocked: false, status: 'new' },
  { n: 21, knocked: false, status: 'follow_up' },
]
const STREET = 'Marbury Row'
const OTHER = 'Faraway Ln'

const seed = (me) =>
  page.evaluate(
    ({ me, DOORS, STREET, OTHER }) =>
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
            if (mine.length < DOORS.length + 3) {
              return rej(new Error(`only ${mine.length} leads for this rep`))
            }
            mine.forEach((row, i) => {
              if (i < DOORS.length) {
                const d = DOORS[i]
                row.address1 = `${d.n} ${STREET}`
                row.status = d.status
                if (d.knocked) {
                  row.lastVisitAt = Date.now() - 3_600_000
                  row.lastOutcome = d.outcome
                } else {
                  delete row.lastVisitAt
                  delete row.lastOutcome
                }
              } else if (i === DOORS.length || i === DOORS.length + 1) {
                /*
                  Two doors on a second street, one of them knocked.

                  The picker needs somewhere to switch to, and the knocked one is
                  what a cross-street count would wrongly add to this street's
                  total — without it that mistake is invisible.
                */
                const first = i === DOORS.length
                row.address1 = `${first ? 7 : 11} ${OTHER}`
                row.status = 'new'
                if (first) {
                  row.lastVisitAt = Date.now() - 7_200_000
                  row.lastOutcome = 'interested'
                } else {
                  delete row.lastVisitAt
                  delete row.lastOutcome
                }
              } else {
                // Everything else off both streets entirely, so the counts on
                // screen are exactly the fixture's.
                row.address1 = `${100 + i} Unrelated Way`
                delete row.lastVisitAt
                delete row.lastOutcome
              }
              store.put(row)
            })
            tx.oncomplete = () => {
              // Read one back: the demo installs itself asynchronously on first
              // sign-in, and a write landing mid-install is partly overwritten.
              const c = db
                .transaction('properties', 'readonly')
                .objectStore('properties')
                .get(mine[0].id)
              c.onsuccess = () =>
                c.result?.address1 === `${DOORS[0].n} ${STREET}`
                  ? res(mine.length)
                  : rej(new Error(`read-back: got ${c.result?.address1}`))
              c.onerror = () => rej(new Error('read-back failed'))
            }
            tx.onerror = () => rej(new Error('write failed'))
          }
          getAll.onerror = () => rej(new Error('read failed'))
        }
      }),
    { me, DOORS, STREET, OTHER },
  )

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)

  const me = await whoami()
  ok(!!me, 'the signed-in rep is known', String(me))

  let seeded = null
  for (let attempt = 0; attempt < 4 && !seeded; attempt++) {
    await page.waitForTimeout(1200)
    seeded = await seed(me).catch((err) => {
      console.log(`  seed attempt ${attempt + 1}: ${String(err).slice(0, 100)}`)
      return null
    })
  }
  if (!seeded) throw new Error('could not seed the fixture')

  /* ===== 1. reachable from the map ====================================== */
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // The button on the map itself, bottom-left. It was briefly a third segment
  // in the map/list control at the top, which pushed the lead search off a
  // 320px screen — see the comment in MapScreen.
  await page.getByRole('button', { name: /^Street$/ }).click()
  await page.waitForTimeout(1200)
  ok(page.url().endsWith('/street'), 'the map’s own control reaches the street view', page.url())

  /*
    The floating add button is suppressed on screens that pin their own bottom
    action, by a list of route prefixes. `street` was missing from it: the
    screen pins nothing, but its list of doors runs under the button, so the
    last door on a street sat beneath a 56px circle. `navigate` was missing for
    the worse version of the same — the circle landed on Start visit.

    And the way back to the map is the only escape from this screen, so it is
    measured as a thumb target rather than assumed to be one.
  */
  ok((await page.getByRole('button', { name: 'Quick actions' }).count()) === 0, 'the floating add button stays off the street screen, where the list runs under it')
  const backToMap = page.getByRole('button', { name: /^Map$/ }).first()
  const mapBox = await backToMap.boundingBox()
  ok(!!mapBox && mapBox.height >= 44, 'and the only way back to the map is a thumb target', mapBox ? `${Math.round(mapBox.height)}px` : 'no box')

  const body = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

  /* ===== 2. the doors are in walking order ============================== */
  {
    // The seeded street is picked explicitly rather than relying on which one
    // sorts first: with no GPS fix the ordering falls back to door count, and
    // an assertion that depends on that is an assertion about the fallback.
    await page.getByRole('button', { name: new RegExp(STREET) }).first().click()
    await page.waitForTimeout(600)

    const numbers = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="street-door"]')].map((el) =>
        Number(el.querySelector('span')?.textContent?.trim()),
      ),
    )
    ok(numbers.length === 5, 'every door on the street is listed', numbers.join(','))
    ok(
      JSON.stringify(numbers) === JSON.stringify([4, 9, 21, 30, 118]),
      'in house-number order — not the order they were stored, and not alphabetical',
      numbers.join(','),
    )
  }

  /* ===== 3. what has been done, and what is left ======================== */
  {
    const txt = await body()
    ok(/3 to go/.test(txt), 'the count a rep tracks is the doors left', /(\d+) to go/.exec(txt)?.[0])
    /*
      Two, not three. There is a knocked door on the other street, so this is
      the assertion that a count spanning every street would fail — and the
      reason the fixture bothers to knock one over there.
    */
    ok(/2 knocked/.test(txt), 'with what has been done beside it, this street only',
      /(\d+) knocked/.exec(txt)?.[0])
    ok(/5 doors/.test(txt), 'and the total is this street only', /(\d+) doors/.exec(txt)?.[0])
    ok(/no answer/.test(txt), 'a door that went unanswered says so, not just "knocked"')
  }

  /* ===== 4. filtering to the work that is left ========================== */
  {
    await page.getByRole('button', { name: /Not knocked 3/ }).click()
    await page.waitForTimeout(500)
    const numbers = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="street-door"]')].map((el) =>
        Number(el.querySelector('span')?.textContent?.trim()),
      ),
    )
    ok(
      JSON.stringify(numbers) === JSON.stringify([4, 9, 21]),
      'the unknocked doors, still in walking order',
      numbers.join(','),
    )
    await page.getByRole('button', { name: /^All 5$/ }).click()
    await page.waitForTimeout(400)
  }

  /* ===== 5. one house at a time, and walking on ========================= */
  {
    ok(
      (await page.getByTestId('street-focus').count()) === 0,
      'no house imagery is requested until a door is chosen — Street View bills per request',
    )
    await page.getByTestId('street-door').first().click()
    await page.waitForTimeout(600)
    ok((await page.getByTestId('street-focus').count()) === 1, 'tapping a door opens that one house')
    ok(/4 Marbury Row/.test(await body()), 'the chosen door is the one tapped')

    await page.getByRole('button', { name: /^Next$/ }).click()
    await page.waitForTimeout(500)
    ok(/9 Marbury Row/.test(await body()), 'and Next walks up the street in order')

    ok(
      await page.getByRole('button', { name: /^Prev$/ }).isEnabled(),
      'with Prev available once past the first door',
    )
  }

  /* ===== 6. the other street is still reachable ========================= */
  {
    await page.getByRole('button', { name: new RegExp(OTHER) }).first().click()
    await page.waitForTimeout(600)
    const txt = await body()
    ok(/1 to go/.test(txt), 'switching streets switches the counts', /(\d+) to go/.exec(txt)?.[0])
    ok(
      (await page.getByTestId('street-focus').count()) === 0,
      'and clears the focused house rather than showing one from the street just left',
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
console.log('=== a street reads door by door, in the order it is walked ===')
