import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'

/**
 * In-app browser detection check.
 *
 * Reps are onboarded by a link in a message, which opens an embedded webview
 * where camera, mic and location are silently denied. Asserts the warning fires
 * for the webviews that matter and — just as important — stays out of the way
 * in a real browser.
 */
const b = await chromium.launch({ executablePath: chromiumPath() })
const cases = [
  ['Messenger (Android)', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/MESSENGER;FBAV/400.0.0.0;]', true],
  ['Facebook (iOS)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FBAN/FBIOS;FBAV/440.0', true],
  ['Generic Android WebView', 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36', true],
  ['Real Chrome (Android)', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', false],
  ['Real Safari (iOS)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', false],
]
let bad = 0
for (const [name, ua, expect] of cases) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(process.env.BASE_URL || 'http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const shown = await p.locator('[role="alert"]').count() > 0
  const txt = shown ? (await p.locator('[role="alert"]').first().innerText()).replace(/\n+/g, ' | ') : ''
  const pass = shown === expect
  if (!pass) bad++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} notice=${shown}  ${txt.slice(0, 90)}`)
  await ctx.close()
}
await b.close()
process.exit(bad ? 1 : 0)
