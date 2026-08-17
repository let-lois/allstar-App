import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  ActivityEvent,
  Appointment,
  Mutation,
  Note,
  Photo,
  Property,
  Route,
  Task,
  Visit,
  DailyStat,
} from '../types'

/**
 * Local store. This is the app's source of truth while the rep is in the field —
 * the network is treated as a replica we push to, not as the thing we read from.
 */
interface AllstarDB extends DBSchema {
  properties: { key: string; value: Property; indexes: { 'by-status': string } }
  visits: { key: string; value: Visit; indexes: { 'by-property': string } }
  notes: { key: string; value: Note; indexes: { 'by-property': string } }
  photos: { key: string; value: Photo; indexes: { 'by-property': string } }
  routes: { key: string; value: Route; indexes: { 'by-date': string } }
  appointments: { key: string; value: Appointment; indexes: { 'by-start': number } }
  tasks: { key: string; value: Task; indexes: { 'by-due': number } }
  activity: { key: string; value: ActivityEvent; indexes: { 'by-at': number } }
  dailyStats: { key: string; value: DailyStat; indexes: { 'by-day': string } }
  outbox: { key: string; value: Mutation; indexes: { 'by-created': number } }
  meta: { key: string; value: unknown }
}

/** Every keyed store (i.e. everything except the loose `meta` bag). */
export type StoreName =
  | 'properties'
  | 'visits'
  | 'notes'
  | 'photos'
  | 'routes'
  | 'appointments'
  | 'tasks'
  | 'activity'
  | 'dailyStats'
  | 'outbox'

let dbPromise: Promise<IDBPDatabase<AllstarDB>> | null = null

export function db(): Promise<IDBPDatabase<AllstarDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AllstarDB>('allstar-field', 2, {
      /**
       * Idempotent by design. `upgrade` runs for a first-time install *and* for
       * every version bump, so creating a store unconditionally throws
       * ConstraintError for anyone who already has the previous version — which
       * is every existing user, and it bricks their local database.
       */
      upgrade(d) {
        const store = <N extends StoreName | 'meta'>(
          name: N,
          keyPath?: string,
          indexes: [string, string][] = [],
        ) => {
          if (d.objectStoreNames.contains(name)) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const os = d.createObjectStore(name as any, keyPath ? { keyPath } : undefined)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          indexes.forEach(([idx, path]) => (os as any).createIndex(idx, path))
        }

        store('properties', 'id', [['by-status', 'status']])
        store('visits', 'id', [['by-property', 'propertyId']])
        store('notes', 'id', [['by-property', 'propertyId']])
        store('photos', 'id', [['by-property', 'propertyId']])
        store('routes', 'id', [['by-date', 'date']])
        store('appointments', 'id', [['by-start', 'startsAt']])
        store('tasks', 'id', [['by-due', 'dueAt']])
        store('activity', 'id', [['by-at', 'at']])
        store('outbox', 'id', [['by-created', 'createdAt']])
        // v2
        store('dailyStats', 'id', [['by-day', 'day']])
        store('meta')
      },
    })
  }
  return dbPromise
}

/**
 * IndexedDB is unavailable in some private-browsing modes and inside certain
 * in-app webviews. Rather than hard-failing, callers fall back to memory — the
 * rep keeps working, they just lose durability across a reload.
 */
let idbUsable: boolean | null = null
const memory: Record<string, Map<string, unknown>> = {}

function mem(store: string): Map<string, unknown> {
  memory[store] ??= new Map()
  return memory[store]
}

export async function idbAvailable(): Promise<boolean> {
  if (idbUsable !== null) return idbUsable
  try {
    await db()
    idbUsable = true
  } catch {
    idbUsable = false
  }
  return idbUsable
}

export async function putAll<T extends { id: string }>(
  store: StoreName,
  rows: T[],
): Promise<void> {
  if (!(await idbAvailable())) {
    rows.forEach((r) => mem(store).set(r.id, r))
    return
  }
  const d = await db()
  const tx = d.transaction(store, 'readwrite')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await Promise.all(rows.map((r) => tx.store.put(r as any)))
  await tx.done
}

export async function put<T extends { id: string }>(store: StoreName, row: T): Promise<void> {
  await putAll(store, [row])
}

export async function all<T>(store: StoreName): Promise<T[]> {
  if (!(await idbAvailable())) return [...mem(store).values()] as T[]
  const d = await db()
  return (await d.getAll(store)) as T[]
}

export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  if (!(await idbAvailable())) return mem(store).get(id) as T | undefined
  const d = await db()
  return (await d.get(store, id)) as T | undefined
}

export async function del(store: StoreName, id: string): Promise<void> {
  if (!(await idbAvailable())) {
    mem(store).delete(id)
    return
  }
  const d = await db()
  await d.delete(store, id)
}

export async function clear(store: StoreName): Promise<void> {
  if (!(await idbAvailable())) {
    mem(store).clear()
    return
  }
  const d = await db()
  await d.clear(store)
}

export async function metaGet<T>(key: string): Promise<T | undefined> {
  if (!(await idbAvailable())) return mem('meta').get(key) as T | undefined
  const d = await db()
  return (await d.get('meta', key)) as T | undefined
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  if (!(await idbAvailable())) {
    mem('meta').set(key, value)
    return
  }
  const d = await db()
  await d.put('meta', value, key)
}

/**
 * Photos dominate local storage. When we're close to the quota, drop the oldest
 * already-synced photo blobs — the metadata row stays so the UI can show a
 * placeholder and re-fetch when there's Wi-Fi.
 */
export async function estimateStorage(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null
  const est = await navigator.storage.estimate()
  if (est.usage == null || est.quota == null) return null
  return { usedMB: est.usage / 1e6, quotaMB: est.quota / 1e6 }
}
