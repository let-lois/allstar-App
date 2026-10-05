import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Today's route: the visit's X always lands somewhere real, and the visit's
 * "What's next here?" step never scrolls sideways.
 *
 * Reported from a phone, two bugs:
 *
 *   The X (Exit visit) on a visit started from Today's route left the app on
 *   a blank screen that only a restart cleared. Root cause: a hook declared
 *   after the visit screen's "no longer available" early return. Exiting a
 *   visit with no outcome discards it, the next render took the early return
 *   with one hook fewer, and React (#300) unmounted the app. On top of that
 *   the X stepped back blindly — nothing behind a visit opened first in the
 *   session, two steps back on a double tap.
 *
 *   "What's next here?" slid left and right, with a small bar at the bottom
 *   right — iOS's horizontal scroll indicator. WebKit gives a native
 *   date/time input an intrinsic minimum width wider than the card on a
 *   phone; the visit's scroll pane, `overflow-y: auto`, was therefore also a
 *   horizontal scroller. This browser has no such minimum, so the gate
 *   imposes one the way WebKit does (a low-specificity rule) and holds the
 *   page to the device width anyway.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}
const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []

async function demo(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1200)
  return { ctx, page }
}
const path = (page) => new URL(page.url()).pathname
/** The app is alive: a heading is on screen and the bottom nav answers. */
const alive = async (page) => (await page.locator('h1, h2').count()) > 0 && (await page.getByRole('navigation', { name: 'Primary' }).count()) > 0
const startFromToday = async (page) => {
  await page.locator('[data-tour="start-visit"]').first().click()
  await page.waitForURL(/\/visit\//, { timeout: 8000 })
  await page.waitForTimeout(500)
}
const exitVisit = (page) => page.getByRole('button', { name: 'Exit visit' })

try {
  /* ===== navigation ====================================================== */
  {
    const { ctx, page } = await demo()
    const before = errors.length

    // 1. Today → Today's route visit → X → Today.
    await startFromToday(page)
    await exitVisit(page).click()
    await page.waitForTimeout(900)
    ok(path(page) === '/today' && (await alive(page)), 'Test 1: Today → visit → X returns to Today, alive', path(page))
    ok(errors.length === before, 'and nothing throws (it used to: React #300, blank screen)', errors.slice(before)[0])

    // 3. Reopen afterwards: works normally.
    await startFromToday(page)
    ok(/What happened\?/.test(await page.locator('body').innerText()), 'Test 3: reopening the route visit after X works')
    // 7. Two quick taps on X: one exit, the app intact.
    const histBefore = await page.evaluate(() => history.length)
    await exitVisit(page).dblclick()
    await page.waitForTimeout(1200)
    ok(path(page) === '/today' && (await alive(page)), 'Test 7: a double tap on X lands on Today once', path(page))
    // A second step back would have left the app (or landed before Today).
    await page.goBack()
    await page.waitForTimeout(700)
    ok(path(page) !== '/today' || (await page.evaluate(() => history.length)) <= histBefore, 'and did not step back twice')
    await page.goForward()
    await page.waitForTimeout(700)

    // 4. After X the rest of the app works.
    await startFromToday(page)
    await exitVisit(page).click()
    await page.waitForTimeout(900)
    for (const [label, re] of [['Leads', /\/leads/], ['Map', /\/map/], ['More', /\/more/], ['Today', /\/today/]]) {
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label }).first().click()
      await page.waitForTimeout(800)
      ok(re.test(path(page)) && (await page.locator('main').count()) === 1, `Test 4: after X, ${label} opens`, path(page))
    }

    // 2. Today → route → a stop's Start → X → back on that route's screen chain.
    await page.goto(`${BASE}/route`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await dismissTour(page)
    await page.getByRole('button', { name: /^Start$/ }).first().click()
    await page.waitForURL(/\/visit\//, { timeout: 8000 })
    await page.waitForTimeout(500)
    await exitVisit(page).click()
    await page.waitForTimeout(900)
    ok(path(page) === '/route' && (await alive(page)), 'Test 2: route → stop → X returns to the route', path(page))
    await page.getByRole('button', { name: /^Back$/ }).first().click()
    await page.waitForTimeout(800)
    ok(path(page) === '/today', 'and Back from there reaches Today', path(page))

    // 6. Backgrounded mid-visit, then X.
    await startFromToday(page)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pagehide'))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
    })
    await page.waitForTimeout(500)
    await exitVisit(page).click()
    await page.waitForTimeout(900)
    ok(path(page) === '/today' && (await alive(page)), 'Test 6: background, return, X: back on Today', path(page))

    // Route progress is untouched by an exited visit: the stop is still to do.
    const pending = await page.evaluate(
      () =>
        new Promise((res) => {
          const q = indexedDB.open('allstar-field')
          q.onsuccess = () => {
            const r = q.result.transaction('routes').objectStore('routes').getAll()
            r.onsuccess = () => res(r.result[0]?.stops?.filter((s) => s.status === 'pending').length ?? -1)
          }
        }),
    )
    ok(pending > 0, 'closing a visit leaves the route and its stops in place', pending)

    // 5. A visit opened as the first screen of the session (cold start / app
    //    restored onto it): nothing behind it, and X still lands on Today.
    await startFromToday(page)
    const visitUrl = page.url()
    const fresh = await ctx.newPage()
    fresh.on('pageerror', (e) => errors.push(String(e)))
    await fresh.goto(visitUrl, { waitUntil: 'domcontentloaded' })
    await fresh.waitForTimeout(1500)
    await dismissTour(fresh)
    ok((await exitVisit(fresh).count()) === 1, 'Test 5: a visit opened first in a session shows its X')
    await exitVisit(fresh).click()
    await fresh.waitForTimeout(900)
    ok(path(fresh) === '/today' && (await alive(fresh)), 'and X there lands on Today, not nowhere', path(fresh))
    await ctx.close()
  }

  /* ===== "What's next here?" holds the device width ===================== */
  for (const [label, viewport] of [
    ['iPhone SE 320×568', { width: 320, height: 568 }],
    ['iPhone SE 375×667', { width: 375, height: 667 }],
    ['iPhone 14 390×844', { width: 390, height: 844 }],
    ['iPhone Pro Max 430×932', { width: 430, height: 932 }],
  ]) {
    const { ctx, page } = await demo(viewport)
    // What WebKit does on its own: a native date input wider than the card.
    await page.addStyleTag({ content: 'input { min-width: 420px; }' })
    await startFromToday(page)
    await page.getByRole('button', { name: /Interested/ }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^Continue$/ }).click()
    await page.waitForTimeout(400)
    ok(/What's next here\?/.test(await page.locator('body').innerText()), `${label}: on "What's next here?"`)
    await page.getByRole('button', { name: /Follow up/ }).first().click()
    await page.waitForTimeout(400)
    const m = await page.evaluate((W) => {
      const pane = document.querySelector('.scroll-pane')
      const input = document.querySelector('[data-testid="visit-pick-time"]')
      const box = input.parentElement
      const card = box.closest('.card') ?? box.parentElement
      // Anything drawn past the screen. The native input is skipped on purpose:
      // it is forced wider than the card above, as WebKit draws it, and the
      // point is that it is clipped by its box and moves nothing.
      const out = []
      for (const el of document.querySelectorAll('body *')) {
        if (el === input) continue
        const b = el.getBoundingClientRect()
        if (b.width && b.height && (b.right > W + 0.5 || b.left < -0.5)) out.push(`${el.tagName.toLowerCase()} ${Math.round(b.left)}–${Math.round(b.right)}`)
      }
      const before = pane.scrollLeft
      pane.scrollLeft = 50
      const moved = pane.scrollLeft !== before
      pane.scrollLeft = 0
      const bb = box.getBoundingClientRect()
      const cb = card.getBoundingClientRect()
      return {
        out,
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        moved,
        ox: getComputedStyle(pane).overflowX,
        nativeW: Math.round(input.getBoundingClientRect().width),
        boxIn: bb.left >= cb.left - 0.5 && bb.right <= cb.right + 0.5,
        boxW: Math.round(bb.width),
        cardW: Math.round(cb.width),
        clips: getComputedStyle(box).overflow === 'hidden',
        bar: (() => {
          const b = document.querySelector('.app-shell > .shrink-0.bg-surface')?.getBoundingClientRect()
          return b ? { l: Math.round(b.left), r: Math.round(b.right) } : null
        })(),
      }
    }, viewport.width)
    ok(m.out.length === 0, `${label}: nothing on the step extends past the screen`, m.out.slice(0, 3).join(', ') || 'none')
    ok(m.boxIn && m.clips, `${label}: the time field's box sits inside its card, and clips the native picker drawn ${m.nativeW}px wide`, `${m.boxW} in ${m.cardW}`)
    ok(m.paneOverflow <= 0 && m.doc <= 0, `${label}: no horizontal overflow on the step or the page`, `${m.paneOverflow}/${m.doc}`)
    ok(!m.moved && m.ox === 'hidden', `${label}: the step cannot be scrolled sideways`, `overflow-x ${m.ox}`)
    ok(m.bar && m.bar.l >= 0 && m.bar.r <= viewport.width, `${label}: the bottom action bar stays inside the screen`, m.bar && `${m.bar.l}–${m.bar.r}`)
    // Tapping the field is what slid the step on the phone: focusing it must not.
    await page.getByTestId('visit-pick-time').focus()
    await page.waitForTimeout(200)
    const after = await page.evaluate(() => ({
      pane: document.querySelector('.scroll-pane').scrollLeft,
      h1: Math.round([...document.querySelectorAll('h2')].find((h) => /What's next here/.test(h.textContent))?.getBoundingClientRect().left ?? -1),
    }))
    ok(after.pane === 0 && after.h1 >= 12, `${label}: focusing the time field does not slide the step`, `scrollLeft ${after.pane}, heading at ${after.h1}px`)
    // Choosing a time still sets it.
    await page.getByTestId('visit-pick-time').fill('2026-10-10T10:00')
    await page.waitForTimeout(200)
    const said = await page.locator('body').innerText()
    ok(/Scheduled for Sat, Oct 10 at 10:00/.test(said) && /Oct 10/.test(await page.getByTestId('visit-pick-time').locator('xpath=..').innerText()), `${label}: picking a time shows it in the field and below`, said.match(/Scheduled for[^\n]*/)?.[0])
    // Buttons readable and tappable.
    const tiny = await page.evaluate(() => [...document.querySelectorAll('.scroll-pane button')].filter((b) => { const r = b.getBoundingClientRect(); return r.height && (r.height < 44 || r.width < 44) }).length)
    ok(tiny === 0, `${label}: every choice is at least 44px both ways`, tiny)
    // Vertical scrolling still works when the content is taller than the pane.
    const v = await page.evaluate(() => {
      const pane = document.querySelector('.scroll-pane')
      const room = pane.scrollHeight - pane.clientHeight
      pane.scrollTop = 80
      return { room, top: pane.scrollTop }
    })
    ok(v.room <= 0 || v.top > 0, `${label}: still scrolls up and down`, `${v.room}px to scroll`)
    await ctx.close()
  }
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors anywhere', errors[0])
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== the visit X always lands somewhere real, and "What\'s next here?" holds the screen width ===')
