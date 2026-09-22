// Reproduce the Android boot sequence against the real exported DOM page.
//
// iOS: react-native-webview defines ReactNativeWebView.injectedObjectJson via a
//      WKUserScript at document start -> present before any page script.
// Android: react-native-webview defines it with evaluateJavascript(), which for
//      a page without injectedJavaScriptBeforeContentLoaded only happens on
//      about:blank (before navigation) and at onPageFinished (after the page's
//      own scripts). window.ReactNativeWebView itself exists from document
//      start (WebMessageListener) but carries only postMessage.
import { chromium } from 'playwright'
import { chromiumPath } from '../lib/browser.mjs'
import { readdirSync } from 'node:fs'

const dir = process.argv[2] ?? new URL('../../apps/mobile/dist/www.bundle', import.meta.url).pathname
const html = readdirSync(dir).find((f) => f.endsWith('.html'))
const url = `file://${dir}/${html}`
const browser = await chromium.launch({ executablePath: chromiumPath() })

async function boot(label, initScript) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript(initScript)
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(3000)
  const text = (await page.locator('#root').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  console.log(`\n=== ${label} ===`)
  console.log('root text length:', text.length, text ? `-> "${text.slice(0, 60)}"` : '(EMPTY - black screen)')
  console.log('errors:', errors.length ? errors.map((e) => '  ' + e.split('\n')[0]).join('\n') : '  none')
  await ctx.close()
}

const json = JSON.stringify({ EXPO_DOM_HOST_OS: 'android', initialProps: { names: ['apiFetch', 'onCanGoBack'], props: {} } })

// iOS sequence: object is complete at document start.
await boot('iOS-like: injectedObjectJson at document start', `
  window.ReactNativeWebView = { postMessage() {}, injectedObjectJson: () => ${JSON.stringify(json)} }
`)

// Android sequence: postMessage only at document start; injectedObjectJson arrives at page finish.
await boot('Android-like: injectedObjectJson only after load', `
  window.ReactNativeWebView = { postMessage() {} }
  window.addEventListener('load', () => {
    window.ReactNativeWebView.injectedObjectJson = () => ${JSON.stringify(json)}
  })
`)

await browser.close()
