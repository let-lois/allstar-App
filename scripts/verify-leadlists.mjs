import { canSee, leadIdsViaLists, listsContaining, listsFor, withMembers } from '../src/lib/leadLists.ts'

/**
 * Who can see what, on the phone — the same answer the server gives.
 *
 * The server decides a rep's scope with one SQL predicate: assigned to them, OR
 * on a live list assigned to them. The phone has its own copy in TypeScript,
 * because a rep's map is drawn from IndexedDB with no signal. Two copies of a
 * visibility rule is how one ends up wider than the other, and either mistake is
 * visible to a rep: a house that vanishes on refresh, or a list that is one
 * short. So every case is stated here, and `smoke:lists` states the same cases
 * against the real database; if the two ever disagree, one of these files is
 * red.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const rep = { id: 'u_rep', role: 'field_rep' }
const other = { id: 'u_other', role: 'field_rep' }
const manager = { id: 'u_mgr', role: 'manager' }

const list = (over) => ({
  id: 'll_1', name: 'Northwest', archived: false, createdAt: 1, updatedAt: 1,
  leadIds: [], repIds: [], ...over,
})

const mine = { id: 'p_mine', assignedRepId: 'u_rep' }
const theirs = { id: 'p_theirs', assignedRepId: 'u_other' }
const nobodys = { id: 'p_nobody', assignedRepId: undefined }

/* --- the scope ------------------------------------------------------------- */
{
  const none = leadIdsViaLists(rep, [])
  ok(canSee(mine, rep, none), 'a rep sees a house assigned to them')
  ok(!canSee(theirs, rep, none), 'and not one assigned to somebody else')
  ok(!canSee(nobodys, rep, none), 'nor one assigned to nobody — the control')

  const handed = leadIdsViaLists(rep, [list({ leadIds: ['p_theirs', 'p_nobody'], repIds: ['u_rep'] })])
  ok(canSee(theirs, rep, handed), 'a house on a list handed to them becomes visible, whoever it is assigned to')
  ok(canSee(nobodys, rep, handed), 'so does one assigned to nobody')

  const archived = leadIdsViaLists(rep, [list({ leadIds: ['p_theirs'], repIds: ['u_rep'], archived: true })])
  ok(!canSee(theirs, rep, archived), 'an archived list confers nothing — the house leaves the phone')

  const notMine = leadIdsViaLists(rep, [list({ leadIds: ['p_theirs'], repIds: ['u_other'] })])
  ok(!canSee(theirs, rep, notMine), 'a list handed to somebody else confers nothing either')

  /*
    The subtle one, and the one that keeps the rule from being circular. A rep
    can only put a house on their OWN list if they could already see it, so a
    list they made must never widen their scope — otherwise "made a list" would
    become a way to see houses, and the server does not count it either.
  */
  const own = leadIdsViaLists(rep, [list({ leadIds: ['p_theirs'], repIds: [], createdBy: 'u_rep' })])
  ok(!canSee(theirs, rep, own), 'a list a rep made themselves does not widen what they can see')

  ok(canSee(theirs, manager, new Set()), 'an office role sees everything, lists or not')
  ok(!canSee(mine, null, none), 'and nobody signed in sees nothing')
}

/* --- which lists a person works ------------------------------------------- */
{
  const lists = [
    list({ id: 'a', repIds: ['u_rep'] }),
    list({ id: 'b', createdBy: 'u_rep' }),
    list({ id: 'c', repIds: ['u_other'] }),
    list({ id: 'd', repIds: ['u_rep'], archived: true }),
  ]
  const ids = (xs) => xs.map((l) => l.id).sort().join(',')
  ok(ids(listsFor(rep, lists)) === 'a,b', 'a rep works the lists handed to them and the ones they made, live only', ids(listsFor(rep, lists)))
  ok(ids(listsFor(manager, lists)) === 'a,b,c', 'a manager works every live list', ids(listsFor(manager, lists)))
  ok(listsFor(null, lists).length === 0, 'nobody signed in works none')
  ok(ids(listsContaining('p_x', [list({ id: 'a', leadIds: ['p_x'] }), list({ id: 'b', leadIds: ['p_x'], archived: true }), list({ id: 'c' })])) === 'a',
     'a lead reports the live lists it is on, not archived ones')
}

/* --- membership edits stay honest ----------------------------------------- */
{
  const l = list({ leadIds: ['p_1', 'p_2'] })
  const grown = withMembers(l, ['p_3', 'p_2'], ['p_1'])
  ok(grown.leadIds.join(',') === 'p_2,p_3', 'add and remove in one call, with no duplicate for a house already on it', grown.leadIds.join(','))
  ok(l.leadIds.join(',') === 'p_1,p_2', 'and the original is untouched — the outbox and the screen must agree on what was sent')
  ok(grown.updatedAt >= l.updatedAt, 'and the list knows it changed')
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the phone and the server agree on who sees what ===')
