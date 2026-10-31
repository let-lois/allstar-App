import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Adding a lead from the map while working a list.
 *
 * A rep who opens the map from a list is working that list. A house tapped on
 * that map used to open a form that began on "Not on a list", so every lead meant
 * a second step — find the lead, find Lists, tick — or, more often, a lead that
 * never reached the list. The form now starts on the map's open list.
 *
 * What has to hold, in order of how much a wrong answer costs:
 *
 *   The default is the map's open list, and the lead lands on it.
 *   Choosing another list sends the lead there and leaves the map's own list
 *   alone — the rep is still working the list they opened.
 *   With no open list, nothing is pre-ticked and nothing is added anywhere.
 *   A list this person may not add to is never ticked, and the form says why.
 *   One tap on Save is one lead, however fast the second tap comes.
 *   The choice does not leak onto the next house: a rep who ticked another list
 *   for one lead is back on the map's list for the next.
 *
 * Demo mode, so every write is the local-first path a rep in a dead zone takes.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

const idb = (store) =>
  page.evaluate(
    (name) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const r = req.result.transaction(name, 'readonly').objectStore(name).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(new Error('no rows'))
        }
      }),
    store,
  )
const lists = async () => Object.fromEntries((await idb('leadLists')).map((l) => [l.name, l]))
const leadCount = async () => (await idb('properties')).length

async function enterForm() {
  const btn = page.getByTestId('detected-add-lead')
  if ((await btn.count()) > 0) {
    await btn.click()
    await page.waitForTimeout(400)
  }
}
/** Tap somewhere that is not a lead until the Add-lead sheet opens. */
async function tapOpenGround(from = 0) {
  const spots = [[200, 430], [110, 470], [300, 380], [150, 350], [250, 500], [320, 450], [90, 400]]
  for (const [x, y] of spots.slice(from)) {
    await page.mouse.click(x, y)
    await page.waitForTimeout(700)
    if (await page.locator('[data-testid="add-lead-sheet"]').isVisible().catch(() => false)) return true
    const close = page.getByRole('button', { name: /All leads/ })
    if (await close.isVisible().catch(() => false)) await close.click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  return false
}
const summary = async () => (await page.getByTestId('lead-list-summary').innerText()).replace(/\s+/g, ' ').trim()
let nextStreet = 100
async function typeAddress() {
  await page.locator('input[autocomplete="street-address"]').fill(`${nextStreet++} Gate List Ln`)
  await page.waitForTimeout(400)
}
async function openMapOn(listId) {
  await page.goto(`${BASE}/map${listId ? `?list=${listId}` : ''}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await dismissTour(page)
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2000)

  /* --- two lists of the rep's own ------------------------------------------ */
  const NAME_A = 'Gate Saturday Knock'
  const NAME_B = 'Gate Evening Callbacks'
  const ids = {}
  for (const [key, name] of [['a', NAME_A], ['b', NAME_B]]) {
    await page.goto(`${BASE}/lists`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await dismissTour(page)
    await page.getByTestId('new-list').click()
    await page.waitForTimeout(300)
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: /^Create list$/ }).click()
    await page.waitForTimeout(1000)
    ids[key] = page.url().split('/lists/')[1]
  }
  ok(!!ids.a && !!ids.b && ids.a !== ids.b, 'two lists exist to choose between')
  const base = await leadCount()

  /* ===== 1. the map's open list is the default ============================== */
  await openMapOn(ids.a)
  ok(/Gate Saturday Knock/.test(await page.getByTestId('map-list-chip').innerText()), 'the map is open on the first list')
  ok(await tapOpenGround(), 'tapping the map opens the Add-lead sheet')
  await enterForm()
  ok((await page.getByTestId('lead-list-choice').count()) === 1, 'the form has a list control')
  ok(new RegExp(`Goes on ${NAME_A}$`).test(await summary()), 'which already says the lead goes on the map’s list', await summary())
  ok((await page.getByTestId('lead-list-blocked').count()) === 0, 'with no warning, because the rep may add to it')

  await page.getByTestId('lead-list-choice').getByRole('button', { name: /Change/ }).click()
  await page.waitForTimeout(300)
  const picker = page.getByTestId('lead-list-picker')
  ok((await picker.getByLabel(NAME_A).isChecked()) && !(await picker.getByLabel(NAME_B).isChecked()), 'the picker has the first list ticked and the second not')
  ok((await picker.getByTestId('lead-list-current').count()) === 1 && /current list/.test(await picker.getByTestId('lead-list-current').innerText()), 'and marks which one is the current list')
  await page.getByTestId('lead-list-choice').getByRole('button', { name: /Done/ }).click()

  await typeAddress()
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1500)
  let l = await lists()
  ok((await leadCount()) === base + 1, 'saving makes exactly one lead', `${(await leadCount()) - base}`)
  ok(l[NAME_A].leadIds.length === 1 && l[NAME_B].leadIds.length === 0, 'and it is on the map’s list only')
  const leadOnA = l[NAME_A].leadIds[0]

  /* ===== 2. another list, without moving the map's ========================== */
  ok(await tapOpenGround(2), 'a second tap opens the sheet again')
  await enterForm()
  ok(new RegExp(`Goes on ${NAME_A}$`).test(await summary()), 'the next house starts on the map’s list again', await summary())
  await page.getByTestId('lead-list-choice').getByRole('button', { name: /Change/ }).click()
  await page.waitForTimeout(300)
  await picker.getByLabel(NAME_A).click()
  await picker.getByLabel(NAME_B).click()
  await page.waitForTimeout(300)
  ok(new RegExp(`Goes on ${NAME_B}$`).test(await summary()), 'switching list changes where the lead goes', await summary())
  ok(/Gate Saturday Knock/.test(await page.getByTestId('map-list-chip').innerText()), 'and the map stays open on its own list')
  await page.getByTestId('lead-list-choice').getByRole('button', { name: /Done/ }).click()
  await typeAddress()
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1500)
  l = await lists()
  ok(l[NAME_B].leadIds.length === 1 && !l[NAME_B].leadIds.includes(leadOnA), 'the lead is on the list that was chosen')
  ok(l[NAME_A].leadIds.length === 1 && l[NAME_A].leadIds[0] === leadOnA, 'and not on the map’s list')
  ok(/Gate Saturday Knock/.test(await page.getByTestId('map-list-chip').innerText()), 'the map is still open on its own list after saving')

  /* ===== 3. the choice does not leak onto the next house ==================== */
  ok(await tapOpenGround(4), 'a third tap opens the sheet')
  await enterForm()
  ok(new RegExp(`Goes on ${NAME_A}$`).test(await summary()), 'a list ticked for one lead is not carried to the next', await summary())

  /* ===== 4. one tap, one lead =============================================== */
  const beforeDouble = await leadCount()
  await typeAddress()
  await page.getByRole('button', { name: /Save lead/ }).evaluate((el) => {
    el.click()
    el.click()
  })
  await page.waitForTimeout(1800)
  ok((await leadCount()) === beforeDouble + 1, 'two quick taps on Save make one lead', `${(await leadCount()) - beforeDouble}`)
  l = await lists()
  ok(l[NAME_A].leadIds.length === 2, 'and it joined the map’s list once', `${l[NAME_A].leadIds.length}`)

  /* ===== 5. no open list ==================================================== */
  await openMapOn(null)
  ok((await page.getByTestId('map-list-chip').count()) === 0, 'a map opened with no list shows no list chip')
  ok(await tapOpenGround(), 'tapping it opens the sheet')
  await enterForm()
  ok(/Not on a list/.test(await summary()), 'the form starts on no list', await summary())
  ok((await page.getByTestId('lead-list-blocked').count()) === 0, 'and says nothing about a list that is not there')
  const countsBefore = Object.values(await lists()).map((x) => x.leadIds.length).join(',')
  await typeAddress()
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1500)
  ok(Object.values(await lists()).map((x) => x.leadIds.length).join(',') === countsBefore, 'saving puts the lead on no list')

  await openMapOn('l_does_not_exist')
  ok((await page.getByTestId('map-list-chip').count()) === 0, 'a list id that is not there is treated as no list')
  ok(await tapOpenGround(), 'and the sheet still opens')
  await enterForm()
  ok(/Not on a list/.test(await summary()), 'starting on no list', await summary())
  await page.getByRole('button', { name: /^Cancel$/ }).click()
  await page.waitForTimeout(400)

  /* ===== 6. a list the rep may only work, not change ======================== */
  await page.evaluate(
    () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const tx = req.result.transaction('leadLists', 'readwrite')
          tx.objectStore('leadLists').put({
            id: 'l_office_gate', name: 'Gate Office Handout', createdBy: 'u_admin', archived: false,
            createdAt: Date.now(), updatedAt: Date.now(), leadIds: [], repIds: ['u_rep'],
          })
          tx.oncomplete = () => res(true)
          tx.onerror = () => rej(new Error('write failed'))
        }
      }),
  )
  await openMapOn('l_office_gate')
  ok(/Gate Office Handout/.test(await page.getByTestId('map-list-chip').innerText()), 'the map opens on a list the office handed over')
  ok(await tapOpenGround(), 'tapping it opens the sheet')
  await enterForm()
  ok(/Not on a list/.test(await summary()), 'the form does not tick a list the server would refuse', await summary())
  const blocked = page.getByTestId('lead-list-blocked')
  ok((await blocked.count()) === 1 && /Gate Office Handout is view-only/.test(await blocked.innerText()), 'and says so, by name')
  await typeAddress()
  await page.getByRole('button', { name: /Save lead/ }).click()
  await page.waitForTimeout(1500)
  ok((await lists())['Gate Office Handout'].leadIds.length === 0, 'the lead is saved without it')

  ok(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '))
} catch (e) {
  ok(false, `script error: ${e.message}`)
} finally {
  await browser.close()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll checks passed')
process.exit(fails.length ? 1 : 0)
