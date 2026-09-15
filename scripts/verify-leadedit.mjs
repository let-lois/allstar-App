import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Correcting a lead at the door.
 *
 * A lead is made in seconds from a map tap and any of its details can be wrong
 * or missing: the number painted on the house, the homeowner's name, a phone,
 * an email. This proves a rep can fix all of them from the lead's page, that
 * the page shows the correction at once, that it survives a reload, and that
 * exactly one mutation carrying the corrected fields is queued for the server.
 * Demo mode, so every write takes the local-first path.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const text = (page) => page.locator('body').innerText()

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(2000)

await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await dismissTour(page)
await page.getByTestId('lead-row').first().click()
await page.waitForTimeout(1000)
const propertyId = page.url().split('/property/')[1]?.split(/[?#]/)[0]
ok(!!propertyId, 'a lead opens', propertyId)

const card = page.getByTestId('lead-contact')
ok((await card.count()) === 1, 'the lead shows a contact card')
await page.getByTestId('lead-edit-open').click()
await page.waitForTimeout(500)
const sheet = page.getByTestId('lead-edit')
ok((await sheet.count()) === 1, 'Edit details opens a sheet')
const before = await sheet.getByLabel('Address', { exact: true }).inputValue()
ok(before.length > 0, 'prefilled with the address as it is', before)

const ADDR = `${before.replace(/^\d+/, '').trim() ? before.replace(/^(\d+)/, '$1B') : '44B Gate St'}`
await sheet.getByLabel('Address', { exact: true }).fill(ADDR)
await sheet.getByLabel('ZIP').fill('78665')
await sheet.getByLabel('Contact name').fill('Priya Natarajan')
await sheet.getByLabel('Phone').fill('512 555 0142')
await sheet.getByLabel('Email').fill('priya@example.com')
// Offline for the save, so the queued write can be read before the demo's
// pretend network drains it. A rep correcting a house number on a street with
// no signal is the ordinary case, not the edge.
await ctx.setOffline(true)
await page.getByTestId('lead-edit-save').click()
await page.waitForTimeout(900)

ok((await page.getByTestId('lead-edit').count()) === 0, 'Save closes the sheet')
const body = await text(page)
ok(body.includes(ADDR), 'the page shows the corrected address', ADDR)
const cardText = await card.innerText()
ok(/Priya Natarajan/.test(cardText) && /512 555 0142/.test(cardText) && /priya@example\.com/.test(cardText), 'and the contact with name, phone and email', cardText.replace(/\s+/g, ' '))
ok(/78665/.test(body), 'and the corrected ZIP')

/* --- exactly one write is queued, then it survives a reload ---------------- */
const stored = await page.evaluate(
  (id) =>
    new Promise((resolve) => {
      const req = indexedDB.open('allstar-field')
      req.onsuccess = () => {
        const tx = req.result.transaction(['properties', 'outbox'], 'readonly')
        const p = tx.objectStore('properties').get(id)
        const o = tx.objectStore('outbox').getAll()
        let prop = null
        p.onsuccess = () => { prop = p.result }
        o.onsuccess = () => resolve({ prop, updates: o.result.filter((m) => m.kind === 'property.update' && m.payload?.id === id).map((m) => m.payload) })
        o.onerror = () => resolve({ prop, updates: [] })
      }
      req.onerror = () => resolve(null)
    }),
  propertyId,
)
ok(stored?.prop?.address1 === ADDR && stored?.prop?.zip === '78665', 'the phone holds the corrected address', `${stored?.prop?.address1} ${stored?.prop?.zip}`)
ok(stored?.prop?.contacts?.filter((c) => c.isPrimary).length === 1, 'with one primary contact, not a duplicate')
ok(stored?.updates?.length === 1, 'exactly one update is queued for the server', `${stored?.updates?.length}`)
const u = stored?.updates?.[0]
ok(u?.address1 === ADDR && u?.zip === '78665', 'carrying the corrected address', JSON.stringify({ address1: u?.address1, zip: u?.zip }))
ok(u?.contacts?.[0]?.name === 'Priya Natarajan' && u?.contacts?.[0]?.phone === '512 555 0142' && u?.contacts?.[0]?.email === 'priya@example.com', 'and the contact, by id, with every field', JSON.stringify(u?.contacts))
ok(!('status' in (u ?? {})), 'and never a status — that follows from a visit')

await ctx.setOffline(false)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
ok((await text(page)).includes(ADDR) && /Priya Natarajan/.test(await page.getByTestId('lead-contact').innerText()), 'the correction survives a reload')

/* --- a cleared name removes the contact rather than keeping a nameless one -- */
await page.getByTestId('lead-edit-open').click()
await page.waitForTimeout(500)
await page.getByTestId('lead-edit').getByLabel('Contact name').fill('')
await page.getByTestId('lead-edit-save').click()
await page.waitForTimeout(900)
ok(/No contact yet/.test(await page.getByTestId('lead-contact').innerText()), 'clearing the name leaves the lead with no contact, said plainly')

/* --- an empty address is refused ------------------------------------------- */
await page.getByTestId('lead-edit-open').click()
await page.waitForTimeout(500)
await page.getByTestId('lead-edit').getByLabel('Address', { exact: true }).fill('   ')
ok(await page.getByTestId('lead-edit-save').isDisabled(), 'a blank address cannot be saved')

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== a lead can be corrected at the door ===')
process.exit(fails.length ? 1 : 0)
