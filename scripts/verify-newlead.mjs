import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
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
  executablePath: chromiumPath(),
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

  // Saved offline — the case this screen exists for — which also keeps the
  // queued write where it can be read before the demo's pretend network
  // drains it.
  await ctx.setOffline(true)
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
    What was queued for the server, not only what was stored on the phone.

    The create used to carry `{ id, created: true }` and nothing else, so the
    office received "Untitled property" at 0,0 — and the phone, on its next
    refresh, received it back. The outbox row is read directly: it is the
    exact body the server will get.
  */
  const queued = await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const req = indexedDB.open('allstar-field')
        req.onsuccess = () => {
          const all = req.result.transaction('outbox', 'readonly').objectStore('outbox').getAll()
          all.onsuccess = () =>
            resolve(all.result.find((m) => m.kind === 'property.status' && m.payload?.id === id)?.payload ?? null)
          all.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      }),
    row?.id,
  )
  ok(!!queued, 'the create is queued for the server')
  ok(queued?.address1 === '4512 Cedar Springs Rd', 'carrying the address the rep typed', queued?.address1)
  ok(Math.abs((queued?.lat ?? 0) - 32.7767) < 0.01 && typeof queued?.lng === 'number', 'and the pin', `${queued?.lat}, ${queued?.lng}`)
  ok(Array.isArray(queued?.contacts), 'and the contacts, so the office sees who lives there')
  await ctx.setOffline(false)

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

/* ========== save for later ============================================= */
//
// A form put aside is not a lead: nothing in `properties`, nothing queued,
// and everything typed back in the boxes when the screen is opened again —
// after leaving it, and after the app has been killed, which a full reload
// with IndexedDB as the only memory stands in for.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 32.7767, longitude: -96.797 },
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  await page.route('**://places.googleapis.com/**', (r) => r.abort())
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await signIn(page)
  const before = await newestProperty(page)
  await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const later = page.getByTestId('lead-save-later')
  ok((await later.count()) === 1 && !(await later.isEnabled()), 'Save for later is offered, and dead while the form is empty')
  await page.getByLabel(/Address/i).fill('77 Draft Lane')
  await page.locator('input[autocomplete="name"]').fill('Pat Draft')
  await page.waitForTimeout(300)
  ok(await later.isEnabled(), 'and live once something is typed')
  await later.click()
  await page.waitForTimeout(900)
  ok(!/\/lead\/new$/.test(page.url()), 'putting it aside leaves the screen', page.url())
  const after = await newestProperty(page)
  ok((after?.id ?? null) === (before?.id ?? null), 'and no lead was written — a draft is not a house')
  await page.goto(`${BASE}/lead/new`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  ok((await page.getByTestId('lead-draft-restored').count()) === 1, 'coming back restores the draft and says so')
  ok(
    (await page.getByLabel(/Address/i).inputValue()) === '77 Draft Lane' &&
      (await page.locator('input[autocomplete="name"]').inputValue()) === 'Pat Draft',
    'with the address and name as typed',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  ok((await page.getByLabel(/Address/i).inputValue()) === '77 Draft Lane', 'and it survives the app being killed and reopened')
  await page.getByTestId('lead-draft-discard').click()
  await page.waitForTimeout(500)
  ok(
    (await page.getByLabel(/Address/i).inputValue()) === '' && (await page.getByTestId('lead-draft-restored').count()) === 0,
    'Discard empties the form and forgets the draft',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  ok((await page.getByTestId('lead-draft-restored').count()) === 0 && (await page.getByLabel(/Address/i).inputValue()) === '', 'for good')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== add lead OK ===')
process.exit(fails.length ? 1 : 0)
