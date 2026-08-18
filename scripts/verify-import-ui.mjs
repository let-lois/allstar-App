import { chromium } from 'playwright'

/**
 * The import wizard, in a browser.
 *
 * The server side is covered by `api/scripts/smoke-import.mjs`; this covers the
 * half a spreadsheet operator actually touches, and the half where a mistake is
 * silent rather than loud:
 *
 *   - a messy real-world header row maps to the right fields
 *   - rows with no coordinates are held back rather than imported invisible
 *   - the demo can't write to a real database
 *
 * The API is mocked at the network layer so a failure here means the client is
 * wrong, not that a government geocoder was slow.
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
  id: 'u_live_admin',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'admin@ridgeline.test',
  name: 'Nadia Petrov',
  role: 'client_admin',
}

const EMPTY_BOOTSTRAP = {
  user: ADMIN,
  properties: [],
  routes: [],
  appointments: [],
  tasks: [],
  activity: [],
  dailyStats: [],
  serverTime: Date.now(),
}

const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * Headers a real export actually uses — none of them match our field names, and
 * the coordinate columns are absent entirely, which is the normal case.
 */
const MESSY_CSV = [
  'PROPERTY_ADDRESS,City,ST,Zip Code,Owner Name,Primary Phone,Estimated Value',
  '"1420 Cedar Bend Dr",Round Rock,TX,78664,"Whitfield, Dana",512-555-0134,"$14,500"',
  '"1422 Cedar Bend Dr",Round Rock,TX,78664,,,',
  '"1424 Cedar Bend Dr",Round Rock,TX,78664,"Vance, Marcus",512-555-0199,"$9,200"',
  ',Round Rock,TX,78664,"No Address Here",,',
].join('\n')

async function signedInConsole(ctx, { withGeocode = true } = {}) {
  const page = await ctx.newPage()
  await page.route('**/api/auth/login', json(200, { token: 'tok_admin', user: ADMIN }))
  await page.route('**/api/bootstrap', json(200, EMPTY_BOOTSTRAP))
  await page.route('**/api/users', json(200, {
    users: [
      { id: 'u_rep_1', name: 'Marcus Vance', email: 'marcus@ridgeline.test', role: 'field_rep', active: true, pending: false },
      { id: 'u_rep_2', name: 'Priya Raman', email: 'priya@ridgeline.test', role: 'field_rep', active: true, pending: true },
    ],
  }))
  if (withGeocode) {
    // Two of three place; one is deliberately unfindable.
    await page.route('**/api/import/geocode', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      const matches = body.rows.map((r, i) =>
        i === 1
          ? { ref: r.ref, status: 'no_match' }
          : {
              ref: r.ref,
              status: 'match',
              lat: 30.5115 + i * 0.0002,
              lng: -97.6755 - i * 0.0002,
              matchedAddress: `${r.address1.toUpperCase()}, ROUND ROCK, TX, 78664`,
            },
      )
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matches }) })
    })
  }
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1400)
  await page.goto(`${BASE}/admin/import`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  return page
}

/* ========== the happy path, with a messy file ============================ */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await signedInConsole(ctx)
  let importPosted = null
  await page.route('**/api/import/properties', async (route) => {
    importPosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ created: importPosted.rows.length, updated: 0, rejected: [], territoryId: 'terr_x' }),
    })
  })

  ok((await page.locator('text=/Import leads/').count()) > 0, 'the import page loads in the console')

  await page.locator('textarea').fill(MESSY_CSV)
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(500)

  ok((await page.locator('text=/4 rows found/').count()) > 0, 'all four data rows are counted')

  // Auto-mapping against headers that share none of our field names.
  const valueOf = (label) =>
    page.evaluate((l) => {
      const labels = [...document.querySelectorAll('label')]
      const hit = labels.find((el) => el.textContent?.trim().startsWith(l))
      return hit?.querySelector('select')?.value ?? null
    }, label)

  ok((await valueOf('Street address')) === 'PROPERTY_ADDRESS', 'maps PROPERTY_ADDRESS to the street address')
  ok((await valueOf('State')) === 'ST', 'maps the ST abbreviation to state')
  ok((await valueOf('ZIP')) === 'Zip Code', 'maps Zip Code to ZIP')
  ok((await valueOf('Owner name')) === 'Owner Name', 'maps Owner Name')
  ok((await valueOf('Phone')) === 'Primary Phone', 'maps Primary Phone')
  ok((await valueOf('Latitude')) === '', 'no latitude column is invented when the file has none')

  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(600)

  const tally = async (label) =>
    page.evaluate((l) => {
      const el = [...document.querySelectorAll('p')].find((p) => p.textContent?.trim() === l)
      return el?.previousElementSibling?.textContent?.trim() ?? null
    }, label)

  // Nothing is importable yet: no coordinates means invisible on a map.
  ok((await tally('Ready to import')) === '0', 'a file with no coordinates has nothing ready yet')
  ok((await tally('Need an address lookup')) === '3', 'the three real addresses need a lookup')
  ok((await tally('No street address')) === '1', 'the blank-address row is counted separately')

  ok(
    (await page.getByRole('button', { name: /^Import 0 leads$/ }).count()) > 0 ||
      (await page.getByRole('button', { name: /Import 0 lead/ }).isDisabled()),
    'the import button offers nothing while no row is placed',
  )

  // A quoted comma in the owner column must not have shifted the fields.
  ok(
    (await page.locator('td', { hasText: 'Whitfield, Dana' }).count()) > 0,
    'a comma inside a quoted owner name survives into the preview',
  )

  await page.getByRole('button', { name: /Look up 3 addresses/ }).click()
  await page.waitForTimeout(1200)

  ok((await tally('Ready to import')) === '2', 'placed rows become ready')
  ok((await tally('Need an address lookup')) === '1', 'the unplaceable row stays held back')
  ok((await page.locator('text=/Not found/').count()) > 0, 'the unplaceable row is labelled, not silently dropped')
  ok(
    (await page.locator('text=/1420 CEDAR BEND DR, ROUND ROCK/').count()) > 0,
    'the geocoder’s normalised address is shown so a wrong match is visible',
  )

  await page.locator('input[placeholder*="Cedar Bend"]').fill('Cedar Bend — August')
  await page.selectOption('select:below(:text("Assign to"))', 'u_rep_1').catch(async () => {
    const sel = page.locator('select').filter({ hasText: 'Nobody yet' })
    await sel.selectOption('u_rep_1')
  })
  await page.waitForTimeout(200)

  await page.getByRole('button', { name: /^Import 2 leads$/ }).click()
  await page.waitForTimeout(1400)

  ok(importPosted !== null, 'the import request was sent')
  ok(importPosted?.rows?.length === 2, `only placed rows were sent (${importPosted?.rows?.length})`)
  ok(
    importPosted?.rows?.every((r) => typeof r.lat === 'number' && typeof r.lng === 'number'),
    'every row sent carries coordinates',
  )
  ok(importPosted?.territoryName === 'Cedar Bend — August', 'the territory name was sent')
  ok(importPosted?.assignRepId === 'u_rep_1', 'the chosen rep was sent')
  // "$14,500" has to arrive as a number, not a string with a currency symbol.
  const withValue = importPosted?.rows?.find((r) => r.address1.startsWith('1420'))
  ok(withValue?.opportunityValue === 14500, `a currency-formatted value is parsed to a number (${withValue?.opportunityValue})`)
  ok(withValue?.ownerName === 'Whitfield, Dana', 'the owner name reaches the server intact')

  ok((await page.locator('text=/Import finished/').count()) > 0, 'the operator sees a result summary')
  ok((await page.locator('text=/New leads created/').count()) > 0, 'the summary reports what was created')

  await ctx.close()
}

/* ========== unassigned leads must appear on the territory map ============ */
//
// Reported from the field: an import with no territory name produced a
// Territories page reading "14 properties" in the table and "0 properties" on
// the map beside it. The table bucketed leads with no territory under a
// synthetic id; the map filtered on `territoryId === selected`, which is
// undefined for exactly those rows. The bucket could be selected and never
// matched anything — so every lead from a default import was invisible.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx.newPage()
  const placed = (n, territoryId) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${territoryId ?? 'u'}${i}`,
      address1: `${100 + i * 2} Cedar Bend Dr`,
      city: 'Round Rock',
      state: 'TX',
      zip: '78664',
      lat: 30.5115 + i * 0.0006,
      lng: -97.6755 - i * 0.0006,
      status: 'new',
      score: 60,
      opportunityValue: 21000,
      territoryId,
      contacts: [],
    }))

  await page.route('**/api/auth/login', json(200, { token: 'tok_admin', user: ADMIN }))
  await page.route('**/api/users', json(200, { users: [
    { id: 'u_rep_1', name: 'Marcus Vance', email: 'm@x.test', role: 'field_rep', active: true, pending: false },
  ] }))
  await page.route('**/api/bootstrap', json(200, {
    ...EMPTY_BOOTSTRAP,
    // Fourteen with no territory at all, plus a named one to prove both work.
    properties: [...placed(14, undefined), ...placed(3, 'terr_abc')],
    territories: [{ id: 'terr_abc', name: 'Cedar Bend — August' }],
  }))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const text = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))

  ok(/Unassigned/.test(await text()), 'the unassigned bucket is labelled readably, not "unassigned" as an id')
  ok(
    !/__unassigned__/.test(await text()),
    'the internal sentinel never reaches the screen',
  )
  ok(
    /Cedar Bend — August/.test(await text()),
    'a named territory shows its name rather than its id hash',
  )

  const panelCount = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('span')].find((s) =>
        /^\d+ properties$/.test((s.textContent || '').trim()),
      )
      return el?.textContent?.trim() ?? null
    })

  /*
    Rows are matched on their first cell, not on their text: every row's rep
    dropdown contains an option reading "Unassigned", so a whole-row text filter
    matches all of them.
  */
  const rowNamed = (name) =>
    page.locator('tbody tr').filter({ has: page.locator(`td:first-child:text-is("${name}")`) })

  // The count beside the map is the thing that read 0 while the table read 14.
  await rowNamed('Unassigned').click()
  await page.waitForTimeout(700)
  const unassignedCount = await panelCount()
  ok(unassignedCount === '14 properties', `the map panel agrees with the table (${unassignedCount})`)

  // And selecting the named territory switches the map to its three.
  await rowNamed('Cedar Bend — August').click()
  await page.waitForTimeout(700)
  const after = await panelCount()
  ok(after === '3 properties', `selecting a territory filters the map to it (${after})`)

  // The rep dropdown must offer the real team, not the demo roster.
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('select')].flatMap((s) => [...s.options].map((o) => o.text)),
  )
  ok(options.includes('Marcus Vance'), 'the assignment dropdown lists the real team')
  ok(
    !options.includes('Dana Whitfield'),
    'demo reps are not offered on a live account — they do not work here',
  )

  /* ---- and assigning actually assigns --------------------------------- */
  //
  // This dropdown existed for several builds as decoration, under a footnote
  // saying reassignment was read-only. A control that looks live and does
  // nothing is worse than no control: an admin sets it, believes a rep has
  // been given the patch, and the rep opens an empty app.
  let assignPosted = null
  await page.route('**/api/territories/assign', async (route) => {
    assignPosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ assigned: 14 }),
    })
  })

  // Target the row by the name the operator reads, not by position.
  const unassignedRow = rowNamed('Unassigned')
  await unassignedRow.locator('select').selectOption('u_rep_1')
  await page.waitForTimeout(900)

  ok(assignPosted !== null, 'changing the rep sends an assignment')
  ok(
    assignPosted?.territoryId === null,
    `the unassigned bucket goes over the wire as null, not as the internal sentinel (${assignPosted?.territoryId})`,
  )
  ok(assignPosted?.repId === 'u_rep_1', 'the chosen rep is sent')
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr td:first-child')].map((c) => c.textContent?.trim()),
  )
  ok(
    order[order.length - 1] === 'Unassigned',
    `the catch-all bucket sorts last rather than by its internal id (${order.join(' | ')})`,
  )
  const confirm = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/14 leads assigned/.test(confirm), 'the operator is told how many leads moved')
  ok(
    /next time their phone syncs/i.test(confirm),
    'and that it reaches the rep on their next sync rather than instantly',
  )

  // A refusal must not look like success.
  await page.unroute('**/api/territories/assign')
  await page.route('**/api/territories/assign', json(400, { error: 'That person is not on this team.' }))
  await unassignedRow.locator('select').selectOption('')
  await page.waitForTimeout(800)
  ok(
    /not on this team/.test((await page.locator('body').innerText()).replace(/\s+/g, ' ')),
    'a refused assignment shows the server’s reason instead of appearing to work',
  )

  await ctx.close()
}

/* ========== the office can find and move a single lead =================== */
//
// Before this page existed, the console could count leads and draw them on a
// map but not answer "what happened at 1420 Cedar Bend" — and moving one house
// to a different rep had no path at all short of re-importing.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx.newPage()
  const leads = [
    { id: 'p1', address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664',
      lat: 30.51, lng: -97.67, status: 'new', score: 60, opportunityValue: 21000,
      assignedRepId: 'u_rep_1', contacts: [{ id: 'c1', name: 'Ada Reyes', phone: '512-555-0101', isPrimary: true }] },
    { id: 'p2', address1: '99 Oak Ridge Ln', city: 'Austin', state: 'TX', zip: '78701',
      lat: 30.27, lng: -97.74, status: 'won', score: 80, opportunityValue: 30000,
      assignedRepId: 'u_rep_2', contacts: [] },
    { id: 'p3', address1: '5 Elm Ct', city: 'Round Rock', state: 'TX', zip: '78664',
      lat: 30.52, lng: -97.66, status: 'new', score: 40, contacts: [] },
  ]
  await page.route('**/api/auth/login', json(200, { token: 'tok_admin', user: ADMIN }))
  await page.route('**/api/users', json(200, { users: [
    { id: 'u_rep_1', name: 'Marcus Vance', email: 'm@x.test', role: 'field_rep', active: true, pending: false },
    { id: 'u_rep_2', name: 'Priya Raman', email: 'p@x.test', role: 'field_rep', active: true, pending: false },
  ] }))
  await page.route('**/api/bootstrap', json(200, { ...EMPTY_BOOTSTRAP, properties: leads, territories: [] }))
  let movePosted = null
  await page.route('**/api/properties/assign', async (route) => {
    movePosted = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ assigned: movePosted.propertyIds.length }) })
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const body = () => page.locator('body').innerText().then((t) => t.replace(/\s+/g, ' '))
  const rowCount = () => page.locator('tbody tr').count()

  ok((await rowCount()) === 3, 'every lead is listed')
  ok(/Marcus Vance/.test(await body()), 'each lead names the rep holding it')
  ok(/Nobody/.test(await body()), 'and an unassigned lead says so rather than showing a blank')
  ok(/Ada Reyes/.test(await body()), 'the owner is shown, so a lead can be found by who lives there')

  // Search — the thing the console could not do at all before.
  await page.locator('input[type="search"]').fill('Cedar Bend')
  await page.waitForTimeout(400)
  ok((await rowCount()) === 1, 'searching an address narrows to it')
  await page.locator('input[type="search"]').fill('78701')
  await page.waitForTimeout(400)
  ok((await rowCount()) === 1, 'searching a ZIP works too')
  await page.locator('input[type="search"]').fill('')
  await page.waitForTimeout(400)

  // Filtering by rep is how an office answers "what does Priya have".
  await page.selectOption('select', 'u_rep_2')
  await page.waitForTimeout(400)
  ok((await rowCount()) === 1, 'filtering by rep shows only their leads')
  await page.selectOption('select', 'unassigned')
  await page.waitForTimeout(400)
  ok(
    (await rowCount()) === 1 && /5 Elm Ct/.test(await body()),
    'and unassigned leads can be found as a group — the ones nobody is working',
  )
  await page.selectOption('select', 'all')
  await page.waitForTimeout(400)

  /* ---- moving one house ---- */
  ok(
    (await page.getByRole('button', { name: /^Apply$/ }).count()) === 0,
    'no bulk action is offered until something is selected',
  )
  await page.locator('tbody tr').filter({ hasText: '5 Elm Ct' }).locator('input[type="checkbox"]').check()
  await page.waitForTimeout(300)
  ok(/1 selected/.test(await body()), 'selecting a lead shows what will be acted on')

  await page.locator('select').last().selectOption('u_rep_1')
  await page.getByRole('button', { name: /^Apply$/ }).click()
  await page.waitForTimeout(900)

  ok(movePosted?.propertyIds?.length === 1, 'only the selected lead was sent')
  ok(movePosted?.propertyIds?.[0] === 'p3', 'and it was the right one')
  ok(movePosted?.repId === 'u_rep_1', 'to the chosen rep')
  ok(
    /1 lead moved to Marcus Vance/.test(await body()),
    'the operator is told what happened, by name',
  )
  ok(
    /next time their phone syncs/i.test(await body()),
    'and that it reaches the rep on their next sync rather than instantly',
  )

  // "Select all" must not reach past what is on screen.
  await page.locator('input[type="search"]').fill('Cedar Bend')
  await page.waitForTimeout(400)
  await page.locator('thead input[type="checkbox"]').check()
  await page.waitForTimeout(300)
  ok(
    /1 selected/.test(await body()),
    'select-all covers the filtered rows only, never the ones hidden by a filter',
  )

  await ctx.close()
}

/* ========== a file that isn't a CSV ====================================== */
//
// Reported from the field: a Windows shortcut (.lnk) was dragged in instead of
// the file it points at. The app decoded the pointer, found a "header row" in
// the mojibake, and showed a column mapper full of binary garbage under the
// heading "2 rows found". No error, no way for the operator to tell whether the
// fault was theirs or the app's.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await signedInConsole(ctx)

  const drop = async (name, bytes) => {
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(bytes),
    })
    await page.waitForTimeout(500)
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  }

  // A real shell link: "L\0\0\0", the link GUID, then the path it points at.
  const lnk = [
    0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
    ...Buffer.from('C:\\Users\\me\\DOWNLO~1\\TEST-L~1.CSV'),
  ]
  let text = await drop('test-leads.csv.lnk', lnk)
  ok(/shortcut/i.test(text), 'a dropped shortcut is named as a shortcut')
  ok(!/rows found/i.test(text), 'a shortcut never reports a row count')
  ok(
    (await page.locator('select').count()) === 0,
    'no column mapper is shown for a file that could not be read',
  )
  ok(
    (await page.locator('textarea').count()) > 0,
    'the operator is left on the file-choosing step, able to try again',
  )

  // An .xlsx is the mistake this will hit most often — "my spreadsheet" and "my
  // CSV" are the same thing to everyone who isn't a programmer.
  text = await drop('leads.xlsx', [0x50, 0x4b, 0x03, 0x04, ...Buffer.from('xl/workbook.xml')])
  ok(/excel|workbook/i.test(text), 'an Excel workbook is named as one')
  ok(/save as/i.test(text), 'and the operator is told how to convert it')

  text = await drop('report.pdf', Buffer.from('%PDF-1.7\n1 0 obj'))
  ok(/pdf/i.test(text), 'a PDF is named as a PDF')

  // And a good file still works immediately afterwards — the error state must
  // not wedge the wizard.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'leads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(MESSY_CSV),
  })
  await page.waitForTimeout(600)
  text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(/4 rows found/.test(text), 'a real CSV loads straight after a rejected one')
  ok(!/shortcut|excel|pdf/i.test(text), 'the previous error is cleared')

  await ctx.close()
}

/* ========== the demo must not be able to write to a real database ======== */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx.newPage()
  let wrote = false
  await page.route('**/api/import/**', (route) => {
    wrote = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Nadia Petrov/ }).click()
  await page.waitForTimeout(1300)
  await page.goto(`${BASE}/admin/import`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  ok(
    (await page.locator('text=/You’re in the demo/').count()) > 0,
    'the demo says plainly that it cannot import',
  )

  await page.locator('textarea').fill(MESSY_CSV)
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.waitForTimeout(600)

  // The mapping and preview still work — that's the useful part of a dry run.
  ok((await page.locator('text=/Need an address lookup/').count()) > 0, 'the demo can still preview a file')

  const lookup = page.getByRole('button', { name: /Look up 3 addresses/ })
  ok(await lookup.isDisabled(), 'address lookup is disabled in the demo')
  const importBtn = page.getByRole('button', { name: /Import 0 lead/ })
  ok(await importBtn.isDisabled(), 'importing is disabled in the demo')
  ok(wrote === false, 'the demo made no write request at all')

  await ctx.close()
}

/* ========== a rep has no business here =================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(1300)
  await page.goto(`${BASE}/admin/import`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  ok(
    (await page.locator('text=/Not available for your role/').count()) > 0,
    'a field rep reaching the import URL directly is refused',
  )
  ok((await page.locator('textarea').count()) === 0, 'no import form is rendered for a rep')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} import-ui check(s) failed` : '\nimport wizard works')
process.exit(fails.length ? 1 : 0)
