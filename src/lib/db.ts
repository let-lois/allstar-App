import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  ActivityEvent,
  Appointment,
  DailyStat,
  LeadList,
  Mutation,
  Note,
  Photo,
  Property,
  Route,
  Task,
  TeamMember,
  Territory,
  Visit,
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
  territories: { key: string; value: Territory }
  leadLists: { key: string; value: LeadList }
  team: { key: string; value: TeamMember }
  outbox: { key: string; value: Mutation; indexes: { 'by-created': number } }
  tiles: { key: string; value: TileBlob }
  meta: { key: string; value: unknown }
}

/**
 * One stored map tile.
 *
 * Deliberately not in `StoreName`, alongside `meta`, so the generic loops in
 * `hydrate`, `demo` and `erase-local` cannot reach it. Imagery is not tenant
 * data: it is the same public photograph of a street whoever is signed in, and
 * wiping a rep's downloaded territory because they signed out — or because the
 * office erased a lead — would take away the thing they are carrying a phone
 * for. Removing it is `clearTileCache`, which a person asks for by name.
 */
export interface TileBlob {
  /** The tile's source URL, and the key. */
  url: string
  blob: Blob
  bytes: number
  /** When it was stored, so a future eviction pass can start with the oldest. */
  at: number
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
  | 'territories'
  | 'leadLists'
  | 'team'
  | 'outbox'

let dbPromise: Promise<IDBPDatabase<AllstarDB>> | null = null

export function db(): Promise<IDBPDatabase<AllstarDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AllstarDB>('allstar-field', 7, {
      /**
       * Idempotent by design. `upgrade` runs for a first-time install *and* for
       * every version bump, so creating a store unconditionally throws
       * ConstraintError for anyone who already has the previous version — which
       * is every existing user, and it bricks their local database.
       */
      upgrade(d) {
        const store = <N extends StoreName | 'meta' | 'tiles'>(
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
        // v3 — territory names, so the console labels a patch instead of
        // printing the hash its id is derived from.
        store('territories', 'id')
        // v4 — the roster, so every console screen names the same people from
        // one place instead of each fetching it and none of them caching it.
        store('team', 'id')
        // v6 — lead lists: the working sets a rep is handed or makes for
        // themselves, with their members and reps, so the map can filter by
        // one with no signal.
        store('leadLists', 'id')
        /*
          v7 — map tiles, moved here from Cache Storage.

          Cache Storage is exposed only to a secure context with a network
          scheme, and a packaged app is served from neither: WKWebView loads it
          through a custom scheme handler, where `caches` is absent and no
          service worker runs. Tiles were written to Cache Storage and read back
          only by the worker's fetch handler, so on iOS the download would
          decline and, had it not, the imagery would never have been served — a
          rep tapping download, seeing it succeed, and finding a blank map in a
          dead zone. IndexedDB is there under every scheme, and reading it in app
          code means one path that works everywhere instead of two that differ
          silently.
        */
        store('tiles', 'url')
        store('meta')
      },

      /*
        Another tab wants to upgrade and this connection is what is stopping it.

        Closing is the only cooperative answer. Without it the two tabs deadlock:
        the new one waits on `blocked` forever, and this one keeps a connection
        open forever because nothing tells it to let go. Reads here fail
        afterwards and fall back to memory, which is the correct trade — one tab
        losing durability beats both tabs hanging.
      */
      blocking() {
        /*
          Marked unusable in the same breath as the close, not left to be
          discovered. A closed connection does not fail reads gracefully — it
          throws InvalidStateError out of `getAll`, past callers that have no
          branch for it. Flipping the flag sends every later read down the
          memory path the no-IndexedDB case already uses, and the rep picks the
          upgraded database back up on their next launch.
        */
        idbUsable = false
        void dbPromise?.then((d) => d.close()).catch(() => {})
      },
    })
  }
  return dbPromise
}

/**
 * How long a database open is allowed to take before the app gives up on disk.
 *
 * There is no smaller number that is safe and no larger one that is useful. An
 * open that is merely slow — a first-run upgrade on a cheap phone — finishes
 * well inside a second; an open that is *blocked* never finishes at all, because
 * `openDB` does not reject when another connection is holding the old version,
 * it simply waits. Ten seconds separates the two without ever mistaking one for
 * the other.
 */
const OPEN_BUDGET_MS = 10_000

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
    /*
      Bounded, because the failure this guards against is not an error.

      `openDB` rejects when IndexedDB is disabled, and that case was already
      handled. What it does *not* do is reject when the open is blocked — it
      waits, silently, for as long as whatever is blocking it lives. Every read
      in the app goes through here, so an unbounded wait is not a slow start,
      it is an app that never starts: `boot` never reaches `loadLocal`, `ready`
      never flips, and the rep sits on "Loading your territory…" with nothing on
      screen to explain it and no way to retry. That is the shape of the
      unexplained cold-boot hang recorded in #40.

      Losing durability for the session is a real cost, paid knowingly: a rep
      who can work and lose their cache on reload is strictly better off than a
      rep who cannot open the app at all, and the outbox drains from memory the
      same way it drains from disk.
    */
    await Promise.race([
      db(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('indexeddb open timed out')), OPEN_BUDGET_MS),
      ),
    ])
    idbUsable = true
  } catch {
    idbUsable = false
  }
  return idbUsable
}

/**
 * The device is out of room.
 *
 * Its own type because it is the one write failure a rep can actually do
 * something about, and the only correct response to it is to say so. Everything
 * else this layer can throw is a bug in us.
 */
export class StorageFull extends Error {
  constructor() {
    super('This phone is out of storage')
    this.name = 'StorageFull'
  }
}

/**
 * Names a quota failure across engines.
 *
 * `QuotaExceededError` is the standard, Firefox has historically thrown code 22
 * and Safari has its own wording — and getting this wrong means a full phone
 * reads as an ordinary bug and is reported as "the app is broken".
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; message?: string }
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    /quota|storage is full|not enough space/i.test(e.message ?? '')
  )
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
  try {
    const tx = d.transaction(store, 'readwrite')
    /*
      `tx.done` is claimed before anything can reject.

      A failing `put` aborts the transaction, which rejects `tx.done` as well —
      and if the `Promise.all` below rejects first, nothing is awaiting `done`
      by the time it does. That is an unhandled rejection, which on a phone is a
      crash overlay or a silent console entry depending on the browser, for a
      condition this function is about to report properly anyway.
    */
    const done = tx.done.catch((err: unknown) => {
      if (isQuotaError(err)) throw new StorageFull()
      throw err
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writes = Promise.all(rows.map((r) => tx.store.put(r as any)))
    // `allSettled` on purpose: both need to settle before this returns, and
    // whichever failed is re-thrown below rather than racing the other.
    const [w] = await Promise.allSettled([writes, done])
    if (w.status === 'rejected') throw w.reason
    await done
  } catch (err) {
    /*
      A full device is the one write failure that is not our bug, and the only
      one a rep can act on. Translated here rather than at each call site so
      every write in the app gets the same answer — and so the caller can tell
      "there is no room" apart from "something went wrong", which is the
      difference between a rep clearing space and a rep filing a support ticket.
    */
    if (isQuotaError(err)) throw new StorageFull()
    throw err
  }
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

/* --- map tiles -------------------------------------------------------------
 *
 * Their own small API rather than the generic `put`/`all`/`clear` above, for
 * two reasons. They are keyed on a URL instead of an `id`, so the generic
 * signatures do not fit; and none of them falls back to the in-memory map the
 * rest of this file uses when IndexedDB is missing. A territory is hundreds of
 * megabytes of imagery — holding that in a JavaScript object would trade a
 * blank map for a dead tab, and `tileStorageAvailable()` already lets the
 * screen decline the download instead.
 */

export async function tilePut(url: string, blob: Blob): Promise<void> {
  const d = await db()
  await d.put('tiles', { url, blob, bytes: blob.size, at: Date.now() })
}

export async function tileGet(url: string): Promise<Blob | undefined> {
  const d = await db()
  return (await d.get('tiles', url))?.blob
}

/**
 * Every stored tile URL, in one read.
 *
 * `getAllKeys` rather than a lookup per URL, which is the mistake the old
 * `cachedCount` header already records: 1,159 serialised lookups for a 3.6 km
 * territory, every time the screen mounted, which left the count reading zero
 * for seconds after a download had plainly finished.
 */
export async function tileKeys(): Promise<Set<string>> {
  const d = await db()
  return new Set((await d.getAllKeys('tiles')) as string[])
}

export async function tileClear(): Promise<void> {
  const d = await db()
  await d.clear('tiles')
}

/**
 * Ask the browser not to throw this app's data away.
 *
 * Without it, everything here is "best-effort" storage: a browser short of disk
 * may evict it, and iOS Safari clears script-writable storage after seven days
 * of not opening a site that is not installed to the home screen. For a field
 * app that means a rep back from a week off finds an app that looks freshly
 * installed — leads re-download, but anything still in the outbox does not come
 * back, because the server never heard of it.
 *
 * Granted, not requested: browsers decide, mostly on whether the site is
 * installed or well used. Chrome grants it to an installed PWA and usually
 * refuses a tab someone opened once. That is why the answer is reported rather
 * than assumed — "we asked" is not the same fact as "it is safe", and the More
 * screen should not claim the second when it only knows the first.
 *
 * Idempotent and cheap: a browser that has already granted it returns true
 * without prompting anyone.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    // Ask only when it is not already granted. `persist()` can prompt in some
    // browsers, and a prompt on every launch would be its own bug.
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    // Some engines throw in private browsing rather than answering. Not being
    // able to ask is the same outcome as being told no.
    return false
  }
}

/** Whether the browser has already promised to keep this app's data. */
export async function storageIsPersisted(): Promise<boolean> {
  if (!navigator.storage?.persisted) return false
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}

/**
 * How much room this device has left, or null where the browser won't say.
 *
 * Reporting only. An earlier version of this comment described dropping the
 * oldest already-uploaded photos when the quota got close; no such code was ever
 * written, and photos are now kept on the phone deliberately so a rep can open
 * any of them with no signal. What guards against a full device is `StorageFull`
 * below — the write fails loudly instead of the disk quietly filling.
 */
export async function estimateStorage(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null
  const est = await navigator.storage.estimate()
  if (est.usage == null || est.quota == null) return null
  return { usedMB: est.usage / 1e6, quotaMB: est.quota / 1e6 }
}
