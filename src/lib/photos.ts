import type { Photo } from '../types'
import { AuthExpiredError, OfflineError, online, uploadPhoto } from './api'
import * as store from './db'

/**
 * The photo outbox.
 *
 * Photos are the one thing a rep produces that is too big to ride the mutation
 * queue. That queue batches forty writes into one request that has to succeed
 * as a unit; dropping a 200KB image into it means a slow upload on one bar of
 * signal can cost a rep their whole morning of knocks. So the bytes travel
 * separately, and this is what carries them.
 *
 * Three things shape it:
 *
 *   Order. The server refuses bytes for a photo it has no row for — that row is
 *   what proves the photo belongs to a property in this tenant — so the
 *   metadata mutation has to land first. The drain does not try to sequence the
 *   two queues; it just reads the server's "not yet" and comes back.
 *
 *   One at a time. Six parallel uploads on a cellular edge is how you make
 *   every one of them time out.
 *
 *   The photos are the queue. There is no second store listing what to send —
 *   see the note on `Photo.pending`.
 */

type Listener = (snapshot: PhotoSyncSnapshot) => void

export interface PhotoSyncSnapshot {
  /** Photos whose bytes are still owed to the server. */
  waiting: number
  /** Photos that ran out of attempts. A person has to ask again. */
  failed: number
  /** Photos on a deployment with nowhere to put them. Not a failure. */
  localOnly: number
  /** Bytes still owed — what "waiting" actually costs on a data plan. */
  waitingBytes: number
  uploading: boolean
}

/** Same budget as the mutation outbox: eight tries, then a person decides. */
const MAX_ATTEMPTS = 8
const backoffMs = (attempts: number) => Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))

let listeners: Listener[] = []
let updated: ((photo: Photo) => void) | null = null
/**
 * Whether this app session has already re-asked a server that once had no
 * photo storage.
 *
 * Once per launch, not once ever: turning R2 on is a deploy, and a rep whose
 * photos were marked local last week must not have to know that in order to
 * get them off their phone. Once per launch is also the ceiling — re-probing on
 * every drain would mean a guaranteed 503 every few seconds, forever, on the
 * deployments where the answer really is no.
 */
let reprobed = false
let uploading = false
let retryTimer: number | undefined
let snap: PhotoSyncSnapshot = {
  waiting: 0,
  failed: 0,
  localOnly: 0,
  waitingBytes: 0,
  uploading: false,
}

const owed = (p: Photo) => !!p.pending && !p.localOnly
const spent = (p: Photo) => (p.attempts ?? 0) >= MAX_ATTEMPTS

/**
 * Where a photo's bytes are, in one word, for anything that has to say so.
 *
 * A pure function of the row and exported deliberately: the strip on the visit
 * screen and the queue on the More screen have to agree, and the only way two
 * screens disagree about this is if each works it out from the flags itself.
 *
 *   uploaded — on the server as well as here.
 *   waiting  — owed, and still trying.
 *   failed   — owed, out of attempts, waiting on a person.
 *   local    — nowhere to send it. Not a failure, and must not be drawn as one.
 */
export type PhotoState = 'uploaded' | 'waiting' | 'failed' | 'local'

export function photoState(p: Photo): PhotoState {
  if (p.localOnly) return 'local'
  if (!p.pending) return p.uploadedAt ? 'uploaded' : 'local'
  return spent(p) ? 'failed' : 'waiting'
}

export function subscribePhotoSync(l: Listener): () => void {
  listeners.push(l)
  l(snap)
  return () => {
    listeners = listeners.filter((x) => x !== l)
  }
}

export function getPhotoSyncSnapshot(): PhotoSyncSnapshot {
  return snap
}

/**
 * How the store hears about a photo the drain changed.
 *
 * A callback rather than an import, because this module must not depend on the
 * store: the store already imports the queue, and a cycle between the two is
 * the kind of thing that works in dev and comes apart in a production bundle.
 */
export function onPhotoUpdated(fn: (photo: Photo) => void) {
  updated = fn
}

async function recount() {
  const rows = await store.all<Photo>('photos')
  const pending = rows.filter(owed)
  const live = pending.filter((p) => !spent(p))
  snap = {
    waiting: live.length,
    failed: pending.length - live.length,
    localOnly: rows.filter((p) => p.localOnly).length,
    waitingBytes: live.reduce((sum, p) => sum + (p.bytes || 0), 0),
    uploading,
  }
  listeners.forEach((l) => l(snap))
}

async function save(photo: Photo) {
  await store.put('photos', photo)
  updated?.(photo)
}

/**
 * Put every local-only photo back in the queue.
 *
 * Called when something *did* upload, because that is proof the server has
 * somewhere to put photos after all — and a photo marked local on the strength
 * of a 503 that no longer happens is simply wrong.
 */
async function reviveLocalOnly(rows?: Photo[]): Promise<number> {
  const all = rows ?? (await store.all<Photo>('photos'))
  const stranded = all.filter((p) => p.localOnly && !p.uploadedAt)
  for (const p of stranded) {
    await save({ ...p, pending: true, localOnly: false, attempts: undefined, lastError: undefined })
  }
  return stranded.length
}

/**
 * Send whatever is owed, oldest first.
 *
 * Returns when the queue is empty or when it hits something waiting will not
 * fix. Every early exit leaves the remaining rows exactly as they were.
 */
export async function drainPhotos(): Promise<void> {
  if (uploading) return
  if (!online()) return

  uploading = true
  await recount()

  try {
    for (;;) {
      if (!online()) break
      const rows = await store.all<Photo>('photos')
      let queue = rows
        .filter((p) => owed(p) && !spent(p))
        .sort((a, b) => a.createdAt - b.createdAt)

      /*
        Nothing owed, but photos sitting here marked local. Ask once.

        Without this they are stranded: a photo marked local is not owed, so it
        is not in the queue, not in the count, and there is no failure for a
        person to retry. Turning photo storage on would leave every photo taken
        before the deploy on the phone forever, and the only sign of it would be
        a rep saying the office never got their roof shots.
      */
      if (queue.length === 0 && !reprobed) {
        reprobed = true
        const stranded = rows
          .filter((p) => p.localOnly && !p.uploadedAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (stranded.length > 0) {
          const probe = { ...stranded[0], pending: true, localOnly: false }
          await save(probe)
          queue = [probe]
        }
      }
      if (queue.length === 0) break

      const photo = queue[0]
      let outcome
      try {
        outcome = await uploadPhoto(photo.id, photo.dataUrl)
      } catch (err) {
        // Lost the link, or the session died. Neither is the photo's fault and
        // neither is fixed by burning its retry budget.
        if (err instanceof OfflineError || err instanceof AuthExpiredError) break
        const attempts = (photo.attempts ?? 0) + 1
        await save({
          ...photo,
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
        })
        scheduleRetry(backoffMs(attempts))
        break
      }

      if (outcome === 'stored') {
        await save({
          ...photo,
          pending: false,
          uploadedAt: Date.now(),
          attempts: undefined,
          lastError: undefined,
        })
        // An upload landing is proof the server has somewhere to put photos, so
        // anything still marked local on the strength of an older refusal is
        // wrong and goes back in the queue.
        await reviveLocalOnly()
        continue
      }

      if (outcome === 'waiting') {
        // The metadata row is still in the mutation outbox. Every photo behind
        // this one is newer, so they are at least as unsent — stop rather than
        // walk the whole queue collecting the same answer.
        scheduleRetry(backoffMs(1))
        break
      }

      // 'unsupported': there is no photo storage on this deployment. That is a
      // fact about the server, not about this photo, so it is recorded on every
      // photo that was waiting — otherwise the queue re-asks the same question
      // once per photo, forever, and the rep is told something is failing when
      // nothing is.
      for (const p of queue) {
        await save({ ...p, pending: false, localOnly: true, attempts: undefined, lastError: undefined })
      }
      break
    }
  } finally {
    uploading = false
    await recount()
  }
}

function scheduleRetry(ms: number) {
  if (retryTimer) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    void drainPhotos()
  }, ms)
}

/**
 * Try the ones that gave up again.
 *
 * `localOnly` is cleared too: a deployment that had no photo storage is exactly
 * the sort of thing that gets fixed between one day and the next, and a rep who
 * asks for a retry should not have to know that the reason their photos never
 * left was configuration rather than signal.
 */
export async function retryFailedPhotos(): Promise<void> {
  const rows = await store.all<Photo>('photos')
  for (const p of rows) {
    if (p.uploadedAt || p.localOnly) continue
    if (!spent(p)) continue
    await save({ ...p, pending: true, localOnly: false, attempts: undefined, lastError: undefined })
  }
  await reviveLocalOnly(rows)
  // Asking by hand is also a reason to ask the server again, whatever it said
  // last time this session.
  reprobed = false
  await recount()
  void drainPhotos()
}

export async function initPhotoSync(): Promise<void> {
  await recount()
}
