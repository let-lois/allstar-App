import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Address suggestions on the phone, and what a pick does.
 *
 * A rep adding a lead types three letters and gets the door offered to them;
 * tapping it fills the address, carries the town and ZIP, and sets the pin on
 * that door — on the Add-lead screen, where there is no other source of a
 * location, and on the map's sheet, where the pin has to *move* from the
 * roughly-right tap to the exactly-right pick. That second half is the one
 * this app got wrong: the tapped point kept winning, so a lead could save a
 * house's address with the neighbour's coordinates.
 *
 * Runs against a build made with placeholder Google values, served from its
 * own directory: with the vars unset Rollup strips the Google code as dead and
 * there is nothing to test. Google itself is stood in for by a script that
 * defines the two Places calls the field makes and nothing else — so the map
 * fails over to the drawn one (the sheet under test does not care which map it
 * sits on), and the geocoder refuses, which is the exact half-configured
 * deployment this exists to keep working.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = Number(process.env.PLACES_APP_PORT || 4175)
const BASE = `http://127.0.0.1:${APP_PORT}`

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

let preview = null
async function startPreview() {
  preview = spawn(resolve(root, 'node_modules/.bin/vite'),
    ['preview', '--outDir', 'dist-places', '--port', String(APP_PORT), '--strictPort'],
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

/* The door Google would offer. Somewhere the demo's default view is not. */
const DOOR = {
  main: '742 Evergreen Terrace',
  secondary: 'Round Rock, TX, USA',
  lat: 30.5091,
  lng: -97.6812,
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
}

/*
  The stand-in for Google's script. Just the surface the address field touches:
  a session token, the suggestions call, and a place that resolves to typed
  components and a location. Every other library comes back empty, so the map
  and the geocoder fail the way they would on a key with only Places enabled.
  Requests are counted so the gate can see the debounce and the session token
  doing their job — the billable part.
*/
const STUB = `
window.__placesCalls = []
window.__placeFetches = 0
window.google = { maps: { importLibrary: async (name) => {
  if (name !== 'places') return {}
  return {
    AutocompleteSessionToken: class { constructor() { this.id = Math.random() } },
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions: async ({ input, sessionToken }) => {
        window.__placesCalls.push({ input, session: sessionToken && sessionToken.id })
        if (!/^742/i.test(input)) return { suggestions: [] }
        return { suggestions: [{ placePrediction: {
          mainText: ${JSON.stringify(DOOR.main)},
          secondaryText: ${JSON.stringify(DOOR.secondary)},
          text: ${JSON.stringify(DOOR.main + ', ' + DOOR.secondary)},
          toPlace: () => ({
            fetchFields: async () => { window.__placeFetches += 1 },
            addressComponents: [
              { longText: '742', shortText: '742', types: ['street_number'] },
              { longText: 'Evergreen Terrace', shortText: 'Evergreen Ter', types: ['route'] },
              { longText: ${JSON.stringify(DOOR.city)}, shortText: ${JSON.stringify(DOOR.city)}, types: ['locality'] },
              { longText: 'Texas', shortText: ${JSON.stringify(DOOR.state)}, types: ['administrative_area_level_1'] },
              { longText: ${JSON.stringify(DOOR.zip)}, shortText: ${JSON.stringify(DOOR.zip)}, types: ['postal_code'] },
            ],
            location: { lat: () => ${DOOR.lat}, lng: () => ${DOOR.lng} },
            formattedAddress: ${JSON.stringify(DOOR.main + ', ' + DOOR.city + ', ' + DOOR.state + ' ' + DOOR.zip + ', USA')},
          }),
        } }] }
      },
    },
  }
} } }
window.__allstarGmapsReady && window.__allstarGmapsReady()
`

const browser = await chromium.launch({ executablePath: chromiumPath() })

async function repPage() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    // No position: the Add-lead screen has to get its pin from the pick.
    permissions: [],
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**://maps.googleapis.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }),
  )
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1800)
  return { ctx, page, errors }
}

const readout = (page) => page.getByTestId('lead-pin-readout').innerText()
/** The saved lead, found by the address the pick wrote — read from the device, not the screen. */
const newest = (page) =>
  page.evaluate(
    (address1) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const all = req.result.transaction('properties').objectStore('properties').getAll()
          all.onsuccess = () => res(all.result.filter((p) => p.address1 === address1).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0])
          all.onerror = () => rej(all.error)
        }
      }),
    DOOR.main,
  )

try {
  await startPreview()

  /* ===== 1. the Add-lead screen: a pick is the address and the pin ======= */
  {
    const { ctx, page, errors } = await repPage()
    await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await dismissTour(page)

    const field = page.getByRole('combobox', { name: /Address/ })
    ok((await field.count()) === 1, 'the address field is a combobox — it offers suggestions')
    await field.fill('74')
    await page.waitForTimeout(700)
    ok((await page.getByRole('listbox').count()) === 0, 'two characters ask Google nothing')
    // The stub is not even loaded yet at two characters — nothing has asked for it.
    const before = await page.evaluate(() => (window.__placesCalls ?? []).length)
    ok(before === 0, 'and cost nothing', `${before} requests`)

    await field.fill('742 Ever')
    await page.waitForTimeout(900)
    const list = page.getByRole('listbox', { name: /Address suggestions/ })
    ok((await list.count()) === 1, 'three characters and a pause bring the list up')
    const option = list.getByRole('option').first()
    ok(/742 Evergreen Terrace/.test(await option.innerText()), 'with the door on it')
    const calls = await page.evaluate(() => window.__placesCalls)
    ok(calls.length === 1, 'one request for the whole word, not one per keystroke', `${calls.length}`)
    const box = await option.boundingBox()
    ok(box && box.height >= 44, 'and the row is a thumb target', `${Math.round(box?.height ?? 0)}px`)

    await option.getByRole('button').click()
    await page.waitForTimeout(700)
    ok((await field.inputValue()) === DOOR.main, 'tapping it writes the street address into the field')
    ok(new RegExp(`${DOOR.city} ${DOOR.state} ${DOOR.zip}`).test(await page.locator('body').innerText()), 'and shows the town and ZIP it carried')
    ok(new RegExp(`Pinned on the address — ${DOOR.lat.toFixed(5)}, ${DOOR.lng.toFixed(5)}`).test(await readout(page)),
      'and the pin is the door — with no GPS at all')
    ok((await page.evaluate(() => window.__placeFetches)) === 1, 'resolving the pick is one billable fetch')

    // The list's dismiss layer must be gone by now, or this click lands on it.
    // It was not: a pick changed the field's value, the debounce searched for
    // the picked text and the list came straight back up. Pinned here.
    ok((await page.locator('button.fixed').count()) === 0, 'after a pick the list stays closed and nothing sits over Save')
    await page.getByRole('button', { name: /Save lead/i }).click()
    await page.waitForTimeout(1500)
    const saved = await newest(page)
    ok(
      saved?.address1 === DOOR.main && saved.city === DOOR.city && saved.state === DOOR.state && saved.zip === DOOR.zip,
      'the saved lead carries the structured address',
      `${saved?.address1}, ${saved?.city} ${saved?.state} ${saved?.zip}`,
    )
    ok(saved?.lat === DOOR.lat && saved?.lng === DOOR.lng, 'at the picked coordinates')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }

  /* ===== 2. the map's sheet: a pick moves the pin ========================= */
  {
    const { ctx, page, errors } = await repPage()
    await page.locator('a[href="/map"]:visible').first().click()
    await page.waitForTimeout(2500)
    // The stub has no Map, so the drawn one is what renders — and it is enough.
    const map = page.getByRole('application', { name: /Map of your leads/ })
    await map.waitFor({ timeout: 20_000 })
    const mb = await map.boundingBox()
    await page.mouse.click(mb.x + mb.width * 0.5, mb.y + mb.height * 0.25)
    await page.waitForTimeout(1500)
    // The sheet opens on what the map found — here, with the geocoder refusing,
    // on "Address not found" — and the form is one tap further. See verify:mapadd.
    ok((await page.getByTestId('detected-property').count()) === 1, 'the tap opens on the house, not on a form')
    await page.getByTestId('detected-add-lead').click()
    await page.waitForTimeout(500)
    const tapped = (await readout(page)).match(/Pinned where you tapped — ([\d.-]+), ([\d.-]+)/)
    ok(!!tapped, 'tapping the map drops a pin and says where', tapped ? `${tapped[1]}, ${tapped[2]}` : await readout(page))

    const field = page.getByRole('combobox', { name: /Address/ })
    ok((await field.count()) === 1, 'the geocoder refused, so the sheet offers the address field with suggestions')
    await field.fill('742 Ever')
    await page.waitForTimeout(900)
    const option = page.getByRole('listbox', { name: /Address suggestions/ }).getByRole('option').first()
    ok((await option.count()) === 1, 'the suggestion comes up over the map')
    await option.getByRole('button').click()
    await page.waitForTimeout(1000)

    const after = await readout(page)
    ok(new RegExp(`Pinned on the address — ${DOOR.lat.toFixed(5)}, ${DOOR.lng.toFixed(5)}`).test(after),
      'the pin moves from the tap to the picked door', after.split('\n')[1])
    ok(!new RegExp(`${tapped?.[1]}, ${tapped?.[2]}`).test(after), 'and the tapped point is no longer the pin')

    await page.getByRole('button', { name: /^Save lead$/ }).click()
    await page.waitForTimeout(1500)
    const saved = await newest(page)
    ok(saved?.lat === DOOR.lat && saved?.lng === DOOR.lng, 'the saved lead sits on the door, not on the tap',
      `${saved?.lat}, ${saved?.lng}`)
    ok(saved?.address1 === DOOR.main && saved.zip === DOOR.zip, 'with the picked address')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }
} catch (err) {
  ok(false, `the walk did not finish: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close()
  stopPreview()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== address suggestions OK ===')
process.exit(fails.length ? 1 : 0)
