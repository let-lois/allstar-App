import type { BadgeInfo, BadgeStatus, LeadStatus, OnboardingStatus, OnboardingStep, Role } from '../types'

/**
 * The API client.
 *
 * Deliberately thin. The app is offline-first and reads from IndexedDB, so this
 * is only used at three moments: signing in, refreshing the local cache, and
 * draining the outbox. Nothing on a screen ever awaits it.
 */

/*
  `API_URL` lives in its own module so that anything needing only the address —
  the tile URLs, a Node gate — can import it without pulling in this file, whose
  class fields Node's strip-only TypeScript loader cannot parse. Re-exported so
  every existing `from './http'` import keeps working.
*/
import { API_URL } from './api-url'
export { API_URL }

export interface SessionUserDTO {
  id: string
  clientId: string
  clientName: string
  email: string
  name: string
  role: Role
  phone?: string
  /*
    The rest is what /api/me and the login payload carry beyond the session
    fields. All optional: a bootstrap mock, or a server from before onboarding
    existed, sends none of it, and the app treats "absent" as "nothing to do".
  */
  firstName?: string
  lastName?: string
  jobTitle?: string
  teamId?: string
  teamName?: string
  avatarUrl?: string
  onboarding?: { status: OnboardingStatus; step?: OnboardingStep; version: number; completedAt?: number }
  badge?: BadgeInfo | null
  company?: { name: string; timezone: string; logoUrl?: string; website?: string; badgeQrUrl?: string }
}

export function apiMe(token: string) {
  return request<{ user: SessionUserDTO }>('/api/me', { token })
}

/** Redeem a company join code: creates the account (or claims a pending one) and signs in. */
export function apiJoin(input: {
  code: string
  email: string
  password: string
  firstName?: string
  lastName?: string
}) {
  return request<{ token: string; user: SessionUserDTO; claimedInvite: boolean }>('/api/join', {
    method: 'POST',
    body: input,
    // Hashes a password server-side; give it room, as login does.
    timeoutMs: 30_000,
  })
}

/* --- onboarding --------------------------------------------------------- */

export interface ChecklistItemDTO {
  key: string
  label: string
  done: boolean
  required: boolean
  detail?: string
}

/** Mirrors `OnboardingView` in api/src/onboardingFlow.ts. */
export interface OnboardingViewDTO {
  status: OnboardingStatus
  step: OnboardingStep
  steps: OnboardingStep[]
  version: number
  requiredVersion: number
  completedAt?: number
  profile: {
    firstName?: string
    lastName?: string
    email: string
    phone?: string
    jobTitle?: string
    teamName?: string
    hasPhoto: boolean
    editable: ('firstName' | 'lastName' | 'phone' | 'jobTitle')[]
    locked: ('email' | 'role' | 'team')[]
  }
  missing: ('firstName' | 'lastName' | 'photo')[]
  setup: { completedAt?: number; locationStatus?: string; notificationStatus?: string }
  walkthrough: { completedAt?: number }
  badge: BadgeInfo | null
  checklist: ChecklistItemDTO[]
  canComplete: boolean
}

export function apiOnboarding(token: string) {
  return request<OnboardingViewDTO>('/api/me/onboarding', { token })
}

export function apiOnboardingStep(token: string, step: OnboardingStep, data?: Record<string, unknown>) {
  return request<OnboardingViewDTO>('/api/me/onboarding/step', {
    method: 'POST',
    body: { step, data: data ?? {} },
    token,
  })
}

/**
 * Delete the signed-in person's own account (App Store 5.1.1(v)). The password
 * and a typed DELETE are checked by the server; the phone signs out after.
 */
export function apiDeleteAccount(token: string, input: { password: string; confirm: string }) {
  return request<{ ok: true }>('/api/me/delete', { method: 'POST', body: input, token, timeoutMs: 30_000 })
}

export function apiUpdateProfile(
  token: string,
  input: { firstName?: string; lastName?: string; phone?: string; jobTitle?: string },
) {
  return request<{ user: SessionUserDTO }>('/api/me/profile', { method: 'PATCH', body: input, token })
}

/* --- a badge, checked by whoever it was shown to ------------------------- */

export type VerifyStatus = 'active' | 'expired' | 'pending' | 'inactive'
export interface VerifyDTO {
  status: VerifyStatus
  badge: { id: string; issuedAt?: number; expiresAt?: number }
  person: { name: string; title?: string; photoUrl?: string }
  company: { name: string; logoUrl?: string; website?: string; badgeQrUrl?: string }
}

/** Public: no session. 404 for an unknown number, 429 after too many misses. */
export function apiVerifyBadge(badgeId: string) {
  return request<VerifyDTO>(`/api/verify?badge=${encodeURIComponent(badgeId)}`)
}

export function apiMintBadge(token: string) {
  return request<{ badge: BadgeInfo }>('/api/me/badge', { method: 'POST', token })
}

export function apiConfirmBadge(token: string) {
  return request<{ badge: BadgeInfo }>('/api/me/badge/confirm', { method: 'POST', token })
}

export function apiRenewOwnBadge(token: string) {
  return request<{ badge: BadgeInfo }>('/api/me/badge/renew', { method: 'POST', token })
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

  /**
   * The server answered and the browser threw the answer away.
   *
   * Almost always the allowed-origins list: this deployment's address is not on
   * it, so every response arrives without `access-control-allow-origin` and the
   * browser refuses to hand any of them to the app. The distinction matters
   * because the two failures need opposite advice — a dead link is worth
   * retrying and a configuration mismatch never is, and until now both said
   * "try again in a moment".
   *
   * Undefined when it was not worth finding out; see `answeredButBlocked`.
   */
  readonly blocked?: boolean

  constructor(reason?: unknown, blocked?: boolean) {
    super(blocked ? 'The server answered but the browser blocked the reply' : 'Could not reach the server')
    this.name = 'NetworkError'
    this.reason = reason
    this.blocked = blocked
  }
}

/**
 * Was the server actually there?
 *
 * `fetch` reports a dead network and a refused cross-origin reply as the same
 * bare TypeError, deliberately — a page that could tell them apart could probe
 * other people's servers. So this asks the one question a browser will answer:
 * a `no-cors` request returns an opaque response whenever the host replied at
 * all, and rejects when it did not. It cannot read the reply, which is the
 * point; it only has to establish that there was one.
 *
 * Not run on every failure. A rep in a dead zone is the normal case in this
 * app, and spending a second round trip to confirm what `navigator.onLine`
 * already said would slow the one path that has to stay fast.
 */
async function answeredButBlocked(err: unknown): Promise<boolean> {
  // A timeout is a timeout. The server may well be there and simply slow, and
  // calling that a configuration problem sends somebody to the wrong console.
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

  const probe = new AbortController()
  const timer = setTimeout(() => probe.abort(), 4000)
  try {
    await fetch(`${API_URL}/api/health`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: probe.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
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
    /*
      A refusal, a DNS failure, an abort — and one more that used to hide in
      here: a reply the browser would not let the app read. They are the same
      exception, so the probe is what tells them apart. It costs a round trip
      only on a failure, and only when the device believes it is online.
    */
    clearTimeout(timer)
    throw new NetworkError(err, await answeredButBlocked(err))
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

/**
 * Leads as a spreadsheet, for the office.
 *
 * Not through `request`, which parses JSON: this is a file. The filename is
 * derived here rather than read from the response, so it works whether or not
 * the browser is allowed to see the `content-disposition` header — the server
 * builds the same name from the same parts.
 */
export async function apiExportLeadsCsv(
  token: string,
  params: { list?: string | null; listName?: string | null; rep?: string | null; status?: string | null },
): Promise<{ blob: Blob; filename: string }> {
  const q = new URLSearchParams()
  if (params.list) q.set('list', params.list)
  if (params.rep) q.set('rep', params.rep)
  if (params.status) q.set('status', params.status)
  const res = await fetch(`${API_URL}/api/leads/export.csv${q.size ? `?${q}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    let message = 'The export could not be produced.'
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message)
  }
  const blob = await res.blob()
  const day = new Date().toISOString().slice(0, 10)
  const slug =
    (params.listName ?? 'leads').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'leads'
  return { blob, filename: `allstar-${slug}-${day}.csv` }
}

export function apiUploadPhoto(token: string, photoId: string, blob: Blob) {
  return request<{ ok: true; key: string }>(`/api/photos/${photoId}`, {
    method: 'POST',
    token,
    raw: blob,
    contentType: blob.type || 'image/jpeg',
    timeoutMs: 90_000,
  })
}

export interface PhotoDTO {
  id: string
  propertyId: string
  visitId?: string
  category: string
  /** What an `other` photo is of; absent for every named category. */
  type?: string
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

export type InvitationStatus = 'not_sent' | 'pending' | 'opened' | 'accepted' | 'expired' | 'revoked'

export interface TeamUserDTO {
  id: string
  name: string
  email: string
  role: Role
  phone?: string
  active: boolean
  /** Invited but hasn't set a password yet. */
  pending: boolean
  firstName?: string
  lastName?: string
  jobTitle?: string
  teamId?: string
  teamName?: string
  /** Derived on the server from the newest invitation token. */
  invitation: InvitationStatus
  invitedAt?: number
  /** When the current link was sent, when that was not the first. */
  resentAt?: number
  /** When the current link was first opened in a browser. */
  openedAt?: number
  onboarding: OnboardingStatus
  onboardingStep?: OnboardingStep
  badge: BadgeStatus
  badgeExpiresAt?: number
  createdAt: number
  lastSeenAt?: number
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

/**
 * "Forgot password?" — asks the server to email a reset link.
 *
 * Deliberately learns nothing about whether the address exists: a 200 means
 * "if that address has an account, a link is on its way", and a stranger
 * typing someone else's address is told exactly the same. The failures it
 * does surface are about the request — nothing typed, too many tries, or a
 * deployment with no email set up — which are the person's to act on.
 */
export function apiForgotPassword(email: string) {
  return request<{ ok: true }>('/api/auth/forgot', { method: 'POST', body: { email }, timeoutMs: 30_000 })
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

/* --- the admin's per-person actions -------------------------------------- */

/** Re-send an invitation; a fresh link, the old one revoked. 409 once they have a password. */
export function apiResendInvite(token: string, userId: string) {
  return request<{ url: string; email: string; expiresAt: number; revoked: number; emailed: boolean; mailError?: string }>(
    `/api/invites/${encodeURIComponent(userId)}/resend`,
    { method: 'POST', token },
  )
}

export function apiRevokeInvite(token: string, userId: string) {
  return request<{ ok: true; revoked: number }>(`/api/invites/${encodeURIComponent(userId)}/revoke`, { method: 'POST', token })
}

export function apiSetUserTeam(token: string, userId: string, teamId: string | null) {
  return request<{ ok: true }>(`/api/users/${encodeURIComponent(userId)}/team`, { method: 'POST', body: { teamId }, token })
}

export function apiSetUserTitle(token: string, userId: string, jobTitle: string) {
  return request<{ ok: true }>(`/api/users/${encodeURIComponent(userId)}/title`, { method: 'POST', body: { jobTitle }, token })
}

/** Clears completion so the flow opens again on their next sign-in; what they entered stays. */
export function apiResetOnboarding(token: string, userId: string) {
  return request<{ ok: true }>(`/api/users/${encodeURIComponent(userId)}/onboarding-reset`, { method: 'POST', token })
}

/** Same id, later expiry, confirmation cleared. */
export function apiRenewBadge(token: string, userId: string) {
  return request<{ badge: BadgeInfo }>(`/api/users/${encodeURIComponent(userId)}/badge-renew`, { method: 'POST', token })
}

/** A different id — for a badge that was lost or copied. */
export function apiRegenerateBadge(token: string, userId: string) {
  return request<{ badge: BadgeInfo }>(`/api/users/${encodeURIComponent(userId)}/badge-regenerate`, { method: 'POST', token })
}

/* --- the company: join link, badge details, teams ------------------------- */

export interface JoinLinkDTO {
  /** null when self-signup is switched off. */
  code: string | null
  createdAt?: number
  url?: string
}

export function apiJoinLink(token: string) {
  return request<JoinLinkDTO>('/api/join-link', { token })
}

export function apiRotateJoinCode(token: string) {
  return request<JoinLinkDTO>('/api/join-link', { method: 'POST', token })
}

export function apiDisableJoinCode(token: string) {
  return request<{ ok: true }>('/api/join-link', { method: 'DELETE', token })
}

export interface CompanyDTO {
  name: string
  timezone: string
  logoUrl?: string
  website?: string
  /** What every badge's QR code encodes; absent means each badge's own verification page. */
  badgeQrUrl?: string
}

/** `null` clears a field; a key left out is left alone. */
export function apiUpdateCompany(token: string, input: { website?: string | null; logo?: string | null; badgeQrUrl?: string | null }) {
  return request<{ company: CompanyDTO }>('/api/company', { method: 'POST', body: input, token })
}

export function apiRenameTeam(token: string, teamId: string, name: string) {
  return request<TeamDTO>(`/api/teams/${encodeURIComponent(teamId)}`, { method: 'PATCH', body: { name }, token })
}

export function apiDeleteTeam(token: string, teamId: string) {
  return request<{ ok: true }>(`/api/teams/${encodeURIComponent(teamId)}`, { method: 'DELETE', token })
}

export function apiDeleteUser(token: string, userId: string) {
  return request<{ ok: true }>(`/api/users/${userId}`, { method: 'DELETE', token })
}

/**
 * What inviting somebody produced.
 *
 * `alreadyMember` is the case the console has to say out loud: the address
 * already belongs to a working account, so nothing was minted and nothing was
 * sent — an admin left believing an invitation went out to somebody who can
 * already sign in is the bug this field exists to prevent.
 */
export type CreatedInviteDTO =
  | {
      alreadyMember: false
      url: string
      email: string
      expiresAt: number
      userId: string
      resent: boolean
      /** True only when the server actually emailed the link. */
      emailed: boolean
      mailError?: string
    }
  | { alreadyMember: true; email: string; userId: string; message: string }

export interface TeamDTO {
  id: string
  name: string
  memberCount: number
  createdAt: number
}

export function apiTeams(token: string) {
  return request<{ teams: TeamDTO[] }>('/api/teams', { token })
}

export function apiCreateTeam(token: string, name: string) {
  return request<TeamDTO>('/api/teams', { method: 'POST', body: { name }, token })
}

export function apiInvite(
  token: string,
  input: {
    email: string
    role: Role
    /** Either the halves or the whole; all optional — an address is enough. */
    firstName?: string
    lastName?: string
    name?: string
    phone?: string
    jobTitle?: string
    teamId?: string | null
  },
) {
  return request<CreatedInviteDTO>('/api/invites', { method: 'POST', body: input, token })
}

/**
 * Assign every lead in a territory to a rep.
 *
 * `territoryId: null` addresses the leads that aren't in a territory yet — after
 * a plain import that's all of them, so without it a first import would be
 * unassignable. `repId: null` un-assigns. On a territory, `action: 'add'` (the
 * default) puts a rep on the patch alongside whoever is there; `'remove'` takes
 * one off. Neither touches a house somebody else is working.
 */
export function apiAssignTerritory(
  token: string,
  input: { territoryId: string | null; repId: string | null; action?: 'add' | 'remove' },
) {
  return request<{ assigned: number; repIds?: string[] }>('/api/territories/assign', {
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
  input: {
    name: string
    repId: string | null
    repIds?: string[]
    boundary: { lat: number; lng: number }[]
    /** Also look up the houses inside and make each one a lead. */
    generate?: boolean
  },
) {
  return request<{
    territory: { id: string; name: string; repIds?: string[] }
    assigned: number
    generated?: GeneratedLeads | { error: string; code?: string }
  }>(
    '/api/territories',
    // A minute, like Find addresses: with the box ticked the Worker also looks
    // the houses up before it answers.
    { method: 'POST', body: input, token, timeoutMs: input.generate ? 90_000 : 30_000 },
  )
}

/**
 * Rename a territory, and delete one.
 *
 * Live-only, like every other territory write: the server owns which leads a
 * shape claims, so there is nothing sensible for these to do against a cached
 * copy. The delete returns the number of leads it handed back to the unassigned
 * bucket, because that is the sentence the console shows afterwards and a
 * locally-guessed count would sometimes be wrong.
 */
/**
 * The photo of a house, fetched through our own server.
 *
 * Deliberately not `request()`. That helper parses JSON and throws an
 * `ApiError` on anything that is not 2xx, and here three of the four answers
 * are not JSON and only one of them is a failure worth throwing about: an
 * image, a 204 for a street with no coverage, a 501 for a company with no key,
 * and a 502 for a lookup that could not be made. Those are states the frame on
 * screen has to tell apart, not errors.
 *
 * The bytes come back as an object URL rather than a `src` pointing at the API.
 * An `<img>` cannot send an Authorization header, and the endpoint is
 * authenticated — so the app fetches it as a request like any other and hands
 * the result to the tag. In the native shell that ride is over the bridge,
 * which already carries binary: `image/*` is decoded from base64 on arrival,
 * so a Blob comes out the far side exactly as it does on the web.
 *
 * The caller owns the URL and must revoke it. See the effect in `StreetView`.
 */
/**
 * Why there is no photo, mirroring `api/src/streetview.ts`'s own type.
 *
 * Restated rather than imported: the Worker is its own package and the web
 * bundle does not reach into it. The set is small and closed, and
 * `verify:streetview` asserts the two lists are identical, so a code added on
 * one side and forgotten on the other fails a gate rather than falling through
 * to "unavailable" in a year's time.
 */
export type StreetViewCode =
  | 'AVAILABLE'
  | 'NO_COVERAGE'
  | 'NOT_CONFIGURED'
  | 'API_KEY_ERROR'
  | 'API_NOT_ENABLED'
  | 'BILLING_ERROR'
  | 'QUOTA_ERROR'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'

export type StreetViewShot =
  | { kind: 'image'; url: string; code: 'AVAILABLE' }
  | { kind: 'none'; code: 'NO_COVERAGE' }
  | { kind: 'unconfigured'; code: 'NOT_CONFIGURED' }
  | { kind: 'error'; code: StreetViewCode }

/**
 * The classification the Worker sent, if it sent one we recognise.
 *
 * Falls back rather than trusting the wire. A header is user-controllable in
 * principle and an older Worker sends none at all, so an unrecognised value
 * becomes the caller's own default — which is always the *coarser* answer, and
 * therefore never turns a real failure into "no coverage".
 */
function codeFrom(res: Response, fallback: StreetViewCode): StreetViewCode {
  const raw = res.headers.get('x-streetview-code')
  const known: StreetViewCode[] = [
    'AVAILABLE',
    'NO_COVERAGE',
    'NOT_CONFIGURED',
    'API_KEY_ERROR',
    'API_NOT_ENABLED',
    'BILLING_ERROR',
    'QUOTA_ERROR',
    'NETWORK_ERROR',
    'UPSTREAM_ERROR',
  ]
  return known.includes(raw as StreetViewCode) ? (raw as StreetViewCode) : fallback
}

export async function apiStreetView(
  token: string,
  lat: number,
  lng: number,
): Promise<StreetViewShot> {
  const controller = new AbortController()
  // Shorter than a data call: this is decoration on a screen that is already
  // useful, and a rep must never wait on it.
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(`${API_URL}/api/streetview?lat=${lat}&lng=${lng}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    /*
      The status decides the shape; the header only refines the reason. That
      order matters: a 204 is "no coverage" whatever a header says, so a
      malformed or absent header can never promote a street with no imagery
      into a configuration error the office would go chasing.
    */
    if (res.status === 204) return { kind: 'none', code: 'NO_COVERAGE' }
    if (res.status === 501) return { kind: 'unconfigured', code: 'NOT_CONFIGURED' }
    if (!res.ok) return { kind: 'error', code: codeFrom(res, 'UPSTREAM_ERROR') }
    return { kind: 'image', url: URL.createObjectURL(await res.blob()), code: 'AVAILABLE' }
  } catch {
    /*
      Offline, aborted, refused — the request never got an answer, so this is
      the one code the server cannot have told us. Never cached by the caller:
      a rep in a dead zone must not have every house marked "no photo" for the
      rest of the day.
    */
    return { kind: 'error', code: 'NETWORK_ERROR' }
  } finally {
    clearTimeout(timer)
  }
}

export function apiRenameTerritory(token: string, id: string, name: string) {
  return request<{ territory: { id: string; name: string } }>(
    `/api/territories/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { name }, token },
  )
}

/** What looking up the houses inside a territory did. */
export interface GeneratedLeads {
  found: number
  created: number
  existed: number
  erased: number
  skipped: number
  tiles: number
  /*
    Optional: a Worker from before the rooftop look-up answers without them,
    and the console then describes the result the old way.
  */
  coverage?: 'addresses' | 'rooftops' | 'none'
  rooftops?: number
  nonResidential?: number
  withoutAddress?: number
  resolved?: number
  unresolved?: number
  lookupFailed?: number
  lookupSkipped?: number
  geocoder?: 'on' | 'off'
  lookupError?: string | null
  coverageStatus?: 'GOOD' | 'PARTIAL' | 'LIMITED' | 'NONE'
  pointCoverage?: number | null
  homeRooftops?: number
  bySource?: { overture: number; census_tiger: number; geocodio: number }
  residential?: { residential: number; unknown: number }
  interpolated?: number
  rangeData?: boolean
  unranged?: number
}

/**
 * Find the houses inside a territory and make each one a lead.
 *
 * Office-only and live-only: the Worker reads the address tiles and writes the
 * rows. Safe to press twice — every address that is already a lead counts as
 * "existed". A deployment with no address data answers 501 and says so.
 */
export function apiGenerateTerritoryLeads(token: string, id: string) {
  return request<GeneratedLeads>(`/api/territories/${encodeURIComponent(id)}/leads`, {
    method: 'POST',
    token,
    timeoutMs: 60_000,
  })
}

export function apiDeleteTerritory(token: string, id: string) {
  return request<{ ok: true; released: number }>(
    `/api/territories/${encodeURIComponent(id)}`,
    { method: 'DELETE', token, timeoutMs: 30_000 },
  )
}

/** Move specific leads to a rep, rather than a whole territory. */
/**
 * Set a status on a batch of leads.
 *
 * Office-only, and deliberately absent from the field app's surface: a rep
 * records what happened at the door and the status follows from it. See
 * `api/src/lead-edit.ts` for why that split is worth keeping.
 */
export function apiSetLeadStatus(token: string, input: { propertyIds: string[]; status: LeadStatus }) {
  return request<{ updated: number; protectedDnc: number }>('/api/leads/status', {
    method: 'POST',
    token,
    body: input,
  })
}

/** What a bulk erase reports. Exact, by id — see api/src/erase.ts. */
export interface BulkEraseDTO {
  ok: true
  requested: number
  deleted: number
  alreadyGone: number
  notFound: string[]
  failed: string[]
  photos: number
}

/** Admin only; the server refuses anyone else. A reason is required. */
export function apiEraseLeads(token: string, input: { propertyIds: string[]; reason: string }) {
  return request<BulkEraseDTO>('/api/leads/erase-bulk', { method: 'POST', body: input, token })
}

/**
 * Let erased addresses be imported again.
 *
 * Addresses rather than ids, because the id is a hash of the company and the
 * normalised street line that only the server knows how to compute. It brings
 * nothing back — the lead and everything on it stay destroyed — it only lifts
 * the block that stops the address existing a second time.
 */
export function apiUnblockLeads(
  token: string,
  input: { rows: { address1: string; city?: string; state?: string; zip?: string }[]; reason: string },
) {
  return request<{ ok: true; unblocked: number; requested: number }>('/api/leads/unblock', {
    method: 'POST',
    body: input,
    token,
  })
}

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

/** Selected leads into a territory, or out of every territory with `territoryId: null`. */
export function apiMoveToTerritory(token: string, input: { propertyIds: string[]; territoryId: string | null }) {
  return request<{ moved: number }>('/api/properties/territory', {
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

/**
 * What one provider did with the batch it was handed.
 *
 * Returned alongside the matches so a provider rejecting everything is visible.
 * The chain degrades rather than fails — Google falling over means Census
 * answers instead — and the price of that is a dead key looking identical to a
 * provider that had nothing to add, with every pin quietly dropping from a
 * rooftop to a block.
 */
export interface GeocodeAttemptDTO {
  provider: 'google' | 'census'
  asked: number
  matched: number
  errors: number
  /** The provider's own words, so a bad key reads as a bad key. */
  firstError?: string
}

export function apiGeocode(token: string, rows: GeocodeRequestDTO[]) {
  return request<{ matches: GeocodeMatchDTO[]; attempts?: GeocodeAttemptDTO[] }>('/api/import/geocode', {
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
  /**
   * The geocoder's own verdict on the coordinates above, passed straight back
   * from `/api/import/geocode`.
   *
   * The preview already showed this to the operator and then dropped it here,
   * which meant the app knew which houses it was estimating and forgot the
   * moment the lead was saved.
   */
  precision?: 'rooftop' | 'interpolated' | 'approximate'
  geoProvider?: string
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
/** The wire shape of a lead list. Mirrors LeadListDTO in api/src/lists.ts. */
export interface LeadListDTO {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  boundary?: { lat: number; lng: number }[]
  archived: boolean
  createdAt: number
  updatedAt: number
  leadIds: string[]
  repIds: string[]
}

/*
  Three list wrappers used to sit here — GET /api/lists, PATCH a list, POST its
  members — written when the feature was first built and superseded before it
  shipped: lists arrive on the bootstrap, and a rename, an archive or a member
  change is queued through the outbox so it works with no signal.

  The *server* routes are very much alive. They are what the outbox applies
  against, and they are covered by api/scripts/smoke-lists.mjs. Removing the
  client wrappers is not a reason to go looking for the endpoints behind them.
*/
export const apiCreateList = (
  token: string,
  body: {
    id?: string
    name: string
    description?: string
    propertyIds?: string[]
    repIds?: string[]
    boundary?: { lat: number; lng: number }[]
  },
) => request<{ list: LeadListDTO; skipped: number }>('/api/lists', { method: 'POST', body, token })

export const apiDeleteList = (token: string, id: string) =>
  request<{ ok: true }>(`/api/lists/${encodeURIComponent(id)}`, { method: 'DELETE', token })

export const apiSetListReps = (token: string, id: string, repIds: string[]) =>
  request<{ repIds: string[] }>(`/api/lists/${encodeURIComponent(id)}/reps`, {
    method: 'PUT',
    body: { repIds },
    token,
  })

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
   * The lists this person can see, members and reps included. Optional for the
   * same reason as `team`: a Worker deployed before lists existed does not send
   * it, and absence must read as "none", not as a crash.
   */
  leadLists?: LeadListDTO[]
  /**
   * Notes on the leads this person can see, newest first. Optional for the
   * same reason as `team`: an older Worker does not send it.
   */
  notes?: unknown[]
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

/**
 * Evidence that the nightly backup is happening, as opposed to configured.
 *
 * `/api/health` answers "are both halves of the configuration present", which
 * stays true through a cron that stopped firing and a bucket somebody emptied.
 * This answers "what is actually in the bucket, and when did it land". Super
 * admin only on the server, because a dump's size describes the database.
 */
export interface BackupEvidenceDTO {
  configured: boolean
  reason?: string
  latest?: { key: string; bytes: number; uploadedAt: number }
  seen: number
  scanCapped: boolean
}

export function apiLatestBackup(token: string) {
  return request<BackupEvidenceDTO>('/api/ops/backups', { token })
}

/**
 * The address under a point, asked of our own server.
 *
 * The browser asks Google directly through the Maps JavaScript geocoder — see
 * `reverseGeocode.ts`. The native shell cannot, and no key fixes it: a DOM
 * component's page is loaded from `file://` so it sends no `Referer`, and an
 * HTTP-referrer restriction is the only application restriction the Maps
 * JavaScript API supports. This is the same lookup on the Worker's key, which
 * is also where it gets counted against the company's geocoder quota.
 *
 * `parts: null` is a real answer — a tap in a field or a lake. The refusals are
 * `no_reverse_geocoder` (this company has no provider that can do it) and
 * `geocoder_unavailable`, and both arrive as an `ApiError` with that code.
 */
export function apiReverseGeocode(token: string, at: { lat: number; lng: number }) {
  return request<{ parts: unknown[] | null; locationType?: string }>('/api/geocode/reverse', {
    method: 'POST',
    token,
    body: at,
    // A geocoder round trip behind a Worker. A rep waiting on the Add-lead form
    // would rather see an empty field than a spinner.
    timeoutMs: 10_000,
  })
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
