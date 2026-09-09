import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The visit-window filters, wired to the screens.
 *
 * `verify:leadfilter` proves the arithmetic — which calendar the day is cut on,
 * that seven days is seven days across a clock change, and that "last 30 days"
 * and "over 30 days ago" leave no instant in neither. None of that says the
 * chips are connected to anything, and a filter that renders and does nothing
 * looks exactly like a filter with nothing to show.
 *
 * So this is the wiring, on the two surfaces a rep uses: the leads list and the
 * map. Both read the same predicate, which is the point — the assertion worth
 * having is that each one changes what is on screen, in the same direction, from
 * the same data.
 *
 * The fixture sets every one of the rep's leads to one state at a time, as the
 * no-answer gate does and for the same reason: three attempts at a
 * hand-picked fixture there each produced a passing gate that was measuring
 * somebody else's leads, the route rather than the selection, or an off-screen
 * viewport. Whole-set states need no control over what is visible.
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

// Read-only, and separate from the write: a readwrite lock on `meta` starves the
// app's own session read during boot and sends it to the login screen.
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

/** Every one of this rep's leads knocked `daysAgo` ago, or never. */
const setAll = (me, daysAgo) =>
  page.evaluate(
    ({ me, daysAgo }) =>
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
            if (mine.length < 4) return rej(new Error(`only ${mine.length} leads`))
            for (const row of mine) {
              delete row.geoPrecision
              row.status = 'new'
              if (daysAgo === null) {
                delete row.lastVisitAt
                delete row.lastOutcome
              } else {
                row.lastVisitAt = Date.now() - daysAgo * 86_400_000
                row.lastOutcome = 'interested'
              }
              store.put(row)
            }
            tx.oncomplete = () => {
              // Read back: the demo installs itself asynchronously, and a write
              // landing mid-install is partly overwritten rather than refused.
              const c = db
                .transaction('properties', 'readonly')
                .objectStore('properties')
                .get(mine[0].id)
              c.onsuccess = () =>
                (daysAgo === null) === (c.result?.lastVisitAt === undefined)
                  ? res(mine.length)
                  : rej(new Error(`read-back: lastVisitAt=${c.result?.lastVisitAt}`))
              c.onerror = () => rej(new Error('read-back failed'))
            }
            tx.onerror = () => rej(new Error('write failed'))
          }
          getAll.onerror = () => rej(new Error('read failed'))
        }
      }),
    { me, daysAgo },
  )

const write = async (me, daysAgo) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(1000)
    const n = await setAll(me, daysAgo).catch((err) => {
      console.log(`    write attempt ${attempt + 1}: ${String(err).slice(0, 90)}`)
      return null
    })
    if (n !== null) return n
  }
  throw new Error('could not write the fixture')
}

/** "12 of 25" from the leads header. */
const listCounts = async () => {
  const t = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const m = /(\d+) of (\d+)/.exec(t)
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null
}

const pinCount = () =>
  page.evaluate(() => document.querySelectorAll('[data-marker="pin"],[data-marker="cluster"]').length)

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)

  const me = await whoami()
  ok(!!me, 'the signed-in rep is known', String(me))

  /* ===== the leads list ================================================= */
  //
  // Every door knocked 40 days ago. "Over 30 days ago" must show all of them and
  // "Today" none — which is the pair that fails in both broken directions: a
  // filter doing nothing shows all of them for both, and a filter matching
  // nothing shows none for both.
  {
    const total = await write(me, 40)
    await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const before = await listCounts()
    ok(before?.shown === total, 'the list starts with every lead', `${before?.shown}/${total}`)

    await page.getByRole('button', { name: /^Over 30 days ago$/ }).click()
    await page.waitForTimeout(600)
    const stale = await listCounts()
    ok(
      stale?.shown === total,
      'with every door knocked 40 days ago, "Over 30 days ago" keeps them all',
      `${stale?.shown} of ${stale?.total}`,
    )

    await page.getByRole('button', { name: /^Today$/ }).click()
    await page.waitForTimeout(600)
    const today = await listCounts()
    ok(today?.shown === 0, 'and "Today" hides every one of them', `${today?.shown} of ${today?.total}`)

    await page.getByRole('button', { name: /^Never knocked$/ }).click()
    await page.waitForTimeout(600)
    const never = await listCounts()
    ok(
      never?.shown === 0,
      'and "Never knocked" hides them too — a knocked door is not an unknocked one',
      `${never?.shown} of ${never?.total}`,
    )
  }

  /* ===== and the same question, asked of doors nobody has been to ======= */
  {
    const total = await write(me, null)
    await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: /^Never knocked$/ }).click()
    await page.waitForTimeout(600)
    const never = await listCounts()
    ok(
      never?.shown === total,
      'with nothing knocked, "Never knocked" is every lead',
      `${never?.shown} of ${never?.total}`,
    )
    await page.getByRole('button', { name: /^Over 30 days ago$/ }).click()
    await page.waitForTimeout(600)
    const stale = await listCounts()
    ok(stale?.shown === 0, 'and "Over 30 days ago" is none of them', `${stale?.shown}`)
  }

  /* ===== the map asks it the same way =================================== */
  {
    await write(me, 40)
    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    await page.getByRole('button', { name: /^All$/ }).click()
    await page.waitForTimeout(500)
    const all = await pinCount()
    ok(all > 0, 'the map has markers to filter', `${all}`)

    await page.getByRole('button', { name: /^Over 30 days ago$/ }).click()
    await page.waitForTimeout(700)
    ok((await pinCount()) === all, 'the map keeps them all under "Over 30 days ago"', `${await pinCount()}`)

    await page.getByRole('button', { name: /^Today$/ }).click()
    await page.waitForTimeout(700)
    ok((await pinCount()) === 0, 'and clears the map under "Today"', `${await pinCount()}`)
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
console.log('=== the visit filters change what is on screen, on the list and the map ===')
