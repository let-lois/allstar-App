import { chromium } from 'playwright'

/**
 * Console access check.
 *
 * The office console is the one desktop-first surface in a mobile-first app, and
 * it's the only place with role-restricted data. Two things must stay true:
 *
 *  1. A field rep can never reach it — not by nav, not by typing the URL.
 *  2. On a phone it hands off honestly instead of rendering wide tables badly.
 *
 * Both are the kind of regression a refactor introduces silently.
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

/* --- a phone gets a handoff, not a broken table --------------------------- */
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await signIn(ctx, /Ray Okafor/, `${BASE}/admin`)
  const text = await page.evaluate(() => document.body.innerText)
  ok(/larger screen/i.test(text), 'phone: console hands off to the mobile screens')
  ok(!/Doors knocked/.test(text), 'phone: no desktop dashboard content leaks through')
  ok(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )),
    'phone: no horizontal overflow on the handoff',
  )
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
