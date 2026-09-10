import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

const browser = await chromium.launch({ executablePath: chromiumPath() })

for (const [width, height] of [[320, 568], [390, 844], [430, 932], [820, 1180]]) {
  const ctx = await browser.newContext({
    viewport: { width, height }, isMobile: width < 700, hasTouch: true,
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
  await page.getByRole('list', { name: 'Route stops' }).getByRole('button').first().click()
  await page.waitForTimeout(600)
  await page.locator('.scroll-pane').last().evaluate((e) => (e.scrollTop = 9999))
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^View full profile$/ }).click()
  await page.waitForTimeout(900)
  const url = page.url()
  const id = url.split('/property/')[1]?.split('?')[0]

  // Two notes: an older one carrying the safety tag, a newer routine one.
  for (const [body, tag] of [['Big dog in the side yard, gate code 4417', 'Dog'], ['Left a flyer, nobody home', null]]) {
    await page.goto(`http://127.0.0.1:4173/property/${id}?note=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await page.locator('textarea').first().fill(body)
    if (tag) await page.getByRole('button', { name: new RegExp(`^${tag}$`) }).first().click()
    await page.getByRole('button', { name: /^Save note$/ }).click()
    await page.waitForTimeout(900)
  }

  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1200)
  if (width < 768) {
    await page.getByRole('button', { name: /^list$/i }).click()
    await page.waitForTimeout(700)
  }
  await page.getByRole('list', { name: 'Route stops' }).getByRole('button').first().click()
  await page.waitForTimeout(800)

  const res = await page.evaluate(() => {
    const full = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'View full profile',
    )
    if (!full) return { err: 'no peek rendered' }
    const pane = full.closest('.scroll-pane')
    const start = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Start visit',
    )
    const pr = pane.getBoundingClientRect()
    const noteEl = document.querySelector('[data-testid="peek-note"]')
    return {
      paneClient: pane.clientHeight,
      paneScroll: pane.scrollHeight,
      hiddenBelowFold: pane.scrollHeight - pane.clientHeight,
      paneBottom: Math.round(pr.bottom),
      startTop: start ? Math.round(start.getBoundingClientRect().top) : null,
      startVisible: start ? Math.round(start.getBoundingClientRect().bottom) <= Math.round(pr.bottom) : null,
      noteShown: !!noteEl,
      noteText: noteEl ? noteEl.innerText.replace(/\s+/g, ' ') : null,
      peekText: (pane.innerText || '').replace(/\s+/g, ' '),
    }
  })
  console.log(`\n--- ${width}x${height} ---`)
  console.log(JSON.stringify(res, null, 1))
  await ctx.close()
}
await browser.close()
