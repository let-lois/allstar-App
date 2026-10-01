import * as db from './db'
import { TOUR_KEY, TOUR_VERSION } from '../data/tour'
import type { Role } from '../types'

/**
 * Whether this person has been through the tutorial, kept per person.
 *
 * It used to be one flag per phone (`allstar.tour.v2`), so a second rep signing
 * in on a shared phone never saw it and a manager who had once been a rep on
 * this phone was never shown the office tour. The key is now the tour version,
 * the role (the two tours are different walks) and the user:
 *
 *   allstar.tour.v2:field_rep:u_123
 *
 * Bumping `TOUR_VERSION` shows everybody the new one once, which is the only
 * reason it should ever reappear on its own. Nothing about doing work — a
 * visit, a note, a status change — touches this key.
 *
 * The old per-phone flag is honoured once: whoever signs in first after the
 * update inherits it, and it is removed, so nobody is shown the tour again
 * just because the key changed.
 */
export function tourKeyFor(user: { id: string; role: Role } | null | undefined): string {
  return user ? `allstar.tour.v${TOUR_VERSION}:${user.role}:${user.id}` : TOUR_KEY
}

export async function tourSeen(user: { id: string; role: Role } | null | undefined): Promise<boolean> {
  const key = tourKeyFor(user)
  if (await db.metaGet<boolean>(key)) return true
  if (user && (await db.metaGet<boolean>(TOUR_KEY))) {
    await db.metaSet(key, true)
    await db.metaSet(TOUR_KEY, undefined)
    return true
  }
  return false
}

export function markTourSeen(user: { id: string; role: Role } | null | undefined): Promise<void> {
  return db.metaSet(tourKeyFor(user), true)
}

export function clearTourSeen(user: { id: string; role: Role } | null | undefined): Promise<void> {
  return db.metaSet(tourKeyFor(user), undefined)
}
