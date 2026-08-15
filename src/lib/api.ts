import type { Mutation } from '../types'

/**
 * Stand-in for the real backend.
 *
 * The point of keeping it behind this interface is that the offline queue,
 * optimistic UI and sync indicator are all written against a *real* async
 * boundary that can fail — so swapping in HTTP later is a one-file change, not a
 * rewrite of every screen.
 */

export class OfflineError extends Error {
  constructor() {
    super('offline')
    this.name = 'OfflineError'
  }
}

/** Devtools switch: simulate a dead zone without pulling the Wi-Fi. */
let forcedOffline = false
export function setForcedOffline(v: boolean) {
  forcedOffline = v
}
export function isForcedOffline() {
  return forcedOffline
}

export function online(): boolean {
  return !forcedOffline && navigator.onLine
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Push one mutation. Throws OfflineError when there's no link (the queue keeps
 * the row) and a generic Error on a server-side reject (the queue records the
 * failure and backs off).
 */
export async function pushMutation(m: Mutation): Promise<void> {
  if (!online()) throw new OfflineError()
  // Cellular round-trip on the edge of coverage is not 30ms. Model it.
  await sleep(220 + Math.random() * 380)
  if (!online()) throw new OfflineError()
  // Photos are big; give them a realistic extra beat.
  if (m.kind === 'photo.create') await sleep(400 + Math.random() * 600)
}

export async function fetchBootstrap(): Promise<void> {
  if (!online()) throw new OfflineError()
  await sleep(300)
}
