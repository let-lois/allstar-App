import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Phase 1, end to end, the way a company would actually use it.
 *
 *   manager onboards a rep → rep's badge is real → manager draws an area,
 *   makes a list, hands it to the rep → rep sees it, opens it on the map,
 *   works the houses (details, notes, outcomes) → it all survives a reload
 *   and a fresh sign-in → the manager sees every update, who made it and
 *   which list it is on → the manager exports it all to CSV and the file
 *   says the same.
 *
 * A real Worker on its own port with a fresh database, the app built against
 * it into `dist-phase1`, and two browsers: a phone for the rep, a laptop for
 * the manager. Nothing is mocked except Google Maps, which is aborted so the
 * self-rendered map is exercised deterministically.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const api = resolve(root, 'api')
const PORT = Number(process.env.P1_API_PORT || 8857)
const APP_PORT = Number(process.env.P1_APP_PORT || 4178)
const API = `http://127.0.0.1:${PORT}`
const APP = `http://127.0.0.1:${APP_PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/phase1-e2e-state')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* ---- the Worker --------------------------------------------------------- */
function writeConfig(name) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const body = source.replace('main = "src/index.ts"', 'main = "../src/index.ts"')
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}
let worker = null
async function startWorker(config) {
  worker = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:local-phase1-pepper',
     '--var', `ALLOWED_ORIGINS:${APP}`],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  worker.stdout.on('data', () => {})
  worker.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${API}/api/health`); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}
async function stopWorker() {
  if (!worker) return
  const dead = new Promise((r) => worker.once('exit', r))
  try { process.kill(-worker.pid, 'SIGTERM') } catch { worker.kill('SIGTERM') }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  worker = null
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${API}/api/health`) } catch { return }
    await new Promise((r) => setTimeout(r, 500))
  }
}
async function applySchema(config) {
  await new Promise((done, fail) => {
    const p = spawn(resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'],
      { cwd: api, stdio: 'ignore' })
    p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`d1 execute exited ${c}`))))
  })
}

/* ---- the app, built against that Worker ---------------------------------- */
let preview = null
async function startPreview() {
  preview = spawn(resolve(root, 'node_modules/.bin/vite'),
    ['preview', '--outDir', 'dist-phase1', '--port', String(APP_PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  preview.stdout.on('data', () => {})
  preview.stderr.on('data', () => {})
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(APP); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('vite preview never answered')
}
function stopPreview() {
  if (!preview) return
  try { process.kill(-preview.pid, 'SIGTERM') } catch { preview.kill('SIGTERM') }
  preview = null
}

const call = (path, opts = {}, token) =>
  fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })

/** RFC 4180, so a note with a line break is one cell here as it is in Excel. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\r') { /* CRLF */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const stamp = Date.now()
const OWNER = { email: `p1-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const REP = { email: `bea-${stamp}@example.com`, password: 'Bea-password-1234', first: 'Bea', last: 'Whitfield' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LIST = 'Oak Street Area'
const ROWS = [
  { address1: '10 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5050, lng: -97.6750 },
  { address1: '12 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5056, lng: -97.6744 },
  { address1: '14 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5044, lng: -97.6756 },
  { address1: '16 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5052, lng: -97.6758 },
  { address1: '1 Outside Ave', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5600, lng: -97.6200 },
  { address1: '3 Outside Ave', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.4500, lng: -97.7300 },
]

const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []

async function signIn(ctx, who) {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${who.email}: ${e.message}`))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.locator('input[type="email"]').fill(who.email)
  await page.locator('input[autocomplete="current-password"]').fill(who.password)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(2500)
  await dismissTour(page)
  await page.waitForTimeout(800)
  return page
}
const text = (page) => page.locator('body').innerText()
const phoneCtx = () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 30.5053, longitude: -97.6752 } })
const settle = (page, ms = 2500) => page.waitForTimeout(ms)

/** Walk a completed visit from a lead page: outcome, optional note, finish. */
async function workHouse(page, outcome, note) {
  await page.getByRole('button', { name: /^Start visit$/ }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: new RegExp(`^${outcome}$`) }).click()
  await page.waitForTimeout(700)
  if (note) {
    await page.getByPlaceholder(/Tap a quick note above/).fill(note)
    await page.waitForTimeout(300)
  }
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /^Complete visit$/ }).click()
  await page.waitForTimeout(1200)
}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('phase1-e2e.toml')
  await startWorker(config)
  await applySchema(config)
  await stopWorker()
  await startWorker(config)
  await startPreview()

  /* ===== 1. onboarding a brand-new rep ==================================== */
  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Ray Okafor', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'the company exists and its manager can sign in')

  const invite = await (await call('/api/invites', {
    method: 'POST', body: JSON.stringify({ email: REP.email, firstName: REP.first, lastName: REP.last, role: 'field_rep' }),
  }, manager)).json()
  ok(!!invite.url, 'the manager invites a rep and gets a link to hand over', invite.url ? 'link issued' : JSON.stringify(invite))
  const accept = await fetch(invite.url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: REP.password, confirm: REP.password }),
  })
  ok(accept.ok || accept.status === 302, `the rep sets a password through the invitation (${accept.status})`)
  // Inviting the same e-mail again must not make a second account. The server
  // answers "already a member" with no new link, and the team view below is
  // asserted to hold exactly one row for her.
  const dup = await (await call('/api/invites', {
    method: 'POST', body: JSON.stringify({ email: REP.email, firstName: REP.first, lastName: REP.last, role: 'field_rep' }),
  }, manager)).json()
  ok(dup.alreadyMember === true && !dup.url, 'inviting the same e-mail again links to the existing account and issues no second invitation', JSON.stringify({ alreadyMember: dup.alreadyMember, url: !!dup.url }))

  const repLogin = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(REP) })).json()
  ok(!!repLogin.token && repLogin.user?.role === 'field_rep', 'the rep can sign in as a field rep')
  const repId = repLogin.user?.id
  const step = (s, data) => call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: s, data }) }, repLogin.token)
  await step('profile', { jobTitle: 'Sales Representative' })
  await step('setup', { locationStatus: 'skipped' })
  await step('walkthrough')
  const badgeMade = await (await call('/api/me/badge', { method: 'POST' }, repLogin.token)).json()
  await call('/api/me/badge/confirm', { method: 'POST' }, repLogin.token)
  await step('badge')
  await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id: `avatar-${stamp}`, kind: 'user.avatar', payload: { userId: repId, dataUrl: PNG }, createdAt: Date.now() }] }) }, repLogin.token)
  const done = await (await step('checklist')).json()
  ok(done.status === 'complete', 'the rep completes onboarding', done.status)
  const me = await (await call('/api/me', {}, repLogin.token)).json()
  const person = me.user ?? me
  ok(person.name === 'Bea Whitfield' && person.email === REP.email, 'the rep’s information is saved as entered', `${person.name} <${person.email}>`)
  const badgeId = String(person.badgeId ?? badgeMade.badgeId ?? badgeMade.badge?.id ?? '')
  ok(/^\d{6,}$/.test(badgeId), 'a badge number was issued', badgeId)

  /* ---- the badge, as the rep sees it, and as a homeowner checks it -------- */
  const repCtx = await phoneCtx()
  let rep = await signIn(repCtx, REP)
  await rep.goto(`${APP}/badge`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1800)
  ok((await rep.getByTestId('badge-name').textContent()) === 'Bea Whitfield', 'the badge carries the rep’s name')
  ok((await rep.getByTestId('badge-id').innerText()).includes(badgeId), 'and the number the server issued', await rep.getByTestId('badge-id').innerText())
  ok(/Summit Exteriors/i.test(await text(rep)), 'and the company')
  await rep.goto(`${APP}/verify/${badgeId}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1800)
  ok((await rep.getByTestId('verify-page').getAttribute('data-state')) === 'active', 'a homeowner scanning the badge is told it is valid', await rep.getByTestId('verify-page').getAttribute('data-state'))
  ok((await rep.getByTestId('badge-name').textContent()) === 'Bea Whitfield', 'with the same name')

  /* ---- the manager's team view ------------------------------------------- */
  const mgrCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const mgr = await signIn(mgrCtx, OWNER)
  await mgr.goto(`${APP}/admin/team`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2000)
  const beaRows = mgr.locator('tbody tr', { hasText: 'Bea Whitfield' })
  ok((await beaRows.count()) === 1, 'the new rep appears once in the team view', `${await beaRows.count()}`)
  ok((await beaRows.first().getByTestId('col-onboarding').getAttribute('data-value')) === 'Complete', 'marked as onboarded', await beaRows.first().getByTestId('col-onboarding').getAttribute('data-value'))
  ok((await beaRows.first().getByTestId('col-badge').getAttribute('data-value')) === 'Active', 'with an active badge', await beaRows.first().getByTestId('col-badge').getAttribute('data-value'))
  ok((await beaRows.first().getByTestId('col-account').getAttribute('data-value')) === 'Active', 'and an active account')

  /* ===== 2. the manager selects an area, makes a list, hands it over ======= */
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 6, 'six houses exist, assigned to nobody', `${imported.created}`)
  await mgr.goto(`${APP}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2000)
  await mgr.getByTestId('list-create-toggle').click()
  await mgr.waitForTimeout(800)
  const map = mgr.getByRole('application', { name: /Outline a list/ })
  await map.scrollIntoViewIfNeeded()
  await mgr.waitForTimeout(400)
  ok((await mgr.locator('[data-marker="pin"]').count()) === 6, 'the drawing map shows every house')
  const box = await map.boundingBox()
  for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]) {
    await mgr.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
    await mgr.waitForTimeout(300)
  }
  const offered = Number(((await text(mgr)).match(/Create with ([\d,]+) lead/) ?? ['', '0'])[1].replace(/,/g, ''))
  ok(offered === 4, 'the area takes in the four houses on the block and says so', `${offered}`)
  await mgr.getByLabel('Name').fill(LIST)
  await mgr.locator('fieldset', { hasText: 'Hand to' }).getByLabel('Bea Whitfield').check()
  await mgr.getByRole('button', { name: /^Create with/ }).click()
  await mgr.waitForTimeout(3000)
  ok(new RegExp(`Created ${LIST} with 4 leads\\. Handed to Bea Whitfield\\.`).test(await text(mgr)), 'Select area, create list, assign rep, save — in one screen')

  // Persists: a hard reload re-reads everything from the server.
  await mgr.reload({ waitUntil: 'domcontentloaded' })
  await settle(mgr, 2500)
  const listRow = mgr.locator('tbody tr', { hasText: LIST })
  ok((await listRow.count()) === 1 && /Bea Whitfield/.test(await listRow.innerText()) && /\b4\b/.test(await listRow.innerText()), 'after a refresh the list is still there, with its four houses and its rep', (await listRow.innerText()).replace(/\s+/g, ' '))
  const lists = await (await call('/api/lists', {}, manager)).json()
  const list = (lists.lists ?? []).find((l) => l.name === LIST)
  ok(!!list && new Set(list.leadIds).size === list.leadIds.length && list.leadIds.length === 4, 'the stored list holds four distinct houses', `${list?.leadIds?.length}`)
  ok(list?.repIds?.length === 1 && list.repIds[0] === repId, 'assigned to exactly the rep')

  /* ===== 3. the rep works the list ======================================== */
  await rep.goto(`${APP}/lists`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2500)
  ok(new RegExp(`${LIST}\\s*\\n\\s*4 leads`).test(await text(rep)), 'the rep sees the assigned list under My Lists, with its count')
  await rep.getByTestId('list-row').filter({ hasText: LIST }).click()
  await settle(rep, 1200)
  ok((await rep.getByTestId('list-lead').count()) === 4, 'opening it lists the four houses')
  ok(/^4 total · 4 new$/.test((await rep.getByTestId('list-progress').innerText()).trim()), 'and shows the progress: all new', await rep.getByTestId('list-progress').innerText())
  await rep.getByTestId('open-on-map').click()
  await settle(rep, 2500)
  ok(/Search 4 leads/.test((await rep.locator('input[placeholder^="Search "]').getAttribute('placeholder')) ?? ''), 'the map opens narrowed to the list')
  ok((await rep.getByTestId('map-list-chip').count()) === 1, 'and names it')
  {
    const mb = await rep.getByRole('application').boundingBox()
    const pins = await rep.locator('[data-marker="pin"], [data-marker="cluster"]').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
    ok(pins.length > 0 && pins.every((p) => p.x >= mb.x && p.y >= mb.y && p.x + p.w <= mb.x + mb.width && p.y + p.h <= mb.y + mb.height), 'framed on the list — every pin is on screen', `${pins.length} markers`)
  }
  await rep.goto(`${APP}/leads`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2000)
  await dismissTour(rep)
  ok(/4 of 4/.test(await text(rep)), 'the rep has exactly the four houses and not the two across town')
  await rep.goto(`${APP}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1200)
  ok(/Not available for your role/.test(await text(rep)), 'and cannot open the console')

  // House one: details learned at the door, then a visit with a note.
  const [h1, h2, h3] = list.leadIds
  await rep.goto(`${APP}/property/${h1}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1500)
  await rep.getByTestId('lead-edit-open').click()
  await rep.waitForTimeout(500)
  const sheet = rep.getByTestId('lead-edit')
  const addr1 = await sheet.getByLabel('Address', { exact: true }).inputValue()
  await sheet.getByLabel('Address', { exact: true }).fill(`${addr1} Unit A`)
  await sheet.getByLabel('Contact name').fill('Priya Natarajan')
  await sheet.getByLabel('Phone').fill('512 555 0142')
  await sheet.getByLabel('Email').fill('priya@example.com')
  await rep.getByTestId('lead-edit-save').click()
  await rep.waitForTimeout(900)
  ok(/Priya Natarajan/.test(await rep.getByTestId('lead-contact').innerText()), 'the rep records the homeowner at the door')
  const NOTE = 'Roof about 15 years, hail marks on the north side, wants a quote by Friday'
  await workHouse(rep, 'Interested', NOTE)
  ok(/Complete|Nice work|Done|Back to/i.test(await text(rep)), 'the visit completes')

  // House two: follow up. House three: sold.
  await rep.goto(`${APP}/property/${h2}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1500)
  await workHouse(rep, 'Follow Up')
  await rep.goto(`${APP}/property/${h3}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 1500)
  await workHouse(rep, 'Sold')

  // A new lead, added by the rep from the field, on the same list.
  await rep.goto(`${APP}/lead/new`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2000)
  const NEW_ADDR = `18 Inside St`
  await rep.getByLabel(/Address/i).fill(NEW_ADDR)
  await rep.getByLabel('Contact name').fill('Sam Okonkwo')
  await rep.getByLabel('Phone').fill('512 555 0177')
  const saveLead = rep.getByRole('button', { name: /Save lead/i })
  await saveLead.waitFor({ timeout: 15_000 })
  await saveLead.click()
  await settle(rep, 2500)
  const newId = rep.url().split('/property/')[1]?.split(/[?#]/)[0]
  ok(!!newId, 'the rep adds a lead from the field', newId)

  // Let the outbox drain, then reload: everything must come back from the server.
  await settle(rep, 3500)
  await rep.goto(`${APP}/lists/${list.id}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2500)
  const progress = (await rep.getByTestId('list-progress').innerText()).trim()
  ok(/4 total/.test(progress) && /1 new/.test(progress) && /1 working/.test(progress) && /1 follow-up/.test(progress) && /1 won/.test(progress), 'the list’s progress reflects the day', progress)

  await rep.goto(`${APP}/property/${h1}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2000)
  ok(/Priya Natarajan/.test(await rep.getByTestId('lead-contact').innerText()) && /512 555 0142/.test(await rep.getByTestId('lead-contact').innerText()), 'after a reload the contact is still there')
  ok((await text(rep)).includes(`${addr1} Unit A`), 'and the corrected address')
  ok(/Working/.test(await text(rep)), 'and the status the outcome earned')
  ok((await text(rep)).includes(NOTE), 'and the note')

  // Signed out and back in on a fresh phone: nothing was only in the browser.
  await repCtx.close()
  const repCtx2 = await phoneCtx()
  rep = await signIn(repCtx2, REP)
  await rep.goto(`${APP}/property/${h1}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2500)
  ok(/Priya Natarajan/.test(await rep.getByTestId('lead-contact').innerText()) && (await text(rep)).includes(`${addr1} Unit A`) && /Working/.test(await text(rep)), 'after signing out and back in, the details and status are all there')
  ok((await text(rep)).includes(NOTE), 'and the note came back from the server')
  await rep.goto(`${APP}/property/${newId}`, { waitUntil: 'domcontentloaded' })
  await settle(rep, 2000)
  ok((await text(rep)).includes(NEW_ADDR) && /Sam Okonkwo/.test(await rep.getByTestId('lead-contact').innerText()), 'so did the lead added from the field, with its contact')

  /* ===== 4. the manager sees the rep's day ================================ */
  await mgr.goto(`${APP}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2500)
  await mgr.locator('input[type="search"]').fill('Inside St')
  await mgr.waitForTimeout(800)
  const rowH1 = mgr.locator('tbody tr', { hasText: `${addr1} Unit A` })
  ok((await rowH1.count()) === 1, 'the manager finds the house by its corrected address', `${await rowH1.count()}`)
  ok(/Working/.test(await rowH1.innerText()) && /Bea Whitfield/.test(await rowH1.innerText()), 'with the status the rep earned and the rep’s name', (await rowH1.innerText()).replace(/\s+/g, ' '))
  ok(/Priya Natarajan/.test(await rowH1.innerText()), 'and the homeowner the rep recorded')
  const rowNew = mgr.locator('tbody tr', { hasText: NEW_ADDR })
  ok((await rowNew.count()) === 1 && /Bea Whitfield/.test(await rowNew.innerText()) && !/Untitled/.test(await text(mgr)), 'the lead added from the field is here, whole, assigned to the rep', (await rowNew.innerText()).replace(/\s+/g, ' '))
  const rowsInside = await mgr.locator('tbody tr', { hasText: 'Inside St' }).count()
  ok(rowsInside === 5, 'five houses on Inside St — four imported and one added, none duplicated', `${rowsInside}`)

  // The manager reads the rep's note on the lead itself.
  await mgr.goto(`${APP}/property/${h1}`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2500)
  ok((await text(mgr)).includes(NOTE), 'the manager reads the note the rep left')
  ok((await mgr.getByTestId('on-list').count()) === 1 && (await mgr.getByTestId('on-list').innerText()) === LIST, 'and sees which list the house is on')

  /* ===== 5. export ======================================================== */
  await mgr.goto(`${APP}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2500)
  const [download] = await Promise.all([mgr.waitForEvent('download', { timeout: 15_000 }), mgr.getByTestId('export-csv').click()])
  const csvPath = await download.path()
  const csv = csvPath ? readFileSync(csvPath, 'utf8') : ''
  ok(/^allstar-leads-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), 'Export CSV downloads a dated file', download.suggestedFilename())
  const rows = parseCsv(csv)
  const header = rows[0] ?? []
  const col = (n) => header.indexOf(n)
  for (const c of ['lead_id', 'address', 'name', 'phone', 'email', 'status', 'notes', 'assigned_rep', 'lists', 'first_activity', 'updated']) ok(col(c) >= 0, `the file has a ${c} column`)
  const data = rows.slice(1)
  ok(data.length === 7, 'seven leads, seven rows', `${data.length}`)
  ok(new Set(data.map((r) => r[0])).size === data.length, 'no duplicate rows')
  const r1 = data.find((r) => r[0] === h1)
  ok(r1?.[col('address')] === `${addr1} Unit A` && r1?.[col('name')] === 'Priya Natarajan' && r1?.[col('phone')] === '512 555 0142' && r1?.[col('email')] === 'priya@example.com', 'the corrected details are in the file', r1 ? `${r1[col('address')]} / ${r1[col('name')]}` : 'no row')
  ok(r1?.[col('status')] === 'working' && r1?.[col('assigned_rep')] === 'Bea Whitfield' && r1?.[col('lists')] === LIST, 'with status, rep and list', r1 ? `${r1[col('status')]} / ${r1[col('assigned_rep')]} / ${r1[col('lists')]}` : '')
  ok((r1?.[col('notes')] ?? '').includes(NOTE) && /Bea Whitfield:/.test(r1?.[col('notes')] ?? ''), 'and the note, signed by the rep', (r1?.[col('notes')] ?? '').slice(0, 60))
  ok(!Number.isNaN(Date.parse(r1?.[col('updated')] ?? '')), 'dates are dates')
  const r3 = data.find((r) => r[0] === h3)
  ok(r3?.[col('status')] === 'won', 'the sold house reads won', r3?.[col('status')])

  // The same list, exported from its own page.
  await mgr.goto(`${APP}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await settle(mgr, 2500)
  await mgr.locator('tbody tr', { hasText: LIST }).click()
  await mgr.waitForTimeout(800)
  const [dl2] = await Promise.all([mgr.waitForEvent('download', { timeout: 15_000 }), mgr.getByTestId('export-list-csv').click()])
  const listRows = parseCsv(readFileSync(await dl2.path(), 'utf8')).slice(1)
  ok(listRows.length === 4 && listRows.every((r) => list.leadIds.includes(r[0])), 'exporting the list gives exactly its four houses', `${listRows.length}`)
  ok(/^allstar-oak-street-area-/.test(dl2.suggestedFilename()), 'named after the list', dl2.suggestedFilename())

  /* ===== 6. the browser's own rules, with nothing intercepting them ======= */
  //
  // Every other page in this file — and in every other browser gate — installs
  // a Playwright route to keep Google Maps off the network. Request
  // interception makes Chromium skip CORS enforcement, which is how a preflight
  // that advertised only GET, POST and DELETE reached production: assigning a
  // list to a rep is a PUT and renaming one is a PATCH, the browser refused to
  // send either, and every gate that should have caught it was running with the
  // rule switched off. A manager saw "That needs a connection" and a green
  // suite. This page routes nothing, so the rule is real here.
  {
    const bare = await browser.newContext()
    const page = await bare.newPage()
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const tried = await page.evaluate(async (api) => {
      const out = {}
      for (const [method, path] of [['PUT', '/api/lists/nope/reps'], ['PATCH', '/api/lists/nope'], ['DELETE', '/api/lists/nope'], ['POST', '/api/lists']]) {
        try {
          const res = await fetch(api + path, {
            method,
            headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
            body: method === 'DELETE' ? undefined : '{}',
          })
          out[method] = `reached ${res.status}`
        } catch (e) {
          out[method] = `blocked: ${e.message}`
        }
      }
      return out
    }, API)
    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      ok(
        /^reached/.test(tried[method] ?? ''),
        `a real browser may send ${method} to the API — no interception, no exemption`,
        tried[method],
      )
    }
    await bare.close()
  }

  /* ===== last: the rep deletes their own account from the phone =========== */
  // App Store guideline 5.1.1(v). Last, because it removes the rep the walk used.
  {
    await rep.goto(`${APP}/more`, { waitUntil: 'domcontentloaded' })
    await settle(rep, 1500)
    ok((await rep.getByRole('link', { name: 'Privacy policy' }).getAttribute('href'))?.endsWith('/privacy') === true, 'More links the privacy policy')
    ok((await rep.getByRole('link', { name: 'Terms of use' }).getAttribute('href'))?.endsWith('/terms') === true, 'and the terms of use')
    ok((await rep.getByRole('link', { name: 'All Star Help', exact: true }).getAttribute('href')) === 'https://help.allstarhomesolutions.com', 'and All Star Help (the Help Center)')
    await rep.getByRole('button', { name: 'Delete account' }).click()
    await settle(rep, 1200)
    ok(/\/profile/.test(rep.url()) && (await rep.getByTestId('delete-account').count()) === 1, 'Delete account leads to the profile, where it is explained')
    await rep.getByTestId('delete-account-open').click()
    await settle(rep, 600)
    const submit = rep.getByTestId('delete-account-submit')
    await rep.getByTestId('delete-account-password').fill(REP.password)
    ok(await submit.isDisabled(), 'the button stays off until DELETE is typed')
    await rep.getByTestId('delete-account-confirm').fill('delete')
    ok(!(await submit.isDisabled()), 'typing it, in any case, turns it on')
    const overflow = await rep.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    ok(overflow <= 0, 'the sheet fits a 390px phone', `overflow ${overflow}px`)
    await submit.click()
    await settle(rep, 3000)
    ok((await rep.locator('input[type="email"]').count()) === 1, 'the phone is signed out, back on the sign-in screen')
    const gone = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: REP.email, password: REP.password }) })
    ok(gone.status === 401, 'and the account can no longer sign in', `${gone.status}`)
  }

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  await repCtx2.close(); await mgrCtx.close()
} catch (err) {
  ok(false, `the walk did not finish: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close()
  stopPreview()
  await stopWorker()
  rmSync(STATE, { recursive: true, force: true })
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== Phase 1: rep onboarded, area assigned, houses worked, reviewed, exported ===')
