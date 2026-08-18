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

/* --- managing an existing person ----------------------------------------- */
{
  await page.route('**/api/users/*/footprint', json(200, {
    visits: 214, notes: 88, photos: 31, tasks: 12, appointments: 6, activity: 240,
    assignedProperties: 50,
  }))
  let passwordPosted = null
  await page.route('**/api/users/*/password', async (route) => {
    passwordPosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  let activePosted = null
  await page.route('**/api/users/*/active', async (route) => {
    activePosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  let deleted = false
  await page.route(/\/api\/users\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deleted = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  const manageRow = (name) =>
    page.locator('tbody tr').filter({ hasText: name }).getByRole('button', { name: /Manage/ })

  await manageRow('Marcus Vance').click()
  await page.waitForTimeout(600)
  const sheet = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  /* ---- password ---- */
  ok(/signs .* out of every device/i.test(await sheet()), 'a reset is described as ending every session')
  const pwInput = page.locator('input[autocomplete="new-password"]')
  await pwInput.fill('short')
  ok(
    await page.getByRole('button', { name: /^Set$/ }).isDisabled(),
    'a too-short password cannot be submitted',
  )
  await pwInput.fill('a-proper-long-password')
  await page.getByRole('button', { name: /^Set$/ }).click()
  await page.waitForTimeout(700)
  ok(passwordPosted?.password === 'a-proper-long-password', 'the new password reaches the server')

  /* ---- the safer alternative is offered ---- */
  await manageRow('Marcus Vance').click()
  await page.waitForTimeout(600)
  ok(
    /never see it/i.test(await sheet()),
    'the reset-link option says the admin never learns the password',
  )

  /* ---- deactivate is the prominent action, delete is not ---- */
  ok(/Remove from team/.test(await sheet()), 'removing someone is offered as the ordinary action')
  ok(
    /work stays|visits, notes and numbers stay/i.test(await sheet()),
    'and is described as keeping their work',
  )
  await page.getByRole('button', { name: /Remove from team/ }).click()
  await page.waitForTimeout(700)
  ok(activePosted?.active === false, 'removing someone deactivates rather than deletes')

  /* ---- THE assertion: delete states what it destroys, before it happens ---- */
  await manageRow('Marcus Vance').click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /^Delete Marcus Vance…$/ }).click()
  await page.waitForTimeout(700)
  const warn = await sheet()
  ok(/591 records/.test(warn), `the real record count is shown before deleting (${warn.match(/[\d,]+ records?/)?.[0]})`)
  ok(/214/.test(warn) && /240/.test(warn), 'broken down by kind rather than as one number')
  ok(
    /50 assigned leads will survive/i.test(warn),
    'and what survives is stated too — the leads outlive the person',
  )
  ok(deleted === false, 'nothing was deleted merely by opening the confirmation')

  const confirmBtn = page.getByRole('button', { name: /^Delete permanently$/ })
  ok(await confirmBtn.isDisabled(), 'the confirm button is dead until the name is typed')
  await page.locator('input').filter({ hasNot: page.locator('[type=email]') }).last().fill('Marcus')
  await page.waitForTimeout(200)
  ok(await confirmBtn.isDisabled(), 'a partial name is not enough')
  await page.locator('input').filter({ hasNot: page.locator('[type=email]') }).last().fill('Marcus Vance')
  await page.waitForTimeout(200)
  ok(!(await confirmBtn.isDisabled()), 'the exact name enables it')
  await confirmBtn.click()
  await page.waitForTimeout(700)
  ok(deleted === true, 'and then it deletes')
}

/* --- you cannot lock yourself out ---------------------------------------- */
{
  await page.locator('tbody tr').filter({ hasText: ADMIN.name }).getByRole('button', { name: /Manage/ }).click()
  await page.waitForTimeout(600)
  const own = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(
    /can’t remove or delete your own account|cannot remove or delete your own account/i.test(own),
    'your own account offers no remove or delete',
  )
  ok(
    (await page.getByRole('button', { name: /Remove from team/ }).count()) === 0,
    'the remove button is absent on your own row, not merely disabled',
  )
  ok(
    (await page.getByRole('button', { name: /^Delete .*…$/ }).count()) === 0,
    'and so is delete',
  )
  ok(
    (await page.locator('input[autocomplete="new-password"]').count()) === 1,
    'but you can still change your own password',
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

/* --- a rejection is surfaced, not swallowed ------------------------------- */
await page.unroute('**/api/invites')
await page.route('**/api/invites', json(409, { error: 'That person already has an account.' }))
await page.getByRole('button', { name: /Invite user/ }).click()
await page.waitForTimeout(300)
{
  const dialog2 = page.getByRole('dialog')
  await dialog2.locator('input[type="text"], input:not([type])').first().fill('Marcus Vance')
  await dialog2.locator('input[type="email"]').fill('marcus@ridgeline.test')
}
await page.getByRole('button', { name: /Create invite/ }).click()
await page.waitForTimeout(700)
ok(
  /already has an account/i.test(await body()),
  'the server’s reason for refusing is shown verbatim',
)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

/* --- settings that actually reach the phone ------------------------------- */
//
// A setting that saves but changes nothing on the phone is worse than one that
// says it is disabled — it looks like it worked. So this asserts the round trip
// all the way to the buttons a rep taps, not just that a POST was sent.
{
  let savedSettings = null
  await page.route('**/api/settings', async (route) => {
    savedSettings = JSON.parse(route.request().postData() || '{}').settings
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, settings: savedSettings }),
    })
  })

  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  const body = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

  ok(
    !/Saving is disabled/.test(await body()),
    'the screen no longer says saving is disabled',
  )
  ok(
    !/Summit Exteriors/.test(await body()),
    'and does not name the demo company on a live account',
  )
  ok(/Ridgeline Roofing/.test(await body()), 'it names the real one')

  // Rename an outcome and move it up the grid.
  const quoteInput = page.locator('tbody tr').filter({ hasText: 'quote_requested' }).locator('input')
  await quoteInput.fill('Estimate requested')
  await page.locator('tbody tr').filter({ hasText: 'quote_requested' })
    .getByRole('button', { name: /Move .* up/ }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /Save changes/ }).first().click()
  await page.waitForTimeout(800)

  ok(savedSettings !== null, 'saving sends the settings')
  const sent = savedSettings.outcomes.find((o) => o.code === 'quote_requested')
  ok(sent?.label === 'Estimate requested', 'the new label is sent against the unchanged code')
  ok(
    savedSettings.outcomes.every((o) => typeof o.order === 'number'),
    'with an explicit order, because order is what a rep sees',
  )
  // Nothing structural may travel: a label change must not be able to rewrite
  // what an outcome means.
  ok(
    Object.keys(sent).sort().join(',') === 'code,label,order',
    `only code, label and order are sent (${Object.keys(sent).join(',')})`,
  )
  ok(/Saved\./.test(await body()), 'and the operator is told it saved')

  await ctx.close()
}

/* --- the labels a rep actually sees --------------------------------------- */
{
  const ctx4 = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5115, longitude: -97.6755 },
  })
  const rep = {
    id: 'u_rep', clientId: 'c_live', clientName: 'Ridgeline Roofing',
    email: 'rep@ridgeline.test', name: 'Marcus Vance', role: 'field_rep',
  }
  const page4 = await ctx4.newPage()
  await page4.route('**/api/auth/login', json(200, { token: 'tok', user: rep }))
  await page4.route('**/api/mutations', json(200, { results: [], serverTime: Date.now() }))
  await page4.route('**/api/bootstrap', json(200, {
    user: rep,
    properties: [{
      id: 'p1', address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664',
      lat: 30.5115, lng: -97.6755, status: 'new', score: 60, assignedRepId: 'u_rep', contacts: [],
    }],
    routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [],
    // The company renamed one outcome and put it first.
    settings: {
      outcomes: [
        { code: 'quote_requested', label: 'Estimate requested', order: 0 },
        { code: 'no_answer', label: 'Nobody home', order: 1 },
      ],
      noteTemplates: ['Wants an estimate'],
    },
    serverTime: Date.now(),
  }))

  await page4.goto(BASE, { waitUntil: 'networkidle' })
  await page4.locator('input[type="email"]').fill(rep.email)
  await page4.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page4.getByRole('button', { name: /^Sign in$/ }).click()
  await page4.waitForTimeout(1600)

  await page4.goto(`${BASE}/property/p1`, { waitUntil: 'domcontentloaded' })
  await page4.waitForTimeout(700)
  await page4.getByRole('button', { name: /Start visit/ }).first().click()
  await page4.waitForTimeout(900)

  const grid = (await page4.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/Estimate requested/.test(grid), 'the rep sees the company’s label, not the default')
  ok(!/Quote/.test(grid), 'and the default label is gone')
  ok(/Nobody home/.test(grid), 'a second relabelled outcome comes through too')
  // Everything the company did not touch must still be there — a partial
  // override cannot be allowed to delete the rest of the grid.
  ok(/Sold/.test(grid) && /Do Not Contact/.test(grid), 'untouched outcomes keep their defaults')

  /*
    Order is a real setting, not a cosmetic one: the first outcome is rendered
    as the full-width target, separately from the grid holding the rest. So the
    assertion is on document order across the whole outcome area, not on the
    first child of the grid — which is the *second* outcome.
  */
  const outcomeButtons = await page4.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
      // Every outcome the grid can render, whether relabelled or not — an
      // override must reorder and rename, never remove.
      .filter((t) =>
        /Estimate requested|Nobody home|Interested|Follow Up|Appointment|Sold|Do Not Contact/.test(
          t,
        ),
      ),
  )
  ok(
    /Estimate requested/.test(outcomeButtons[0] ?? ''),
    `the reordered outcome is rendered first (${outcomeButtons.slice(0, 3).join(' | ')})`,
  )
  ok(
    outcomeButtons.length === 8,
    `and all eight outcomes are still present (${outcomeButtons.length})`,
  )

  await ctx4.close()
}

/* --- the activity log ----------------------------------------------------- */
//
// The log exists for the conversation that starts "I never did that", so what
// matters is that a reader can settle the argument without translating event
// names into English.
{
  const ctx5 = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx5.newPage()
  await page.route('**/api/auth/login', json(200, { token: 'tok', user: ADMIN }))
  await page.route('**/api/users', json(200, { users: roster }))
  await page.route('**/api/bootstrap', json(200, {
    user: ADMIN, properties: [], routes: [], appointments: [], tasks: [],
    activity: [], dailyStats: [], territories: [], serverTime: Date.now(),
  }))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)

  const ENTRIES = [
    { id: 'a1', actorName: 'Nadia Petrov', action: 'user.deleted', targetType: 'user',
      targetLabel: 'Marcus Vance', detail: { email: 'marcus@ridgeline.test', role: 'field_rep' },
      at: Date.now() - 60_000 },
    { id: 'a2', actorName: 'Nadia Petrov', action: 'user.role_changed', targetType: 'user',
      targetLabel: 'Priya Raman', detail: { from: 'field_rep', to: 'manager' }, at: Date.now() - 120_000 },
    { id: 'a3', actorName: 'Priya Raman', action: 'user.password_set', targetType: 'user',
      targetLabel: 'Priya Raman', detail: { self: true }, at: Date.now() - 180_000 },
    { id: 'a4', actorName: 'Nadia Petrov', action: 'user.password_set', targetType: 'user',
      targetLabel: 'Owen Boone', detail: { self: false }, at: Date.now() - 240_000 },
    { id: 'a5', actorName: 'Nadia Petrov', action: 'leads.imported', targetType: 'import',
      targetLabel: 'Cedar Bend — August', detail: { created: 50, updated: 0, rejected: 2 },
      at: Date.now() - 300_000 },
  ]
  await page.route('**/api/audit*', json(200, { entries: ENTRIES }))
  await page.goto(`${BASE}/admin/audit`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const log = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  ok(
    /Nadia Petrov permanently deleted Marcus Vance/.test(log),
    'a deletion reads as a sentence, naming both people',
  )
  ok(
    /changed Priya Raman from Field Rep to Manager/.test(log),
    'a role change says what it changed from and to, in words',
  )
  ok(
    /Priya Raman changed their own password/.test(log),
    'a self-service password change is phrased as one',
  )
  ok(
    /Nadia Petrov set a new password for Owen Boone/.test(log),
    'and an admin setting someone else’s is phrased differently — the distinction is the point',
  )
  ok(!/user\.role_changed|user\.deleted/.test(log), 'no raw event names reach the screen')
  ok(
    /read-only|cannot be edited or removed/i.test(log),
    'the page states that the log cannot be edited',
  )

  // Filters narrow the view; none of them can remove an entry from the record.
  await page.getByRole('button', { name: /^Leads$/ }).click()
  await page.waitForTimeout(400)
  const leadsOnly = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/imported leads/.test(leadsOnly), 'filtering to leads keeps the import')
  ok(!/permanently deleted/.test(leadsOnly), 'and hides the unrelated entries')
  await page.getByRole('button', { name: /^Everything$/ }).click()
  await page.waitForTimeout(400)
  ok(
    /permanently deleted/.test((await page.locator('body').innerText()).replace(/\s+/g, ' ')),
    'clearing the filter brings them back — filtering hides, it never deletes',
  )
  await ctx5.close()
}

/* ========== a live account never shows the demo team ===================== */
//
// Found while auditing for production readiness: Reports, the Dashboard and the
// team leaderboard resolved rep names straight from `data/seed`, so a real
// company's reports listed five people who do not work there and none of the
// ones who do. Team and Territories had been fixed; these had not, because each
// screen fetched or derived the roster on its own.
{
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page3 = await ctx3.newPage()
  const REAL = [
    { id: 'u_admin', name: 'Nadia Petrov', email: ADMIN.email, role: 'client_admin', active: true, pending: false },
    { id: 'u_rep_real', name: 'Marcus Vance', email: 'marcus@ridgeline.test', role: 'field_rep', active: true, pending: false },
  ]
  await page3.route('**/api/auth/login', json(200, { token: 'tok', user: ADMIN }))
  await page3.route('**/api/users', json(200, { users: REAL }))
  await page3.route('**/api/bootstrap', json(200, {
    user: ADMIN,
    properties: [],
    routes: [],
    appointments: [],
    tasks: [],
    activity: [],
    territories: [],
    dailyStats: [
      { id: 'd1', repId: 'u_rep_real', day: new Date().toISOString().slice(0, 10),
        knocks: 42, conversations: 11, appointments: 3, quotes: 2, sold: 1, pipelineValue: 21000 },
    ],
    serverTime: Date.now(),
  }))

  await page3.goto(BASE, { waitUntil: 'networkidle' })
  await page3.locator('input[type="email"]').fill(ADMIN.email)
  await page3.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page3.getByRole('button', { name: /^Sign in$/ }).click()
  await page3.waitForTimeout(1600)

  const DEMO_NAMES = /Dana Whitfield|Ray Okafor|Luis Ortega|Simone|Priya Raman/

  for (const [label, path] of [
    ['Dashboard', '/admin'],
    ['Reports', '/admin/reports'],
    ['Team', '/admin/team'],
    ['Territories', '/admin/territories'],
  ]) {
    await page3.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page3.waitForTimeout(1100)
    const text = (await page3.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(!DEMO_NAMES.test(text), `${label}: no seeded demo rep appears on a live account`)
  }

  // And the real rep is actually named, not shown as a raw id.
  await page3.goto(`${BASE}/admin/reports`, { waitUntil: 'domcontentloaded' })
  await page3.waitForTimeout(1100)
  const reports = (await page3.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/Marcus Vance/.test(reports), 'Reports names the real rep')
  ok(!/u_rep_real/.test(reports), 'and not their internal id')

  await ctx3.close()
}

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
