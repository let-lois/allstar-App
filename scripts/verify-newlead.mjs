import { chromium } from 'playwright'
import { dismissTour } from './lib/tour.mjs'

/**
 * Adding a lead from the field.
 *
 * Two claims under test, and neither of them is "the suggestions work" — that
 * needs a real Places key on an allowed origin, and a key that works in CI is a
 * key committed somewhere.
 *
 * **It degrades to typing.** Suggestions are an enhancement on a screen a rep
 * uses outdoors. With no key, no signal, or a rejected key, the address field
 * has to behave exactly as it did before autocomplete existed: type it, save it,
 * no scolding. This is the assertion that stops a billed convenience from
 * becoming a dependency.
 *
 * **It no longer invents an address.** The screen used to write `Round Rock, TX
 * 78664` onto every lead added from the field, whatever town the rep was in.
 * That was invisible in a one-territory demo and wrong for a real second client,
 * so the saved record is inspected directly rather than trusting the form.
 *
 * The stored row is read out of IndexedDB, because the offline write is the thing
 * that matters: nothing here waits on a network, so what landed on the device is
 * the whole truth.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

/** The newest property on the device, as the app actually stored it. */
const newestProperty = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => reject(new Error('no db'))
        req.onsuccess = () => {
          const tx = req.result.transaction('properties', 'readonly')
          const all = tx.objectStore('properties').getAll()
          all.onsuccess = () => {
            const rows = all.result.filter((p) => p.id.startsWith('p_'))
            resolve(rows[rows.length - 1] ?? null)
          }
          all.onerror = () => reject(new Error('read failed'))
        }
      }),
  )

async function signIn(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1800)
}

/* --- typed address, GPS available ---------------------------------------- */
//
// The path a rep takes when Places is unavailable, which on this screen is any
// time they are somewhere with no signal.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 32.7767, longitude: -96.797 }, // Dallas, not Round Rock.
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  // Places can never answer, which is the condition being tested.
  await page.route('**://places.googleapis.com/**', (r) => r.abort())
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await signIn(page)

  await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // By label, not by role: the input carries role="combobox" now, which is the
  // correct ARIA for a field with a suggestion popup and means it is no longer a
  // "textbox" to assistive tech.
  const addr = page.getByLabel(/Address/i)
  ok(await addr.isVisible(), 'the address field is present with Places unreachable')

  await addr.fill('4512 Cedar Springs Rd')
  await page.waitForTimeout(900) // Past the debounce, so a request would have fired.

  ok(
    (await page.getByRole('listbox', { name: /Address suggestions/i }).count()) === 0,
    'no suggestion list appears when Places cannot answer',
  )
  ok(
    (await addr.inputValue()) === '4512 Cedar Springs Rd',
    'and what the rep typed is still there, untouched',
  )

  const save = page.getByRole('button', { name: /Save lead/i })
  await save.waitFor({ timeout: 15_000 })
  ok(await save.isEnabled(), 'saving is allowed on a typed address with a GPS pin')

  await save.click()
  await page.waitForTimeout(2000)

  const row = await newestProperty(page)
  ok(!!row, 'the lead is written to the device')
  ok(row?.address1 === '4512 Cedar Springs Rd', `the address is stored as typed (${row?.address1})`)
  ok(
    row?.city !== 'Round Rock' && row?.state !== 'TX' && row?.zip !== '78664',
    `no invented town is stored (city="${row?.city}" state="${row?.state}" zip="${row?.zip}")`,
  )
  ok(row?.city === '' && row?.zip === '', 'unknown parts are blank, which the office can see and fix')
  ok(
    Math.abs((row?.lat ?? 0) - 32.7767) < 0.01,
    `the pin is the rep's real position, not a hardcoded one (${row?.lat})`,
  )

  /*
    Storing blank is right, but three screens interpolated
    `{city}, {state} {zip}` directly, so an unknown town rendered as a bare
    comma — an honest value that read as a bug. The lead was saved above, which
    navigates to its detail screen, so this is the screen a rep actually lands on
    after adding a door.
  */
  await page.waitForTimeout(1200)
  const detail = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(
    !/^\s*,|·\s*,|,\s*·|,\s*$/m.test(detail) && !detail.includes(' ,'),
    'a lead with no known town renders no orphaned punctuation',
  )
  ok(
    detail.includes('4512 Cedar Springs Rd'),
    'and the address it does know is shown',
  )
  await ctx.close()
}

/* --- no GPS, and no suggestions ------------------------------------------ */
//
// The trap this screen used to contain: a rep whose browser had blocked location
// found Save dead with nothing saying why, and no way to proceed.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Location denied, exactly as Chrome does after a few dismissals.
    permissions: [],
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  await page.route('**://places.googleapis.com/**', (r) => r.abort())
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await signIn(page)
  await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(1500)

  const addr = page.getByLabel(/Address/i)
  if (await addr.count()) {
    await addr.fill('900 Congress Ave')
    await page.waitForTimeout(1200)

    const body = await page.locator('body').innerText()
    ok(
      /Pick the address from the suggestions|turn on\s+location/i.test(body),
      'a rep with no pin is told what to do about it, not just refused',
    )
    ok(
      !(await page.getByRole('button', { name: /Save lead/i }).isEnabled()),
      'and saving is still withheld rather than storing a lead with no pin',
    )
  } else {
    ok(false, 'could not reach the add-lead screen')
  }
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== add lead OK ===')
process.exit(fails.length ? 1 : 0)
