import { chromium } from 'playwright'
import { chromiumPath } from '/home/user/allstar-App/scripts/lib/browser.mjs'
import { dismissTour } from '/home/user/allstar-App/scripts/lib/tour.mjs'

const browser = await chromium.launch({ executablePath: chromiumPath() })

for (const [width, height] of [[320, 568], [320, 844], [390, 844], [430, 932]]) {
  const ctx = await browser.newContext({
    viewport: { width, height }, isMobile: true, hasTouch: true,
  })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1500)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /^list$/i }).click()
  await page.waitForTimeout(700)
  const list = page.getByRole('list', { name: 'Route stops' })
  await list.getByRole('button').first().click()
  await page.waitForTimeout(700)

  const res = await page.evaluate(() => {
    const full = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'View full profile',
    )
    if (!full) return { err: 'no peek' }
    const pane = full.closest('.scroll-pane')
    const panel = pane?.parentElement
    const start = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Start visit',
    )
    const pr = pane.getBoundingClientRect()
    return {
      panelH: Math.round(panel.getBoundingClientRect().height),
      paneTop: Math.round(pr.top),
      paneBottom: Math.round(pr.bottom),
      paneClient: pane.clientHeight,
      paneScroll: pane.scrollHeight,
      startTop: start ? Math.round(start.getBoundingClientRect().top) : null,
      startBottom: start ? Math.round(start.getBoundingClientRect().bottom) : null,
      fullTop: Math.round(full.getBoundingClientRect().top),
      hasFooter: !!panel.querySelector('.border-t.border-line-soft'),
      noteShown: !!document.querySelector('[data-testid="peek-note"]'),
      text: (pane.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    }
  })

  console.log(`\n--- ${width}x${height} ---`)
  console.log(JSON.stringify(res, null, 1))
  if (res.paneScroll) {
    const hidden = res.paneScroll - res.paneClient
    console.log(`overflow hidden below fold: ${hidden}px`)
    console.log(`"Start visit" fully visible: ${res.startBottom != null && res.startBottom <= res.paneBottom}`)
    console.log(`"Start visit" top offscreen-in-pane by: ${res.startTop - res.paneBottom}px`)
  }
  await ctx.close()
}
await browser.close()
