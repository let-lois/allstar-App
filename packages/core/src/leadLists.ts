import type { LeadList, Property, Territory, User } from './types'

/**
 * Lead lists on the phone: who can see what, kept in step with the server.
 *
 * The server decides a rep's scope with one SQL predicate in
 * `api/src/lists.ts`: a rep sees a property if it is assigned to them, OR it is
 * on a live list assigned to them. This is that predicate in TypeScript, and it
 * has to give the same answer — a phone that shows a house the server would not
 * send is showing a house that vanishes on the next refresh, and one that hides
 * a house the server did send is a rep wondering why their list is short.
 *
 * Pure, and exported, so `verify:leadlists` can state every case without a
 * browser or a database: assigned only, list only, both, archived list,
 * unassigned list, and an office role that sees everything.
 */

const isRep = (user: Pick<User, 'id' | 'role'> | null | undefined) => user?.role === 'field_rep'

/**
 * Draw a list round an area, or hand one to reps. The office roles — the same
 * set the server's `canManageLists` uses, and the same line the app already
 * draws for imports and assignment. The server enforces it; this is so the UI
 * does not offer a button the server would refuse.
 */
export function canManageLists(user: Pick<User, 'role'> | null | undefined): boolean {
  return !!user && (user.role === 'super_admin' || user.role === 'client_admin' || user.role === 'manager')
}

/** May this person rename, archive, or change the members of this list? */
export function canEditList(user: Pick<User, 'id' | 'role'> | null | undefined, list: Pick<LeadList, 'createdBy'>): boolean {
  if (!user) return false
  return canManageLists(user) || list.createdBy === user.id
}

/** The lists this person works — assigned to them, or made by them. Live only. */
export function listsFor(user: Pick<User, 'id' | 'role'> | null | undefined, lists: LeadList[]): LeadList[] {
  if (!user) return []
  if (!isRep(user)) return lists.filter((l) => !l.archived)
  return lists.filter((l) => !l.archived && (l.repIds.includes(user.id) || l.createdBy === user.id))
}

/**
 * Every property id a rep may see by way of a list.
 *
 * Only lists *assigned* to them count here, not ones they made: a rep can only
 * put a house on their own list if they could already see it, so their own
 * lists never widen anything. That matches the server exactly.
 */
export function leadIdsViaLists(user: Pick<User, 'id' | 'role'>, lists: LeadList[]): Set<string> {
  const out = new Set<string>()
  for (const l of lists) {
    if (l.archived || !l.repIds.includes(user.id)) continue
    for (const id of l.leadIds) out.add(id)
  }
  return out
}

/** The territories this person is on, by id. */
export function territoryIdsFor(
  user: Pick<User, 'id'>,
  territories: Pick<Territory, 'id' | 'repIds'>[],
): Set<string> {
  const out = new Set<string>()
  for (const t of territories) if (t.repIds?.includes(user.id)) out.add(t.id)
  return out
}

/**
 * The server's scope, on the phone.
 *
 * Three ways in, the same three as `repScopeSql` on the Worker: the house is
 * assigned to them, it is on a live list handed to them, or it sits in a
 * territory they are on. `viaTerritories` is optional so a caller with no
 * territories to hand keeps the two-way answer it always had.
 */
export function canSee(
  property: Pick<Property, 'id' | 'assignedRepId' | 'territoryId'>,
  user: Pick<User, 'id' | 'role'> | null | undefined,
  viaLists: Set<string>,
  viaTerritories?: Set<string>,
): boolean {
  if (!user) return false
  if (!isRep(user)) return true
  if (property.assignedRepId === user.id || viaLists.has(property.id)) return true
  return !!property.territoryId && !!viaTerritories?.has(property.territoryId)
}

/** The lists a given lead is on, for the peek and the profile. */
export function listsContaining(propertyId: string, lists: LeadList[]): LeadList[] {
  return lists.filter((l) => !l.archived && l.leadIds.includes(propertyId))
}

/** Immutable membership edits, so optimistic local state and the outbox agree. */
/**
 * How far along a list is, by status.
 *
 * The order is the pipeline's, not alphabetical and not by count: a manager
 * reading "8 new · 10 contacted · 5 follow-up · 2 won" is reading left to right
 * as the doors move, and a rep is reading how much of tonight is left. Statuses
 * with nothing in them are left out — a row of zeros says nothing a total does
 * not. Counted over the houses handed in, which for a rep is the houses their
 * phone can see, so the figure never claims more than the screen shows.
 */
export const TALLY_ORDER: Property['status'][] = [
  'new',
  'contacted',
  'follow_up',
  'working',
  'appointment',
  'quoted',
  'won',
  'lost',
  'dnc',
]

export function tallyStatuses(
  properties: Pick<Property, 'status'>[],
): { status: Property['status']; count: number }[] {
  const counts = new Map<Property['status'], number>()
  for (const p of properties) counts.set(p.status, (counts.get(p.status) ?? 0) + 1)
  return TALLY_ORDER.filter((s) => counts.has(s)).map((s) => ({ status: s, count: counts.get(s)! }))
}

export function withMembers(list: LeadList, add: string[] = [], remove: string[] = []): LeadList {
  const gone = new Set(remove)
  const kept = list.leadIds.filter((id) => !gone.has(id))
  const have = new Set(kept)
  for (const id of add) if (!have.has(id)) { kept.push(id); have.add(id) }
  return { ...list, leadIds: kept, updatedAt: Date.now() }
}
