import type { Mutation } from '../types'
import {
  ApiError,
  NetworkError,
  apiBootstrap,
  apiPushMutations,
  type BootstrapDTO,
} from './http'
import { isDemo, liveToken, sessionKnown, signalAuthExpired } from './session'

/**
 * The boundary between the app and the server.
 *
 * Two implementations behind one interface: the demo simulator and real HTTP.
 * Everything above this file — the outbox, the optimistic writes, the sync chip
 * — is written against the interface, so the demo exercises exactly the same
 * failure paths as production instead of a happy path that only production
 * discovers is wrong.
 */

/**
 * No link. Distinct from a failure on purpose: the queue leaves an offline row
 * completely untouched, whereas a rejection burns an attempt and backs off.
 * Conflating them is how an offline queue exhausts its retries in a tunnel and
 * marks a rep's whole morning as failed.
 */
export class OfflineError extends Error {
  constructor() {
    super('offline')
    this.name = 'OfflineError'
  }
}

/**
 * The session is gone — expired, revoked, or the pepper changed under us.
 * Retrying cannot help, but the queued work is still valid, so the drain stops
 * and the rows wait for the next sign-in rather than being thrown away.
 */
export class AuthExpiredError extends Error {
  constructor() {
    super('Signed out')
    this.name = 'AuthExpiredError'
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

export type PushOutcome = 'applied' | 'duplicate' | 'rejected'

export interface PushResult {
  id: string
  status: PushOutcome
  error?: string
}

/**
 * How many mutations go up in one request.
 *
 * Batched because the shape of the problem is bursty: a rep works a street with
 * no signal and then queues thirty writes the moment a bar appears. Sending
 * those one at a time is thirty cellular round trips, and any one of them
 * dropping restarts the tail. The server caps a batch at 200; staying well under
 * that keeps a single request inside a Worker's CPU budget even when several
 * rows are expensive.
 */
export const BATCH_SIZE = 40

/**
 * Push a batch. Returns a per-mutation verdict — the server is the authority on
 * which ones landed, and `duplicate` is a success: it means a previous attempt
 * got through and the response is what we lost.
 *
 * Throws OfflineError when there's no link (rows keep their place),
 * AuthExpiredError when the session is dead, and a plain Error on a server-side
 * failure that affected the whole batch.
 */
export async function pushMutations(rows: Mutation[]): Promise<PushResult[]> {
  if (rows.length === 0) return []
  // Until we know who is signed in, there is no correct destination for a write.
  // Treated as "no link" rather than an error, so the rows keep their place and
  // their retry budget — the drain simply comes back when boot has finished.
  if (!sessionKnown()) throw new OfflineError()
  if (!online()) throw new OfflineError()

  if (isDemo()) {
    // Cellular round-trip on the edge of coverage is not 30ms. Model it, and
    // give photos the extra beat their size actually costs.
    await sleep(220 + Math.random() * 380)
    if (rows.some((r) => r.kind === 'photo.create')) await sleep(400 + Math.random() * 600)
    if (!online()) throw new OfflineError()
    return rows.map((r) => ({ id: r.id, status: 'applied' as const }))
  }

  const token = liveToken()
  if (!token) throw new AuthExpiredError()

  try {
    const res = await apiPushMutations(
      token,
      rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, createdAt: r.createdAt })),
    )
    return res.results.map((r) => ({
      id: r.id,
      status: (r.status as PushOutcome) ?? 'rejected',
      error: r.error,
    }))
  } catch (err) {
    throw translate(err)
  }
}

export async function fetchBootstrap(): Promise<BootstrapDTO | null> {
  if (!sessionKnown() || isDemo()) return null
  if (!online()) throw new OfflineError()
  const token = liveToken()
  if (!token) throw new AuthExpiredError()
  try {
    return await apiBootstrap(token)
  } catch (err) {
    throw translate(err)
  }
}

/**
 * Collapses the HTTP client's errors onto the three the queue reasons about.
 * A 401 is signalled globally as well as thrown, because it is almost always
 * discovered by a background drain with no screen attached to it.
 */
function translate(err: unknown): Error {
  if (err instanceof NetworkError) return new OfflineError()
  if (err instanceof ApiError && err.status === 401) {
    signalAuthExpired()
    return new AuthExpiredError()
  }
  return err instanceof Error ? err : new Error(String(err))
}
