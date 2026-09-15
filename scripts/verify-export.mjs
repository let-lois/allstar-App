import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Export CSV, from the console, as a download.
 *
 * The file itself is proved by the API smoke against a real database. This is
 * the other half: the button asks the server for the right file — the filters
 * the screen is showing, or the list that is open — and what the browser saves
 * is what the server sent, under a name that says what it is. The server is
 * stubbed and answers a fixed CSV, so the assertion is on the request and on
 * the bytes that reach disk, not on the data.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const ADMIN = {
  id: 'u_live_admin',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'admin@ridgeline.test',
  name: 'Nadia Petrov',
  role: 'client_admin',
}
const leads = [
  { id: 'p1', address1: '1 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51, lng: -97.67, status: 'new', score: 50, contacts: [], updatedAt: 1 },
  { id: 'p2', address1: '2 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5105, lng: -97.6695, status: 'contacted', score: 50, contacts: [], updatedAt: 1 },
]
const LIST = { id: 'll_oak', name: 'Oak Street Area', description: null, createdBy: ADMIN.id, archived: false, createdAt: 1, updatedAt: 1, leadIds: ['p1', 'p2'], repIds: [] }
const CSV = 'lead_id,address,notes\r\np1,"1 Cedar Bend Dr","said ""hi"", left"\r\np2,2 Cedar Bend Dr,\r\n'
const EMPTY_BOOTSTRAP = { properties: [], routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], leadLists: [], team: [], settings: null }

const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

const exportUrls = []
await page.route('**/api/**', json(200, {}))
await page.route('**/api/auth/login', json(200, { token: 'tok_admin', user: ADMIN }))
await page.route('**/api/me', json(200, { user: ADMIN }))
await page.route('**/api/users', json(200, { users: [{ id: 'u_rep_1', name: 'Marcus Vance', email: 'm@x.test', role: 'field_rep', active: true, pending: false }] }))
await page.route('**/api/bootstrap', json(200, { ...EMPTY_BOOTSTRAP, properties: leads, leadLists: [LIST], team: [{ id: 'u_rep_1', name: 'Marcus Vance', role: 'field_rep', active: true }] }))
await page.route('**/api/leads/export.csv**', async (route) => {
  exportUrls.push(new URL(route.request().url()))
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="allstar-leads-2026-01-01.csv"' },
    body: CSV,
  })
})

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await dismissTour(page)

  /* --- every lead, from the Leads page ---------------------------------- */
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const btn = page.getByTestId('export-csv')
  ok((await btn.count()) === 1, 'the Leads page offers Export CSV')
  {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), btn.click()])
    ok(exportUrls.length === 1, 'the button asks the server for the file')
    ok(exportUrls[0]?.search === '', 'with no filter, when none is set', exportUrls[0]?.search)
    const name = download.suggestedFilename()
    ok(/^allstar-leads-\d{4}-\d{2}-\d{2}\.csv$/.test(name), 'saved under a name that says what and when', name)
    const path = await download.path()
    const saved = path ? readFileSync(path, 'utf8') : ''
    ok(saved === CSV, 'and the bytes on disk are the bytes the server sent, quotes and CRLF intact', `${saved.length} bytes`)
  }

  /* --- the filters travel ------------------------------------------------- */
  await page.getByRole('button', { name: /^Contacted$/ }).click()
  await page.waitForTimeout(300)
  {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), btn.click()])
    ok(exportUrls[1]?.searchParams.get('status') === 'contacted', 'a status filter on screen narrows the file', exportUrls[1]?.search)
    ok(!!download, 'and a file is still produced')
  }
  const repSelect = page.getByLabel('Assigned to')
  if ((await repSelect.count()) > 0) {
    await repSelect.first().selectOption('u_rep_1')
    await page.waitForTimeout(300)
    await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), btn.click()])
    ok(exportUrls[2]?.searchParams.get('rep') === 'u_rep_1', 'so does the rep filter', exportUrls[2]?.search)
  }

  /* --- one list, from the Lists page -------------------------------------- */
  await page.goto(`${BASE}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.locator('tbody tr', { hasText: LIST.name }).first().click()
  await page.waitForTimeout(500)
  const listBtn = page.getByTestId('export-list-csv')
  ok((await listBtn.count()) === 1, 'an open list offers Export CSV')
  {
    const before = exportUrls.length
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), listBtn.click()])
    ok(exportUrls[before]?.searchParams.get('list') === LIST.id, 'which asks for exactly that list', exportUrls[before]?.search)
    ok(/^allstar-oak-street-area-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), 'and names the file after it', download.suggestedFilename())
  }

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the console hands the office the file it asked for ===')
