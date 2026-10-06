import type {
  ActivityEvent,
  Appointment,
  Mutation,
  Note,
  Photo,
  Route,
  Task,
  Visit,
} from '../types'
import * as db from './db'

/**
 * Erasing a lead from this device.
 *
 * The server side of erasure has existed since the deletion work landed: a lead
 * and everything under it goes from the database, the photo files go from object
 * storage, and a tombstone stops the address coming back. None of that touched
 * the phones, and the phones are where a good deal of the actual personal data
 * lives — the free text a rep typed about a household, and the photographs of
 * their house, held as bytes on the row.
 *
 * ## Why a normal refresh was never going to do it
 *
 * A refresh replaces the stores the server owns, so a property the server stops
 * sending does disappear — eventually, and only while the outbox is empty.
 * But `visits`, `notes` and `photos` are deliberately *not* server-owned on this
 * device: bootstrap never returns them, and `applyBootstrap` never touches them,
 * because a rep's own work must not vanish because a refresh ran. That rule is
 * right, and it means those three stores are exactly the ones an erasure could
 * never reach on its own. Hence a positive instruction — "this lead is gone" —
 * rather than an inference from absence.
 *
 * ## It runs even with work queued
 *
 * Everywhere else in this file's neighbour, a pending outbox turns a replace into
 * a merge, because a row the server did not mention might be work it has not
 * seen yet. That reasoning does not apply here and reversing it would be a bug:
 * an erased id is not "unmentioned", it is named, and an erasure is not the kind
 * of thing that waits for a queue to drain.
 *
 * ## Scans, not indexes
 *
 * `by-property` indexes exist on three of these stores and not the rest, and the
 * store has an in-memory fallback for devices where IndexedDB is unavailable —
 * where indexes do not exist at all. Reading the whole store through the same
 * primitives every other caller uses means one code path that is correct in both
 * modes, which for a privacy mechanism is worth more than the milliseconds an
 * index would save on a purge that only runs when there is something to purge.
 */

export interface PurgeCount {
  properties: number
  visits: number
  notes: number
  photos: number
  appointments: number
  tasks: number
  activity: number
  routeStops: number
  outbox: number
}

const EMPTY: PurgeCount = {
  properties: 0, visits: 0, notes: 0, photos: 0,
  appointments: 0, tasks: 0, activity: 0, routeStops: 0, outbox: 0,
}

/** Delete every row in `store` whose `propertyId` is in `ids`. */
async function purgeStore<T extends { id: string; propertyId?: string }>(
  store: db.StoreName,
  ids: Set<string>,
): Promise<number> {
  const rows = await db.all<T>(store)
  const doomed = rows.filter((r) => r.propertyId && ids.has(r.propertyId))
  for (const r of doomed) await db.del(store, r.id)
  return doomed.length
}

/**
 * Which lead a queued mutation is about.
 *
 * Mirrors `propertyIdOf` on the server, and has to: a mutation the server will
 * discard as obsolete should not still be sitting in this outbox. `property.status`
 * names the lead as `id` because the mutation *is* the property; everything else
 * names it as `propertyId`.
 */
function targetOf(m: Mutation): string {
  const p = (m.payload ?? {}) as Record<string, unknown>
  if (m.kind === 'property.status' || m.kind === 'property.plan') return typeof p.id === 'string' ? p.id : ''
  return typeof p.propertyId === 'string' ? p.propertyId : ''
}

/**
 * Remove every trace of these leads from this device.
 *
 * Idempotent, and deliberately so: the server sends the full list of erased ids
 * on every bootstrap rather than a delta, so this runs against ids it has
 * already handled every time the app refreshes. Deleting a row that is not there
 * costs nothing, and the alternative — a client-side watermark — is a second
 * place for the two sides to disagree about what has been erased.
 */
export async function purgeErased(erasedIds: string[]): Promise<PurgeCount> {
  if (!erasedIds || erasedIds.length === 0) return { ...EMPTY }
  const ids = new Set(erasedIds)
  const n: PurgeCount = { ...EMPTY }

  // The lead itself. Bootstrap would eventually drop this one on its own, but
  // only on a refresh with an empty outbox — and "eventually, conditionally" is
  // not a property an erasure may have.
  for (const id of ids) {
    if (await db.get('properties', id)) {
      await db.del('properties', id)
      n.properties += 1
    }
  }

  // The three the server never sends back, and the reason this exists.
  n.visits = await purgeStore<Visit>('visits', ids)
  n.notes = await purgeStore<Note>('notes', ids)
  // Photo bytes live on the photo row, so deleting the row is deleting the
  // picture — there is no second place holding the image.
  n.photos = await purgeStore<Photo>('photos', ids)

  n.appointments = await purgeStore<Appointment>('appointments', ids)
  n.tasks = await purgeStore<Task>('tasks', ids)
  n.activity = await purgeStore<ActivityEvent>('activity', ids)

  /*
    Routes hold their stops inline, so a stop is edited out rather than the route
    being deleted. Deleting the route would take the rest of the rep's day with
    it — the other twenty houses on that street have nothing to do with this.
  */
  const routes = await db.all<Route>('routes')
  for (const r of routes) {
    const keep = (r.stops ?? []).filter((s) => !ids.has(s.propertyId))
    if (keep.length === (r.stops ?? []).length) continue
    n.routeStops += (r.stops ?? []).length - keep.length
    await db.put('routes', { ...r, stops: keep })
  }

  /*
    Queued work for an erased lead, dropped here as well as being refused by the
    server. Both ends is not redundant: the server discards it as obsolete when
    it arrives, but a phone that has been offline for a week would otherwise sit
    on that row — and a queued note about a household is the same personal data
    as a saved one. Removing it here also means the rep's pending count reflects
    work that can still land.
  */
  const queued = await db.all<Mutation>('outbox')
  for (const m of queued) {
    const target = targetOf(m)
    if (target && ids.has(target)) {
      await db.del('outbox', m.id)
      n.outbox += 1
    }
  }

  return n
}
