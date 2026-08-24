import { chromium } from 'playwright'
import fs from 'node:fs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Mobile-first layout audit.
 *
 * Walks the field-rep flow at every viewport we support and fails on the two
 * things that quietly ruin a field app: horizontal overflow, and interactive
 * elements smaller than a fingertip. Run against a production preview build:
 *
 *   npm run build && npm run preview &
 *   npm run audit:viewports
 */

const OUT = process.argv[2] || 'viewport-audit'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
fs.mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: '320-small-android', width: 320, height: 640 },
  { name: '375-iphone-se', width: 375, height: 667 },
  { name: '390-iphone-14', width: 390, height: 844 },
  // 393 and 412 are the two commonest Android widths — Pixel and the Samsung A
  // series. They sit between the iPhone sizes, which is exactly where a layout
  // tuned only to Apple's widths breaks: one breakpoint short of `sm`.
  { name: '393-pixel', width: 393, height: 852 },
  { name: '412-android', width: 412, height: 915 },
  { name: '430-iphone-pro-max', width: 430, height: 932 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-desktop', width: 1024, height: 800 },
]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const problems = []

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.width < 768,
    hasTouch: vp.width < 768,
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5115, longitude: -97.6755 },
    locale: 'en-US',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // sign in as the field rep
  // The demo roster now sits behind the real login screen.
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(900)

  const shot = async (label) => {
    await page.screenshot({ path: `${OUT}/${vp.name}--${label}.png` })
  }

  const checkOverflow = async (label) => {
    const res = await page.evaluate(() => {
      const de = document.documentElement
      const horizontal = de.scrollWidth > de.clientWidth + 1
      // find any element wider than the viewport
      const wide = []
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > window.innerWidth + 2 && r.height > 0) {
          wide.push(`${el.tagName}.${(el.className || '').toString().slice(0, 60)} w=${Math.round(r.width)}`)
        }
      })
      return { horizontal, wide: wide.slice(0, 5), sw: de.scrollWidth, cw: de.clientWidth }
    })
    if (res.horizontal) problems.push(`${vp.name} ${label}: horizontal overflow ${res.sw}>${res.cw} :: ${res.wide.join(' | ')}`)
  }

  // Touch target audit: every interactive element must be >= 44px in its
  // smaller dimension (allowing inline links inside prose).
  const auditTargets = async (label) => {
    const small = await page.evaluate(() => {
      const out = []
      const sel = 'button, a[href], input, textarea, select, [role="switch"], [role="button"]'
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return
        if (Math.min(r.width, r.height) < 40) {
          out.push(`${el.tagName}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)}] ${Math.round(r.width)}x${Math.round(r.height)}`)
        }
      })
      return out
    })
    if (small.length) problems.push(`${vp.name} ${label}: small targets -> ${small.join(' ; ')}`)
  }

  // Control-part containment.
  //
  // A control's moving parts must stay inside the control. The offline
  // simulator's knob did not: it was positioned with a `top` and no `left`, so
  // the browser fell back to its static position inside the button's anonymous
  // centring box and parked the knob 22px past the end of its own track. It was
  // a white circle on a white card, so nothing looked broken — the switch just
  // appeared to have no knob at all, in either state.
  //
  // Neither of the checks above can see this. There is no page overflow (the
  // knob is 22px into a card with room to spare) and the tap target is the
  // track, which is the right size. So: any absolutely positioned part whose
  // containing block is a control must sit inside that control's box.
  const auditContainment = async (label) => {
    const escaped = await page.evaluate(() => {
      const out = []
      const SEL = 'button, [role="switch"], [role="button"]'
      document.querySelectorAll('button *, [role="switch"] *, [role="button"] *').forEach((el) => {
        if (getComputedStyle(el).position !== 'absolute') return
        // Measure against the control, not against offsetParent. A switch is
        // commonly a target wrapping a track wrapping a knob, so the knob's
        // containing block is an inner span — and a check that only looked at
        // offsetParent would skip the exact element it exists to watch.
        const host = el.closest(SEL)
        if (!host) return
        const r = el.getBoundingClientRect()
        const h = host.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        // 1px of slack for subpixel rounding; a real escape is many pixels.
        const over = Math.max(h.left - r.left, r.right - h.right, h.top - r.top, r.bottom - h.bottom)
        if (over > 1) {
          const name = (host.getAttribute('aria-label') || host.textContent || '').trim().slice(0, 28)
          out.push(`${el.tagName} escapes ${host.tagName}[${name}] by ${Math.round(over)}px`)
        }
      })
      return out
    })
    if (escaped.length) problems.push(`${vp.name} ${label}: control parts escape -> ${escaped.join(' ; ')}`)
  }

  await shot('01-today')
  await checkOverflow('today')
  await auditTargets('today')
  await auditContainment('today')

  // Map
  await page.getByRole('link', { name: 'Map' }).first().click().catch(() => {})
  await page.waitForTimeout(700)
  await shot('02-map')
  await checkOverflow('map')

  // Tap a property pin to open the sheet
  const marker = page.locator('g[data-marker="pin"]').nth(3)
  if (await marker.count()) {
    const box = await marker.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(500)
      await shot('03-map-sheet')
      await checkOverflow('map-sheet')
      await auditTargets('map-sheet')
    }
  }

  // Leads
  await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await shot('04-leads')
  await checkOverflow('leads')

  // Pipeline
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await shot('05-pipeline')
  await checkOverflow('pipeline')

  // Property detail
  await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const row = page.locator('button', { hasText: /Cypress Ridge|Marigold|Old Mill|Harper|Bellcrest/ }).first()
  if (await row.count()) {
    await row.click()
    await page.waitForTimeout(700)
    await shot('06-property')
    await checkOverflow('property')
    await auditTargets('property')
    await auditContainment('property')

    // Start visit -> outcome step
    const start = page.getByRole('button', { name: /^Start visit$/ })
    if (await start.count()) {
      await start.first().click()
      await page.waitForTimeout(1200)
      await shot('07-visit-outcome')
      await checkOverflow('visit-outcome')
      await auditTargets('visit-outcome')
      await auditContainment('visit-outcome')

      // Choose "Interested" -> detail step
      const interested = page.getByRole('button', { name: /Interested/ }).first()
      if (await interested.count()) {
        await interested.click()
        await page.waitForTimeout(600)
        await shot('08-visit-detail')
        await checkOverflow('visit-detail')

        const cont = page.getByRole('button', { name: /^Continue$/ })
        if (await cont.count()) {
          await cont.click()
          await page.waitForTimeout(500)
          await shot('09-visit-next')
          await checkOverflow('visit-next')
          await page.getByRole('button', { name: /Tomorrow AM/ }).first().click().catch(()=>{});
          await page.waitForTimeout(300);
          const complete = page.getByRole('button', { name: /Complete visit/ })
          if (await complete.count()) {
            await complete.click()
            await page.waitForTimeout(900)
            await shot('10-visit-done')
            await checkOverflow('visit-done')
          }
        }
      }
    }
  }

  // Route + More
  await page.goto(`${BASE}/route`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await shot('11-route')
  await checkOverflow('route')

  await page.goto(`${BASE}/more`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await shot('12-more')
  await checkOverflow('more')

  // Expand every section before auditing. Collapsed, More is four headers and
  // nothing to measure — the switch that shipped broken lives one tap down.
  const headers = page.locator('button[aria-expanded="false"]')
  for (let i = await headers.count(); i > 0; i--) {
    await headers.first().click().catch(() => {})
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(300)
  await shot('13-more-open')
  await checkOverflow('more-open')
  await auditTargets('more-open')
  await auditContainment('more-open')

  // Both switch states: the knob travels, so only one end may be out of bounds.
  const sw = page.locator('[role="switch"]').first()
  if (await sw.count()) {
    await sw.click()
    await page.waitForTimeout(400)
    await auditContainment('more-open-switched')
    await sw.click()
    await page.waitForTimeout(400)
  }

  if (errors.length) problems.push(`${vp.name}: console errors -> ${errors.slice(0, 4).join(' | ')}`)

  await ctx.close()
  console.log(`done ${vp.name}`)
}

await browser.close()

if (problems.length) {
  console.log('\n=== PROBLEMS ===')
  problems.forEach((p) => console.log('- ' + p))
} else {
  console.log('\n=== no layout/target problems detected ===')
}
