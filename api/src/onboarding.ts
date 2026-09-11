/**
 * Team member onboarding: the facts, and what they mean.
 *
 * Nothing in here touches a database. Every status the console shows —
 * invitation, onboarding, badge — is *derived* from timestamps on the row,
 * never stored beside them, so it cannot disagree with them. The derivations
 * live in this file, on their own, so a Node gate can pin the ranking without
 * a Worker, a browser or a network.
 *
 * ## Why derived
 *
 * A stored `status` column is a cache of a decision, and caches of decisions
 * go stale in exactly the cases that matter: an admin revokes a token and the
 * row still says "pending"; a badge passes its expiry at 3am and nothing runs
 * to flip it. Reading `revoked_at` and `badge_expires_at` at the moment
 * somebody asks is always right and costs nothing.
 *
 * ## The version
 *
 * `ONBOARDING_VERSION` is the flow a person is asked to complete. A row records
 * the version it completed. Bumping the constant is the one planned way to
 * ask everyone again; migration 019 hard-codes `1` for the people who existed
 * before the flow did, and must keep saying so after the bump.
 */

export const ONBOARDING_VERSION = 1

/** How long a badge is good for, from issue. Stored per badge at mint. */
export const BADGE_VALID_DAYS = 365

export type OnboardingStep = 'profile' | 'setup' | 'walkthrough' | 'badge' | 'checklist'
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'profile',
  'setup',
  'walkthrough',
  'badge',
  'checklist',
]

/**
 * `required` is the state after completion that asks for the flow again: the
 * version moved on, or an admin reset it, or the account has lost the one thing
 * every account must have — a name.
 */
export type OnboardingStatus = 'not_started' | 'in_progress' | 'complete' | 'required'
export type BadgeStatus = 'none' | 'awaiting_confirmation' | 'active' | 'expired'
export type InvitationStatus = 'not_sent' | 'pending' | 'accepted' | 'expired' | 'revoked'

/** The columns the derivations read. Nullable exactly as the database has them. */
export interface OnboardingRow {
  name: string | null
  first_name: string | null
  last_name: string | null
  onboarding_step: string | null
  onboarding_version: number | null
  onboarding_completed_at: number | null
  badge_id: string | null
  badge_expires_at: number | null
  badge_confirmed_at: number | null
}

export interface InviteRow {
  accepted_at: number | null
  revoked_at: number | null
  expires_at: number
}

/**
 * The name everything displays.
 *
 * First and last when both are known; whichever one is when only one is; the
 * stored `name` otherwise — and, for a person the admin added by email alone,
 * the part of the address before the @, so a roster never shows a blank.
 */
export function displayName(row: {
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  email?: string | null
}): string {
  const first = row.first_name?.trim() ?? ''
  const last = row.last_name?.trim() ?? ''
  if (first || last) return [first, last].filter(Boolean).join(' ')
  const name = row.name?.trim() ?? ''
  if (name) return name
  const email = row.email?.trim() ?? ''
  return email.includes('@') ? email.slice(0, email.indexOf('@')) : email
}

export function onboardingStatus(row: OnboardingRow, now: number): OnboardingStatus {
  void now
  if (row.onboarding_completed_at == null) {
    return row.onboarding_step ? 'in_progress' : 'not_started'
  }
  if ((row.onboarding_version ?? 0) < ONBOARDING_VERSION) return 'required'
  if (!displayName(row)) return 'required'
  return 'complete'
}

/**
 * Expired outranks unconfirmed: a badge nobody confirmed and whose date has
 * passed is expired, and the fix for it is a renewal, not a confirmation.
 */
export function badgeStatus(row: OnboardingRow, now: number): BadgeStatus {
  if (!row.badge_id) return 'none'
  if (row.badge_expires_at != null && row.badge_expires_at <= now) return 'expired'
  if (row.badge_confirmed_at == null) return 'awaiting_confirmation'
  return 'active'
}

/**
 * The newest invite token decides. Accepted beats everything — an invitation
 * that was used is used, whatever happened to the token afterwards. Revoked
 * beats expired, because it records a decision rather than a calendar.
 */
export function invitationStatus(invite: InviteRow | null, now: number): InvitationStatus {
  if (!invite) return 'not_sent'
  if (invite.accepted_at != null) return 'accepted'
  if (invite.revoked_at != null) return 'revoked'
  if (invite.expires_at <= now) return 'expired'
  return 'pending'
}

/** A badge id: eight digits, as printed. Uniqueness is the caller's job. */
export function mintBadgeId(random: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += Math.floor(random() * 10)
  // A leading zero prints fine but reads oddly on a badge; keep the first digit 1-9.
  return out[0] === '0' ? `${1 + Math.floor(random() * 9)}${out.slice(1)}` : out
}
