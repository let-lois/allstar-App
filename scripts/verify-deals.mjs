import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Plans and sales, on the screens.
 *
 * Every dollar figure used to be a spreadsheet's estimate that nothing in the
 * app could set. Now a rep picks the plan when a door says yes, the lead shows
 * its sale, a rep can change the plan, only a manager can change the value
 * (with a reason), and the office keeps the price list in the console.
 *
 *   - Sold in a visit asks which plan, with "Not sure" for the office;
 *   - the lead's Sale card shows the plan price, and the plan can be changed;
 *   - a rep is not offered "Change value"; a manager is, and must give a reason;
 *   - what the phone sends is the plan id, never a value it made up;
 *   - the console's Plans page adds and retires plans;
 *   - none of it scrolls sideways on a phone.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}
const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []

async function demo(who, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: who }).click()
  await dismissTour(page)
  await page.waitForTimeout(1200)
  return { ctx, page }
}
/** Read a whole IndexedDB store of the app's local database. */
const store = (page, name) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        const q = indexedDB.open('allstar-field')
        q.onsuccess = () => {
          const r = q.result.transaction(n).objectStore(n).getAll()
          r.onsuccess = () => res(r.result)
        }
      }),
    name,
  )
/** Nothing on the page is wider than the screen, and no pane scrolls sideways. */
const noSideways = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    if (document.scrollingElement.scrollWidth > vw + 1) return `page ${document.scrollingElement.scrollWidth}>${vw}`
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el)
      // A row of chips or photos that scrolls sideways on purpose is not this.
      if (el.classList.contains('snap-x-row')) continue
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        return `${el.className.slice?.(0, 40)} ${el.scrollWidth}>${el.clientWidth}`
      }
    }
    return ''
  })
/** Navigate inside the app, which works offline where a page load does not. */
const go = (page, to) =>
  page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, to)
const text = (loc) => loc.innerText().catch(() => '')

try {
  /* ===== a rep sells at the door ======================================== */
  {
    const { ctx, page } = await demo(/Dana Whitfield/)
    // Offline, so what the phone queues stays in the outbox to be read: the
    // demo's simulated server otherwise takes it within a second.
    await ctx.setOffline(true)
    await page.locator('[data-tour="start-visit"]').first().click()
    await page.waitForURL(/\/visit\//, { timeout: 8000 })
    await page.waitForTimeout(500)
    const visitId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
    const propertyId = (await store(page, 'visits')).find((v) => v.id === visitId)?.propertyId
    ok(!!propertyId, 'a visit is open on a lead', propertyId)

    await page.getByRole('button', { name: /^Sold/ }).first().click()
    await page.waitForTimeout(500)
    const picker = page.getByTestId('visit-plan')
    ok((await picker.count()) === 1, 'Sold asks which plan')
    const options = picker.locator('[data-testid^="plan-option-"]')
    ok((await options.count()) === 4, 'the three plans on the price list, and "Not sure"', await options.count())
    ok(/Premium[\s\S]*\$24,000/.test(await text(picker)), 'each with its price on the button')
    ok((await page.getByTestId('plan-option-unset').getAttribute('aria-pressed')) === 'true', 'nothing is assumed: "Not sure" until the rep picks')
    await page.getByTestId('plan-option-plan_demo_premium').click()
    await page.waitForTimeout(250)
    ok((await page.getByTestId('plan-option-plan_demo_premium').getAttribute('aria-pressed')) === 'true', 'tapping a plan picks it')
    ok((await noSideways(page)) === '', 'the step does not scroll sideways on a phone', await noSideways(page))
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/deals-visit-plan.png` : '/dev/null' }).catch(() => {})

    await page.getByRole('button', { name: /^Continue$/ }).click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^Complete visit$/ }).click()
    await page.waitForTimeout(1200)

    const sent = (await store(page, 'outbox')).find((m) => m.kind === 'visit.complete' && m.payload?.id === visitId)
    ok(sent?.payload?.deal?.planId === 'plan_demo_premium', 'the phone sends the plan picked', JSON.stringify(sent?.payload?.deal))
    ok(sent?.payload?.deal?.value === undefined, 'and never a value of its own — the server prices it')

    await go(page, `/property/${propertyId}`)
    await page.waitForTimeout(1200)
    await dismissTour(page)
    const sale = page.getByTestId('lead-sale')
    ok((await sale.count()) === 1, 'the lead shows its sale')
    ok((await text(page.getByTestId('sale-value'))) === '$24,000', 'worth the plan price', await text(page.getByTestId('sale-value')))
    ok(/Premium plan/.test(await text(page.getByTestId('sale-plan'))), 'on the plan sold')
    ok((await page.getByTestId('sale-change-value').count()) === 0, 'a rep is not offered "Change value"')

    await page.getByTestId('sale-change-plan').click()
    await page.waitForTimeout(500)
    const sheet = page.getByTestId('sale-sheet')
    ok((await sheet.locator('[data-testid="plan-option-unset"]').count()) === 0, 'changing the plan of a sale offers only real plans')
    await sheet.getByTestId('plan-option-plan_demo_standard').click()
    await sheet.getByTestId('sale-save').click()
    await page.waitForTimeout(800)
    ok((await text(page.getByTestId('sale-value'))) === '$15,000', 'a rep can move the sale onto another plan, and it takes that price', await text(page.getByTestId('sale-value')))
    const update = (await store(page, 'outbox')).find((m) => m.kind === 'deal.update' && m.payload?.propertyId === propertyId)
    ok(update?.payload?.planId === 'plan_demo_standard' && update?.payload?.value === undefined, 'sent as a plan change', JSON.stringify(update?.payload))
    ok((await noSideways(page)) === '', 'the lead does not scroll sideways', await noSideways(page))
    await ctx.close()
  }

  /* ===== a manager overrides a value, with a reason ===================== */
  {
    const { ctx, page } = await demo(/Ray Okafor/)
    await ctx.setOffline(true)
    const won = (await store(page, 'properties')).find((p) => p.status === 'won' && p.deal)
    ok(!!won, 'the demo has a sold lead', won?.id)
    await go(page, `/property/${won.id}`)
    await page.waitForTimeout(1200)
    await dismissTour(page)
    ok((await page.getByTestId('sale-change-value').count()) === 1, 'a manager is offered "Change value"')
    await page.getByTestId('sale-change-value').click()
    await page.waitForTimeout(500)
    await page.getByTestId('sale-value-input').fill('18,500')
    ok(await page.getByTestId('sale-save').isDisabled(), 'and cannot save it without saying why')
    await page.getByTestId('sale-reason-input').fill('Bundle discount agreed on site')
    await page.getByTestId('sale-save').click()
    await page.waitForTimeout(800)
    ok((await text(page.getByTestId('sale-value'))) === '$18,500', 'the sale is worth what the manager set', await text(page.getByTestId('sale-value')))
    ok(/Bundle discount agreed on site/.test(await text(page.getByTestId('sale-override'))), 'with the reason shown beside it')
    ok(/plan price \$/.test(await text(page.getByTestId('sale-override'))), 'and the plan price it replaced')
    const update = (await store(page, 'outbox')).find((m) => m.kind === 'deal.update' && m.payload?.propertyId === won.id)
    ok(update?.payload?.value === 18500 && /Bundle/.test(update?.payload?.reason ?? ''), 'sent with the value and the reason', JSON.stringify(update?.payload))
    const line = (await store(page, 'activity')).find((a) => a.type === 'deal' && a.propertyId === won.id)
    ok(/\$18,500/.test(line?.summary ?? ''), "and written into the lead's activity", line?.summary)
    await ctx.close()
  }

  /* ===== the price list in the console =================================== */
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const { ctx, page } = await demo(/Nadia Petrov/, viewport)
    await page.goto(`${BASE}/admin/plans`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await dismissTour(page)
    const rows = page.getByTestId('plan-row')
    ok((await rows.count()) === 3, `${viewport.width}px: the console lists the price list`, await rows.count())
    ok(/\d+ sold/.test(await text(page.getByTestId('plans-list'))), 'with what each plan has sold')
    await page.getByTestId('plan-name').fill('Gold')
    await page.getByTestId('plan-price').fill('30000')
    await page.getByTestId('plan-add').click()
    await page.waitForTimeout(600)
    ok((await rows.count()) === 4 && /Gold[\s\S]*\$30,000/.test(await text(page.getByTestId('plans-list'))), 'the office adds a plan', await rows.count())
    await rows.filter({ hasText: 'Starter' }).getByTestId('plan-toggle').click()
    await page.waitForTimeout(500)
    ok(/Starter\s*Retired/.test(await text(page.getByTestId('plans-list'))), 'and retires one, which stays listed')
    ok((await noSideways(page)) === '', `${viewport.width}px: the page does not scroll sideways`, await noSideways(page))
    if (viewport.width === 1280) {
      ok((await page.getByRole('link', { name: 'Plans' }).count()) > 0, 'Plans is in the console menu')
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors', errors[0])
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== plans and sales work on the phone and in the console ===')
