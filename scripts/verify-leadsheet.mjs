import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The Leads screen's filters, on a phone.
 *
 * This header was two horizontal rails holding eighteen chips on a rep's
 * phone, with "All" clipped at the right edge of a 390px screen and nothing to
 * say more lay past it. The brief for this app says filter UI must not need a
 * horizontal swipe, and the map already learned the answer: the question a
 * rep answers on arriving stays in plain sight, and everything else is one
 * tap away in a sheet with headings.
 *
 * So the checks are the ones the map's rail gate makes, applied here: nothing
 * behind a swipe at the narrowest width, a full thumb target into the sheet,
 * the sheet holding everything without overflow, and the filters actually
 * filtering — with the count on the button matching the list it leaves. Plus
 * the two things the change must not break: the walkthrough's anchors on this
 * header, and the office's "whose leads" question, which a rep never sees.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

async function onLeads(who, width = 390, height = 844) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1100)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: who }).click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await dismissTour(page)
  return { ctx, page, errors }
}
const subtitleCount = async (page) => {
  const m = (await page.locator('header').innerText()).match(/(\d+) of (\d+)/)
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null
}
const openSheet = async (page) => {
  await page.getByTestId('leads-filters').click()
  await page.waitForTimeout(500)
}
const closeSheet = async (page) => {
  await page.getByRole('button', { name: /^Show \d+ leads?$/ }).click()
  await page.waitForTimeout(500)
}

try {
  /* ===== 1. nothing behind a swipe, at the width that broke ============== */
  {
    const { ctx, page } = await onLeads(/Dana Whitfield/, 320, 720)
    const header = await page.evaluate(() => {
      const h = document.querySelector('header')
      const btn = document.querySelector('[data-testid="leads-filters"]').getBoundingClientRect()
      const rails = [...document.querySelectorAll('header .snap-x-row')].length
      return { width: h.clientWidth, content: h.scrollWidth, btnHeight: btn.height, btnRight: btn.right, rails }
    })
    ok(header.content <= header.width + 1, 'at 320px the Leads header holds everything it shows, with nothing behind a swipe',
       `${header.content}px of content in ${header.width}px`)
    ok(header.rails === 0, 'and carries no horizontal rail at all', `${header.rails} rails`)
    ok(header.btnHeight >= 44, 'the way into the rest is a full thumb target', `${Math.round(header.btnHeight)}px`)
    ok(header.btnRight <= 320, 'and is on screen', `right edge ${Math.round(header.btnRight)}px`)

    await openSheet(page)
    const inside = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="leads-filter-sheet"]')
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

  /* ===== 2. the filters filter, and the button counts what they leave ==== */
  {
    const { ctx, page, errors } = await onLeads(/Dana Whitfield/)
    const before = await subtitleCount(page)
    ok(!!before && before.total > 0, 'the rep has leads to filter', before ? `${before.shown} of ${before.total}` : 'no count')
    ok(await page.locator('[data-tour="leads-search"]').isVisible(), 'the walkthrough’s search anchor is still on the header')
    ok(await page.locator('[data-tour="leads-sort"]').isVisible(), 'and its sort anchor')
    ok((await page.getByTestId('leads-filters').getAttribute('aria-label')) === 'Filters', 'nothing is on to begin with')

    await openSheet(page)
    const sheet = page.getByTestId('leads-filter-sheet')
    ok(/^Status$/m.test(await sheet.innerText()) && /^Last visit$/m.test(await sheet.innerText()), 'the sheet has Status and Last visit sections')
    ok(!/^Whose$/m.test(await sheet.innerText()), 'and no Whose section — a rep’s list is already only theirs')
    await sheet.getByRole('button', { name: /^Won$/ }).click()
    await page.waitForTimeout(400)
    const label = await page.getByRole('button', { name: /^Show \d+ leads?$/ }).innerText()
    await closeSheet(page)
    const after = await subtitleCount(page)
    ok(!!after && after.shown < before.total, 'picking a status narrows the list', `${after?.shown} of ${after?.total}`)
    ok(label.replace(/\D/g, '') === String(after?.shown), 'and the number on the button is the number of rows it left',
       `button ${label.replace(/\D/g, '')}, list ${after?.shown}`)
    ok(/1 active/.test((await page.getByTestId('leads-filters').getAttribute('aria-label')) ?? ''), 'the Filters button says one is on')

    await openSheet(page)
    await sheet.getByRole('button', { name: /^Never knocked$/ }).click()
    await page.waitForTimeout(300)
    await closeSheet(page)
    ok(/2 active/.test((await page.getByTestId('leads-filters').getAttribute('aria-label')) ?? ''), 'two questions answered is two')

    await openSheet(page)
    await page.getByRole('button', { name: /^Clear$/ }).click()
    await page.waitForTimeout(300)
    await closeSheet(page)
    const cleared = await subtitleCount(page)
    ok(cleared?.shown === before.total, 'Clear brings every lead back', `${cleared?.shown} of ${cleared?.total}`)
    ok((await page.getByTestId('leads-filters').getAttribute('aria-label')) === 'Filters', 'and the button stops claiming anything is on')

    // Sort stays in plain sight and still works.
    await page.getByRole('button', { name: /^Value$/ }).click()
    await page.waitForTimeout(400)
    ok((await page.getByRole('button', { name: /^Value$/ }).getAttribute('aria-pressed')) === 'true', 'sort is answered on the header, not in the sheet')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* ===== 3. the office asks whose ======================================== */
  {
    const { ctx, page } = await onLeads(/Ray Okafor/)
    await openSheet(page)
    const sheet = page.getByTestId('leads-filter-sheet')
    ok(/^Whose$/m.test(await sheet.innerText()), 'a manager’s sheet has the Whose section')
    ok((await sheet.getByRole('button', { name: /^Dana Whitfield$/ }).count()) === 1, 'naming the reps')
    const total = (await subtitleCount(page))?.total ?? 0
    await sheet.getByRole('button', { name: /^Dana Whitfield$/ }).click()
    await page.waitForTimeout(400)
    await closeSheet(page)
    const hers = await subtitleCount(page)
    ok(!!hers && hers.shown > 0 && hers.shown < total, 'and picking one narrows to their leads', `${hers?.shown} of ${total}`)
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== the Leads filters need no swipe, and they filter ===')
process.exit(fails.length ? 1 : 0)
