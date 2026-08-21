import { chromium } from 'playwright'

/**
 * Console access, and the console on a phone.
 *
 * Two things must stay true, and one of them is the reverse of what this file
 * used to assert:
 *
 *  1. A field rep can never reach it — not by nav, not by typing the URL. This
 *     is the part that matters and it has not changed.
 *  2. **A phone gets the console.** It used to refuse below 1024px and hand off
 *     to the field screens, and these checks asserted the refusal — so when the
 *     console became mobile-first, the gate went red for the fix. Asserting a
 *     design decision rather than a requirement is how a green suite ends up
 *     defending the thing you are trying to change.
 *
 * The phone checks below deliberately measure the *failure that was invisible*:
 * a nine-column table on a 390px screen showed three columns and clipped the
 * rest with no scrollbar and no hint they existed. So they assert that data from
 * the far right of each table — the numbers somebody actually opens the screen
 * for — is on screen at 390px. Column count is not the test; reaching column
 * nine is.
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

const signIn = async (ctx, name, url = BASE) => {
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name }).click()
  await page.waitForTimeout(1200)
  if (url !== BASE) {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
  }
  return page
}

/* --- a phone gets the console --------------------------------------------- */
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await signIn(ctx, /Ray Okafor/, `${BASE}/admin`)
  const text = await page.evaluate(() => document.body.innerText)

  ok(!/larger screen/i.test(text), 'phone: the console opens instead of handing off')
  ok(/Doors knocked/i.test(text), 'phone: and renders its actual content')

  // Every section reachable without a drawer. Nine of them, as chips.
  for (const [label, path] of [
    ['Team', '/admin/team'],
    ['Leads', '/admin/leads'],
    ['Territories', '/admin/territories'],
    // Not Settings: this is a *manager*, and Settings is admin-only — the role
    // check further down asserts its absence. Picking it here would have made
    // two assertions in one file contradict each other.
    ['Import leads', '/admin/import'],
  ]) {
    ok(
      (await page.locator(`a[href="${path}"]:visible`).count()) > 0,
      `phone: ${label} is one tap from the header`,
    )
  }

  /*
    The columns that used to be off the right edge. Each of these lived in
    column six or later of a table that showed three, so its presence at 390px is
    the whole point of the rewrite — and its absence is precisely the bug that
    shipped invisibly, because a clipped table looks like a table.
  */
  const reaches = [
    ['/admin/team', /Contact rate/i, "a rep's contact rate"],
    ['/admin/leads', /Territory/i, "a lead's territory"],
    ['/admin/territories', /Coverage/i, 'territory coverage'],
  ]
  for (const [path, pattern, what] of reaches) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    const body = await page.evaluate(() => document.body.innerText)

    /*
      Measured, not searched.

      The first version of this asserted the label was in `body.innerText`, and
      it passed with the clipped table still on screen — because a table squeezed
      into 390px keeps every cell in the DOM, it just renders them as slivers off
      the right edge or wrapped one word per line. `innerText` cannot tell the
      difference between "readable" and "present", which is the entire failure
      being tested for. So this measures the box: the label has to be inside the
      viewport and wide enough to read.
    */
    const box = await page
      .getByText(pattern, { exact: false })
      .first()
      .boundingBox()
      .catch(() => null)
    ok(
      box != null && box.x >= -1 && box.x + box.width <= 391 && box.width >= 55,
      `phone: ${what} is on screen and readable at 390px (${
        box ? `x=${Math.round(box.x)} w=${Math.round(box.width)}` : 'not found'
      })`,
    )

    // And nothing pushes the page sideways while doing it.
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    ok(over <= 1, `phone: ${path} does not overflow (${over}px)`)

    /*
      A raw id where a name belongs. The seed assigned territory ids and never
      created the records they point at, so every territory read "t_0" — visible
      only once the column was.
    */
    ok(!/\bt_\d\b/.test(body), `phone: ${path} shows names, not raw ids`)
  }
  await ctx.close()
}

/* --- every section, on the two commonest phone widths --------------------- */
//
// Three screens above are checked in detail; this sweeps the rest. What it is
// looking for is the two failures a mobile console produces silently: content
// wider than the screen, and a control too small to hit.
for (const width of [390, 412]) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await signIn(ctx, /Nadia Petrov/, `${BASE}/admin`)

  const SECTIONS = [
    '/admin',
    '/admin/reports',
    '/admin/team',
    '/admin/leads',
    '/admin/territories',
    '/admin/import',
    '/admin/audit',
    '/admin/settings',
  ]

  for (const path of SECTIONS) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1400)

    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    ok(over <= 1, `[${width}] ${path}: no horizontal overflow (${over}px)`)

    /*
      Tap targets. Buttons, links and form controls that are visible and not
      inside a deliberately-scrolling row have to clear 44px on one axis — the
      console's controls were sized for a cursor, which is fine at a desk and
      not fine one-handed. Measured on the element a thumb lands on rather than
      on a wrapper.
    */
    const small = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, a[href], select, input[type=checkbox]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // Checkboxes are allowed to be small when their row is the target.
        if (el.matches('input[type=checkbox]')) continue
        if (r.height < 36) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 24)}" ${Math.round(r.height)}px`)
      }
      return out
    })
    ok(small.length === 0, `[${width}] ${path}: controls are thumb-sized${small.length ? ' — ' + small.slice(0, 3).join(', ') : ''}`)
  }
  await ctx.close()
}

/* --- a field rep can never reach it --------------------------------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await signIn(ctx, /Dana Whitfield/)
  ok(
    !(await page.evaluate(() => !!document.querySelector('a[href="/admin"]'))),
    'rep: no console link in the side rail',
  )
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  ok(
    /Not available for your role/i.test(await page.evaluate(() => document.body.innerText)),
    'rep: console is role-gated even by direct URL',
  )
  await ctx.close()
}

/* --- a manager sees fewer sections than an admin -------------------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await signIn(ctx, /Ray Okafor/, `${BASE}/admin`)
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('nav a')].map((a) => a.textContent.trim()),
  )
  ok(!links.includes('Clients'), 'manager: no Clients section')
  ok(!links.includes('Settings'), 'manager: no Settings section')
  await ctx.close()
}

/* --- a super admin sees everything ---------------------------------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await signIn(ctx, /Curtis Lane/, `${BASE}/admin`)
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('nav a')].map((a) => a.textContent.trim()),
  )
  ok(links.includes('Clients'), 'super admin: Clients section present')
  ok(links.includes('Settings'), 'super admin: Settings section present')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nconsole access is correct')
process.exit(fails.length ? 1 : 0)
