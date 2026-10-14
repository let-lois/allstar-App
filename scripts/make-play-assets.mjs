import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The Google Play graphics, made from the app itself.
 *
 *   npm run build && npx vite preview --port 4173 &   # the app, as shipped
 *   node scripts/make-play-assets.mjs [outDir]          # default docs/google-play/assets
 *
 * Everything on a screenshot is the real field app running its built-in demo
 * company (the same sample data a reviewer can open) — no mock-ups, no invented
 * numbers. Google Maps is blocked so the map draws the app's own street grid,
 * exactly as it does before a map key is configured; no third-party imagery is
 * redistributed in a store listing.
 *
 * What Play asks for, and what this makes:
 *
 *   icon-512.png              512 × 512, from the app icon (apps/mobile/assets/images/icon.png)
 *   feature-graphic.png       1024 × 500, no transparency
 *   phone/NN-*.png            1080 × 1920 (9:16) — Play allows at most 2:1
 *   tablet-7in/NN-*.png       1200 × 1920 — optional; the app supports tablets
 *   tablet-10in/NN-*.png      1600 × 2560 — optional; the app supports tablets
 *
 * Every side is between 320 and 3840 px, as Play requires.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const OUT = resolve(process.argv[2] || resolve(root, 'docs/google-play/assets'))

const DEVICES = [
  { dir: 'phone', width: 360, height: 640, scale: 3 },
  { dir: 'tablet-7in', width: 600, height: 960, scale: 2 },
  { dir: 'tablet-10in', width: 800, height: 1280, scale: 2 },
]

// One message per screenshot, in the order a field rep's day runs.
const SCREENS = [
  ['01-today', 'Today: the route, appointments and follow-ups'],
  ['02-map', 'Map of the leads, nearest door first'],
  ['03-leads', 'Leads, searchable and filtered'],
  ['04-lead', 'A lead: contact, history, plan'],
  ['05-visit-outcome', 'Record what happened at the door'],
  ['06-visit-sold-plan', 'Sold: pick the plan that was sold'],
  ['07-pipeline', 'Pipeline'],
  ['08-standings', 'Team standings'],
]

const go = (page, to) =>
  page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, to)

const browser = await chromium.launch({ executablePath: chromiumPath() })
const made = []
try {
  for (const d of DEVICES) {
    const dir = resolve(OUT, d.dir)
    mkdirSync(dir, { recursive: true })
    const ctx = await browser.newContext({
      viewport: { width: d.width, height: d.height },
      deviceScaleFactor: d.scale,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'block',
      colorScheme: 'light',
    })
    const page = await ctx.newPage()
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    const shot = async (name) => {
      await page.waitForTimeout(900)
      const path = resolve(dir, `${name}.png`)
      await page.screenshot({ path })
      made.push(path)
    }

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Try the demo/ }).click()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await dismissTour(page)
    await shot(SCREENS[0][0])
    await go(page, '/map')
    await dismissTour(page, 800)
    await shot(SCREENS[1][0])
    await go(page, '/leads')
    await dismissTour(page, 800)
    await shot(SCREENS[2][0])

    const lead = await page.evaluate(
      () =>
        new Promise((res) => {
          const q = indexedDB.open('allstar-field')
          q.onsuccess = () => {
            const r = q.result.transaction('properties').objectStore('properties').getAll()
            r.onsuccess = () => {
              const open = r.result.filter((p) => !['won', 'dnc', 'lost'].includes(p.status))
              res(open.find((p) => p.ownerName) ?? open[0])
            }
          }
        }),
    )
    await go(page, `/property/${lead.id}`)
    await dismissTour(page, 800)
    await shot(SCREENS[3][0])
    await page.getByRole('button', { name: /Start visit/ }).first().click()
    await page.waitForURL(/\/visit\//, { timeout: 8000 })
    await shot(SCREENS[4][0])
    await page.getByRole('button', { name: /^Sold/ }).first().click()
    await shot(SCREENS[5][0])
    // Leave the visit unrecorded: the pipeline and standings show the demo
    // company as it ships, not a sale this script made up.
    await go(page, '/pipeline')
    await dismissTour(page, 800)
    await shot(SCREENS[6][0])
    await go(page, '/standings')
    await dismissTour(page, 800)
    await shot(SCREENS[7][0])
    await ctx.close()
  }

  /* --- the 512 icon, from the app icon itself ---------------------------- */
  const iconB64 = readFileSync(resolve(root, 'apps/mobile/assets/images/icon.png')).toString('base64')
  {
    const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.setContent(
      `<html><body style="margin:0"><img src="data:image/png;base64,${iconB64}" width="512" height="512" style="display:block"></body></html>`,
    )
    const path = resolve(OUT, 'icon-512.png')
    await page.screenshot({ path })
    made.push(path)
    await ctx.close()
  }

  /* --- the feature graphic ------------------------------------------------- */
  // The brand as the app shows it: the dark navy of the app's dark theme, the
  // white-and-teal lockup it uses on dark backgrounds, and one real screen.
  const logoB64 = readFileSync(resolve(root, 'public/logo-light.png')).toString('base64')
  const todayB64 = readFileSync(resolve(OUT, 'phone/01-today.png')).toString('base64')
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box }
      body { margin: 0; width: 1024px; height: 500px; overflow: hidden;
             background: radial-gradient(120% 140% at 0% 0%, #13324a 0%, #0d1320 55%, #0a0f1a 100%);
             font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #fff }
      .copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center }
      .logo { width: 300px; height: auto; display: block; margin-bottom: 34px }
      h1 { margin: 0; font-size: 46px; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em }
      p { margin: 18px 0 0; font-size: 21px; line-height: 1.45; color: #a9b8cc; max-width: 470px }
      .phone { position: absolute; right: 70px; top: 58px; width: 260px; height: 447px; border-radius: 34px;
               background: #05080f; padding: 10px; box-shadow: 0 30px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(127,224,239,.25) }
      .phone img { width: 240px; height: 427px; object-fit: contain; border-radius: 25px; display: block }
      .glow { position: absolute; right: 40px; top: 40px; width: 360px; height: 360px; border-radius: 50%;
              background: radial-gradient(circle, rgba(15,169,184,.35), rgba(15,169,184,0) 70%) }
    </style></head><body>
      <div class="glow"></div>
      <div class="copy">
        <img class="logo" src="data:image/png;base64,${logoB64}" alt="">
        <h1>Door-to-door sales, organized.</h1>
        <p>Routes, leads, visits and sales for your field team — even with no signal.</p>
      </div>
      <div class="phone"><img src="data:image/png;base64,${todayB64}" alt=""></div>
    </body></html>`)
    await page.waitForTimeout(300)
    const path = resolve(OUT, 'feature-graphic.png')
    await page.screenshot({ path })
    made.push(path)
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(`${made.length} files in ${OUT}`)
for (const [name, caption] of SCREENS) console.log(`  ${name}  ${caption}`)
