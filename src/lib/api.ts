import type { Mutation } from '../types'
import {
  ApiError,
  NetworkError,
  apiBootstrap,
  apiPushMutations,
  apiUploadPhoto,
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

/**
 * What became of a photo's bytes.
 *
 * Three outcomes rather than a boolean, because the queue must treat them
 * completely differently and only one of them is a failure:
 *
 *   stored       — done, drop the flag.
 *   waiting      — the metadata row hasn't reached the server yet, so there is
 *                  nothing to attach the bytes to. Not the photo's fault and
 *                  not worth an attempt: the outbox is about to fix it.
 *   unsupported  — this deployment has no photo storage bound. Retrying cannot
 *                  change that, so the photo is marked local and left alone.
 *
 * Anything else throws, and the caller charges an attempt.
 */
export type PhotoUpload = 'stored' | 'waiting' | 'unsupported'

/**
 * Send one photo's bytes.
 *
 * Deliberately not part of `pushMutations`. That request has to succeed or fail
 * as a unit, and putting a multi-megabyte body inside it means a batch of forty
 * cheap writes can be lost to one slow image on one bar of signal.
 */
export async function uploadPhoto(photoId: string, dataUrl: string): Promise<PhotoUpload> {
  if (!sessionKnown()) throw new OfflineError()
  if (!online()) throw new OfflineError()

  if (isDemo()) {
    // A ~200KB image on cellular is not instant, and the whole point of the
    // demo is that the waiting state is visible rather than theoretical.
    await sleep(700 + Math.random() * 900)
    if (!online()) throw new OfflineError()
    return 'stored'
  }

  const token = liveToken()
  if (!token) throw new AuthExpiredError()

  try {
    await apiUploadPhoto(token, photoId, dataUrlToBlob(dataUrl))
    return 'stored'
  } catch (err) {
    // The metadata mutation hasn't been applied yet. The server is right to
    // refuse — it has nothing proving this photo belongs to a property in this
    // tenant — and the outbox is what fixes it, not a retry from here.
    if (err instanceof ApiError && err.status === 404) return 'waiting'
    if (err instanceof ApiError && err.code === 'no_photo_storage') return 'unsupported'
    throw translate(err)
  }
}

/**
 * A data URL back to bytes.
 *
 * `fetch(dataUrl)` would be one line and is what most code does, but it routes
 * a multi-megabyte string through the network stack and a service worker for no
 * reason. This is the same work without leaving the main thread's memory.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, comma)
  const type = /:(.*?)[;,]/.exec(header)?.[1] ?? 'image/jpeg'
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
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
