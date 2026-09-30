import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The redesign's promises, checked at phone sizes.
 *
 *   Help is one tap away: the question mark sits at the right of every main
 *   screen's header (and on the map, which has no header), and opens All Star
 *   Help. More leads with "Need help?".
 *
 *   More is a menu grouped by what it is for, and shows only what the role can
 *   use: a rep sees no Manage group; the office sees Team activity, the
 *   console and territories. Sign out is the last row, and asks first.
 *
 *   The floating add button is on the screens people work from (Today, the map)
 *   and nowhere it covers content (More, profile, badge, lists, pipeline).
 *
 *   Nothing scrolls sideways and no header control drops off screen at
 *   320, 375, 390 and 430 wide, and the console's lead filters fold behind one
 *   button on a phone.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

async function signIn(name, width = 375, height = 667) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name }).click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  return { ctx, page }
}
const go = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1300)
  await dismissTour(page)
}
const helpOnScreen = async (page) => {
  const help = page.getByTestId('help-button').first()
  if (!(await help.count())) return { found: false }
  const box = await help.boundingBox()
  return {
    found: true,
    href: await help.getAttribute('href'),
    target: await help.getAttribute('target'),
    label: await help.getAttribute('aria-label'),
    box,
    inView: !!box && box.x >= 0 && box.x + box.width <= page.viewportSize().width + 0.5 && box.y >= 0,
  }
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const fab = (page) => page.getByRole('button', { name: 'Quick actions' }).count()

try {
  /* ===== the rep ============================================================ */
  {
    const { ctx, page } = await signIn(/Dana Whitfield/)
    for (const path of ['/today', '/leads', '/pipeline', '/more', '/lists', '/standings', '/route']) {
      await go(page, path)
      const h = await helpOnScreen(page)
      ok(h.found && h.inView && h.box.width >= 44 && h.box.height >= 44, `rep ${path}: the Help question mark is in view, 44pt or larger`, h.box ? `${Math.round(h.box.x)},${Math.round(h.box.y)} ${Math.round(h.box.width)}×${Math.round(h.box.height)}` : 'missing')
    }
    // The map has no header; the mark floats in the top row.
    await go(page, '/map')
    const hm = await helpOnScreen(page)
    ok(hm.found && hm.inView && hm.box.y < 200, 'rep /map: Help floats at the top of the map', hm.box ? `y=${Math.round(hm.box.y)}` : 'missing')
    // A lead's own screen has it too.
    const leadId = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('allstar-field'); q.onsuccess = () => { const r = q.result.transaction('properties').objectStore('properties').getAll(); r.onsuccess = () => res(r.result[0]?.id) } }))
    await go(page, `/property/${leadId}`)
    const hl = await helpOnScreen(page)
    ok(hl.found && hl.inView, 'rep lead detail: Help is in the header beside Back')

    ok(/\/support$|help/i.test(hm.href ?? '') && hm.target === '_blank' && hm.label === 'Help', 'it opens All Star Help in a new window, and is named "Help" for a screen reader', `${hm.href} ${hm.target}`)

    // More: Need help first, then the groups a rep can use, sign out last.
    await go(page, '/more')
    const need = page.getByTestId('more-need-help')
    ok((await need.count()) === 1 && /Need help\?/.test(await need.innerText()) && /All Star Help/.test(await need.innerText()), 'More leads with "Need help? Visit All Star Help"')
    ok((await need.getAttribute('href')) === hm.href, 'which opens the same place as the question mark')
    const groups = await page.locator('section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    ok(groups.includes('Your work') && groups.includes('Help'), 'More is grouped: Your work, Help', groups.join(' · '))
    ok(!groups.includes('Manage'), 'a rep sees no Manage group')
    ok((await page.getByRole('button', { name: /Admin console/ }).count()) === 0, 'and no console link')
    for (const label of ["Today's route", 'Lists', 'Standings', 'Add a lead', 'Schedule an appointment', 'Show the tutorial again']) {
      ok((await page.getByRole('button', { name: label }).count()) === 1, `More still reaches “${label}”`)
    }
    const signOut = page.getByTestId('sign-out')
    ok((await signOut.count()) === 1, 'sign out is on More')
    const last = await page.evaluate(() => {
      const so = document.querySelector('[data-testid="sign-out"]')
      const all = [...document.querySelectorAll('.content-col a, .content-col button')].filter((b) => b.getBoundingClientRect().height > 0)
      return all.filter((b) => b.getBoundingClientRect().top > so.getBoundingClientRect().top + 1).map((b) => b.textContent?.trim()).slice(0, 3)
    })
    ok(last.length === 0, 'as the last control on the screen', last.join(', ') || 'nothing below it')
    await signOut.click()
    await page.waitForTimeout(700)
    ok(/Sign out\?/.test(await page.locator('body').innerText()), 'and asks before it acts')
    await page.getByRole('button', { name: /Stay signed in/ }).click()
    await page.waitForTimeout(500)

    // The home header: sync and Help, and nothing that ends the session.
    await go(page, '/today')
    ok((await page.locator('header').first().getByRole('button', { name: 'Sign out', exact: true }).count()) === 0, 'Today’s header no longer holds sign out')

    // The floating add button: working screens only.
    for (const path of ['/today', '/map']) {
      await go(page, path)
      ok((await fab(page)) === 1, `the add button is on ${path}`)
    }
    for (const path of ['/more', '/profile', '/badge', '/lists', '/pipeline', '/standings']) {
      await go(page, path)
      ok((await fab(page)) === 0, `and not on ${path}, where it covered content`)
    }

    // Leads: sort and Filters on one row at 375.
    await go(page, '/leads')
    const row = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="leads-filters"]')?.getBoundingClientRect()
      const s = document.querySelector('[data-tour="leads-sort"]')?.getBoundingClientRect()
      return f && s ? { fy: Math.round(f.top), sy: Math.round(s.top), right: Math.round(f.right) } : null
    })
    ok(!!row && Math.abs(row.fy - row.sy) <= 6 && row.right <= 375, 'Leads: Filters sits on the first row beside the sort chips on a 375 phone', JSON.stringify(row))
    await ctx.close()
  }

  /* ===== the office ========================================================= */
  {
    const { ctx, page } = await signIn(/Ray Okafor/)
    for (const path of ['/today', '/team', '/more']) {
      await go(page, path)
      const h = await helpOnScreen(page)
      ok(h.found && h.inView, `manager ${path}: Help is in the header`)
    }
    await go(page, '/more')
    const groups = await page.locator('section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    ok(groups.includes('Manage'), 'a manager sees the Manage group', groups.join(' · '))
    for (const label of ['Team activity', 'Admin console', 'Territories']) {
      ok((await page.getByRole('button', { name: label }).count()) === 1, `with “${label}”`)
    }
    await go(page, '/admin')
    const hc = await helpOnScreen(page)
    ok(hc.found && hc.inView, 'the console on a phone has Help in its header')

    // Console leads: filters fold behind one button on a phone.
    await go(page, '/admin/leads')
    const selectsShown = await page.locator('select[aria-label="Assigned to"]').isVisible().catch(() => false)
    ok(!selectsShown, 'console Leads on a phone opens with its filters folded away')
    await page.getByTestId('console-leads-filters').click()
    await page.waitForTimeout(300)
    ok(await page.locator('select[aria-label="Assigned to"]').isVisible(), 'and one tap opens them')
    await page.locator('select[aria-label="Assigned to"]').selectOption('unassigned')
    await page.waitForTimeout(300)
    ok(/Filters · 1/.test(await page.getByTestId('console-leads-filters').innerText()), 'the button counts what is on')
    await page.getByRole('button', { name: /^Reset$/ }).click()
    await page.waitForTimeout(300)
    ok((await page.locator('select[aria-label="Assigned to"]').inputValue()) === 'all', 'and Reset clears it')
    await ctx.close()
  }

  /* ===== widths ============================================================= */
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
    const { ctx, page } = await signIn(/Dana Whitfield/, w, h)
    const over = []
    for (const path of ['/today', '/map', '/leads', '/pipeline', '/more', '/lists']) {
      await go(page, path)
      const x = await sideways(page)
      if (x > 0) over.push(`${path} +${x}px`)
      const hb = await helpOnScreen(page)
      if (!hb.inView) over.push(`${path} help off screen`)
    }
    ok(over.length === 0, `${w}×${h}: no sideways scroll, and Help in view, on every main screen`, over.join(', ') || 'clean')
    await ctx.close()
  }

  /* ===== signed out ========================================================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const link = page.getByRole('link', { name: /Help & support/ })
    ok((await link.count()) === 1, 'the sign-in screen links to Help too')
    await ctx.close()
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await browser.close()
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== help in reach, a menu by role, nothing sideways ===')
