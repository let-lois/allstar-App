import type { Mutation, MutationKind, SyncState } from '../types'
import {
  AuthExpiredError,
  BATCH_SIZE,
  OfflineError,
  online,
  pushMutations,
  type PushResult,
} from './api'
import * as store from './db'
import { uid } from './id'
import { drainPhotos } from './photos'

/**
 * Durable outbox.
 *
 * Every write the rep makes goes into IndexedDB first and is drained in FIFO
 * order. Nothing in the UI ever waits on the network: a completed visit is
 * "saved" the moment it's queued, and the sync chip is what tells the rep
 * whether it has made it to the server yet.
 */

type Listener = (snapshot: SyncSnapshot) => void

export interface SyncSnapshot {
  state: SyncState
  pending: number
  failed: number
  lastSyncedAt?: number
  draining: boolean
}

const MAX_ATTEMPTS = 8
/** Exponential backoff, capped — a rep in a basement shouldn't hammer the radio. */
const backoffMs = (attempts: number) => Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))

let listeners: Listener[] = []
let draining = false
let lastSyncedAt: number | undefined
let pendingCount = 0
let failedCount = 0
let retryTimer: number | undefined

function snapshot(): SyncSnapshot {
  let state: SyncState
  if (!online()) state = 'offline'
  else if (draining) state = 'syncing'
  else if (failedCount > 0) state = 'error'
  else if (pendingCount > 0) state = 'pending'
  else state = 'synced'
  return { state, pending: pendingCount, failed: failedCount, lastSyncedAt, draining }
}

function emit() {
  const snap = snapshot()
  listeners.forEach((l) => l(snap))
}

export function subscribeSync(l: Listener): () => void {
  listeners.push(l)
  l(snapshot())
  return () => {
    listeners = listeners.filter((x) => x !== l)
  }
}

export function getSyncSnapshot(): SyncSnapshot {
  return snapshot()
}

async function recount() {
  const rows = await store.all<Mutation>('outbox')
  pendingCount = rows.filter((r) => r.status !== 'failed').length
  failedCount = rows.filter((r) => r.status === 'failed').length
  emit()
}

/** Queue a write. Returns immediately — callers already applied it optimistically. */
export async function enqueue(kind: MutationKind, payload: unknown): Promise<string> {
  const m: Mutation = {
    id: uid('mut'),
    kind,
    payload,
    createdAt: Date.now(),
    attempts: 0,
    status: 'queued',
  }
  await store.put('outbox', m)
  pendingCount += 1
  emit()
  void drain()
  return m.id
}

export async function drain(): Promise<void> {
  if (draining) return
  if (!online()) {
    emit()
    return
  }
  draining = true
  emit()

  /*
    Whether the outbox emptied, as opposed to the drain stopping for a reason.

    It decides whether photo bytes are attempted afterwards. The server refuses
    bytes for a photo whose metadata row hasn't landed, so sending them while
    writes are still queued is a round trip that can only be told "not yet".
  */
  let clean = false

  try {
    // Re-read each pass: the rep keeps working while we're draining.
    for (;;) {
      const rows = (await store.all<Mutation>('outbox'))
        .filter((r) => r.status !== 'failed')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, BATCH_SIZE)
      if (rows.length === 0) {
        clean = true
        break
      }
      if (!online()) break

      let results: PushResult[]
      try {
        results = await pushMutations(rows)
      } catch (err) {
        if (err instanceof OfflineError) {
          // Not a failure — we simply lost the link. Keep the rows untouched.
          break
        }
        if (err instanceof AuthExpiredError) {
          // Nothing to retry until someone signs in again, and the work is
          // still good. Stop the drain; don't burn attempts on it.
          break
        }
        // The whole request failed, so every row in it is still unsent. Charge
        // each one an attempt and back off — this is the path a 500 takes.
        await chargeBatch(rows, err)
        break
      }

      // The server's verdict is authoritative, and `duplicate` means a previous
      // attempt landed and we only lost the response. Both are done.
      const verdict = new Map(results.map((r) => [r.id, r]))
      let settled = 0
      let worst = 0
      for (const row of rows) {
        const r = verdict.get(row.id)
        // A row the server didn't mention at all is an inconsistency we can't
        // resolve from here. Leave it alone and let the next pass carry it.
        if (!r) continue
        settled += 1
        if (r.status === 'applied' || r.status === 'duplicate') {
          await store.del('outbox', row.id)
          lastSyncedAt = Date.now()
          continue
        }
        row.attempts += 1
        row.lastError = r.error ?? 'Rejected by the server'
        if (row.attempts >= MAX_ATTEMPTS) row.status = 'failed'
        worst = Math.max(worst, row.attempts)
        await store.put('outbox', row)
      }

      await recount()
      // Nothing in the batch moved. Re-reading would produce the same rows and
      // the same answer, so stop rather than spin the radio in a tight loop.
      if (settled === 0) {
        scheduleRetry(backoffMs(1))
        break
      }
      if (worst > 0) {
        // Back off before the next pass rather than hammering a row the server
        // keeps refusing.
        scheduleRetry(backoffMs(worst))
        break
      }
    }
  } finally {
    draining = false
    await recount()
  }

  /*
    Photos last, and outside the `finally`.

    Outside because a drain that stopped on a dead link or a dead session has
    nothing to gain from trying a much larger upload over the same link. Last
    because the metadata has to arrive first, and the outbox is where it lives.
  */
  if (clean) await drainPhotos()
}

/** A request that failed as a whole: every row in it is still unsent. */
async function chargeBatch(rows: Mutation[], err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  let worst = 0
  for (const row of rows) {
    row.attempts += 1
    row.lastError = message
    if (row.attempts >= MAX_ATTEMPTS) row.status = 'failed'
    worst = Math.max(worst, row.attempts)
    await store.put('outbox', row)
  }
  await recount()
  scheduleRetry(backoffMs(worst))
}

function scheduleRetry(ms: number) {
  if (retryTimer) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    void drain()
  }, ms)
}

/** Manual "try again" for rows that exhausted their retries. */
export async function retryFailed(): Promise<void> {
  const rows = await store.all<Mutation>('outbox')
  await Promise.all(
    rows
      .filter((r) => r.status === 'failed')
      .map((r) => store.put('outbox', { ...r, status: 'queued' as const, attempts: 0 })),
  )
  await recount()
  void drain()
}

export async function listOutbox(): Promise<Mutation[]> {
  const rows = await store.all<Mutation>('outbox')
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function initSync(): Promise<void> {
  lastSyncedAt = await store.metaGet<number>('lastSyncedAt')
  await recount()

  window.addEventListener('online', () => {
    emit()
    void drain()
  })
  window.addEventListener('offline', () => emit())

  // Coming back from the lock screen is the most common moment a rep regains
  // signal — that's the cheapest place to retry.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void drain()
  })

  void drain()
}

export async function persistLastSynced(): Promise<void> {
  if (lastSyncedAt) await store.metaSet('lastSyncedAt', lastSyncedAt)
}
