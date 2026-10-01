import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The Territories page, the way the office uses it.
 *
 * The list of territories is what the page opens on. Creating one lives in a
 * section at the top that stays folded until it is wanted: open, it holds the
 * map, the drawing tools, the name (required), the reps, whether to find the
 * houses inside, and Create. Folding it keeps what was drawn. After Create the
 * page says what happened in numbers — addresses found, new leads, houses that
 * were already leads — and the new territory is in the list.
 *
 * Duplicate prevention itself is the server's (`api/scripts/smoke-territory-
 * leads.mjs`: four found, three created, the existing one counted, a second
 * press creates nothing). This holds the page to showing those numbers as the
 * server gave them.
 *
 * And at 320, 375, 390 and 430 wide: nothing scrolls sideways, and the map,
 * the tools, the fields, the button and the list do not sit on one another.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured !== undefined ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const errors = []

async function demoAdmin(width = 390, height = 844) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Nadia Petrov/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await dismissTour(page, 1500)
  return { ctx, page }
}
const toggle = (page) => page.getByTestId('territory-create-toggle')
const drawMap = (page) => page.getByRole('application', { name: /Outline a territory/ })
const listRows = (page) => page.getByRole('button', { name: /^Show .* on the map$/ })
async function draw(page, corners = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.72], [0.3, 0.72]]) {
  const map = drawMap(page)
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const box = await map.boundingBox()
  for (const [fx, fy] of corners) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
    await page.waitForTimeout(280)
  }
}
const vertices = (page) => page.locator('[data-draw="territory"] circle').count()

try {
  /* ===== 1–2. the page opens on the list =================================== */
  {
    const { ctx, page } = await demoAdmin()
    const before = await listRows(page).count()
    ok(before > 0, 'Territories opens with the existing territories listed', `${before}`)
    ok((await toggle(page).getAttribute('aria-expanded')) === 'false' && (await drawMap(page).count()) === 0, 'and the Create section folded, with no drawing map open')
    const t = await toggle(page).boundingBox()
    const firstRow = await listRows(page).first().boundingBox()
    ok(!!t && !!firstRow && t.y < firstRow.y, 'Create new territory sits above the list')
    ok(/Create new territory/.test(await toggle(page).innerText()), 'and says what it is')

    /* ===== 3–4. it opens with everything creating needs ===================== */
    await toggle(page).click()
    await page.waitForTimeout(700)
    ok((await toggle(page).getAttribute('aria-expanded')) === 'true', 'tapping it opens the section')
    const panel = page.locator('#territory-create-panel')
    ok((await drawMap(page).count()) === 1, 'with the map to draw on')
    ok((await panel.getByRole('button', { name: 'Undo point' }).count()) === 1 && (await panel.getByRole('button', { name: 'Start over' }).count()) === 1, 'the drawing tools')
    const name = page.getByTestId('territory-name')
    ok((await name.count()) === 1 && (await name.getAttribute('required')) !== null && /required/i.test(await panel.innerText()), 'a territory name, marked required')
    ok((await panel.locator('fieldset', { hasText: 'Assign to reps' }).locator('input[type="checkbox"]').count()) > 0, 'the reps to assign')
    ok((await page.getByTestId('territory-create-submit').count()) === 1, 'and the Create action')

    /* ===== 5. draw; folding keeps the drawing =============================== */
    await draw(page)
    ok((await vertices(page)) === 4, 'a territory is drawn: four taps, four points')
    await toggle(page).click()
    await page.waitForTimeout(500)
    ok((await drawMap(page).count()) === 0 && (await listRows(page).count()) === before, 'folding it hides the creation and the list is there')
    await toggle(page).click()
    await page.waitForTimeout(700)
    ok((await vertices(page)) === 4, 'opening it again brings back what was drawn')

    /* ===== 6. the name is required ========================================== */
    await page.getByTestId('territory-create-submit').click()
    await page.waitForTimeout(400)
    ok(/Give the area a name/.test(await panel.innerText()), 'Create without a name says the name is needed, and creates nothing')
    ok((await listRows(page).count()) === before, 'and nothing was added to the list')

    /* ===== 7–9. name, reps, create ========================================= */
    const NAME = 'Gate Collapsible Patch'
    await name.fill(NAME)
    const rep = panel.locator('fieldset', { hasText: 'Assign to reps' }).locator('label').first()
    const repName = (await rep.innerText()).trim()
    await rep.locator('input').check()
    await page.getByTestId('territory-create-submit').click()
    await page.waitForTimeout(1600)

    /* ===== 13–16. the result, folded, and in the list ======================= */
    const created = page.getByTestId('territory-created')
    ok(new RegExp(`Created ${NAME}`).test(await created.innerText()), 'Create says the territory was created', (await created.innerText()).slice(0, 90))
    ok((await toggle(page).getAttribute('aria-expanded')) === 'false' && (await drawMap(page).count()) === 0, 'and folds the section away')
    ok((await listRows(page).count()) === before + 1, 'the territory list is there, one longer', `${before} → ${await listRows(page).count()}`)
    ok((await page.getByRole('button', { name: `Show ${NAME} on the map` }).count()) === 1, 'with the new territory in it')
    ok((await page.getByRole('heading', { name: NAME }).count()) === 1, 'shown on the map below the list, ready to edit')
    ok((await page.getByRole('button', { name: /^Rename$/ }).count()) === 1, 'where Rename, reps and Delete are, as before')
    ok(new RegExp(repName.split(' ')[0]).test(await page.locator('body').innerText()), 'with the rep it was given', repName)
    await ctx.close()
  }

  /* ===== 10–13. the numbers, as the server gives them ======================== */
  {
    /*
      A live account against a mock server that answers the create with what
      the look-up found: 12 addresses inside, 9 new leads, 3 already leads.
      The page must show those three numbers — not the leads already inside,
      not found + existing — and keep the existing ones out of "new".
    */
    const REP = { id: 'u_mgr', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'mgr@ridgeline.test', name: 'Ray Okafor', role: 'manager' }
    const props = [0, 1, 2].map((i) => ({ id: `p${i}`, address1: `${10 + i} Cedar Bend Dr`, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5115 + i * 0.0002, lng: -97.6755, status: 'new', score: 50, contacts: [], assignedRepId: null }))
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    let posted = null
    await page.route(/maps\.googleapis\.com/, (r) => r.abort())
    await page.route('**/api/**', json(200, {}))
    await page.route('**/api/auth/login', json(200, { token: 'tok', user: REP }))
    await page.route('**/api/bootstrap', json(200, { user: REP, properties: props, routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], team: [{ id: 'u_dana', name: 'Dana Whitfield', role: 'field_rep', active: true }, REP], territories: [], serverTime: Date.now() }))
    await page.route('**/api/mutations', json(200, { results: [], serverTime: Date.now() }))
    await page.route('**/api/territories', async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ territories: [] }) })
      posted = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        territory: { id: 't_new', name: posted.name, repIds: posted.repIds ?? [] },
        assigned: 3,
        generated: { found: 12, created: 9, existed: 3, coverage: 'addresses', coverageStatus: 'GOOD' },
      }) })
    })
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.locator('input[type="email"]').fill(REP.email)
    await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    await page.waitForTimeout(1600)
    await dismissTour(page)
    await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await toggle(page).click()
    await page.waitForTimeout(700)
    ok(await page.getByTestId('territory-generate').isChecked(), 'finding the houses inside is offered, and on')
    await draw(page, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    await page.getByTestId('territory-name').fill('Gate Counted Patch')
    await page.locator('fieldset', { hasText: 'Assign to reps' }).getByLabel('Dana Whitfield').check()
    await page.getByTestId('territory-create-submit').click()
    await page.waitForTimeout(2000)
    ok(posted?.generate === true && posted?.name === 'Gate Counted Patch' && posted?.repIds?.includes('u_dana'), 'Create asks the server to find the houses, with the name and the reps', JSON.stringify(posted && { name: posted.name, generate: posted.generate, repIds: posted.repIds }))
    const count = async (id) => Number((await page.getByTestId(`territory-count-${id}`).innerText().catch(() => 'NaN')).replace(/,/g, ''))
    ok((await count('found')) === 12, 'the result shows the addresses found', `${await count('found')}`)
    ok((await count('created')) === 9, 'the new leads created — and only those', `${await count('created')}`)
    ok((await count('existed')) === 3, 'and the houses that were already leads, kept as they were', `${await count('existed')}`)
    ok(/12 addresses found, 9 leads created, 3 already leads/.test(await page.getByTestId('territory-created').innerText()), 'and says it in words too')
    await ctx.close()
  }

  /* ===== phone widths: nothing sideways, nothing on top of anything ========== */
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
    const { ctx, page } = await demoAdmin(w, h)
    const issues = []
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if ((await sideways()) > 0) issues.push(`folded +${await sideways()}px`)
    await toggle(page).click()
    await page.waitForTimeout(700)
    await draw(page)
    await page.getByTestId('territory-name').fill('Width check')
    if ((await sideways()) > 0) issues.push(`open +${await sideways()}px`)
    const boxes = await page.evaluate(() => {
      const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, y: b.y + scrollY, w: b.width, h: b.height, right: b.right } : null }
      const panel = document.querySelector('#territory-create-panel')
      return {
        vw: document.documentElement.clientWidth,
        tools: r(panel?.querySelector('button')?.parentElement?.parentElement),
        map: r(panel?.querySelector('[role="application"]')),
        name: r(document.querySelector('[data-testid="territory-name"]')),
        reps: r([...(panel?.querySelectorAll('fieldset') ?? [])].find((f) => /Assign to reps/.test(f.textContent))),
        submit: r(document.querySelector('[data-testid="territory-create-submit"]')),
        list: r(document.querySelector('[aria-label^="Show "]')),
        offRight: [...(panel?.querySelectorAll('button, input, select, label') ?? [])].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).length,
      }
    })
    const order = [['tools', 'map'], ['map', 'name'], ['name', 'reps'], ['reps', 'submit'], ['submit', 'list']]
    for (const [a, b] of order) {
      const A = boxes[a], B = boxes[b]
      if (!A || !B) { issues.push(`${!A ? a : b} missing`); continue }
      if (A.y + A.h > B.y + 0.5) issues.push(`${a} overlaps ${b}`)
    }
    if (boxes.offRight) issues.push(`${boxes.offRight} controls off the right edge`)
    await toggle(page).click()
    await page.waitForTimeout(400)
    if ((await listRows(page).count()) === 0 || !(await listRows(page).first().isVisible())) issues.push('list not visible after folding')
    ok(issues.length === 0, `${w}×${h}: no sideways scroll; tools, map, name, reps, Create and the list each in their own space`, issues.join(' | ') || 'clean')
    await ctx.close()
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors', errors.join(' | '))
if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== create folded at the top, the list underneath, the numbers as the server gave them ===')
