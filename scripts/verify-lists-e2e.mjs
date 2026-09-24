import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The whole lead-list workflow, end to end, against a real Worker.
 *
 * Every other lists gate proves one half: the API smoke proves the server's
 * scope and refusals; the console and phone gates prove their screens in the
 * demo, where writes stay on one device. Neither can show the thing the feature
 * exists for — a manager draws round a block on a desktop, hands it to a rep,
 * and the houses appear on that rep's phone — because the demo has no server
 * to carry it across.
 *
 * So this stands one up. A Worker on its own port with a fresh database; the
 * app built against it into its own `dist-e2e` (the API origin is baked in at
 * build time); a manager in one browser context and two reps in two more. The
 * manager signs in with a password, draws, names, hands over. Dana's phone gets
 * the four houses and the list; Marcus's gets nothing. The manager takes it
 * back; Dana's phone empties. That is the product, and this is the only gate
 * that watches all of it happen.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const api = resolve(root, 'api')
const PORT = Number(process.env.E2E_API_PORT || 8853)
const APP_PORT = Number(process.env.E2E_APP_PORT || 4174)
const API = `http://127.0.0.1:${PORT}`
const APP = `http://127.0.0.1:${APP_PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/lists-e2e-state')

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
     '--var', 'SESSION_PEPPER:local-e2e-pepper',
     // The app is served from its own port here, and the Worker echoes only an
     // origin it knows — the same rule production runs under.
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
    ['preview', '--outDir', 'dist-e2e', '--port', String(APP_PORT), '--strictPort'],
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

const stamp = Date.now()
const OWNER = { email: `e2e-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const reps = {
  Dana: { email: `dana-${stamp}@example.com`, password: 'Dana-password-1234' },
  Marcus: { email: `marcus-${stamp}@example.com`, password: 'Marcus-password-1234' },
}

/** Invite a rep and set their password — the production path, not a row insert. */
/* A one-pixel PNG: the checklist wants a face on the badge, not a good one. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const SURNAME = { Dana: 'Whitfield', Marcus: 'Bell' }

/*
  Invite, accept, and then do what a new rep does before the app lets them at
  their lists: finish onboarding. Since onboarding shipped, an account that has
  not been through it opens on the onboarding shell rather than on Today, so a
  gate about lists has to walk each rep to the end first — through the same
  endpoints the phone uses, so a change to that order breaks here honestly.
*/
async function mintRep(adminToken, name) {
  const { email, password } = reps[name]
  const invite = await (await call('/api/invites', {
    method: 'POST', body: JSON.stringify({ email, firstName: name, lastName: SURNAME[name], role: 'field_rep' }),
  }, adminToken)).json()
  await fetch(invite.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, confirm: password }),
  })
  const { token, user } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).json()
  const step = (s, data) => call('/api/me/onboarding/step', { method: 'POST', body: JSON.stringify({ step: s, data }) }, token)
  await step('profile', {})
  await step('setup', { locationStatus: 'skipped' })
  await step('walkthrough')
  await call('/api/me/badge', { method: 'POST' }, token)
  await call('/api/me/badge/confirm', { method: 'POST' }, token)
  await step('badge')
  await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [{ id: `avatar-${name}-${stamp}`, kind: 'user.avatar', payload: { userId: user.id, dataUrl: PNG }, createdAt: Date.now() }] }) }, token)
  const done = await (await step('checklist')).json()
  if (done.status !== 'complete') throw new Error(`${name} did not finish onboarding: ${JSON.stringify(done)}`)
}

/*
  Four houses within a few hundred feet of each other, two across town. The
  console's drawing map opens on the first house at street zoom, so a box
  drawn across its middle takes in the cluster and none of the far ones —
  whichever house happens to be first.
*/
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
  const email = page.locator('input[type="email"]')
  await email.waitFor({ state: 'visible', timeout: 20_000 })
  await email.fill(who.email)
  await page.locator('input[autocomplete="current-password"]').fill(who.password)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  /*
    Waits for the login screen to go, rather than for a number of seconds.

    This was `waitForTimeout(2500)`, and it broke — not because signing in
    broke, but because a rep's first boot got slower: the session restore, the
    store hydration and the tour all happen between the click and the first
    thing worth asserting. The gate then failed on `/Dana/` against a page that
    was a few hundred milliseconds from saying "Good evening, Dana", and the
    failure read as a broken sign-in.

    A fixed sleep can only be too short or wasteful, and it fails on the
    machine rather than on the product. Waiting for the email field to detach
    is the actual condition — it is gone precisely when the app has left the
    login screen — so this now fails fast when sign-in is genuinely broken and
    does not fail when the box is busy. The tour is dismissed after, since it
    only exists once the app is up.
  */
  await email.waitFor({ state: 'detached', timeout: 20_000 })
  await dismissTour(page)
  await page.waitForTimeout(800)
  return page
}
const text = (page) => page.locator('body').innerText()
/** The rep's lead count, as the Leads screen states it. */
async function leadCount(page) {
  await page.goto(`${APP}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await dismissTour(page)
  const m = (await text(page)).match(/(\d+) of (\d+)/)
  return m ? Number(m[2]) : -1
}

let LIST = 'Storm Ridge Push'
try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('lists-e2e.toml')
  await startWorker(config)
  await applySchema(config)
  await stopWorker()
  await startWorker(config)
  await startPreview()

  /* ---- a company, a manager, two reps, six houses ------------------------ */
  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Ray Okafor', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'the company exists and its manager can sign in')
  await mintRep(manager, 'Dana')
  await mintRep(manager, 'Marcus')
  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 6, 'six houses imported, assigned to nobody', `${imported.created}`)

  /* ---- before: the reps' phones are empty -------------------------------- */
  const danaCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const dana = await signIn(danaCtx, reps.Dana)
  ok(/Dana/.test(await text(dana)), 'Dana signs in on her phone')
  ok((await leadCount(dana)) === 0, 'and has no leads — nothing is assigned to her', `${await leadCount(dana)}`)
  await dana.goto(`${APP}/lists`, { waitUntil: 'domcontentloaded' })
  await dana.waitForTimeout(1200)
  ok(/No lists yet/.test(await text(dana)), 'and no lists')

  /* ---- the manager draws a list and hands it to Dana --------------------- */
  const mgrCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const mgr = await signIn(mgrCtx, OWNER)
  await mgr.goto(`${APP}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await mgr.waitForTimeout(1800)
  ok(/No lists yet/.test(await text(mgr)), 'the console has no lists yet')
  await mgr.getByRole('button', { name: /New list/ }).click()
  await mgr.waitForTimeout(800)
  const map = mgr.getByRole('application', { name: /Outline a list/ })
  await map.scrollIntoViewIfNeeded()
  await mgr.waitForTimeout(400)
  /*
    The precondition the geometry below rests on, asserted rather than assumed.

    Without this the gate was timing-dependent and said so in the worst
    possible way: a box drawn at fixed fractions of a map that had opened
    somewhere unexpected took in one house instead of four, and the failure
    read as "the server computed the wrong membership". The map now fits every
    lead — so if the store had not filled when it mounted, that shows up here,
    named, instead of as a wrong count three assertions later.
  */
  const pins = await mgr.locator('[data-marker="pin"]').count()
  ok(pins === 6, 'the drawing map opens on every lead in the account', `${pins} pins`)
  const box = await map.boundingBox()
  for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]) {
    await mgr.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
    await mgr.waitForTimeout(300)
  }
  const offered = Number(((await text(mgr)).match(/Create with ([\d,]+) lead/) ?? ['', '0'])[1].replace(/,/g, ''))
  ok(offered === 4, 'the drawn box takes in the four houses on the block and neither across town', `${offered}`)
  await mgr.getByLabel('Name').fill(LIST)
  await mgr.getByLabel('Description').fill('Hail on the 9th')
  await mgr.locator('fieldset', { hasText: 'Hand to' }).getByLabel('Dana').check()
  await mgr.getByRole('button', { name: /^Create with/ }).click()
  await mgr.waitForTimeout(3000)
  const after = await text(mgr)
  ok(new RegExp(`Created ${LIST} with 4 leads\\. Handed to Dana Whitfield\\.`).test(after), 'the server creates it with four houses, handed to Dana')
  const row = mgr.locator('tbody tr', { hasText: LIST })
  ok((await row.count()) === 1 && /Dana/.test(await row.innerText()) && /\b4\b/.test(await row.innerText()), 'and the console, re-read from the server, shows it')

  /* ---- Dana's phone now has the block ------------------------------------ */
  ok((await leadCount(dana)) === 4, 'Dana’s phone now holds the four houses', `${await leadCount(dana)}`)
  await dana.goto(`${APP}/lists`, { waitUntil: 'domcontentloaded' })
  await dana.waitForTimeout(1200)
  const danaLists = await text(dana)
  ok(new RegExp(`${LIST}\\s*\\n\\s*4 leads · from (Ray Okafor|the office)`).test(danaLists), 'with the list, its count, and who handed it over')
  await dana.getByTestId('list-row').filter({ hasText: LIST }).click()
  await dana.waitForTimeout(1000)
  ok((await dana.getByTestId('list-lead').count()) === 4, 'the list page shows the four houses')
  ok((await dana.getByRole('button', { name: /^Remove / }).count()) === 0, 'and offers no Remove — it is the office’s list, not hers')
  ok((await dana.getByRole('button', { name: /^Edit$/ }).count()) === 0, 'nor Edit')
  await dana.getByTestId('open-on-map').click()
  await dana.waitForTimeout(2200)
  const ph = (await dana.locator('input[placeholder^="Search "]').getAttribute('placeholder')) ?? ''
  ok(/Search 4 leads/.test(ph), 'and the map opens narrowed to them', ph)
  ok((await dana.getByTestId('map-list-chip').count()) === 1, 'named on the rail')

  /* ---- Marcus, not handed the list, sees none of it ---------------------- */
  const marcusCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const marcus = await signIn(marcusCtx, reps.Marcus)
  ok((await leadCount(marcus)) === 0, 'Marcus, not handed the list, has no leads', `${await leadCount(marcus)}`)
  await marcus.goto(`${APP}/lists`, { waitUntil: 'domcontentloaded' })
  await marcus.waitForTimeout(1200)
  ok(/No lists yet/.test(await text(marcus)), 'and no lists')
  await marcus.goto(`${APP}/admin/lists`, { waitUntil: 'domcontentloaded' })
  await marcus.waitForTimeout(1200)
  ok(/Not available for your role/.test(await text(marcus)), 'and cannot open the console by URL')

  /* ---- the manager takes it back ----------------------------------------- */
  await mgr.locator('tbody tr', { hasText: LIST }).click()
  await mgr.waitForTimeout(500)
  await mgr.locator('[data-list-editor]').getByLabel('Dana').click()
  await mgr.waitForTimeout(2500)
  ok(/Dana Whitfield no longer has/.test(await text(mgr)), 'the manager unassigns Dana')
  ok(!/Dana/.test(await mgr.locator('tbody tr', { hasText: LIST }).innerText()), 'and the row, re-read from the server, drops her')

  // Her phone re-reads on load, the way it does every morning.
  ok((await leadCount(dana)) === 0, 'Dana’s phone empties — an unassigned list confers nothing', `${await leadCount(dana)}`)
  await dana.goto(`${APP}/lists`, { waitUntil: 'domcontentloaded' })
  await dana.waitForTimeout(1200)
  ok(/No lists yet/.test(await text(dana)), 'and the list is gone from her phone')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  await danaCtx.close(); await marcusCtx.close(); await mgrCtx.close()
} catch (err) {
  ok(false, `the walk did not finish: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close()
  stopPreview()
  await stopWorker()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== manager → list → rep, end to end, OK ===')
process.exit(fails.length ? 1 : 0)
