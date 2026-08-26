import { readFileSync } from 'node:fs'
import {
  POINTS,
  awards,
  boardFor,
  dayKey,
  periodLabel,
  periodStart,
  scoreOf,
  standings,
} from '../src/data/leaderboard.ts'

/**
 * Week and month on the standings board.
 *
 * The board covered today only, which told a rep who had a strong week and a
 * slow Tuesday that they were nowhere, and gave a new starter no window they
 * could ever win.
 *
 * The rule with teeth is where each day's numbers come from. `daily_stats` is
 * written by the *server*, so a rep working a street with no signal has a
 * morning that exists only on their phone; a week summed from history alone
 * would show them a week with today missing, on the one screen whose entire job
 * is telling them where they stand. History supplies the days before today,
 * the device supplies today, and neither is counted twice.
 *
 * All of it is a pure function of two arrays and a clock, which is why this
 * needs no browser — and why the clock is passed in rather than read, so "what
 * happens on the 1st of the month" is a test rather than a wait.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const rep = (id, name, over = {}) => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  knocks: 0,
  conversations: 0,
  appointments: 0,
  sales: 0,
  revenue: 0,
  ...over,
})

const stat = (repId, day, over = {}) => ({
  id: `${repId}:${day}`,
  repId,
  day,
  knocks: 0,
  conversations: 0,
  appointments: 0,
  quotes: 0,
  sold: 0,
  closedValue: 0,
  ...over,
})

/* --- where a period begins -------------------------------------------------- */

console.log('--- where a period begins ---')

// Wednesday 20 August 2026.
const wed = new Date(2026, 7, 19, 14, 30)
ok(periodStart('today', wed) === '2026-08-19', 'today starts today', periodStart('today', wed))
ok(periodStart('week', wed) === '2026-08-16', 'the week starts on Sunday', periodStart('week', wed))
ok(periodStart('month', wed) === '2026-08-01', 'the month starts on the 1st', periodStart('month', wed))

// The edges, which is where an off-by-one lives.
const sun = new Date(2026, 7, 16, 6, 0)
ok(periodStart('week', sun) === '2026-08-16', 'on Sunday the week starts today, not a week ago')
const sat = new Date(2026, 7, 22, 23, 59)
ok(periodStart('week', sat) === '2026-08-16', 'and on Saturday it still starts the same Sunday')
const first = new Date(2026, 7, 1, 0, 30)
ok(periodStart('month', first) === '2026-08-01', 'the 1st is in its own month')

/*
 * A week that crosses a month boundary, which is most weeks and all of the ones
 * that break naive arithmetic on day-of-month.
 */
const sep2 = new Date(2026, 8, 2, 9, 0)
ok(periodStart('week', sep2) === '2026-08-30', 'a week can start in the previous month', periodStart('week', sep2))

/*
 * Local time, not UTC. A rep's week ends when their Saturday ends; a board that
 * rolls over at 7pm because it is midnight in London is a board nobody trusts.
 */
const lateSat = new Date(2026, 7, 22, 22, 0)
ok(dayKey(lateSat) === '2026-08-22', 'late evening is still the same local day', dayKey(lateSat))

ok(/August/.test(periodLabel('month', wed)), 'the month is labelled by name', periodLabel('month', wed))
ok(/^Week of /.test(periodLabel('week', wed)), 'and the week by the day it started', periodLabel('week', wed))

/* --- today is the device's, always ------------------------------------------ */

console.log('\n--- today comes from the phone, not the server ---')

const today = dayKey(wed)
const live = [rep('a', 'Ana Diaz', { knocks: 20, conversations: 5, appointments: 2, sales: 1 })]

{
  // The server has not heard about this morning yet — the common case on a
  // street with no signal.
  const board = boardFor('week', { live, history: [], now: wed })
  ok(board[0].knocks === 20, "an unsynced morning still counts toward the week", `${board[0].knocks} doors`)
}

{
  // And once it *has* synced, the same morning must not be counted twice.
  const history = [stat('a', today, { knocks: 20, conversations: 5, appointments: 2, sold: 1 })]
  const board = boardFor('week', { live, history, now: wed })
  ok(
    board[0].knocks === 20,
    'and is not counted twice once the server knows about it',
    `${board[0].knocks} doors`,
  )
  ok(board[0].sales === 1, 'nor are the sales', `${board[0].sales}`)
}

/* --- the history actually adds up ------------------------------------------- */

console.log('\n--- the week and the month ---')

const history = [
  stat('a', '2026-08-17', { knocks: 30, conversations: 8, appointments: 3, sold: 1 }), // Mon, this week
  stat('a', '2026-08-18', { knocks: 25, conversations: 6, appointments: 1, sold: 0 }), // Tue, this week
  stat('a', '2026-08-14', { knocks: 40, conversations: 9, appointments: 2, sold: 2 }), // last week
  stat('a', '2026-07-30', { knocks: 99, conversations: 1, appointments: 1, sold: 9 }), // last month
]

{
  const week = boardFor('week', { live, history, now: wed })[0]
  ok(week.knocks === 75, 'the week sums this week and today only', `${week.knocks} = 30+25+20`)
  ok(week.sales === 2, 'and so do the sales', `${week.sales}`)
}
{
  const month = boardFor('month', { live, history, now: wed })[0]
  ok(month.knocks === 115, 'the month reaches back further', `${month.knocks} = 40+30+25+20`)
  ok(month.sales === 4, 'and picks up the earlier sales', `${month.sales}`)
}
{
  const day = boardFor('today', { live, history, now: wed })[0]
  ok(day.knocks === 20, 'today ignores history entirely', `${day.knocks}`)
}

/* --- people, not rows -------------------------------------------------------- */

console.log('\n--- who appears ---')

{
  // A rep who left. Their work happened; a board is a list of people, and they
  // are not one any more.
  const withGhost = [...history, stat('gone', '2026-08-17', { knocks: 500, sold: 40 })]
  const board = boardFor('week', { live, history: withGhost, now: wed })
  ok(board.length === 1, 'history for somebody off the roster does not resurrect them')
  ok(!board.some((r) => r.id === 'gone'), 'and cannot win the week')
}

{
  // Somebody on the roster who has not knocked. They belong on the board at
  // zero — a board you appear on only after you perform is a receipt.
  const two = [...live, rep('b', 'Ben Cole')]
  const board = boardFor('week', { live: two, history, now: wed })
  ok(board.length === 2, 'a rep with nothing this week is still on the board')
  ok(board.find((r) => r.id === 'b')?.knocks === 0, 'at zero')
}

/* --- money over a period ------------------------------------------------------- */

console.log('\n--- money ---')

{
  /*
    This block used to assert the opposite, and was right to.

    The history table's money column held a running lifetime total of everything
    a rep had ever won, stamped onto whichever day the write happened, so
    summing it over a week produced a number with no meaning. The board pinned
    revenue to 0 for anything but today and the revenue award suppressed itself
    — the correct call on a number that was wrong.

    The column now holds money closed on that day, so it sums like every other
    column and a week can be won on revenue like it can on doors.
  */
  const days = [
    stat('a', '2026-08-17', { knocks: 1, sold: 1, closedValue: 12_000 }),
    stat('a', '2026-08-18', { knocks: 1, sold: 1, closedValue: 8_000 }),
    // Before the window — must not be counted.
    stat('a', '2026-08-14', { knocks: 1, sold: 1, closedValue: 500_000 }),
  ]
  const today = rep('a', 'Ana Diaz', { revenue: 5_000, sales: 1 })
  const week = boardFor('week', { live: [today], history: days, now: wed })[0]

  ok(week.revenue === 25_000, 'a week sums the money closed on each of its days', `${week.revenue}`)
  ok(
    week.revenue !== 500_000 && week.revenue !== 525_000,
    'and a sale from before the window stays outside it',
  )

  const prizes = awards([week])
  ok(prizes.some((p) => p.key === 'revenue'), 'so a week can now be won on revenue')

  /*
    Today's money comes from the phone, not from history — the same rule the
    door counts follow, and for the same reason: a rep working with no signal
    has a morning that exists only on their device. Counting today from both
    sides would double it.
  */
  const synced = boardFor('week', {
    live: [today],
    history: [...days, stat('a', dayKey(wed), { knocks: 20, sold: 1, closedValue: 5_000 })],
    now: wed,
  })[0]
  ok(synced.revenue === 25_000, 'and today is not counted twice once the server knows about it', `${synced.revenue}`)

  // The rule the awards have always had: nothing is awarded on nothing.
  const dry = boardFor('week', {
    live: [rep('b', 'Ben Cole')],
    history: [stat('b', '2026-08-17', { knocks: 40 })],
    now: wed,
  })[0]
  ok(dry.revenue === 0, 'a week with no sales carries no revenue')
  ok(
    !awards([dry]).some((p) => p.key === 'revenue'),
    'and still hands out no trophy for it',
  )
}

/* --- it is still the same board ------------------------------------------------ */

console.log('\n--- scoring is unchanged ---')

{
  const week = boardFor('week', { live, history, now: wed })
  const expected = 75 * POINTS.door + 19 * POINTS.conversation + 6 * POINTS.appointment + 2 * POINTS.sale
  ok(scoreOf(week[0]) === expected, 'a week is scored by the same published weights', `${expected} pts`)

  const two = boardFor('week', { live: [...live, rep('b', 'Ben Cole', { knocks: 1 })], history, now: wed })
  const board = standings(two)
  ok(board[0].rep.id === 'a' && board[0].rank === 1, 'and ranked the same way')
  ok(board[1].rank === 2, 'with ranks running on')
}

/* --- the words follow the switch ---------------------------------------------- */

console.log('\n--- the copy does not lie ---')

/*
 * A label that says "today" over a week's points is a small lie, and small lies
 * about numbers are how a rep stops trusting the board entirely. Checked here
 * because these strings live in two files and only one of them knows what
 * period is on screen.
 */
{
  const src = readFileSync(new URL('../src/screens/Standings.tsx', import.meta.url), 'utf8')
  ok(!/>You today</.test(src), 'the "you" card is not hardcoded to today')
  ok(/You this \$\{period\}/.test(src), 'and says which period it means')
  ok(
    /period === 'today' \? "Today's honours"/.test(src),
    'the honours heading follows the switch too',
  )

  const prizes = awards([rep('a', 'Ana Diaz', { knocks: 10, appointments: 1, sales: 1 })])
  ok(
    prizes.every((p) => !/today/i.test(p.label)),
    'and no award carries a period in its own label',
    prizes.map((p) => p.label).join(', '),
  )
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== periods OK ===')
