import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * One rep's day, and who is allowed to see it.
 *
 * This screen shows where somebody has been working, so the access rule is the
 * feature rather than a detail of it. Two things are pinned:
 *
 * **A rep cannot open another rep's day.** Not by tapping, and not by typing the
 * URL — a route is not a permission, and the gate that matters is the one in the
 * component. A leaderboard that lets anybody drill into anybody's movements is a
 * different product from the one being built here.
 *
 * **A rep can open their own.** That is the other half of not being creepy:
 * nothing is visible to a manager that is hidden from the person it describes,
 * so the same screen has to answer to both.
 *
 * The rest asserts the claim the screen makes about itself — that it is showing
 * logged doors rather than following a phone. If that sentence ever comes off
 * the screen while the map stays, the product has quietly changed its mind about
 * what it is, and this fails.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({
  executablePath: chromiumPath(),
})

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

async function signIn(who) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: who }).click()
  await page.waitForTimeout(2200)
  await dismissTour(page)
  return { ctx, page }
}

/* --- the office can see a rep's day --------------------------------------- */
let otherRepId = null
{
  const { ctx, page } = await signIn(/Ray Okafor/)
  await page.goto(`${BASE}/standings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  const row = page.locator('ul.plate > li button').first()
  ok((await row.count()) > 0, 'the board rows are tappable')
  await row.click()
  await page.waitForTimeout(1400)
  ok(/\/rep\//.test(page.url()), `a manager can open a rep's day (${page.url()})`)
  otherRepId = page.url().split('/rep/')[1]

  const body = await page.locator('body').innerText()
  for (const label of [
    'Doors visited',
    'Conversations',
    'Interested',
    'Appointments',
    'Sales',
  ]) {
    ok(new RegExp(label).test(body), `the funnel shows ${label.toLowerCase()}`)
  }
  ok(/Doors an hour/.test(body), 'and a productivity figure')
  ok(/Working since/.test(body), 'and when they started')
  ok(/doors left|Route/.test(body), 'and what is left of the route')

  /* --- the claim the screen makes about itself --------------------------- */
  ok(/Where the work is/.test(body), 'the map section is titled for work, not for a person')
  ok(
    /not a location trail|records work, not a phone/.test(body),
    'and says plainly that this is logged doors rather than a followed phone',
  )
  ok(
    !/live location|tracking|last seen at/i.test(body),
    'with no language implying a device is being followed',
  )
  await ctx.close()
}

/* --- a rep can open their own --------------------------------------------- */
{
  const { ctx, page } = await signIn(/Dana Whitfield/)
  /*
    Their own row on the board, rather than a session id read out of storage.
    The session lives in IndexedDB, and digging it out would be testing the
    plumbing; tapping the row marked "you" is the path a rep actually takes.
  */
  await page.goto(`${BASE}/standings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const mine = page.locator('ul.plate > li button').filter({ hasText: 'you' })
  ok((await mine.count()) === 1, `the board marks exactly one row as theirs (${await mine.count()})`)
  await mine.first().click()
  await page.waitForTimeout(1400)
  const myId = page.url().split('/rep/')[1]
  ok(myId != null && myId.length > 0, `which opens their own day (${page.url()})`)
  const body = await page.locator('body').innerText()
  ok(/Doors visited/.test(body), 'a rep can see their own day')
  ok(
    !/not yours to see/i.test(body),
    'and is not refused their own screen',
  )
  ok(
    /you have recorded today|records work, not a phone/.test(body),
    'told in the second person, because it is about them',
  )

  /* --- but not somebody else's ------------------------------------------- */
  //
  // The one that matters. A URL is not a permission.
  //
  // `otherRepId` came from the *top of the board* in a manager's session, and
  // which rep that is changes with the day's demo data. When it happened to be
  // this rep, the check opened their own page, the guard correctly allowed it,
  // and the gate reported a leak — a security alarm going off because two ids
  // happened to match.
  //
  // Nothing about that was subtle to fix and everything about it was dangerous
  // to leave: an assertion that cries wolf about access control is the one
  // people learn to wave through. So the id is checked before it is used, and a
  // collision picks a genuinely different rep off the same board rather than
  // quietly testing nothing.
  if (otherRepId === myId) {
    await page.goto(`${BASE}/standings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const notMe = page.locator('ul.plate > li button').filter({ hasNotText: 'you' })
    ok((await notMe.count()) > 0, 'the board has somebody else on it to try')
    await notMe.first().click()
    await page.waitForTimeout(1200)
    otherRepId = page.url().split('/rep/')[1]
  }
  ok(
    otherRepId != null && otherRepId !== myId,
    `the id being tried belongs to somebody else (${otherRepId} vs ${myId})`,
  )

  await page.goto(`${BASE}/rep/${otherRepId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const other = await page.locator('body').innerText()
  const refused = /not yours to see/i.test(other)
  const leaked = /Doors an hour|Where the work is/.test(other)
  ok(
    refused || !leaked,
    `a rep typing another rep's URL is refused (refused=${refused}, leaked=${leaked})`,
  )
  ok(!leaked, 'and no part of the other rep’s day renders')
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== rep detail OK ===')
process.exit(fails.length ? 1 : 0)
