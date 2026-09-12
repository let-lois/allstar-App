import { badgeStatus, displayName } from './onboarding'
import { checkLoginRate, recordFailure } from './ratelimit'
import type { Env } from './types'

/**
 * A badge, as a homeowner sees it after scanning the code on it.
 *
 * Public by necessity — the person at the door has no Allstar login and never
 * will — and answered as narrowly as the question: is this badge real, whose
 * is it, is it still good. Nothing about territories, leads or anyone else.
 *
 * The id space is ninety million and the ids are random, so guessing is not
 * a way to enumerate a company's staff — but a miss still costs the caller
 * an attempt against the same limiter as a wrong password, and enough misses
 * shut the door for a while. A hit costs nothing, because scanning the same
 * badge twice is what a careful homeowner does.
 *
 * Someone removed from the team keeps their row, so their badge is answered
 * "no longer valid" with the name and nothing else: enough to say the person
 * at the door is not currently with the company, and no photo of somebody
 * who no longer works there.
 */
export type VerifyStatus = 'active' | 'expired' | 'pending' | 'inactive'

export interface VerifyDTO {
  status: VerifyStatus
  badge: { id: string; issuedAt?: number; expiresAt?: number }
  person: { name: string; title?: string; photoUrl?: string }
  company: { name: string; logoUrl?: string; website?: string }
}

type Failure = { error: string; status: number; retryAfter?: number }

const ID_SHAPE = /^[1-9]\d{7}$/

export async function verifyBadge(env: Env, badgeId: unknown, ip: string | null): Promise<VerifyDTO | Failure> {
  // Keyed per caller, not globally: a handful of bad scans anywhere must not
  // shut verification for every homeowner in the country.
  const who = `verify:${ip ?? 'anon'}`
  const limit = await checkLoginRate(env, who, ip)
  if (!limit.allowed) {
    return { error: 'Too many lookups. Wait a few minutes and try again.', status: 429, retryAfter: limit.retryAfter }
  }
  const id = typeof badgeId === 'string' ? badgeId.trim() : ''
  if (!ID_SHAPE.test(id)) {
    await recordFailure(env, who, ip)
    return { error: 'No badge with that number.', status: 404 }
  }

  const row = await env.DB.prepare(
    `SELECT u.name, u.first_name, u.last_name, u.job_title, u.role, u.active, u.avatar_url,
            u.onboarding_step, u.onboarding_version, u.onboarding_completed_at,
            u.badge_id, u.badge_issued_at, u.badge_expires_at, u.badge_confirmed_at,
            c.name AS company_name, c.logo_url, c.website
       FROM users u JOIN clients c ON c.id = u.client_id
      WHERE u.badge_id = ?1`,
  )
    .bind(id)
    .first<Record<string, string | number | null>>()
  if (!row) {
    await recordFailure(env, who, ip)
    return { error: 'No badge with that number.', status: 404 }
  }

  const facts = {
    name: row.name == null ? null : String(row.name),
    first_name: row.first_name == null ? null : String(row.first_name),
    last_name: row.last_name == null ? null : String(row.last_name),
    onboarding_step: row.onboarding_step == null ? null : String(row.onboarding_step),
    onboarding_version: Number(row.onboarding_version ?? 0),
    onboarding_completed_at: row.onboarding_completed_at == null ? null : Number(row.onboarding_completed_at),
    badge_id: String(row.badge_id),
    badge_expires_at: row.badge_expires_at == null ? null : Number(row.badge_expires_at),
    badge_confirmed_at: row.badge_confirmed_at == null ? null : Number(row.badge_confirmed_at),
  }
  const name = displayName({ ...facts, email: '' })
  const company = {
    name: String(row.company_name),
    logoUrl: row.logo_url == null ? undefined : String(row.logo_url),
    website: row.website == null ? undefined : String(row.website),
  }
  const badge = {
    id,
    issuedAt: row.badge_issued_at == null ? undefined : Number(row.badge_issued_at),
    expiresAt: facts.badge_expires_at ?? undefined,
  }

  if (!row.active) {
    return { status: 'inactive', badge, person: { name }, company }
  }
  const status = badgeStatus(facts, Date.now())
  return {
    status: status === 'active' ? 'active' : status === 'expired' ? 'expired' : 'pending',
    badge,
    person: {
      name,
      title: row.job_title == null ? undefined : String(row.job_title),
      photoUrl: row.avatar_url == null ? undefined : String(row.avatar_url),
    },
    company,
  }
}
