import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'
import { STATUS_LABEL } from '../src/data/outcomes.ts'

/**
 * Fourteen chips in a scroller three of them fitted into.
 *
 * That was the map's filter: nine status/scope chips, a hairline, and up to six
 * visit windows, in one horizontal rail. At 320px the rail was 296px wide and
 * its content 1306px — 4.4 times over — so eleven of the fourteen could only be
 * reached by swiping something that gave no sign of how much was hidden. Five
 * of the app's nine statuses had no chip at all: on the map there was no way to
 * ask for New, Contacted, Won, Lost or Do Not Contact.
 *
 * And the rail could contradict itself. "Not knocked" is `!lastVisitAt`; it sat
 * one divider away from "Today", which is `lastVisitAt >= this morning`. Tapping
 * both asked for a door that had never been knocked and was knocked this
 * morning — a guaranteed-empty map, a search box reading "Search 0 leads", and
 * nothing anywhere saying why. Two taps, both on chips that looked like they
 * composed.
 *
 * What this measures, in the order the failures matter:
 *
 *   **Nothing is hidden.** The band's content must fit the band at 320px. This
 *   is the whole complaint, and it is a number, so it is asserted as one.
 *
 *   **Every status is askable.** Derived from STATUS_LABEL rather than listed,
 *   so adding a tenth status and forgetting to expose it fails here instead of
 *   in a rep's afternoon.
 *
 *   **Do Not Contact only by name.** It must never arrive on a rep's map
 *   through a default, a reset, or the widening that runs after a save.
 *
 *   **The route filter still draws the route.** The old 'My route' chip was a
 *   filter *and* the switch that fed the polyline to both renderers — the least
 *   obvious thing the rail did, and the easiest to drop.
 *
 *   **"Nearest door" never offers a closed lead.** Not a filter, but the same
 *   question about the same set: it used to skip won and dnc and not lost, so
 *   the button offering a rep somewhere to go could send them to a door that
 *   had already said no. Nothing tested it at all.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

/** Sign in as a rep with a planned day, on the map. */
async function repOnMap(width = 390, height = 844) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
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
  await page.waitForTimeout(1500)
  return { ctx, page, errors }
}

const pins = (page) => page.locator('[data-marker="pin"],[data-marker="cluster"]').count()
const openSheet = async (page) => {
  await page.getByTestId('map-filters').click()
  await page.waitForTimeout(500)
}
const closeSheet = async (page) => {
  await page.getByRole('button', { name: /^Show \d+ leads?$/ }).click()
  await page.waitForTimeout(600)
}

/** Set every one of this rep's leads to one status, and clear their visit history. */
const setAll = (page, status) =>
  page.evaluate(
    (status) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('properties', 'readwrite')
          const store = tx.objectStore('properties')
          const all = store.getAll()
          all.onsuccess = () => {
            for (const row of all.result) {
              row.status = status
              delete row.lastOutcome
              delete row.lastVisitAt
              store.put(row)
            }
          }
          tx.oncomplete = () => res(all.result.length)
          tx.onerror = () => rej(new Error('write failed'))
        }
      }),
    status,
  )

try {
  /* ===== 1. nothing is behind a swipe, at the width that broke ========== */
  {
    const { ctx, page } = await repOnMap(320, 720)
    const band = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="map-filters"]').parentElement
      const btn = document.querySelector('[data-testid="map-filters"]').getBoundingClientRect()
      return {
        width: el.getBoundingClientRect().width,
        content: el.scrollWidth,
        btnHeight: btn.height,
        btnLeft: btn.left,
      }
    })
    /*
      The number that is the complaint. Before this the same measurement read
      296 and 1306 — everything past the third chip was unreachable without
      swiping a rail that never said it had more.
    */
    ok(
      band.content <= band.width + 1,
      'at 320px the filter band holds everything it shows, with nothing behind a swipe',
      `${band.content}px of content in ${Math.round(band.width)}px`,
    )
    ok(band.btnHeight >= 44, 'and the way into the rest is a full thumb target', `${Math.round(band.btnHeight)}px`)
    // Pinned, not scrolled: whatever else the band carries, the entry point is
    // the one thing that must never be the item that got pushed off.
    ok(band.btnLeft < 20, 'pinned at the near edge where a thumb starts', `left ${Math.round(band.btnLeft)}px`)

    /* --- and the sheet itself does not overflow that screen ------------- */
    //
    // Nothing else measures the inside of a sheet: the viewport audit only ever
    // photographs the closed map.
    await openSheet(page)
    const inside = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="filter-sheet"]')
      const panel = s.closest('.anim-sheet')
      const small = [...panel.querySelectorAll('button')]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0 && Math.min(r.width, r.height) < 40).length
      return { overflow: panel.scrollWidth - panel.clientWidth, small }
    })
    ok(inside.overflow <= 1, 'the sheet fits a 320px screen', `${inside.overflow}px of overflow`)
    ok(inside.small === 0, 'and every control in it clears the tap floor', `${inside.small} under 40px`)
    await ctx.close()
  }

  /* ===== 2. every status the app has can be asked for =================== */
  {
    const { ctx, page, errors } = await repOnMap()
    await openSheet(page)
    const labels = Object.values(STATUS_LABEL)
    const missing = []
    for (const label of labels) {
      const c = await page.getByRole('button', { name: new RegExp(`^${label}$`) }).count()
      if (c === 0) missing.push(label)
    }
    /*
      Derived from STATUS_LABEL, not written out. The rail listed four of the
      nine and nothing said so; a count hardcoded here would have the same
      blind spot.
    */
    ok(
      missing.length === 0,
      `all ${labels.length} statuses can be asked for on the map`,
      missing.length ? `missing: ${missing.join(', ')}` : labels.join(', '),
    )

    /* --- and the two answers that used to contradict each other -------- */
    //
    // One section now, single-select, so there is no way to hold both.
    const both = await page.evaluate(() => {
      const group = document.querySelector('[aria-label="Last knocked"]')
      return [...group.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').length
    })
    ok(both === 1, 'exactly one answer to "when was it last knocked" can be held at a time', `${both} selected`)
    ok(errors.length === 0, 'and the app threw nothing', errors[0]?.slice(0, 120) ?? 'none')
    await ctx.close()
  }

  /* ===== 3. a status filter actually filters ============================ */
  {
    const { ctx, page } = await repOnMap()
    const total = await pins(page)
    ok(total > 0, 'the map has markers to filter', `${total}`)

    await openSheet(page)
    await page.getByRole('button', { name: /^Follow-up$/ }).click()
    await page.waitForTimeout(400)
    const label = await page.getByRole('button', { name: /^Show \d+ leads?$/ }).innerText()
    await closeSheet(page)
    const followUps = await pins(page)
    ok(followUps < total, 'picking one status narrows the map', `${followUps} of ${total}`)
    // The count on the button is the only feedback a rep gets while the sheet
    // covers the map, so it has to be the same number the map then draws.
    ok(
      label.replace(/\D/g, '') === String(followUps),
      'and the number on the button is the number of markers drawn',
      `button said ${label.replace(/\D/g, '')}, map drew ${followUps}`,
    )

    /* --- the count on the trigger says how much is on ----------------- */
    const badge = await page.getByTestId('map-filters').getAttribute('aria-label')
    ok(/1 active/.test(badge ?? ''), 'the Filters button says one filter is on', badge ?? '(none)')

    /* --- and clearing puts it back ------------------------------------ */
    await openSheet(page)
    await page.getByRole('button', { name: /^Clear$/ }).click()
    await page.waitForTimeout(400)
    await closeSheet(page)
    ok((await pins(page)) === total, 'clearing restores every marker', `${await pins(page)} of ${total}`)
    ok(
      (await page.getByTestId('map-filters').getAttribute('aria-label')) === 'Filters',
      'and the button stops claiming anything is on',
    )
    await ctx.close()
  }

  /* ===== 4. Do Not Contact, only ever by name =========================== */
  //
  // The one that would matter most in the field. A rep must never be handed a
  // door somebody has asked never to be called on again.
  {
    const { ctx, page } = await repOnMap()
    const n = await setAll(page, 'dnc')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1800)
    ok(n > 0, 'every lead on this device is now Do Not Contact', `${n} leads`)
    ok((await pins(page)) === 0, 'and the map opens showing none of them', `${await pins(page)} pins`)

    // "All" is the widest thing a rep can ask for by accident. It must widen to
    // everything they are allowed to see — which includes DNC, deliberately,
    // because that is a named request and the office needs to find them.
    await openSheet(page)
    await page.getByRole('button', { name: /^Any status$/ }).click()
    await page.waitForTimeout(400)
    await closeSheet(page)
    ok((await pins(page)) > 0, 'they are reachable when asked for by name', `${await pins(page)} pins`)
    await ctx.close()
  }

  /* ===== 5. the route filter still draws the route ====================== */
  //
  // The least obvious thing the old rail did. 'My route' was a filter and also
  // the switch that handed the polyline to both renderers and the ordered stop
  // list; a restructure that kept the filtering and dropped the drawing would
  // look correct on every count and lose the line.
  {
    const { ctx, page } = await repOnMap()
    const line = () => page.locator('[data-route-line]').count()
    const onRoute = await page.getByRole('button', { name: /^My route$/ }).getAttribute('aria-pressed')
    ok(onRoute === 'true', 'a rep with a day planned opens on their route', `aria-pressed=${onRoute}`)
    const drawnUnderRoute = await line()
    await page.getByRole('button', { name: /^All$/ }).click()
    await page.waitForTimeout(600)
    const drawnUnderAll = await line()
    ok(
      drawnUnderRoute > 0,
      'the route line is drawn while the map is scoped to the route',
      `${drawnUnderRoute} segment(s)`,
    )
    ok(
      drawnUnderAll === 0,
      'and gone once it is not, so no line claims an order the map is not showing',
      `${drawnUnderAll} segment(s)`,
    )
    await ctx.close()
  }

  /* ===== 6. "My route" is absent when there is no route ================= */
  //
  // This rule had a gate, and it was about to stop working: verify:first-day
  // asserts the page text does not contain "My route", which a closed sheet
  // makes true whether or not the rule holds. Asserted here against the
  // controls themselves, in both places the choice now lives.
  {
    const { ctx, page } = await repOnMap()
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('allstar-field')
          req.onerror = () => rej(new Error('no db'))
          req.onsuccess = () => {
            const db = req.result
            const tx = db.transaction('routes', 'readwrite')
            tx.objectStore('routes').clear()
            tx.oncomplete = () => res()
            tx.onerror = () => rej(new Error('clear failed'))
          }
        }),
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1800)
    ok(
      (await page.getByRole('button', { name: /^My route$/ }).count()) === 0,
      'with no day planned there is no "My route" chip on the map',
    )
    /*
      And the sheet never repeats a name the band already carries.

      The scope section was in the sheet in a first draft, next to a band that
      also had "All" and "My route" chips: two controls with the same accessible
      name on screen at once, which a screen reader reads twice with no way to
      tell them apart and which no gate can address unambiguously. Checked as an
      invariant rather than as the absence of one section, since the next
      section somebody adds is where it would happen again.
    */
    await openSheet(page)
    const dupes = await page.evaluate(() => {
      const name = (b) => (b.getAttribute('aria-label') || b.textContent || '').trim()
      const band = new Set(
        [...document.querySelectorAll('[data-testid="map-filters"]')][0]
          .parentElement.querySelectorAll('button'),
      )
      const inSheet = [...document.querySelectorAll('[data-testid="filter-sheet"] button')]
      const bandNames = new Set([...band].map(name))
      return inSheet.map(name).filter((n) => bandNames.has(n))
    })
    ok(
      dupes.length === 0,
      'and no control in the sheet repeats a name the band already uses',
      dupes.length ? `repeated: ${dupes.join(', ')}` : 'none repeated',
    )
    // The incident this rule exists for: a rep with leads but no plan opening
    // the map to nothing.
    await closeSheet(page)
    ok((await pins(page)) > 0, 'and the map still opens with work on it', `${await pins(page)} pins`)
    await ctx.close()
  }

  /* ===== 7. an empty result says so ===================================== */
  //
  // The old rail's worst moment: two taps produced a map that was empty by
  // construction, and the only thing on screen that acknowledged it was a
  // search box reading "Search 0 leads".
  {
    const { ctx, page } = await repOnMap()
    await openSheet(page)
    await page.getByRole('button', { name: /^Do Not Contact$/ }).click()
    await page.waitForTimeout(400)
    await closeSheet(page)
    ok((await pins(page)) === 0, 'a filter that matches nothing empties the map', `${await pins(page)} pins`)
    ok(
      await page.getByTestId('no-matches').isVisible().catch(() => false),
      'and the map says so rather than looking broken',
    )
    // "Show all", not "Clear filters": the strip now distinguishes a filter
    // that matched nothing from a device with no leads on it, and only the
    // first of those has anything to undo. See verify:mapchrome.
    await page.getByRole('button', { name: /^Show all$/ }).click()
    await page.waitForTimeout(600)
    ok((await pins(page)) > 0, 'and offers a way out of it', `${await pins(page)} pins`)
    await ctx.close()
  }

  /* ===== 8. "Nearest door" never offers a closed lead =================== */
  //
  // Ungated until now, and wrong: it skipped won and dnc but not lost, so the
  // one button whose job is to send a rep somewhere worth going could send
  // them to a door that had already turned them down.
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
      permissions: ['geolocation'],
      geolocation: { latitude: 30.5083, longitude: -97.6789, accuracy: 12 },
    })
    const page = await ctx.newPage()
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1100)
    await page.getByRole('button', { name: /Try the demo/ }).click()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(page)
    await page.waitForTimeout(1400)
    await page.locator('a[href="/map"]:visible').first().click()
    await page.waitForTimeout(1600)

    const nearest = () => page.getByRole('button', { name: /Nearest door/ }).count()
    ok((await nearest()) > 0, 'with a position and open work, the map offers the nearest door')

    /*
      Every lead marked "not interested", and then explicitly asked for.

      The asking is the whole point, and the first draft of this check left it
      out: with the default filter those leads are off the map anyway, so the
      button vanished because `shown` was empty and not because anything
      guarded it. Reintroducing the old won/dnc-only test passed that check
      unchanged — which is how it was caught. The guard is only reachable when a
      closed lead is on screen, so the rep has to put one there first.
    */
    await setAll(page, 'lost')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    await openSheet(page)
    await page.getByRole('button', { name: /^Any status$/ }).click()
    await page.waitForTimeout(400)
    await closeSheet(page)
    ok((await pins(page)) > 0, 'with every door marked lost and shown on the map', `${await pins(page)} pins`)
    ok(
      (await nearest()) === 0,
      'nothing is offered as the nearest door — a door that said no is not somewhere to go',
      `${await nearest()} button(s)`,
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
console.log('=== every filter is reachable without a swipe, and none of them contradict ===')
