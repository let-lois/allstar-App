import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The phones reps actually carry, and the one flow that matters most on them.
 *
 * Three widths — a small Android, an iPhone, a large iPhone — and on each the
 * main screens must fit: nothing wider than the viewport, no sideways scroll,
 * and the primary action a full thumb target. Then, at the common width, the
 * whole reason the map exists: tap a house, see what the map found and its
 * photo frame, Add lead, get the form with the pin already in it, save, and
 * land on the house's own sheet with its status, the four ways to reach the
 * household, and Start visit. Demo mode, no Google key: the flow has to hold
 * with the geocoder and Street View both absent.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

async function phone(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)
  return { ctx, page, errors }
}

/**
 * Where the screen runs past the phone.
 *
 * Two places it can. The document itself, which is the obvious one. And any
 * pane that scrolls vertically: `overflow-y: auto` makes `overflow-x` auto as
 * well, so a card wider than the phone does not push the document out — it
 * gives the page pane a sideways scroll, which the first version of this check
 * skipped as "a rail that is meant to scroll". A rail is short; a pane is tall.
 * Anything taller than a chip row that can be scrolled sideways is a defect,
 * and this names the pane and how far it goes.
 */
const fit = (page) =>
  page.evaluate(() => {
    const over = document.documentElement.scrollWidth - window.innerWidth
    let widest = null
    for (const el of document.querySelectorAll('body, body *')) {
      const cs = getComputedStyle(el)
      const ox = cs.overflowX
      if (ox !== 'auto' && ox !== 'scroll' && el !== document.body) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const spill = el.scrollWidth - el.clientWidth
      if (spill <= 1) continue
      // A short strip that scrolls sideways is a rail and means to.
      if (r.height < 120 && el !== document.body) continue
      if (!widest || spill > widest.spill) {
        widest = { spill, tag: el.tagName.toLowerCase(), cls: (el.className?.toString() ?? '').slice(0, 50) }
      }
    }
    return { over, widest }
  })

/**
 * One of the four contact actions, found by its label on the control itself.
 * A Call link with no number to call has no href and so no link role — but it
 * is still the control the rep sees, and it still has to be a thumb target.
 */
const action = (page, label) =>
  page.locator('a, button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })

const tapSize = async (locator) => {
  // Not there is a plain 0, not a 30-second wait for it to appear.
  if ((await locator.count()) === 0) return 0
  const b = await locator.first().boundingBox({ timeout: 1500 }).catch(() => null)
  return b ? Math.round(Math.min(b.width, b.height)) : 0
}

try {
  for (const [width, height, label] of [[360, 800, 'small Android'], [375, 667, 'iPhone SE'], [390, 844, 'iPhone'], [430, 932, 'large iPhone']]) {
    console.log(`\n--- ${width}x${height} (${label}) ---`)
    const { ctx, page, errors } = await phone(width, height)
    const screens = [
      ['/today', 'Today'],
      ['/map', 'Map'],
      ['/leads', 'Leads'],
      ['/lists', 'Lists'],
      ['/lead/new', 'Add lead'],
    ]
    for (const [path, name] of screens) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1600)
      await dismissTour(page)
      const f = await fit(page)
      ok(f.over <= 0 && !f.widest, `${name} fits`, f.widest ? `${f.widest.tag}.${f.widest.cls} scrolls ${f.widest.spill}px sideways` : `${f.over}px over`)
    }
    // A lead's page, and its primary action.
    await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.getByTestId('lead-row').first().click()
    await page.waitForTimeout(1200)
    {
      const f = await fit(page)
      ok(f.over <= 0 && !f.widest, 'a lead’s page fits', f.widest ? `${f.widest.tag}.${f.widest.cls} scrolls ${f.widest.spill}px sideways` : '')
      const start = page.getByRole('button', { name: /^Start visit$/ })
      ok((await tapSize(start)) >= 44, 'Start visit is a full thumb target', `${await tapSize(start)}px`)
      for (const a of ['Call', 'Text', 'Email', 'Navigate']) {
        const btn = action(page, a)
        ok((await tapSize(btn)) >= 44, `${a} is a full thumb target`, `${await tapSize(btn)}px`)
      }
    }
    // The dock.
    {
      // Only the dock that is on screen: the wide-screen rail shares the label
      // and is display:none on a phone, which makes its anchors 0x0.
      const items = page.locator('nav[aria-label="Primary"] a:visible')
      const n = await items.count()
      let small = 0
      for (let i = 0; i < n; i++) if ((await tapSize(items.nth(i))) < 44) small++
      ok(n >= 4 && small === 0, 'every dock item is a full thumb target', `${n} items, ${small} small`)
    }
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* ===== the flow, at the common width ==================================== */
  console.log('\n--- map → house → lead, 390x844 ---')
  {
    const { ctx, page, errors } = await phone(390, 844)
    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await dismissTour(page)
    let opened = false
    for (const [x, y] of [[200, 430], [110, 470], [300, 380], [150, 350], [250, 500]]) {
      await page.mouse.click(x, y)
      await page.waitForTimeout(700)
      if (await page.getByTestId('detected-property').isVisible().catch(() => false)) { opened = true; break }
      // A house's own sheet came up instead — put it away and try elsewhere.
      const close = page.getByRole('button', { name: /^(Close|Done)$/ })
      if (await close.isVisible().catch(() => false)) await close.click()
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)
    }
    ok(opened, 'tapping a house opens on the house')
    if (opened) {
      const d = (await page.getByTestId('detected-property').innerText()).replace(/\s+/g, ' ')
      ok(/Not a lead yet/.test(d), 'which says it is not a lead yet')
      ok((await page.getByTestId('property-image').count()) === 1, 'with the frame where its photo goes')
      ok(/\d+\.\d{5}, -?\d+\.\d{5}/.test(d), 'and the exact point that was tapped', d.match(/-?\d+\.\d{5}, -?\d+\.\d{5}/)?.[0])
      await page.getByTestId('detected-add-lead').click()
      await page.waitForTimeout(500)
      const readout = (await page.getByTestId('lead-pin-readout').innerText()).replace(/\s+/g, ' ')
      ok(/Pinned where you tapped/.test(readout), 'Add lead opens the form with the pin already set', readout.slice(0, 60))
      await page.locator('input[autocomplete="street-address"]').fill('17 Viewport Way')
      await page.locator('input[autocomplete="name"]').fill('Sam Okonkwo')
      const save = page.getByRole('button', { name: /^Save lead$/ })
      ok((await tapSize(save)) >= 44, 'Save lead is a full thumb target')

      /*
        The keyboard, which Playwright cannot raise.

        Typing into a field on a real phone brings up a software keyboard, and
        on iOS that shrinks the *visible* viewport while leaving the layout one
        at full height. The sheet is positioned against whichever of the two it
        is told to use, so this simulates the keyboard the only way a headless
        browser can: by moving `--app-h`, which is the property the app already
        pins to `visualViewport.height`.

        Without this, the sheet kept sizing itself against a height that no
        longer existed and put its fields and this button behind the keyboard —
        on the first screen a rep uses at a door, with no way to reach the
        control that finishes the job.
      */
      const KEYBOARD = 336
      const visible = (page.viewportSize()?.height ?? 844) - KEYBOARD
      await page.evaluate((h) => document.documentElement.style.setProperty('--app-h', `${h}px`), visible)
      await page.waitForTimeout(400)
      const withKeyboard = await save.boundingBox()
      ok(
        !!withKeyboard && withKeyboard.y + withKeyboard.height <= visible + 1,
        `Save lead stays above a ${KEYBOARD}px keyboard rather than behind it`,
        withKeyboard ? `button ends at ${Math.round(withKeyboard.y + withKeyboard.height)}px, keyboard starts at ${visible}px` : 'no box',
      )
      await page.evaluate(() => document.documentElement.style.removeProperty('--app-h'))
      await page.waitForTimeout(300)
      await save.click()
      await page.waitForTimeout(2000)
      const peek = page.getByTestId('property-peek')
      ok(await peek.isVisible().catch(() => false), 'saving lands on the house’s own sheet')
      const t = (await peek.innerText().catch(() => '')).replace(/\s+/g, ' ')
      ok(/17 Viewport Way/.test(t) && /\bNew\b/.test(t) && /Sam Okonkwo/.test(t), 'with its address, status and the homeowner', t.slice(0, 80))
      for (const a of ['Call', 'Text', 'Email', 'Navigate']) {
        ok((await action(page, a).count()) > 0, `and a way to ${a.toLowerCase()}`)
      }
      ok((await page.getByRole('button', { name: /^Start visit$/ }).count()) === 1, 'and Start visit, pinned where a thumb is')
      { const f = await fit(page); ok(f.over <= 0 && !f.widest, 'and the page still fits the phone', f.widest ? `${f.widest.tag} scrolls ${f.widest.spill}px sideways` : '') }
    }
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
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
console.log('=== fits four phones, from the iPhone SE up, and the map flow holds on the common one ===')
