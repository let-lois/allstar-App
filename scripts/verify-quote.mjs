import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * "Send quote" data was not visible.
 *
 * Picking Send quote at the door made a to-do on Today and nothing else: the
 * lead did not say a quote was owed, and ticking the to-do off left no trace
 * that one went out. This walks the door, the lead, Today and the list.
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

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

/** Rows in an IndexedDB store, read whole. */
const rows = (store) =>
  page.evaluate(
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

/* --- a rep, at a door ------------------------------------------------------- */
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
ok((await page.getByTestId('lead-todo').count()) === 0, 'with nothing owed on it yet')

await page.getByRole('button', { name: /^Start visit$/ }).first().click()
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /^Quote$/ }).first().click()
await page.waitForTimeout(700)
const cont = page.getByRole('button', { name: /^Continue$/ })
if (await cont.count()) {
  await cont.click()
  await page.waitForTimeout(500)
}
ok((await page.getByRole('button', { name: /^Send quote$/, pressed: true }).count()) === 1, 'a Quote outcome pre-selects Send quote as what is next')
await page.getByRole('button', { name: /Complete visit/ }).click()
await page.waitForTimeout(1500)
const tasks = (await rows('tasks')).filter((t) => t.propertyId === propertyId && t.kind === 'quote' && !t.done)
ok(tasks.length === 1, 'completing the visit leaves one Send quote to-do', tasks[0]?.title)
const task = tasks[0]

/* --- the lead says a quote is owed ----------------------------------------- */
await page.goto(`${BASE}/property/${propertyId}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const todo = page.getByTestId('lead-todo')
ok((await todo.count()) === 1, 'the lead now has a To do section — it used to live only on Today')
ok(/Send quote/.test(await todo.innerText()), 'saying a quote is to be sent', (await todo.innerText()).replace(/\s+/g, ' ').slice(0, 60))
ok((await page.getByTestId('lead-quote-sent').count()) === 0, 'and no Quote sent yet — owed is not sent')

/* --- ticked off on Today: the record that it went out ------------------------ */
await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await dismissTour(page)
const tick = page.getByRole('button', { name: new RegExp(`^Mark ${task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} complete$`) })
ok((await tick.count()) === 1, 'Today lists the to-do with a box to tick')
// Offline for the tick, so the queued write can be read before the demo's
// pretend network drains it — as verify-leadedit does.
await ctx.setOffline(true)
await tick.click()
await page.waitForTimeout(900)
const sent = (await rows('activity')).filter((a) => a.type === 'quote' && a.propertyId === propertyId)
ok(sent.length === 1 && sent[0].summary === 'Quote sent' && sent[0].id === `quote:${task.id}`, 'ticking it writes one Quote sent line in the lead’s history', JSON.stringify(sent[0]))
const outbox = await rows('outbox')
const queued = outbox.find((m) => m.kind === 'task.complete' && m.payload?.id === task.id)
ok(!!queued && queued.payload.done === true && typeof queued.payload.at === 'number', 'and queues the tick for the server, with the time it happened', JSON.stringify(queued?.payload))
// Today drops a to-do from its list once it is ticked, so there is no box on
// the phone to untick it; the store's untick path and the server's are pinned
// by smoke:quote-sent instead. What is pinned here is that the tick sticks.
ok((await page.getByRole('button', { name: new RegExp(`^Mark ${task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} complete$`) }).count()) === 0, 'and the ticked to-do leaves Today')
await ctx.setOffline(false)

/* --- and everywhere a person then looks -------------------------------------- */
await page.goto(`${BASE}/property/${propertyId}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
ok((await page.getByTestId('lead-todo').count()) === 0, 'the lead no longer says a quote is owed')
const activity = page.getByRole('button', { name: /^Activity/ })
if (await activity.count()) await activity.first().click().catch(() => {})
await page.waitForTimeout(400)
const sheet = await page.getByTestId('lead-sections').innerText()
ok(/Quote sent/.test(sheet), 'its history says Quote sent')
await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await dismissTour(page)
const row = page.getByTestId('lead-row').filter({ has: page.getByTestId('lead-quote-sent') })
const card = row.first().getByTestId('lead-quote-sent')
ok((await row.count()) === 1 && /Quote sent/.test(await card.innerText()), 'and that lead’s card in the list carries it — no other row does', (await card.innerText().catch(() => '')))
ok(new RegExp(task.title.replace(/^Send quote — /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(await row.first().innerText()), 'the row with the stamp is the door that was quoted')

/* --- the phone fits it --------------------------------------------------------- */
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
ok(overflow <= 0, 'the list still fits a 390px phone with the new line', `overflow ${overflow}px`)

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== a quote that went out is seen everywhere ===')
process.exit(fails.length ? 1 : 0)
