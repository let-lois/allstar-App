import { chromium } from 'playwright'

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
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
ok(/Top rep today/.test(body), 'top rep is awarded')
ok(/Most doors/.test(body), 'most doors is awarded')
ok(/Most appointments/.test(body), 'most appointments is awarded')

/*
  Revenue is the one award that can legitimately be missing — the demo always has
  a sale, but a real morning does not. So it is asserted as *consistent* rather
  than present: shown only when somebody has actually sold something.
*/
const hasSale = /[1-9]\d* sold/.test(body)
ok(
  /Most revenue/.test(body) === hasSale,
  `the revenue award appears exactly when there are sales (award=${/Most revenue/.test(body)}, sales=${hasSale})`,
)

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

/* --- the rules are on the screen ------------------------------------------ */
ok(/How points work/.test(body), 'the scoring is published rather than implied')
ok(/Door knocked/.test(body) && /Sale/.test(body), 'with every weight named')

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== standings OK ===')
process.exit(fails.length ? 1 : 0)
