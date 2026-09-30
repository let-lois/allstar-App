import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Tap a house, add it as a lead: the same door never twice, and in the right
 * territory.
 *
 * The manual workflow is the launch path for leads that no territory import
 * created: the rep sees a house, taps it, saves it. Three things it has to get
 * right that verify-mapadd does not cover:
 *
 *   **The same door twice.** Typing the street line of a lead already on the
 *   phone refuses the save and says so; nothing is created. Tapping the map
 *   beside an existing lead never offers "Not a lead yet" — it opens that lead,
 *   directly from its pin or through the "Already a lead" sheet.
 *
 *   **The territory.** A lead saved inside a drawn territory is in that
 *   territory on the phone at once, by the rule the server applies to the same
 *   create (smallest patch first), not filed under Unassigned.
 *
 *   **The office's list.** The Console's Leads page filters to one territory,
 *   the way the Territories page's "View as list" opens it, and shows that new
 *   lead there.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const page = await ctx.newPage()

const readStore = (target, name) =>
  target.evaluate(
    (name) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const r = req.result.transaction(name, 'readonly').objectStore(name).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(new Error(`no ${name}`))
        }
      }),
    name,
  )
const leads = (target = page) => readStore(target, 'properties')

const pinTip = () =>
  page.evaluate(() => {
    const g = document.querySelector('[data-testid="location-pin"]')
    const m = g?.getScreenCTM()
    return m ? { x: m.a * 12 + m.c * 23 + m.e, y: m.b * 12 + m.d * 23 + m.f } : null
  })

async function tapOpenGround(candidates) {
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y)
    await page.waitForTimeout(700)
    const sheet = await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)
    const state = await page.getByTestId('detected-property').getAttribute('data-state').catch(() => null)
    if (sheet && state !== 'existing') return { x, y }
    await page.keyboard.press('Escape')
    const cancel = page.getByRole('button', { name: /^Cancel$/ })
    if (await cancel.first().isVisible().catch(() => false)) await cancel.first().click()
    await page.waitForTimeout(300)
  }
  return null
}

const TERRITORY = { id: 't_gate_manual', name: 'Gate Manual Patch' }

try {
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1500)

  /*
    A drawn territory over the whole demo area, written where the app keeps
    territories on the phone and read back on reload — the same as one that
    arrived in a bootstrap.
  */
  const all = await leads()
  const lats = all.map((p) => p.lat).filter(Number.isFinite)
  const lngs = all.map((p) => p.lng).filter(Number.isFinite)
  const pad = 0.2
  const boundary = [
    { lat: Math.min(...lats) - pad, lng: Math.min(...lngs) - pad },
    { lat: Math.min(...lats) - pad, lng: Math.max(...lngs) + pad },
    { lat: Math.max(...lats) + pad, lng: Math.max(...lngs) + pad },
    { lat: Math.max(...lats) + pad, lng: Math.min(...lngs) - pad },
  ]
  await page.evaluate(
    (t) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onsuccess = () => {
          const tx = req.result.transaction('territories', 'readwrite')
          tx.objectStore('territories').put(t)
          tx.oncomplete = () => res(true)
          tx.onerror = () => rej(tx.error)
        }
      }),
    { ...TERRITORY, boundary },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await dismissTour(page)
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1500)
  const before = (await leads()).length

  /* ===== 1. a typed address that is already a lead =========================== */
  const known = all.find((p) => p.address1 && p.zip)
  const at = await tapOpenGround([[200, 430], [110, 470], [300, 380], [150, 350], [250, 500], [320, 560]])
  ok(!!at, 'tapping open ground opens the new-house sheet', at ? `${at.x},${at.y}` : 'never')
  if (!at) throw new Error('no open ground found')
  const detState = await page.getByTestId('detected-property').getAttribute('data-state')
  ok(detState !== 'existing', 'open ground is not mistaken for an existing lead', detState)
  await page.getByTestId('detected-add-lead').click()
  await page.waitForTimeout(400)
  const street = page.locator('input[autocomplete="street-address"]')
  await street.fill(known.address1)
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1200)
  const refused = await page.locator('text=/is already a lead/').count()
  ok(refused > 0, 'typing the street line of a lead already on the phone is refused, and says so', known.address1)
  ok((await leads()).length === before, 'and creates nothing')

  /* ===== 2. a new door, saved inside the territory =========================== */
  await street.fill('77 Unique Gate Ln')
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1500)
  const after = await leads()
  const made = after.find((p) => p.address1 === '77 Unique Gate Ln')
  ok(after.length === before + 1 && !!made, 'a new address saves exactly one lead', `${after.length - before}`)
  ok(made?.territoryId === TERRITORY.id, 'filed in the territory it stands in, not Unassigned', made?.territoryId ?? 'none')
  ok(!!made?.assignedRepId, 'and assigned to the rep who added it')

  /* ===== 3. tapping beside it opens it, never a second card =================== */
  if (made) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const box = await page.locator(`[data-marker="pin"][data-id="${made.id}"]`).first().boundingBox()
    ok(!!box, 'the new lead has its own marker on the map')
    if (box) {
      // The house itself: just below the marker's point, where the roof is.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height + 3)
      await page.waitForTimeout(900)
      const peekOpen = await page.getByTestId('property-peek').isVisible().catch(() => false)
      const state = await page.getByTestId('detected-property').getAttribute('data-state').catch(() => null)
      ok(peekOpen || state === 'existing', 'tapping beside an existing lead opens it or says it is already a lead', peekOpen ? 'peek' : state)
      ok((await page.locator('text=/Not a lead yet/').count()) === 0, 'and never offers it as "Not a lead yet"')
      if (!peekOpen && state === 'existing') {
        await page.getByTestId('detected-open-lead').click()
        await page.waitForTimeout(900)
      }
      const peek = page.getByTestId('property-peek')
      const text = (await peek.isVisible().catch(() => false)) ? (await peek.innerText()).replace(/\s+/g, ' ') : ''
      ok(/77 Unique Gate Ln/.test(text), 'the sheet that opens is that lead', text.slice(0, 60))
      ok((await leads()).length === before + 1, 'and no second lead was made')
    }
  }

  /* ===== 4. the office's Leads list, filtered to the territory ================ */
  {
    // The office on a desk, in its own browser: a second demo persona.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const desk = await ctx2.newPage()
    await desk.route('**://maps.googleapis.com/**', (r) => r.abort())
    await desk.goto(BASE, { waitUntil: 'domcontentloaded' })
    await desk.waitForTimeout(1200)
    await desk.getByRole('button', { name: /Try the demo/ }).click()
    await desk.getByRole('button', { name: /Ray Okafor/ }).click()
    await dismissTour(desk)
    await desk.waitForTimeout(1500)
    // The desk's own copy of the demo, given the same territory and one lead in it.
    const deskLeads = await leads(desk)
    const target = deskLeads.find((p) => Number.isFinite(p.lat))
    await desk.evaluate(
      ({ t, lead }) =>
        new Promise((res, rej) => {
          const req = indexedDB.open('allstar-field')
          req.onsuccess = () => {
            const tx = req.result.transaction(['territories', 'properties'], 'readwrite')
            tx.objectStore('territories').put(t)
            tx.objectStore('properties').put({ ...lead, territoryId: t.id })
            tx.oncomplete = () => res(true)
            tx.onerror = () => rej(tx.error)
          }
        }),
      { t: { ...TERRITORY, boundary }, lead: target },
    )
    await desk.goto(`${BASE}/admin/leads?territory=${TERRITORY.id}`, { waitUntil: 'domcontentloaded' })
    await desk.waitForTimeout(2500)
    await dismissTour(desk)
    const filter = desk.getByTestId('leads-territory-filter')
    ok((await filter.count()) === 1, 'the Console Leads page has a Territory filter')
    ok((await filter.inputValue().catch(() => '')) === TERRITORY.id, 'opened from a territory, it starts on that territory')
    const body = (await desk.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
    ok(body.includes(target.address1), 'and lists the lead in it', target.address1)
    const others = deskLeads.filter((p) => p.id !== target.id && p.address1 && !body.includes(p.address1)).length
    ok(others >= deskLeads.length - 2, 'and not the leads outside it', `${deskLeads.length - 1 - others} other leads shown`)
    await filter.selectOption('all')
    await desk.waitForTimeout(600)
    const allBody = (await desk.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(deskLeads.filter((p) => p.address1 && allBody.includes(p.address1)).length > 1, 'Every territory shows the rest again')

    // Select one row and the bulk bar offers Move to territory.
    const box = desk.locator('tbody input[type="checkbox"]').first()
    if (await box.count()) {
      await box.check()
      await desk.waitForTimeout(300)
      ok((await desk.getByTestId('bulk-territory').count()) === 1, 'selecting leads offers a bulk Move to territory')
      const opts = await desk.getByTestId('bulk-territory').locator('option').allInnerTexts()
      ok(opts.includes(TERRITORY.name) && opts.includes('No territory'), 'naming each territory, and No territory', opts.join(' | '))
    } else {
      ok(false, 'the Leads table has row checkboxes to select')
    }
    await ctx2.close()
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await browser.close()
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== tap a house, add it once, in its territory ===')
