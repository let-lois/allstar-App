import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
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
  executablePath: chromiumPath(),
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

// ---- signing out must not destroy queued work -----------------------------
/*
  The promise this guards is written on the sign-out dialog: queued knocks "will
  go up next time you sign in". `wipeCachedData` keeps it by deliberately
  sparing the outbox. What broke it was the *next* launch, not the sign-out:
  with nobody signed in, `isDemo()` answered yes, so the start-up drain handed
  every queued row to the demo simulator, which reports each one applied, and
  the queue deleted work that had never left the phone. Nothing threw. The rep
  simply found their morning gone.

  Online on purpose, and that is the whole reason this case is here. The drain
  checks the connection before it checks the mode, so an offline relaunch keeps
  the rows whatever the mode says. The loss only ever reached a phone that had
  signal and nobody signed in — which is every rep who signs out at the end of
  a day and opens the app the next morning.

  The rows are written straight to the store rather than earned through the UI:
  that the app can queue work is proved above, and what is under test here is
  only what a signed-out boot does to rows that already exist.
*/
await ctx.setOffline(true)
await page.goto(`${BASE}/today`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const queued = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res) => {
    req.onsuccess = () => res(req.result)
  })
  const tx = db.transaction('outbox', 'readwrite')
  const store = tx.objectStore('outbox')
  for (let i = 0; i < 3; i++) {
    store.put({
      id: `mut_signout_${i}`,
      kind: 'property.status',
      payload: { propertyId: 'p1', status: 'contacted' },
      createdAt: Date.now(),
      attempts: 0,
      status: 'queued',
    })
  }
  await new Promise((res) => {
    tx.oncomplete = () => res()
  })
  const check = db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
  return await new Promise((res) => {
    check.onsuccess = () => res(check.result.length)
  })
})
ok(queued >= 3, `three mutations are waiting when the rep signs out (${queued})`)

await page.locator('header').first().getByRole('button', { name: 'Sign out', exact: true }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^Sign out$/ }).last().click()
await page.waitForTimeout(900)
ok((await page.locator('text=/Try the demo/').count()) > 0, 'signing out returns to the sign-in screen')

// Signal comes back before the app is opened again — the shape of the morning after.
await ctx.setOffline(false)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const afterSignOut = await page.evaluate(async () => {
  const req = indexedDB.open('allstar-field')
  const db = await new Promise((res) => {
    req.onsuccess = () => res(req.result)
  })
  const r = db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
  return await new Promise((res) => {
    r.onsuccess = () => res(r.result.length)
  })
})
ok(
  afterSignOut >= 3,
  `queued work survives a signed-out relaunch with signal — it is nobody's to discard (${afterSignOut} of 3 still queued)`,
)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall offline checks passed')
process.exit(fails.length ? 1 : 0)
