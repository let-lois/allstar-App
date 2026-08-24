import { chromium } from 'playwright'
import { dismissTour } from './lib/tour.mjs'

/**
 * Offline-first verification.
 *
 * Proves the claim the whole architecture rests on: a rep can complete a visit
 * with no connection, kill the app, relaunch still offline and see their work,
 * and have it upload by itself when signal returns.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})
const page = await ctx.newPage()
const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1200)

const syncText = () => page.locator('button[aria-label^="Sync status"]').first().innerText()

ok((await syncText()).includes('Synced'), 'starts in Synced state')

// ---- go offline -----------------------------------------------------------
await ctx.setOffline(true)
await page.evaluate(() => window.dispatchEvent(new Event('offline')))
await page.waitForTimeout(600)
ok((await syncText()).includes('Offline'), 'sync chip reports Offline when the link drops')

const banner = await page.locator('text=/Working offline/').count()
ok(banner > 0, 'offline banner is shown')

// ---- complete a full visit with no connection -----------------------------
await page.goto(`${BASE}/route`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
await page.getByRole('button', { name: /^Start$/ }).first().click()
await page.waitForTimeout(1500)

const inVisit = page.url().includes('/visit/')
ok(inVisit, 'visit starts while offline')

await page.getByRole('button', { name: /Interested/ }).first().click()
await page.waitForTimeout(600)

// quick note template + tag
await page.getByRole('button', { name: 'Interested in project' }).first().click()
await page.getByRole('button', { name: 'Homeowner' }).first().click()
await page.waitForTimeout(300)

await page.getByRole('button', { name: /^Continue$/ }).click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: /Complete visit/ }).click()
await page.waitForTimeout(1500)

const recorded = await page.locator('text=/Visit recorded/').count()
ok(recorded > 0, 'visit completes offline and confirms')

const savedLocally = await page.locator('text=/Saved on this phone/').count()
ok(savedLocally > 0, 'confirmation tells the rep the work is saved locally')

// ---- pending work is queued, not lost -------------------------------------
await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
const pendingCount = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res) => {
    req.onsuccess = () => res(req.result)
  })
  const tx = db.transaction('outbox', 'readonly')
  const all = await new Promise((res) => {
    const r = tx.objectStore('outbox').getAll()
    r.onsuccess = () => res(r.result)
  })
  return all.length
})
ok(pendingCount > 0, `outbox holds queued mutations while offline (${pendingCount})`)

// ---- kill the app and relaunch, still offline -----------------------------
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
// Back to Today: it's the screen that carries the sync chip.
await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

const stillSignedIn = !(await page.locator('text=/Continue as/').count())
ok(stillSignedIn, 'session survives a cold restart with no connection')

const stillOffline = (await syncText()).includes('Offline')
ok(stillOffline, 'still reports Offline after relaunch')

const survivedCount = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res) => {
    req.onsuccess = () => res(req.result)
  })
  const tx = db.transaction(['outbox', 'visits'], 'readonly')
  const outbox = await new Promise((res) => {
    const r = tx.objectStore('outbox').getAll()
    r.onsuccess = () => res(r.result)
  })
  const visits = await new Promise((res) => {
    const r = tx.objectStore('visits').getAll()
    r.onsuccess = () => res(r.result)
  })
  return { outbox: outbox.length, visits: visits.filter((v) => v.endedAt).length }
})
ok(survivedCount.outbox > 0, `queued work survived the restart (${survivedCount.outbox} pending)`)
ok(survivedCount.visits > 0, `completed visit survived the restart (${survivedCount.visits})`)

// ---- reconnect: the queue should drain by itself ---------------------------
await ctx.setOffline(false)
await page.evaluate(() => window.dispatchEvent(new Event('online')))

let drained = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500)
  const n = await page.evaluate(async () => {
    const req = indexedDB.open('allstar-field')
    const db = await new Promise((res) => {
      req.onsuccess = () => res(req.result)
    })
    const r = db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
    return await new Promise((res) => {
      r.onsuccess = () => res(r.result.length)
    })
  })
  if (n === 0) {
    drained = true
    break
  }
}
ok(drained, 'queue drains automatically once the connection returns')

await page.waitForTimeout(800)
ok((await syncText()).includes('Synced'), 'sync chip returns to Synced after draining')

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall offline checks passed')
process.exit(fails.length ? 1 : 0)
