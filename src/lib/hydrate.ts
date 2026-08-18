import type {
  ActivityEvent,
  Appointment,
  DailyStat,
  Property,
  Route,
  Task,
} from '../types'
import * as db from './db'
import type { BootstrapDTO } from './http'
import type { StoreName } from './db'

/**
 * Bootstrap → local store.
 *
 * `/api/bootstrap` already returns the client's own camelCase shapes, so this is
 * a wholesale replace rather than a mapping layer: the server owns these rows,
 * the phone caches them, and a partial merge would leave a rep looking at a
 * property that was reassigned away from them this morning.
 */

/** Rows the server owns. Replaced wholesale on every refresh. */
const SERVER_STORES: StoreName[] = [
  'properties',
  'routes',
  'appointments',
  'tasks',
  'activity',
  'dailyStats',
]

/**
 * Rows the rep created on *this* device. Bootstrap doesn't return them — a
 * visit's notes and photos live on the phone that took them — so they are never
 * touched by a refresh, only by a change of identity.
 *
 * The outbox is deliberately absent: it holds unsent work, and clearing it
 * because someone signed out would silently destroy a morning's knocks.
 */
const LOCAL_WORK_STORES: StoreName[] = ['visits', 'notes', 'photos']

export async function outboxPending(): Promise<boolean> {
  return (await db.all<{ id: string }>('outbox')).length > 0
}

export async function applyBootstrap(dto: BootstrapDTO, mergeOnly = false): Promise<void> {
  // The server's view is only authoritative once we've told it everything we
  // know. While the outbox still holds unsent work, a row the server didn't
  // mention isn't necessarily gone — it may simply be something this phone
  // created a minute ago that hasn't reached the server yet.
  //
  // Getting this wrong is silent data loss: a rep plans a route on one bar of
  // signal, pulls to refresh, and watches their day disappear. Same for a task,
  // an appointment, or a lead they added standing in front of the house. The
  // work is still in the outbox and would come back on a later refresh — but
  // "come back later" is not what a rep looking at an empty screen believes.
  // `mergeOnly` is passed in as well as checked here, because the dangerous
  // window is the request itself: if the outbox drained *while* the bootstrap
  // was in flight, the response predates that write and a replace would delete
  // it. The caller samples the queue before the fetch; this samples it after.
  const pending = mergeOnly || (await outboxPending())

  await Promise.all([
    replace('properties', dto.properties as Property[], pending),
    replace('routes', dto.routes as Route[], pending),
    replace('appointments', dto.appointments as Appointment[], pending),
    replace('tasks', dto.tasks as Task[], pending),
    replace('activity', dto.activity as ActivityEvent[], pending),
    replace('dailyStats', dto.dailyStats as DailyStat[], pending),
  ])
}

/**
 * Write the server's rows over the local ones.
 *
 * With nothing pending this is a true replace, which is what prunes rows that
 * were deleted or reassigned away server-side. With work still queued it becomes
 * a merge that adds and updates but never deletes — stale rows linger for the
 * few seconds until the outbox drains, which is by far the cheaper mistake.
 */
async function replace<T extends { id: string }>(
  store: StoreName,
  rows: T[],
  keepUnknownLocalRows: boolean,
): Promise<void> {
  // Not a clear-then-write: `put` overwrites by key, so writing the server's
  // rows on top already refreshes everything it knows about. The only thing the
  // clear adds is deletion of rows the server *didn't* send — which is exactly
  // what must not happen while our own work is still queued.
  if (!keepUnknownLocalRows) await db.clear(store)
  await db.putAll(store, rows)
}

/**
 * Wipe cached rows for whoever was signed in before.
 *
 * Field phones get shared and handed over, and a rep's leads, notes and photos
 * are their company's data — leaving them readable to the next person to open
 * the app is not acceptable. Queued work survives, because it isn't cached data:
 * it's work that hasn't reached the server yet.
 */
export async function wipeCachedData(): Promise<void> {
  await Promise.all([...SERVER_STORES, ...LOCAL_WORK_STORES].map((s) => db.clear(s)))
}
