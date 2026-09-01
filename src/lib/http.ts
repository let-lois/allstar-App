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
    /**
     * The server's id for the request that failed. Shown to the person looking
     * at the screen so a support message carries something searchable —
     * "it broke" is unactionable, "it broke, reference 7f3a91" is a log query.
     */
    readonly reference?: string,
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
    let reference = res.headers.get('x-request-id') ?? undefined
    try {
      const body = (await res.json()) as { error?: string; code?: string; reference?: string }
      if (body?.error) message = body.error
      code = body?.code
      reference = body?.reference ?? reference
    } catch {
      /* not JSON — keep the status message */
    }
    // Only worth showing when something actually broke. A wrong password does
    // not need a reference number, and offering one makes the ordinary case
    // look like a fault.
    throw new ApiError(res.status, message, code, res.status >= 500 ? reference : undefined)
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

export interface PhotoDTO {
  id: string
  propertyId: string
  visitId?: string
  category: string
  width?: number
  height?: number
  bytes?: number
  capturedAt?: { lat: number; lng: number }
  createdAt: number
}

export function apiPropertyPhotos(token: string, propertyId: string) {
  return request<{ photos: PhotoDTO[] }>(
    `/api/properties/${encodeURIComponent(propertyId)}/photos`,
    { token },
  )
}

/**
 * Pull one photo's bytes down.
 *
 * Its own function rather than a flag on `request`, because the response is not
 * JSON and the error path still is: a 404 or a 503 comes back as an object with
 * a `code` the queue reasons about, and losing that by reading every response as
 * a blob would turn "this deployment has no photo storage" into a corrupt image.
 */
export async function apiFetchPhoto(token: string, photoId: string): Promise<Blob> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/photos/${encodeURIComponent(photoId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
  } catch (err) {
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
      /* the refusals are JSON; a body that isn't keeps the status message */
    }
    throw new ApiError(res.status, message, code)
  }
  return await res.blob()
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

export interface FootprintDTO {
  visits: number
  notes: number
  photos: number
  tasks: number
  appointments: number
  activity: number
  assignedProperties: number
}

/** What a permanent delete would destroy, counted before it happens. */
export function apiFootprint(token: string, userId: string) {
  return request<FootprintDTO>(`/api/users/${userId}/footprint`, { token })
}

export function apiSetPassword(token: string, userId: string, password: string) {
  return request<{ ok: true }>(`/api/users/${userId}/password`, {
    method: 'POST',
    body: { password },
    token,
    // Hashing is deliberately expensive; give the Worker room.
    timeoutMs: 30_000,
  })
}

export function apiResetLink(token: string, userId: string) {
  return request<{ url: string; email: string; expiresAt: number }>(
    `/api/users/${userId}/reset-link`,
    { method: 'POST', token },
  )
}

export function apiSetActive(token: string, userId: string, active: boolean) {
  return request<{ ok: true }>(`/api/users/${userId}/active`, {
    method: 'POST',
    body: { active },
    token,
  })
}

export function apiSetRole(token: string, userId: string, role: Role) {
  return request<{ ok: true }>(`/api/users/${userId}/role`, {
    method: 'POST',
    body: { role },
    token,
  })
}

export interface AuditRowDTO {
  id: string
  actorName: string
  action: string
  targetType?: string
  targetLabel?: string
  detail?: Record<string, unknown>
  at: number
}

export function apiAudit(token: string, opts: { limit?: number; before?: number } = {}) {
  const q = new URLSearchParams()
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.before) q.set('before', String(opts.before))
  const suffix = q.toString() ? `?${q}` : ''
  return request<{ entries: AuditRowDTO[] }>(`/api/audit${suffix}`, { token })
}

export function apiDeleteUser(token: string, userId: string) {
  return request<{ ok: true }>(`/api/users/${userId}`, { method: 'DELETE', token })
}

export interface CreatedInviteDTO {
  url: string
  email: string
  expiresAt: number
}

export function apiInvite(
  token: string,
  input: { email: string; name: string; role: Role; phone?: string },
) {
  return request<CreatedInviteDTO>('/api/invites', { method: 'POST', body: input, token })
}

/**
 * Assign every lead in a territory to a rep.
 *
 * `territoryId: null` addresses the leads that aren't in a territory yet — after
 * a plain import that's all of them, so without it a first import would be
 * unassignable. `repId: null` un-assigns.
 */
export function apiAssignTerritory(
  token: string,
  input: { territoryId: string | null; repId: string | null },
) {
  return request<{ assigned: number }>('/api/territories/assign', {
    method: 'POST',
    body: input,
    token,
    timeoutMs: 30_000,
  })
}

/**
 * Create a territory from a drawn outline.
 *
 * The server decides which leads fall inside it, not the browser. The browser
 * has already worked that out to show a count while drawing, but that count came
 * from whatever it had cached — and the authority on which leads exist is the
 * database. Sending the shape and letting the server match it is the difference
 * between "the 34 leads I could see" and "the leads that are there".
 */
export function apiCreateTerritory(
  token: string,
  input: { name: string; repId: string | null; boundary: { lat: number; lng: number }[] },
) {
  return request<{ territory: { id: string; name: string }; assigned: number }>(
    '/api/territories',
    { method: 'POST', body: input, token, timeoutMs: 30_000 },
  )
}

/** Move specific leads to a rep, rather than a whole territory. */
export function apiAssignProperties(
  token: string,
  input: { propertyIds: string[]; repId: string | null },
) {
  return request<{ assigned: number }>('/api/properties/assign', {
    method: 'POST',
    body: input,
    token,
    timeoutMs: 30_000,
  })
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
  /** `error` means the lookup failed, not that the address is wrong. */
  status: 'match' | 'no_match' | 'tie' | 'error'
  error?: string
  precision?: 'rooftop' | 'interpolated' | 'approximate'
  /** The provider answered a misspelled address by guessing. */
  partial?: boolean
  provider?: 'google' | 'census'
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
  /**
   * Leads that landed in a drawn territory by their coordinates.
   *
   * Optional because a Worker deployed before territory matching existed does
   * not send it, and a console that assumed it would show "0 matched" against
   * the old server — which reads as a failure rather than as a field the server
   * has never heard of.
   */
  territoryMatched?: number
  territoryUnmatched?: number
  /**
   * The ids this import wrote, so the console can offer to assign exactly them.
   *
   * Optional for the same reason the territory counts are: an older Worker does
   * not send it. Without it the offer degrades to a link rather than vanishing.
   */
  ids?: string[]
  /** How many of those nobody will see until somebody assigns them. */
  unassigned?: number
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
  territories?: unknown[]
  /**
   * Names and initials for everyone on the account — enough to label a rep id.
   *
   * Optional because a Worker deployed before this field existed does not send
   * it, and a client that assumes it would break against the old server for as
   * long as the two are out of step.
   */
  team?: { id: string; name: string; role: string; active: boolean }[]
  /**
   * Leads that have been erased, so this device can erase its copies too.
   *
   * The only field here that describes what is *not* in the response. Optional
   * for the same reason as `team`: an older Worker does not send it, and the
   * client must not treat its absence as "nothing has been erased" — it means
   * "this server cannot tell me", which is a different thing and is why the
   * purge runs on a list rather than on a diff.
   */
  erased?: string[]
  settings?: Record<string, unknown>
  /**
   * The company's IANA timezone — the calendar its reporting days are cut on.
   *
   * Optional for the same reason `team` is: a Worker deployed before this field
   * existed does not send it, and a client that assumed it would break against
   * the old server for as long as the two are out of step.
   */
  timezone?: string
  serverTime: number
}

/**
 * Set the calendar reporting days are cut on.
 *
 * Its own endpoint rather than part of the settings blob, and the server draws
 * the same line: that blob is labels and order, where a rename must never
 * rewrite what history means. This changes which day past work belongs to.
 */
export function apiSetTimezone(token: string, timezone: string) {
  return request<{ ok: true; timezone: string }>('/api/settings/timezone', {
    method: 'POST',
    body: { timezone },
    token,
  })
}

export function apiSaveSettings(token: string, settings: unknown) {
  return request<{ ok: true; settings: Record<string, unknown> }>('/api/settings', {
    method: 'POST',
    body: { settings },
    token,
  })
}

export interface LegDTO {
  distanceMeters: number
  seconds: number
  /** Google's encoded polyline. Decode with `google.maps.geometry.encoding`. */
  polyline: string
}

/**
 * One route from where the rep is to a door.
 *
 * Short timeout on purpose. This is a nicety on a screen that is already useful
 * without it — a rep standing outside a house should not watch a spinner for
 * thirty seconds to be shown a line they can live without.
 */
export function apiDirections(
  token: string,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  mode: 'WALK' | 'DRIVE' = 'WALK',
) {
  return request<{ leg: LegDTO }>('/api/directions', {
    method: 'POST',
    body: { from, to, mode },
    token,
    timeoutMs: 9_000,
  })
}

/* --- a company's own CRM --------------------------------------------------- */
//
// No endpoint here returns a stored token, and there is deliberately none that
// could: connecting means pasting a fresh one, which is why there is no "edit".

export interface IntegrationDTO {
  provider: string
  connected: boolean
  locationId?: string
  /** `••••abcd` — enough to tell two tokens apart and useless to a thief. */
  tokenHint?: string
  status?: string
  lastOkAt?: number
  lastError?: string
  lastErrorAt?: number
  config?: Record<string, unknown>
}

export interface IntegrationQueueDTO {
  pending: number
  failed: number
  oldestPendingAt?: number
}

export interface SyncConflictDTO {
  id: string
  propertyId: string
  address: string
  repId: string | null
  repName: string | null
  kind: string
  actedAt: number
  arrivedAt: number
  changedAt: number
  lateByHours: number
  detail: Record<string, unknown>
  reviewedAt: number | null
}

/**
 * Work that reached us days after a rep did it, onto a lead that had moved.
 *
 * The rep's answer already won — that is the rule and this does not change it.
 * These are the ones a human should look at.
 */
export function apiSyncConflicts(token: string, opts: { all?: boolean } = {}) {
  return request<{ conflicts: SyncConflictDTO[] }>(
    `/api/sync-conflicts${opts.all ? '?all=1' : ''}`,
    { token },
  )
}

export function apiReviewSyncConflict(token: string, id: string) {
  return request<{ ok: true }>('/api/sync-conflicts/review', {
    method: 'POST',
    token,
    body: { id },
  })
}

export function apiIntegrations(token: string) {
  return request<{ integration: IntegrationDTO; queue: IntegrationQueueDTO }>(
    '/api/integrations',
    { token },
  )
}

export function apiConnectGhl(token: string, input: { token: string; locationId: string }) {
  return request<{ integration: IntegrationDTO; locationName?: string }>(
    '/api/integrations/ghl',
    {
      method: 'POST',
      token,
      body: input,
      // The Worker asks GoHighLevel whether the credential works before storing
      // it, so this waits on a third party rather than on us.
      timeoutMs: 20_000,
    },
  )
}

/**
 * Which calendar appointments are booked into — or clear it to stop syncing them.
 *
 * Separate from connecting because it is a setting rather than a credential, and
 * a company may reasonably never set one. With no calendar the app does not
 * queue appointments at all, rather than queueing work it cannot send.
 */
export function apiSetGhlCalendar(token: string, calendarId: string) {
  return request<{ calendarId: string | null }>('/api/integrations/ghl/calendar', {
    method: 'PUT',
    token,
    body: { calendarId },
  })
}

/**
 * The webhook URL to paste into GoHighLevel — created on first request.
 *
 * POST rather than GET because creating the secret is a write, and a GET that
 * writes is the kind of thing a link scanner or a browser prefetch triggers by
 * accident. `rotate` replaces it, which is also how it is revoked: the URL is
 * the credential.
 */
export function apiGhlWebhook(token: string, rotate = false) {
  return request<{ url: string }>('/api/integrations/ghl/webhook', {
    method: 'POST',
    token,
    body: { rotate },
  })
}

export function apiDisconnectGhl(token: string) {
  return request<{ ok: true; dropped: number }>('/api/integrations/ghl', {
    method: 'DELETE',
    token,
  })
}

/* --- geocoding providers -------------------------------------------------- */

/**
 * The provider catalogue and what this company has configured.
 *
 * The catalogue comes from the server rather than being duplicated here. It
 * carries each vendor's storage terms, and those are the substance of the
 * choice being made on that screen — two copies of them would drift, and the
 * copy that drifts is the one telling a customer what they may keep.
 */
export interface GeocodeProviderDTO {
  id: string
  label: string
  needsKey: boolean
  adapter: 'live' | 'planned'
  storage: 'permanent' | 'conditional' | 'temporary'
  storageNote: string
  price: string
  /** Null where the vendor publishes no simple per-thousand rate. */
  pricePerThousandUsd: number | null
  free: string
  freeCount: number | null
  freePeriod: 'day' | 'month' | null
  accuracy: string
  signup: string
}

export interface GeocoderRowDTO {
  provider: string
  active: boolean
  /** Masked. The key itself is never returned by any endpoint. */
  hint: string
  status: string
  lastOkAt?: number
  lastError?: string
  lastErrorAt?: number
}

export interface GeocodeUsageDTO {
  /** Lookups we have sent on the active key since 00:00 UTC. */
  today: number
  /** Lookups we have sent on it since the first of the month, UTC. */
  month: number
}

export interface GeocodersDTO {
  providers: GeocodeProviderDTO[]
  configured: GeocoderRowDTO[]
  active: string
  usage: GeocodeUsageDTO
}

export function apiGeocoders(token: string) {
  return request<GeocodersDTO>('/api/geocoders', { token })
}

export function apiSaveGeocoderKey(token: string, provider: string, apiKey: string) {
  return request<GeocodersDTO>('/api/geocoders/key', {
    method: 'POST',
    body: { provider, apiKey },
    token,
  })
}

export function apiSetActiveGeocoder(token: string, provider: string) {
  return request<GeocodersDTO>('/api/geocoders/active', {
    method: 'POST',
    body: { provider },
    token,
  })
}

export function apiRemoveGeocoderKey(token: string, provider: string) {
  return request<GeocodersDTO>(`/api/geocoders/key?provider=${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    token,
  })
}
