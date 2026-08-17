import type { Mutation, MutationKind, SyncState } from '../types'
import { OfflineError, online, pushMutation } from './api'
import * as store from './db'
import { uid } from './id'

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

  try {
    // Re-read each pass: the rep keeps working while we're draining.
    for (;;) {
      const rows = (await store.all<Mutation>('outbox'))
        .filter((r) => r.status !== 'failed')
        .sort((a, b) => a.createdAt - b.createdAt)
      const next = rows[0]
      if (!next) break

      if (!online()) break

      try {
        await pushMutation(next)
        await store.del('outbox', next.id)
        lastSyncedAt = Date.now()
      } catch (err) {
        if (err instanceof OfflineError) {
          // Not a failure — we simply lost the link. Keep the row untouched.
          break
        }
        next.attempts += 1
        next.lastError = err instanceof Error ? err.message : String(err)
        if (next.attempts >= MAX_ATTEMPTS) {
          next.status = 'failed'
          await store.put('outbox', next)
        } else {
          await store.put('outbox', next)
          scheduleRetry(backoffMs(next.attempts))
          break
        }
      }
      await recount()
    }
  } finally {
    draining = false
    await recount()
  }
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
