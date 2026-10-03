import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Note dictation inside the phone app.
 *
 * Reported from an iPhone: the mic asked for permission, the note said
 * "Listening — speak now", and nothing was ever typed. iOS lets a page inside
 * an app start `webkitSpeechRecognition` and never returns its results. So:
 *
 *   - An app build with the native recogniser: the web app starts the phone's
 *     recogniser through the shell bridge, and the words it posts back land in
 *     the note — interim words shown as they come, settled ones kept, a session
 *     the phone ends on its own restarted, Stop stopping it.
 *   - An app build without it: no fake "Listening". The mic opens the keyboard
 *     on the note and says where the keyboard's own mic is.
 *   - A plain browser keeps the Web Speech API it always used.
 *
 * The shell is stood in for by an init script that sets the same globals the
 * real one does (`window.__allstarShell.dictation`, and `window.cordova` for
 * "running inside an app"), and posts `allstar-dictation` events the way the
 * DOM component's `dictationEvent` handle does.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}
const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []

async function demo(init) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  if (init) await ctx.addInitScript(init)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  const id = await page.evaluate(
    () =>
      new Promise((res) => {
        const q = indexedDB.open('allstar-field')
        q.onsuccess = () => {
          const r = q.result.transaction('properties').objectStore('properties').getAll()
          r.onsuccess = () => res(r.result[0]?.id)
        }
      }),
  )
  await page.goto(`${BASE}/property/${id}?note=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1300)
  await dismissTour(page)
  return { ctx, page }
}
const note = (page) => page.locator('[role="dialog"] textarea').first()
const mic = (page) => page.getByRole('button', { name: /Dictate note|Stop dictation/ })
const post = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('allstar-dictation', { detail: d })), detail)

try {
  /* ===== the app, with the phone's recogniser ============================ */
  {
    const { ctx, page } = await demo(() => {
      window.cordova = {}
      window.__dict = { starts: [], stops: 0 }
      window.__allstarShell = {
        dictation: {
          start: async (o) => {
            window.__dict.starts.push(o)
            return { ok: true }
          },
          stop: async () => {
            window.__dict.stops += 1
          },
        },
      }
    })
    ok((await mic(page).count()) === 1, 'the note has a mic')
    await mic(page).click()
    await page.waitForTimeout(200)
    let d = await page.evaluate(() => window.__dict)
    ok(d.starts.length === 1 && typeof d.starts[0].lang === 'string', 'tapping it starts the phone’s recogniser, with the language', JSON.stringify(d.starts))
    ok(/Listening/.test(await page.locator('[role="dialog"]').innerText()), 'and says it is listening')

    await post(page, { type: 'result', transcript: 'Homeowner wants', isFinal: false })
    await page.waitForTimeout(150)
    ok((await note(page).inputValue()) === 'Homeowner wants', 'words appear in the note as they are spoken', await note(page).inputValue())
    await post(page, { type: 'result', transcript: 'Homeowner wants fiber by Friday', isFinal: true })
    await page.waitForTimeout(150)
    ok((await note(page).inputValue()) === 'Homeowner wants fiber by Friday', 'and settle when the phone finalises them', await note(page).inputValue())

    // The phone ends the session after a pause; dictation carries on.
    await post(page, { type: 'end' })
    await page.waitForTimeout(500)
    d = await page.evaluate(() => window.__dict)
    ok(d.starts.length === 2, 'a session the phone ends on its own is restarted while the rep is still dictating', d.starts.length)
    await post(page, { type: 'result', transcript: 'call after five', isFinal: false })
    await page.waitForTimeout(150)
    ok((await note(page).inputValue()) === 'Homeowner wants fiber by Friday call after five', 'the next words follow the first', await note(page).inputValue())

    // A silence is not an error.
    await post(page, { type: 'error', error: 'no-speech' })
    await page.waitForTimeout(150)
    ok((await mic(page).getAttribute('aria-pressed')) === 'true', 'a pause with no speech does not stop dictation')

    await mic(page).click()
    await page.waitForTimeout(250)
    d = await page.evaluate(() => window.__dict)
    ok(d.stops >= 1 && (await mic(page).getAttribute('aria-pressed')) === 'false', 'Stop stops the phone’s recogniser')
    ok((await note(page).inputValue()) === 'Homeowner wants fiber by Friday call after five', 'and keeps the words not yet finalised', await note(page).inputValue())
    await post(page, { type: 'result', transcript: 'stray', isFinal: true })
    await page.waitForTimeout(150)
    ok(!/stray/.test(await note(page).inputValue()), 'nothing arriving after Stop is typed')

    // Permission refused on the phone: said in words, with where to fix it.
    await page.evaluate(() => {
      window.__allstarShell.dictation.start = async () => ({ ok: false, error: 'not-allowed' })
    })
    await mic(page).click()
    await page.waitForTimeout(300)
    const said = await page.locator('[role="dialog"]').innerText()
    ok(/iPhone Settings/.test(said) && (await mic(page).getAttribute('aria-pressed')) === 'false', 'a refused permission says where to turn it on', said.match(/Microphone[^.]*\./)?.[0])
    await ctx.close()
  }

  /* ===== the app, without the recogniser (an older build) ================ */
  {
    const { ctx, page } = await demo(() => {
      window.cordova = {}
      // What the webview offers: a recogniser that starts and never answers.
      window.__webStarts = 0
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() {
          window.__webStarts += 1
          this.onstart?.()
        }
        stop() {}
      }
    })
    ok((await mic(page).count()) === 1, 'an older app build still shows the mic')
    await mic(page).click()
    await page.waitForTimeout(300)
    ok((await page.evaluate(() => window.__webStarts)) === 0, 'but does not start the webview recogniser that never answers')
    ok(!/Listening/.test(await page.locator('[role="dialog"]').innerText()), 'and never claims to be listening')
    ok((await page.getByTestId('dictation-keyboard-hint').count()) === 1, 'it points to the keyboard’s own mic instead')
    ok(await note(page).evaluate((el) => el === document.activeElement), 'with the note focused, so the keyboard is already up')
    await ctx.close()
  }

  /* ===== a browser keeps the Web Speech API ============================== */
  {
    const { ctx, page } = await demo(() => {
      window.__webStarts = 0
      // Both names: current Chromium ships the unprefixed one, which the app prefers.
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() {
          window.__webStarts += 1
        }
        stop() {}
      }
    })
    await mic(page).click()
    await page.waitForTimeout(300)
    ok((await page.evaluate(() => window.__webStarts)) === 1 && /Listening/.test(await page.locator('[role="dialog"]').innerText()), 'in a browser the mic uses the browser’s speech recognition, as before')
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
console.log('\n=== dictation types what is said, in the app and in a browser ===')
