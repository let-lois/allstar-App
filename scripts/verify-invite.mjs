import { chromium } from 'playwright'

/**
 * Inviting someone onto the team.
 *
 * The assertion that matters most is not that a form submits. It's that the
 * screen never claims an email was sent — because none is. There's no mail
 * service wired up, and an admin who believes a rep was notified will find out a
 * week later that nobody ever got anything. A product that quietly overstates
 * what it did is worse than one that does less.
 *
 * The API is mocked so a failure here means the client is wrong, not that a
 * deployment was down. The server side is covered by api/scripts/smoke-onboarding.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const ADMIN = {
  id: 'u_admin',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'admin@ridgeline.test',
  name: 'Nadia Petrov',
  role: 'client_admin',
}

const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const ctx = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await ctx.newPage()

// A roster that starts with just the admin, and grows when an invite is created.
let roster = [{ id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, role: 'client_admin', active: true, pending: false }]
let invitePosted = null

await page.route('**/api/auth/login', json(200, { token: 'tok', user: ADMIN }))
await page.route('**/api/bootstrap', json(200, {
  user: ADMIN,
  properties: [],
  routes: [],
  appointments: [],
  tasks: [],
  activity: [],
  dailyStats: [],
  territories: [],
  serverTime: Date.now(),
}))
await page.route('**/api/users', async (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: roster }) }),
)
await page.route('**/api/invites', async (route) => {
  invitePosted = JSON.parse(route.request().postData() || '{}')
  roster = [
    ...roster,
    {
      id: 'u_new',
      name: invitePosted.name,
      email: invitePosted.email,
      role: invitePosted.role,
      active: true,
      // The server marks an invited user pending until they set a password.
      pending: true,
    },
  ]
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      url: 'https://api.example.test/invite/abc123token',
      email: invitePosted.email,
      expiresAt: Date.now() + 7 * 86_400_000,
    }),
  })
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="email"]').fill(ADMIN.email)
await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
await page.getByRole('button', { name: /^Sign in$/ }).click()
await page.waitForTimeout(1400)
await page.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

const body = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

/* --- the roster is the real one ------------------------------------------ */
ok(/Nadia Petrov/.test(await body()), 'the live roster shows the real account')
ok(
  !/Dana Whitfield/.test(await body()),
  'seeded demo reps are not shown on a live account — they do not work here',
)
ok(/1 person/.test(await body()), 'the count is singular for one person, not "1 people"')

/* --- inviting ------------------------------------------------------------ */
await page.getByRole('button', { name: /Invite user/ }).click()
await page.waitForTimeout(400)
ok((await page.getByRole('dialog').count()) === 1, 'the invite dialog opens')

// An empty submit must be caught locally rather than round-tripping.
await page.getByRole('button', { name: /Create invite/ }).click()
await page.waitForTimeout(300)
ok(/name and an email/i.test(await body()), 'a missing name or email is caught before sending')
ok(invitePosted === null, 'nothing was sent to the server for an incomplete form')

// Scoped to the dialog throughout: the page behind it has a search box and a
// row of role filter chips whose labels collide with the form's own.
const dialog = page.getByRole('dialog')
await dialog.locator('input[type="text"], input:not([type])').first().fill('Marcus Vance')
await dialog.locator('input[type="email"]').fill('marcus@ridgeline.test')
await dialog.getByText('Field Rep', { exact: true }).click()
await page.getByRole('button', { name: /Create invite/ }).click()
await page.waitForTimeout(800)

ok(invitePosted?.name === 'Marcus Vance', 'the name reaches the server')
ok(invitePosted?.email === 'marcus@ridgeline.test', 'the email reaches the server')
ok(invitePosted?.role === 'field_rep', `the chosen role reaches the server (${invitePosted?.role})`)

/* --- THE assertion: no false claim of having sent anything --------------- */
const after = await body()
ok(
  /nothing has been emailed|no mail service/i.test(after),
  'the screen says plainly that no email was sent',
)
ok(
  !/invitation sent|invite sent|we.{0,3}ve emailed|email sent/i.test(after),
  'the screen never claims an email went out',
)
ok(after.includes('invite/abc123token'), 'the link is shown in full so it can be sent by hand')
ok(
  /expires/i.test(after),
  'the operator is told the link expires, so a week-old one being dead is not a surprise',
)

/* --- the link is actually copyable --------------------------------------- */
await page.getByRole('button', { name: /Copy link/ }).click()
await page.waitForTimeout(400)
const clip = await page.evaluate(() => navigator.clipboard.readText())
ok(clip === 'https://api.example.test/invite/abc123token', `the copy button copies the link (${clip})`)
ok(/Copied/.test(await body()), 'and confirms it copied')

/* --- the roster reflects the invite -------------------------------------- */
await page.getByRole('button', { name: /^Done$/ }).click()
await page.waitForTimeout(700)
const roster2 = await body()
ok(/Marcus Vance/.test(roster2), 'the invited person appears on the roster immediately')
ok(
  /Invite pending/.test(roster2),
  'they are marked as pending, not active — they have no password yet',
)
ok(
  !/Deactivated/.test(roster2),
  'pending is not confused with deactivated — an admin chasing a missing link needs to tell them apart',
)

/* --- a rejection is surfaced, not swallowed ------------------------------ */
await page.unroute('**/api/invites')
await page.route('**/api/invites', json(409, { error: 'That person already has an account.' }))
await page.getByRole('button', { name: /Invite user/ }).click()
await page.waitForTimeout(300)
const dialog2 = page.getByRole('dialog')
await dialog2.locator('input[type="text"], input:not([type])').first().fill('Marcus Vance')
await dialog2.locator('input[type="email"]').fill('marcus@ridgeline.test')
await page.getByRole('button', { name: /Create invite/ }).click()
await page.waitForTimeout(700)
ok(
  /already has an account/i.test(await body()),
  'the server’s reason for refusing is shown verbatim',
)

await ctx.close()

/* ========== the demo has no real team to invite anyone to ================ */
{
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page2 = await ctx2.newPage()
  let called = false
  await page2.route('**/api/invites', (route) => {
    called = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page2.goto(BASE, { waitUntil: 'networkidle' })
  await page2.getByRole('button', { name: /Try the demo/ }).click()
  await page2.getByRole('button', { name: /Nadia Petrov/ }).click()
  await page2.waitForTimeout(1300)
  await page2.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(900)

  const t = (await page2.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/Demo roster/.test(t), 'the demo says its roster is not real')
  ok(/Dana Whitfield/.test(t), 'and still shows a full team, so the pitch works')

  await page2.getByRole('button', { name: /Invite user/ }).click()
  await page2.waitForTimeout(300)
  const d = page2.getByRole('dialog')
  await d.locator('input[type="text"], input:not([type])').first().fill('Someone New')
  await d.locator('input[type="email"]').fill('someone@example.com')
  await page2.getByRole('button', { name: /Create invite/ }).click()
  await page2.waitForTimeout(600)
  ok(called === false, 'the demo makes no invite request')
  ok(
    /live account/i.test((await page2.locator('body').innerText()).replace(/\s+/g, ' ')),
    'and explains why rather than failing silently',
  )
  await ctx2.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} invite check(s) failed` : '\ninviting works, and claims nothing it did not do')
process.exit(fails.length ? 1 : 0)
