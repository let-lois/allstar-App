import type {
  ActivityEvent,
  Appointment,
  DailyStat,
  Note,
  Property,
  Route,
  Task,
  Territory,
  LeadList,
  Visit,
} from '../types'
import * as db from './db'
import { purgeErased } from './erase-local'
import type { BootstrapDTO, LeadListDTO } from './http'
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
  'territories',
  'leadLists',
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

/** The wire shape has nulls where the app has optionals. */
export function leadListFromDTO(d: LeadListDTO): LeadList {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? undefined,
    createdBy: d.createdBy ?? undefined,
    boundary: d.boundary,
    archived: !!d.archived,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    leadIds: Array.isArray(d.leadIds) ? d.leadIds : [],
    repIds: Array.isArray(d.repIds) ? d.repIds : [],
  }
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

  // Settings are a single blob, not a store — kept in `meta` so it survives the
  // same wipe rules as everything else without needing a table of one row.
  if (dto.settings) await db.metaSet('allstar.settings', dto.settings)
  if (dto.timezone) await db.metaSet('allstar.timezone', dto.timezone)
  // The price list rides with settings: small, no history, needed offline at
  // the door. Absent (an older Worker) leaves what the phone already had.
  if (dto.plans) await db.metaSet('allstar.plans', dto.plans)

  /*
    The roster, same treatment and for the same reason as settings: it is one
    small list, it has no history, and it has to be on the device.

    Offline is the point. A rep checks the standings in a truck between streets,
    which is exactly where there is no signal — and a leaderboard that degrades
    into a column of user ids the moment the bars drop is a leaderboard nobody
    opens twice.
  */
  if (dto.team) await db.metaSet('allstar.roster', dto.team)

  await Promise.all([
    replace('properties', dto.properties as Property[], pending),
    replace('routes', dto.routes as Route[], pending),
    replace('appointments', dto.appointments as Appointment[], pending),
    replace('tasks', dto.tasks as Task[], pending),
    replace('activity', dto.activity as ActivityEvent[], pending),
    replace('dailyStats', dto.dailyStats as DailyStat[], pending),
    replace('territories', (dto.territories ?? []) as Territory[], pending),
    /*
      Lists ride the same rule as everything above: a full replace when the
      outbox is empty, a merge when it is not. A list made on this phone a
      minute ago and not yet sent is exactly the "row the server did not
      mention" that the merge rule exists to keep.
    */
    replace('leadLists', (dto.leadLists ?? []).map(leadListFromDTO), pending),
  ])

  /*
    Notes are merged, never replaced — the one server-owned list that is not.

    `notes` is a local-work store: it holds what this phone wrote, some of it
    not yet sent, and a replace would destroy exactly those rows. So the
    server's notes are written over the top by id. A note this phone sent
    already carries the same id and simply loses its `pending`; a teammate's
    or a rep's (read by the office) is added; nothing is removed here — an
    erased lead's notes go with the erasure below.
  */
  if (dto.notes?.length) await db.putAll('notes', dto.notes as Note[])

  /*
    Visits, merged the same way and for the same reason: this phone's own
    visits — one in progress, or one finished but not yet sent — must survive.
    A visit this phone already holds keeps what only the phone knows (its
    photo ids, its pending flag) and takes nothing from the server's copy; one
    it has never seen — a teammate's, or one from another device — is added,
    so a lead's history is the same wherever it is opened.
  */
  if (dto.visits?.length) {
    const incoming = dto.visits as Visit[]
    const mine = await db.all<Visit>('visits')
    const have = new Map(mine.map((v) => [v.id, v]))
    const fresh = incoming.filter((v) => !have.has(v.id))
    if (fresh.length) await db.putAll('visits', fresh)
  }

  /*
    Erasures last, and the order is not arbitrary.

    Erasing a lead writes the tombstone *before* it destroys the row, on purpose:
    a failure half way through then leaves a record of what was meant rather than
    orphaned files nobody can find. The cost of that ordering is a window, a few
    hundred milliseconds wide, in which a bootstrap sees the property in the
    properties list *and* its id in the erased list. Purging first would write the
    lead straight back and leave it on the phone until some later refresh; purging
    afterwards settles it now. The window is narrow and this is the one mechanism
    where "it corrects itself eventually" is not an acceptable answer.

    It also sits outside the `pending` rule that governs every line above. A
    queued outbox turns a replace into a merge because a row the server did not
    mention might be work it has not seen yet — but an erased id is not
    unmentioned, it is named, and an erasure does not wait for a queue to drain.
    See erase-local.ts.
  */
  if (dto.erased?.length) await purgeErased(dto.erased)
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
  // One company's outcome labels have no business showing up under another's
  // account on a shared phone.
  await db.metaSet('allstar.settings', undefined)
  await db.metaSet('allstar.timezone', undefined)
  await db.metaSet('allstar.plans', undefined)
}
