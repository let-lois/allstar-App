import { POINTS, awards, scoreOf, standings } from '../src/data/leaderboard.ts'

/**
 * The rules of the board.
 *
 * No browser: this is arithmetic and a sort, and both are the kind of thing that
 * looks right on a screen while being wrong. A leaderboard that ranks people is
 * also the one screen in this product where being wrong costs trust rather than
 * time — a rep who knows they outsold somebody above them will not believe the
 * next number the app shows them either.
 *
 * The cases that matter are the awkward ones: the empty morning, the tie, and
 * the rep who knocked all day for nothing.
 */

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

const rep = (name, over = {}) => ({
  id: name.toLowerCase(),
  name,
  initials: name.slice(0, 2).toUpperCase(),
  phone: '',
  routeName: '—',
  done: 0,
  total: 0,
  remaining: 0,
  pct: 0,
  knocks: 0,
  conversations: 0,
  contactRate: 0,
  pipelineToday: 0,
  appointments: 0,
  sales: 0,
  revenue: 0,
  ...over,
})

/* --- the score is the sum it says it is ----------------------------------- */
{
  const r = rep('Mike', { knocks: 142, conversations: 51, appointments: 8, sales: 3 })
  const expected =
    142 * POINTS.door + 51 * POINTS.conversation + 8 * POINTS.appointment + 3 * POINTS.sale
  ok(scoreOf(r) === expected, `the score is the published sum (${scoreOf(r)} = ${expected})`)
  ok(POINTS.door === 1, 'a door is worth a point — effort counts for something')
  ok(
    POINTS.sale > POINTS.appointment &&
      POINTS.appointment > POINTS.conversation &&
      POINTS.conversation > POINTS.door,
    'and the weights climb with how far down the funnel the thing is',
  )
}

/* --- a day of knocking beats one lucky door -------------------------------- */
//
// The reason the ranking is not just sales. A rep who works a street all day for
// two appointments has had a better day than one who sold the first door and went
// home, and a board that says otherwise teaches cherry-picking.
{
  const grinder = rep('Grinder', { knocks: 140, conversations: 50, appointments: 2 })
  const lucky = rep('Lucky', { knocks: 6, conversations: 3, sales: 1 })
  const board = standings([lucky, grinder])
  ok(board[0].rep.name === 'Grinder', `the day's work outranks the lucky door (${board[0].rep.name})`)
}

/* --- ties are shown, not broken -------------------------------------------- */
{
  const a = rep('Ann', { knocks: 30 })
  const b = rep('Bob', { knocks: 30 })
  const c = rep('Cal', { knocks: 10 })
  const board = standings([c, b, a])
  ok(board[0].rank === 1 && board[1].rank === 1, 'two equal scores share first place')
  ok(board[0].tied && board[1].tied, 'and are marked as tied')
  ok(board[2].rank === 3, 'the next rep is third, not second — the rank skips')
  ok(!board[2].tied, 'and is not marked tied')
  ok(
    board[0].rep.name === 'Ann' && board[1].rep.name === 'Bob',
    'equal scores order by name, so the board does not reshuffle on every render',
  )
}

/* --- the empty morning ------------------------------------------------------ */
//
// The case that would otherwise crown whoever sorts first alphabetically, on a
// day when nobody has done anything. A visibly arbitrary trophy costs the board
// its authority permanently.
{
  const board = standings([rep('Ann'), rep('Bob')])
  ok(board.length === 2, 'everybody still appears before the first knock')
  ok(board.every((r) => r.points === 0), 'on zero points')
  ok(awards([rep('Ann'), rep('Bob')]).length === 0, 'and nothing is awarded')
}

/* --- awards, one at a time -------------------------------------------------- */
{
  const mike = rep('Mike', { knocks: 142, conversations: 51, appointments: 8, sales: 3, revenue: 41000 })
  const john = rep('John', { knocks: 127, conversations: 44, appointments: 7, sales: 2, revenue: 52000 })
  const sarah = rep('Sarah', { knocks: 119, conversations: 47, appointments: 6, sales: 3, revenue: 12000 })
  const list = awards([mike, john, sarah])
  const by = (k) => list.find((a) => a.key === k)

  ok(by('doors')?.winners[0].name === 'Mike', 'most doors goes to the most doors')
  ok(
    by('revenue')?.winners[0].name === 'John',
    'most revenue goes to the biggest cheque, not the most sales',
  )
  ok(by('appointments')?.winners[0].name === 'Mike', 'most appointments is its own award')
  ok(by('top')?.winners[0].name === 'Mike', 'top rep is the highest score')
  ok(list.length === 4, 'four awards when there is something to award')
}

/* --- an award nobody earned ------------------------------------------------- */
{
  // Everybody knocked; nobody sold. There is no "most revenue" today.
  const list = awards([rep('Ann', { knocks: 40 }), rep('Bob', { knocks: 20 })])
  ok(
    list.find((a) => a.key === 'revenue') === undefined,
    'no revenue award on a day with no sales',
  )
  ok(list.find((a) => a.key === 'doors')?.winners[0].name === 'Ann', 'but doors is still awarded')
  ok(
    list.find((a) => a.key === 'appointments') === undefined,
    'and no appointments award without appointments',
  )
}

/* --- a genuine tie for an award --------------------------------------------- */
{
  const list = awards([rep('Ann', { knocks: 40 }), rep('Bob', { knocks: 40 })])
  const doors = list.find((a) => a.key === 'doors')
  ok(doors?.winners.length === 2, 'both reps win an award they genuinely tied on')
}

/* --- nobody at all ---------------------------------------------------------- */
{
  ok(standings([]).length === 0, 'an empty team is an empty board, not a crash')
  ok(awards([]).length === 0, 'and has no awards')
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== leaderboard OK ===')
process.exit(fails.length ? 1 : 0)
