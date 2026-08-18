import type { Role } from '../types'

/**
 * The API client.
 *
 * Deliberately thin. The app is offline-first and reads from IndexedDB, so this
 * is only used at three moments: signing in, refreshing the local cache, and
 * draining the outbox. Nothing on a screen ever awaits it.
 */

/**
 * Overridable at build time so a local dev server can point at `wrangler dev`.
 * The default is the deployed Worker, which is what a Pages build should use.
 */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://allstar-api.josh-af6.workers.dev'

export interface SessionUserDTO {
  id: string
  clientId: string
  clientName: string
  email: string
  name: string
  role: Role
  phone?: string
}

/**
 * Distinguishes "the server said no" from "we couldn't reach the server".
 * The outbox must retry the second and never the first — retrying a rejection
 * forever is how a queue wedges.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class NetworkError extends Error {
  /**
   * Declared rather than inherited: `Error.cause` is ES2022 and this project
   * targets ES2020 so the bundle stays parseable on older field phones.
   */
  readonly reason?: unknown

  constructor(reason?: unknown) {
    super('Could not reach the server')
    this.name = 'NetworkError'
    this.reason = reason
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  token?: string
  /** Give up rather than hang a screen on a stalled cellular request. */
  timeoutMs?: number
  raw?: BodyInit
  contentType?: string
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.raw ? {} : { 'content-type': 'application/json' }),
        ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: controller.signal,
    })
  } catch (err) {
    // A refusal, a DNS failure, an abort — all "unreachable" from here.
    throw new NetworkError(err)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    let code: string | undefined
    try {
      const body = (await res.json()) as { error?: string; code?: string }
      if (body?.error) message = body.error
      code = body?.code
    } catch {
      /* not JSON — keep the status message */
    }
    throw new ApiError(res.status, message, code)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/* --- endpoints ------------------------------------------------------------ */

export function apiLogin(email: string, password: string) {
  return request<{ token: string; user: SessionUserDTO }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    // Login hashes a password server-side; give it room.
    timeoutMs: 30_000,
  })
}

export function apiLogout(token: string) {
  return request<{ ok: true }>('/api/auth/logout', { method: 'POST', token })
}

export function apiBootstrap(token: string) {
  return request<BootstrapDTO>('/api/bootstrap', { token, timeoutMs: 30_000 })
}

export function apiPushMutations(
  token: string,
  mutations: { id: string; kind: string; payload: unknown; createdAt: number }[],
) {
  return request<{ results: { id: string; status: string; error?: string }[] }>('/api/mutations', {
    method: 'POST',
    body: { mutations },
    token,
    timeoutMs: 30_000,
  })
}

export function apiUploadPhoto(token: string, photoId: string, blob: Blob) {
  return request<{ ok: true; key: string }>(`/api/photos/${photoId}`, {
    method: 'POST',
    token,
    raw: blob,
    contentType: blob.type || 'image/jpeg',
    timeoutMs: 60_000,
  })
}

export interface TeamUserDTO {
  id: string
  name: string
  email: string
  role: Role
  phone?: string
  active: boolean
  /** Invited but hasn't set a password yet. */
  pending: boolean
}

export function apiUsers(token: string) {
  return request<{ users: TeamUserDTO[] }>('/api/users', { token })
}

export interface GeocodeRequestDTO {
  ref: string
  address1: string
  city?: string
  state?: string
  zip?: string
}

export interface GeocodeMatchDTO {
  ref: string
  lat?: number
  lng?: number
  matchedAddress?: string
  status: 'match' | 'no_match' | 'tie'
}

export function apiGeocode(token: string, rows: GeocodeRequestDTO[]) {
  return request<{ matches: GeocodeMatchDTO[] }>('/api/import/geocode', {
    method: 'POST',
    body: { rows },
    token,
    // A batch of a hundred addresses through a government service is not fast.
    timeoutMs: 60_000,
  })
}

export interface ImportRowDTO {
  ref: string
  address1: string
  city?: string
  state?: string
  zip?: string
  lat?: number
  lng?: number
  ownerName?: string
  phone?: string
  email?: string
  opportunityValue?: number
  roofAgeYears?: number
  squareFeet?: number
}

export interface ImportResultDTO {
  created: number
  updated: number
  rejected: { ref: string; reason: string }[]
  territoryId?: string
}

export function apiImport(
  token: string,
  input: { rows: ImportRowDTO[]; assignRepId?: string; territoryName?: string },
) {
  return request<ImportResultDTO>('/api/import/properties', {
    method: 'POST',
    body: input,
    token,
    timeoutMs: 60_000,
  })
}

/** Shape returned by /api/bootstrap — already in the client's domain casing. */
export interface BootstrapDTO {
  user: SessionUserDTO
  properties: unknown[]
  routes: unknown[]
  appointments: unknown[]
  tasks: unknown[]
  activity: unknown[]
  dailyStats: unknown[]
  serverTime: number
}
