import type { LeadList, Property, User } from '../types'

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

/** The server's scope, on the phone. */
export function canSee(
  property: Pick<Property, 'id' | 'assignedRepId'>,
  user: Pick<User, 'id' | 'role'> | null | undefined,
  viaLists: Set<string>,
): boolean {
  if (!user) return false
  if (!isRep(user)) return true
  return property.assignedRepId === user.id || viaLists.has(property.id)
}

/** The lists a given lead is on, for the peek and the profile. */
export function listsContaining(propertyId: string, lists: LeadList[]): LeadList[] {
  return lists.filter((l) => !l.archived && l.leadIds.includes(propertyId))
}

/** Immutable membership edits, so optimistic local state and the outbox agree. */
export function withMembers(list: LeadList, add: string[] = [], remove: string[] = []): LeadList {
  const gone = new Set(remove)
  const kept = list.leadIds.filter((id) => !gone.has(id))
  const have = new Set(kept)
  for (const id of add) if (!have.has(id)) { kept.push(id); have.add(id) }
  return { ...list, leadIds: kept, updatedAt: Date.now() }
}
