import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * "I set appointments but don't see them."
 *
 * Appointments were saved and then had nowhere to appear: Today listed only
 * the day's own, the lead never listed any, the office saw four, and one set
 * at the door became a to-do rather than an appointment at all. This walks
 * both ways of setting one and checks every place a person then looks.
 *
 * Run against a production preview build (`npm run build && npm run preview`).
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

/** Rows in an IndexedDB store, read whole. */
const rows = (store, on = page) =>
  on.evaluate(
    (name) =>
      new Promise((resolve) => {
        const req = indexedDB.open('allstar-field')
        req.onsuccess = () => {
          const tx = req.result.transaction([name], 'readonly')
          const all = tx.objectStore(name).getAll()
          tx.oncomplete = () => resolve(all.result)
          tx.onerror = () => resolve([])
        }
        req.onerror = () => resolve([])
      }),
    store,
  )

/* --- a rep, and a lead ------------------------------------------------------ */
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
const before = (await rows('appointments')).filter((a) => a.propertyId === propertyId).length

/* --- scheduled for three days out, from the schedule screen ----------------- */
await page.goto(`${BASE}/schedule/new?property=${propertyId}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const inThreeDays = new Date()
inThreeDays.setDate(inThreeDays.getDate() + 3)
inThreeDays.setHours(14, 0, 0, 0)
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const when = page.locator('input[type="datetime-local"]').first()
ok((await when.count()) === 1, 'the schedule screen offers a date and time')
await when.fill(local(inThreeDays))
await page.getByRole('button', { name: /^Save|^Book|^Schedule|^Set/ }).first().click().catch(async () => {
  // The primary action is the only full-width large button on the screen.
  await page.locator('button.w-full').last().click()
})
await page.waitForTimeout(1200)
ok(page.url().includes(`/property/${propertyId}`), 'saving lands on the lead', page.url())
const after = (await rows('appointments')).filter((a) => a.propertyId === propertyId)
ok(after.length === before + 1, 'one appointment is stored on the phone', `${before} → ${after.length}`)
const scheduled = after.find((a) => Math.abs(a.startsAt - inThreeDays.getTime()) < 60_000)
ok(!!scheduled, 'at the time that was chosen')

/* --- and the lead shows it --------------------------------------------------- */
const leadList = page.getByTestId('lead-appointments')
ok((await leadList.count()) === 1, 'the lead now has an Appointments section')
ok(/Estimate appointment/.test(await leadList.innerText()), 'listing the one just made', (await leadList.innerText()).replace(/\s+/g, ' ').slice(0, 80))

/* --- and Today shows it before the day ---------------------------------------- */
await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await dismissTour(page)
const upcoming = page.getByTestId('upcoming-appointments')
ok((await upcoming.count()) === 1, 'Today has an Upcoming section — it used to show an appointment only on the day itself')
ok(/Estimate appointment/.test(await upcoming.innerText()), 'with the appointment three days out in it')

/* --- set at the door: an appointment, not a to-do ----------------------------- */
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await dismissTour(page)
await page.getByTestId('lead-row').nth(1).click()
await page.waitForTimeout(900)
const doorId = page.url().split('/property/')[1]?.split(/[?#]/)[0]
const doorBefore = (await rows('appointments')).filter((a) => a.propertyId === doorId).length
await page.getByRole('button', { name: /^Start visit$/ }).first().click()
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /^Appointment$/ }).first().click()
await page.waitForTimeout(700)
const cont = page.getByRole('button', { name: /^Continue$/ })
if (await cont.count()) {
  await cont.click()
  await page.waitForTimeout(500)
}
const nextAppt = page.getByRole('button', { name: /^Appointment$/, pressed: true })
ok((await nextAppt.count()) === 1, 'the next-action step pre-selects Appointment with a time')
// Offline for the save, so the queued booking can be read before the demo's
// pretend network drains it — as verify-leadedit does.
await ctx.setOffline(true)
await page.getByRole('button', { name: /Complete visit/ }).click()
await page.waitForTimeout(1200)
const doorAfter = (await rows('appointments')).filter((a) => a.propertyId === doorId)
ok(doorAfter.length === doorBefore + 1, 'completing the visit books an appointment — the same kind the schedule screen makes', `${doorBefore} → ${doorAfter.length}`)
const tasks = (await rows('tasks')).filter((t) => t.propertyId === doorId && /^Appointment —/.test(t.title))
ok(tasks.length === 0, 'and not a to-do called "Appointment —" as well')
const outbox = await rows('outbox')
ok(outbox.some((m) => m.kind === 'appointment.create' && m.payload?.propertyId === doorId), 'the booking is queued for the server, so the office and the CRM calendar get it too')
await ctx.setOffline(false)

/* --- the office sees past four ------------------------------------------------- */
// A second phone rather than signing Dana out: the office check is about how
// many the Overview lists, not about the sign-out sheet.
const office = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
// The demo seeds each rep's appointments this afternoon. Run at nine in the
// morning, so they are all still ahead whatever the hour the gate is run at;
// otherwise a late run finds none and the Show all branch is never walked.
const nineAm = new Date()
nineAm.setHours(9, 0, 0, 0)
await office.clock.install({ time: nineAm })
const desk = await office.newPage()
desk.on('pageerror', (e) => errors.push(e.message))
await desk.route(/maps\.googleapis\.com/, (r) => r.abort())
await desk.goto(BASE, { waitUntil: 'domcontentloaded' })
await desk.waitForTimeout(1200)
await desk.getByRole('button', { name: /Try the demo/ }).click()
await desk.getByRole('button', { name: /Ray Okafor/ }).click()
await dismissTour(desk)
await desk.waitForTimeout(2000)
const list = desk.getByTestId('overview-upcoming')
const toggle = desk.getByTestId('overview-upcoming-toggle')
const deskNow = await desk.evaluate(() => Date.now())
const total = (await rows('appointments', desk)).filter((a) => a.startsAt >= deskNow).length
if (total > 4) {
  ok((await toggle.count()) === 1 && (await list.locator('li').count()) === 4, `the office sees four of ${total} and a way to the rest`)
  await toggle.click()
  await desk.waitForTimeout(300)
  ok((await list.locator('li').count()) === total, 'Show all shows all of them', `${await list.locator('li').count()}`)
} else {
  ok((await toggle.count()) === 0, `with ${total} ahead there is nothing to expand`)
}

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== an appointment set anywhere is seen everywhere ===')
process.exit(fails.length ? 1 : 0)
