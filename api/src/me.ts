import {
  badgeStatus,
  displayName,
  onboardingStatus,
  type BadgeStatus,
  type OnboardingStatus,
} from './onboarding'
import type { Env, SessionUser } from './types'

/**
 * Who am I, in full.
 *
 * `SessionUser` is what rides on every request: id, tenant, role, name — the
 * eight fields authorization needs, resolved from one join per call. This is
 * the rest: the profile a person can edit, where they are in onboarding, the
 * badge they carry, and what their company looks like on it. Read at sign-in
 * and boot, and after each onboarding step, so it can afford a second join.
 *
 * It is a strict superset of the session user, on purpose: `/api/me` and the
 * login response both return it, and every existing client reader of those
 * payloads keeps working because nothing it reads has moved.
 */

export interface MeDTO extends SessionUser {
  firstName?: string
  lastName?: string
  jobTitle?: string
  teamId?: string
  teamName?: string
  avatarUrl?: string
  createdAt: number
  lastSeenAt?: number
  onboarding: {
    status: OnboardingStatus
    step?: string
    version: number
    completedAt?: number
    walkthroughCompletedAt?: number
    setupCompletedAt?: number
    locationStatus?: string
  }
  badge: {
    id: string
    status: BadgeStatus
    issuedAt?: number
    expiresAt?: number
    confirmedAt?: number
  } | null
  company: {
    name: string
    timezone: string
    logoUrl?: string
    website?: string
    badgeQrUrl?: string
  }
}

type Row = Record<string, string | number | null>
const str = (v: string | number | null | undefined) => (v == null ? undefined : String(v))
const num = (v: string | number | null | undefined) => (v == null ? undefined : Number(v))

export async function readMe(env: Env, userId: string): Promise<MeDTO | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.client_id, u.email, u.name, u.first_name, u.last_name, u.role, u.phone,
            u.job_title, u.team_id, t.name AS team_name, u.avatar_url, u.created_at, u.last_seen_at,
            u.onboarding_step, u.onboarding_version, u.onboarding_completed_at,
            u.walkthrough_completed_at, u.setup_completed_at, u.location_status,
            u.badge_id, u.badge_issued_at, u.badge_expires_at, u.badge_confirmed_at,
            c.name AS client_name, c.timezone AS client_tz, c.logo_url, c.website, c.badge_qr_url
       FROM users u
       JOIN clients c ON c.id = u.client_id
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = ?1`,
  )
    .bind(userId)
    .first<Row>()
  if (!row) return null

  const now = Date.now()
  const facts = {
    name: str(row.name) ?? null,
    first_name: str(row.first_name) ?? null,
    last_name: str(row.last_name) ?? null,
    onboarding_step: str(row.onboarding_step) ?? null,
    onboarding_version: num(row.onboarding_version) ?? 0,
    onboarding_completed_at: num(row.onboarding_completed_at) ?? null,
    badge_id: str(row.badge_id) ?? null,
    badge_expires_at: num(row.badge_expires_at) ?? null,
    badge_confirmed_at: num(row.badge_confirmed_at) ?? null,
  }

  return {
    id: String(row.id),
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    timezone: String(row.client_tz ?? 'UTC'),
    email: String(row.email),
    name: displayName({ ...facts, email: String(row.email) }),
    role: String(row.role) as SessionUser['role'],
    phone: str(row.phone),
    firstName: str(row.first_name),
    lastName: str(row.last_name),
    jobTitle: str(row.job_title),
    teamId: str(row.team_id),
    teamName: str(row.team_name),
    avatarUrl: str(row.avatar_url),
    createdAt: Number(row.created_at),
    lastSeenAt: num(row.last_seen_at),
    onboarding: {
      status: onboardingStatus(facts, now),
      step: facts.onboarding_step ?? undefined,
      version: facts.onboarding_version,
      completedAt: facts.onboarding_completed_at ?? undefined,
      walkthroughCompletedAt: num(row.walkthrough_completed_at),
      setupCompletedAt: num(row.setup_completed_at),
      locationStatus: str(row.location_status),
    },
    badge: facts.badge_id
      ? {
          id: facts.badge_id,
          status: badgeStatus(facts, now),
          issuedAt: num(row.badge_issued_at),
          expiresAt: facts.badge_expires_at ?? undefined,
          confirmedAt: facts.badge_confirmed_at ?? undefined,
        }
      : null,
    company: {
      name: String(row.client_name),
      timezone: String(row.client_tz ?? 'UTC'),
      logoUrl: str(row.logo_url),
      website: str(row.website),
      badgeQrUrl: str(row.badge_qr_url),
    },
  }
}

/**
 * "Last active", as the console shows it.
 *
 * Written at sign-in, at bootstrap and on every mutation push — the three
 * moments that mean a person is actually using the app — and nowhere else. On
 * `resolveSession` it would be a write on every read; on the phone's clock it
 * would be a lie from a device set to the wrong year. Failure is swallowed:
 * the fact being recorded is incidental to whatever request carried it.
 */
export async function touchLastSeen(env: Env, userId: string): Promise<void> {
  try {
    await env.DB.prepare('UPDATE users SET last_seen_at = ?2 WHERE id = ?1')
      .bind(userId, Date.now())
      .run()
  } catch (err) {
    console.error('last_seen_at not written', userId, String(err))
  }
}
