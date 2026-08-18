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

export async function applyBootstrap(dto: BootstrapDTO): Promise<void> {
  await Promise.all(SERVER_STORES.map((s) => db.clear(s)))
  await Promise.all([
    db.putAll('properties', dto.properties as Property[]),
    db.putAll('routes', dto.routes as Route[]),
    db.putAll('appointments', dto.appointments as Appointment[]),
    db.putAll('tasks', dto.tasks as Task[]),
    db.putAll('activity', dto.activity as ActivityEvent[]),
    db.putAll('dailyStats', dto.dailyStats as DailyStat[]),
  ])
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
