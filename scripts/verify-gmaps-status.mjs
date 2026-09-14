import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The console says which Google switches are on.
 *
 * The bug this gates is an absence, which is why it went unnoticed twice. Google
 * is four separate switches — Maps JavaScript, Places, Geocoding, a Map ID — and
 * this app degrades gracefully when any is off, because a rep in a driveway
 * should not meet an error dialog. The cost of that kindness is that a
 * deployment with Geocoding switched off looks exactly like one where every
 * tapped house happens to have no address, and the only complaint is a
 * `console.warn` on the phone of someone who cannot fix it.
 *
 * So there are two halves to check, and a sabotage of either has to be caught:
 *
 *   **It tells the truth.** With Places answering and the geocoder refusing —
 *   the real half-configured key, reproduced by the stub — the panel must say
 *   Places is fine and name the Geocoding API as the switch to turn on. A panel
 *   that says "all good" is worse than no panel.
 *
 *   **It does not spend money to say it.** A geocode is billed per request.
 *   Opening the tab must make zero of them; the button must make exactly one.
 *   That is asserted by counting calls in the stub, not by reading the screen.
 *
 * Runs against a build made with placeholder Google values, in its own
 * directory: with the vars unset Rollup strips the Google code as dead and there
 * is nothing left to test.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = Number(process.env.GMAPS_APP_PORT || 4177)
const BASE = `http://127.0.0.1:${APP_PORT}`

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

let preview = null
async function startPreview() {
  preview = spawn(resolve(root, 'node_modules/.bin/vite'),
    ['preview', '--outDir', 'dist-gmaps', '--port', String(APP_PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  preview.stdout.on('data', () => {})
  preview.stderr.on('data', () => {})
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('vite preview never answered')
}
const stopPreview = () => {
  if (!preview) return
  try { process.kill(-preview.pid, 'SIGTERM') } catch { preview.kill('SIGTERM') }
  preview = null
}

/*
  The stand-in for Google's script, in two flavours.

  `denied` is the deployment this panel exists for: Maps JavaScript loads,
  Places answers, and the geocoder throws REQUEST_DENIED because nobody ticked
  the third box. `working` is the same key with the box ticked. Geocode calls
  are counted on `window`, because the billable thing is the request, not the
  row it draws.
*/
const stub = (mode) => `
window.__geocodes = 0
window.google = { maps: { importLibrary: async (name) => {
  if (name === 'places') return { AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } }
  if (name === 'geocoding') return { Geocoder: class {
    async geocode() {
      window.__geocodes += 1
      ${mode === 'denied'
        ? `throw new Error('Geocoding Service: This API project is not authorized to use this API. REQUEST_DENIED')`
        : mode === 'denied-key'
        ? `throw new Error('Geocoding Service: This API key is not authorized to use this service or API. REQUEST_DENIED')`
        : `return { results: [{ formatted_address: '1600 Pennsylvania Ave NW', address_components: [], geometry: { location_type: 'ROOFTOP' } } ] }`}
    }
  } }
  return {}
} } }
window.__allstarGmapsReady && window.__allstarGmapsReady()
`

const browser = await chromium.launch({ executablePath: chromiumPath() })

/** Sign in as whoever, at whatever size, with Google stubbed the given way. */
async function open({ who, mode, width = 1280, height = 900 }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    isMobile: width < 500,
    hasTouch: width < 500,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**://maps.googleapis.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: stub(mode) }),
  )
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: new RegExp(who) }).click()
  await dismissTour(page)
  await page.waitForTimeout(1800)
  return { ctx, page, errors }
}

const geocodes = (page) => page.evaluate(() => window.__geocodes ?? 0)

async function toGeocodingTab(page) {
  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1400)
  await dismissTour(page)
  await page.getByRole('button', { name: /^Address lookup$/ }).click()
  await page.waitForTimeout(1500)
}

await startPreview()

try {
  /* --- the half-configured key: Places on, Geocoding off ------------------- */
  {
    const { ctx, page, errors } = await open({ who: 'Nadia Petrov', mode: 'denied' })
    await toGeocodingTab(page)

    const panel = page.getByTestId('google-status')
    ok((await panel.count()) === 1, 'the console has a Google status panel')
    const body = await panel.innerText()

    ok(/A browser key is compiled in/.test(body), 'it says whether a key was compiled into this build')
    ok(/Map ID/.test(body), 'and whether a Map ID was')
    ok(/Maps JavaScript accepts this key/.test(body), 'and whether Google accepted the key for this site')
    ok(/Places is enabled/.test(body), 'and whether Places answers')

    // The money assertion, and the reason the geocode row has a button.
    ok((await geocodes(page)) === 0, 'opening the tab bills nothing', `${await geocodes(page)} geocodes`)
    ok(
      /billed per request/.test(body),
      'and the panel says why the geocode check is not automatic',
    )

    await page.getByTestId('probe-geocoder').click()
    await page.waitForTimeout(1200)
    ok((await geocodes(page)) === 1, 'the button makes exactly one request', `${await geocodes(page)} geocodes`)

    const after = await panel.innerText()
    // The stub's refusal is the project-level one, and the panel must say so
    // rather than send an operator to the key page for a switch that is on
    // the API Library page.
    ok(
      /Geocoding API is not enabled on the Google Cloud project/.test(after),
      'a refused geocode names the switch to turn on, not just "failed"',
    )
    ok(
      /Google said: .*This API project is not authorized to use this API/.test(after),
      'and quotes Google’s own sentence underneath, for the case the reading is wrong',
    )
    ok(
      /separate switch from Maps JavaScript/.test(after),
      'and says it is a different switch from the one that is plainly working',
    )
    ok(
      /leaves the address blank, with no error shown to the rep/.test(after),
      'and says what a rep loses — the symptom nobody connected to the cause',
    )
    // Places answered in this stub, so the panel must not blame it.
    ok(
      /Address suggestions are available/.test(after),
      'while Places, which is working, is reported working',
    )
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* --- the other refusal: the project has it, the key does not -------------- */
  //
  // Same status word from Google, different page to fix it on. The panel has
  // to tell the two apart, because the operator who was told "enable it on the
  // project" while staring at an enabled project has nowhere left to look.
  {
    const { ctx, page, errors } = await open({ who: 'Nadia Petrov', mode: 'denied-key' })
    await toGeocodingTab(page)
    await page.getByTestId('probe-geocoder').click()
    await page.waitForTimeout(1200)
    const body = await page.getByTestId('google-status').innerText()
    ok(
      /this key’s API restrictions do not include the Geocoding API/.test(body),
      'a key-level refusal points at the key’s restriction list',
    )
    ok(!/not enabled on the Google Cloud project/.test(body), 'and not at the project, which has it')
    ok(
      /Google said: .*This API key is not authorized/.test(body),
      'and quotes Google underneath',
    )
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* --- the same key with the box ticked ------------------------------------ */
  {
    const { ctx, page, errors } = await open({ who: 'Nadia Petrov', mode: 'working' })
    await toGeocodingTab(page)
    await page.getByTestId('probe-geocoder').click()
    await page.waitForTimeout(1200)
    const body = await page.getByTestId('google-status').innerText()
    ok(
      /Tapping a house on the map fills in its address/.test(body),
      'a working geocoder is reported working',
    )
    ok(!/Geocoding API is not enabled|Google refused/.test(body), 'and is not accused of being switched off')
    ok((await page.getByTestId('google-said').count()) === 0, 'and nothing is quoted when there was no refusal')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* --- it is admin-only ----------------------------------------------------- */
  {
    const { ctx, page } = await open({ who: 'Dana Whitfield', mode: 'denied', width: 390, height: 844 })
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    ok(
      (await page.getByTestId('google-status').count()) === 0,
      'a rep typing the URL is shown no Google diagnostics',
    )
    ok(
      /Not available for your role/.test(await page.locator('body').innerText()),
      'and is told the console is not theirs, rather than shown an empty one',
    )
    await ctx.close()
  }
  {
    const { ctx, page } = await open({ who: 'Ray Okafor', mode: 'denied' })
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    ok(
      (await page.getByTestId('google-status').count()) === 0,
      'nor is a manager, who cannot reach Settings either',
    )
    await ctx.close()
  }

  /* --- and it survives a phone --------------------------------------------- */
  {
    const { ctx, page } = await open({ who: 'Nadia Petrov', mode: 'denied', width: 390, height: 844 })
    await toGeocodingTab(page)
    const panel = page.getByTestId('google-status')
    ok((await panel.count()) === 1, 'the panel is reachable at 390px')
    const box = await panel.boundingBox()
    ok(box && box.width <= 390, 'and does not push the console sideways', `${Math.round(box?.width ?? 0)}px`)
    const btn = await page.getByTestId('probe-geocoder').boundingBox()
    ok(btn && btn.height >= 44, 'with a thumb-sized check button', `${Math.round(btn?.height ?? 0)}px`)
    await ctx.close()
  }
} finally {
  await browser.close()
  stopPreview()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== Google status OK ===')
process.exit(fails.length ? 1 : 0)
