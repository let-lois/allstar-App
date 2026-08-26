import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The standings, as wired up.
 *
 * The rules themselves are covered by `verify:leaderboard`, which runs no browser
 * because the rules are arithmetic. This covers the parts that only exist once
 * the screen is real: that a rep can *find* their rank from the screen they start
 * the day on, that their own row is identifiable at a glance, and that the tie
 * handling the pure test proves in isolation actually reaches the page.
 *
 * The last one is the reason this file exists. Standard competition ranking is
 * easy to get right in a function and easy to lose in a component that re-sorts,
 * and two reps on the same score being shown as 3rd and 4th is the kind of
 * detail that produces an argument in a truck at 6pm.
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

const ctx = await browser.newContext({
  viewport: { width: 390, height: 900 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route(/maps\.googleapis\.com/, (r) => r.abort())

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
// A rep, not a manager: the standings are for the person being ranked.
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(2200)

/* --- a rep can get there from the screen they start on -------------------- */
const strip = page.getByRole('button', { name: /Where you stand today|Top of the board/ })
ok((await strip.count()) > 0, 'Today shows the rep where they stand')
await strip.first().click()
await page.waitForTimeout(1200)
ok(page.url().includes('/standings'), `and it opens the board (${page.url()})`)

const body = await page.locator('body').innerText()

/* --- their own row is findable -------------------------------------------- */
ok(/You today/.test(body), 'the board leads with the rep’s own position')
ok(/#\d+\s+of\s+\d+/.test(body), 'stated as a rank out of the team')
ok(/\byou\b/.test(body), 'and their row in the table is marked')

/* --- the four columns asked for ------------------------------------------- */
for (const col of ['doors', 'convos', 'appts', 'sold']) {
  ok(new RegExp(`\\d+ ${col}`).test(body), `every row carries ${col}`)
}

/* --- awards --------------------------------------------------------------- */
ok(/Top rep/.test(body), 'top rep is awarded')

/*
  Each award is checked against the column it claims to summarise, not merely
  looked for.

  The rule is "the highest non-zero value", so an award over a board of zeroes
  is a trophy on a lie — and that is exactly what a date filter reading the
  wrong side of midnight produces. Not hypothetical: this block failed every
  morning before about nine, because the seed laid today's work out backwards
  from "now" without stopping at the start of the day, so a demo opened early
  showed a team that had knocked one door between them. The award was missing
  and the gate was right, and it still said nothing whatsoever about the
  standings.

  The presence half is a claim about the demo — its day now has doors and
  appointments in it at any hour. The agreement half is a claim about the rule.
*/
for (const [award, column] of [
  ['Most doors', 'doors'],
  ['Most appointments', 'appts'],
]) {
  const shown = new RegExp(award).test(body)
  const any = new RegExp(`[1-9]\\d* ${column}`).test(body)
  ok(any, `the demo has ${column} on the board whatever the hour`)
  ok(
    shown === any,
    `${award} is awarded exactly when there are ${column} (award=${shown}, data=${any})`,
  )
}
/*
  The heading says which period these belong to; the labels must not, or they
  contradict it the moment the board is switched to a week. This used to read
  "Top rep today", which was redundant here and wrong there.
*/
ok(
  /Today.s honours/.test(body) && !/Top rep today/.test(body),
  'the period is on the heading, not repeated inside every award',
)

/*
  Revenue is checked one way only, and the asymmetry is the point.

  It is the money on the properties that were sold, not the count of sales, so a
  sale on a lead carrying no opportunity value is a real state with a sale and
  no revenue. Asserting the equivalence — as this did — was asserting something
  the data does not promise; it happened to hold in the demo. What must hold is
  that the trophy is never handed out with nothing sold behind it.
*/
const hasSale = /[1-9]\d* sold/.test(body)
const revenueAward = /Most revenue/.test(body)
ok(hasSale, 'the demo has a sale on the board whatever the hour')
ok(revenueAward, 'and that sale earns the revenue award')
ok(!revenueAward || hasSale, `no revenue award without a sale (award=${revenueAward}, sales=${hasSale})`)

/* --- ties reach the page -------------------------------------------------- */
//
// Read off the rendered rows rather than recomputed: this is checking that what
// the function decided survived the component.
const ranks = await page.evaluate(() =>
  [...document.querySelectorAll('ul.plate > li')].map((li) => {
    const cells = li.textContent || ''
    const rank = (cells.match(/^T?\d+/) ?? [''])[0]
    const pts = Number((cells.match(/(\d[\d,]*)\s*pts/) ?? ['', '0'])[1].replace(/,/g, ''))
    return { rank, pts }
  }),
)
ok(ranks.length > 0, `the board renders rows (${ranks.length})`)
ok(
  ranks.every((r, i) => i === 0 || r.pts <= ranks[i - 1].pts),
  'and they are in descending order of points',
)

const tied = ranks.filter((r) => r.rank.startsWith('T'))
if (tied.length > 0) {
  const group = tied[0].rank
  const sharing = ranks.filter((r) => r.rank === group)
  ok(sharing.length > 1, `a tied rank is shared by more than one rep (${group} x${sharing.length})`)
  ok(
    new Set(sharing.map((r) => r.pts)).size === 1,
    'and everybody sharing it has the same score',
  )
  // Standard competition ranking: the rank after a tie of n skips by n.
  const after = ranks[ranks.indexOf(sharing[sharing.length - 1]) + 1]
  if (after) {
    ok(
      Number(after.rank.replace('T', '')) ===
        Number(group.replace('T', '')) + sharing.length,
      `the next rank skips past the tie (${group} then ${after.rank})`,
    )
  }
} else {
  console.log('SKIP  no tie in today’s demo data — the pure gate covers the rule')
}

/* --- who is on the board -------------------------------------------------- */
//
// Reported from production: the board showed one name. The membership rule is
// tested properly in `verify:leaderboard`, where the inputs can be controlled;
// this only checks that the screen renders more than the signed-in person, which
// is the symptom that was reported.
{
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('ul.plate > li')].map(
      (li) => (li.textContent || '').trim().split('\n')[0],
    ),
  )
  ok(names.length >= 2, `the board is not a list of one (${names.length} rows)`)
}

/* --- the period switch ----------------------------------------------------- */
//
// The arithmetic behind Week and Month is covered by `verify:periods`, which
// needs no browser. What only exists once the screen is real is the wiring: that
// tapping a chip actually changes what is on the board, and that the words
// around the numbers change with it. A switch that re-labels the heading and
// leaves the figures alone looks exactly like a switch that works.
{
  for (const label of ['Today', 'Week', 'Month']) {
    ok(
      (await page.getByRole('button', { name: label, exact: true }).count()) > 0,
      `the board offers ${label}`,
    )
  }

  const todayText = await page.locator('body').innerText()
  const todayPts = (todayText.match(/(\d[\d,]*)\s*pts/g) ?? []).join('|')

  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.waitForTimeout(900)
  const weekText = await page.locator('body').innerText()

  ok(/Week of /.test(weekText), 'switching to Week says which week')
  ok(/You this week/.test(weekText), 'and the rep’s own card follows the switch')
  ok(!/You today/.test(weekText), 'rather than still claiming to be today')
  ok(/Honours this week/.test(weekText), 'as does the honours heading')

  /*
    The numbers moved. Without this the whole switch could be re-labelling
    headings over today's figures, which is the failure that would ship — every
    word on screen would be right and every number would be wrong.
  */
  const weekPts = (weekText.match(/(\d[\d,]*)\s*pts/g) ?? []).join('|')
  ok(weekPts !== todayPts, 'and the scores are a week’s, not today’s relabelled')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.waitForTimeout(900)
  const backText = await page.locator('body').innerText()
  ok(/You today/.test(backText), 'and switching back returns to today')
}

/* --- the rules are on the screen ------------------------------------------ */
ok(/How points work/.test(body), 'the scoring is published rather than implied')
ok(/Door knocked/.test(body) && /Sale/.test(body), 'with every weight named')

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== standings OK ===')
process.exit(fails.length ? 1 : 0)
