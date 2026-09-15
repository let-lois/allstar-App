import { record } from './audit'
import { readMe, type MeDTO } from './me'
import {
  BADGE_VALID_DAYS,
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  badgeStatus,
  canComplete,
  checklistFor,
  displayName,
  mintBadgeId,
  nextStep,
  onboardingStatus,
  resumeStep,
  stepIndex,
  type ChecklistItem,
  type OnboardingStep,
} from './onboarding'
import type { Env, SessionUser } from './types'

/**
 * A person's own onboarding — the I/O around the pure rules in onboarding.ts.
 *
 * Everything here acts on the signed-in person and nobody else. The admin
 * actions (reset, renew, regenerate) live in users.ts, behind the same guard
 * as every other thing an admin does to an account.
 *
 * ## The server holds the place
 *
 * `onboarding_step` is the step not yet completed, written when the one before
 * it was. A phone asks where it is and is told; it never decides. Close the
 * app on step three, open it on another phone, and step three is what opens —
 * there is no local state to lose, and nothing to reconcile.
 *
 * ## Steps complete in order, and can be redone
 *
 * Completing the current step advances the stored one. Completing an earlier
 * step again (going back to fix a name) applies its writes and leaves the
 * stored step alone. Completing a *later* step than the stored one is refused:
 * a client that skips setup is a client with a bug, and the server says so.
 *
 * ## The badge is minted once
 *
 * `mintBadge` returns the existing badge if there is one. Viewing the badge
 * screen fifty times produces one id. Only `regenerateBadge` (admin) makes a
 * new one, and that is for a badge that was misprinted or compromised.
 */

type Failure = { error: string; status: number; missing?: string[] }
const fail = (error: string, status: number, missing?: string[]): Failure =>
  missing ? { error, status, missing } : { error, status }

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, max) : undefined
}

interface FlowRow {
  id: string
  client_id: string
  email: string
  name: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  job_title: string | null
  role: string
  team_name: string | null
  avatar_url: string | null
  onboarding_step: string | null
  onboarding_version: number | null
  onboarding_completed_at: number | null
  walkthrough_completed_at: number | null
  setup_completed_at: number | null
  location_status: string | null
  notification_status: string | null
  badge_id: string | null
  badge_issued_at: number | null
  badge_expires_at: number | null
  badge_confirmed_at: number | null
}

async function rowFor(env: Env, userId: string): Promise<FlowRow | null> {
  return env.DB.prepare(
    `SELECT u.id, u.client_id, u.email, u.name, u.first_name, u.last_name, u.phone, u.job_title, u.role,
            t.name AS team_name, u.avatar_url,
            u.onboarding_step, u.onboarding_version, u.onboarding_completed_at,
            u.walkthrough_completed_at, u.setup_completed_at, u.location_status, u.notification_status,
            u.badge_id, u.badge_issued_at, u.badge_expires_at, u.badge_confirmed_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = ?1`,
  )
    .bind(userId)
    .first<FlowRow>()
}

export interface OnboardingView {
  status: ReturnType<typeof onboardingStatus>
  /** The step to show. */
  step: OnboardingStep
  steps: readonly OnboardingStep[]
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
    /** What the person may change here. */
    editable: readonly ('firstName' | 'lastName' | 'phone' | 'jobTitle')[]
    /** What only an admin may change, shown but not offered. */
    locked: readonly ('email' | 'role' | 'team')[]
  }
  /** Required profile fields still empty, so a form asks only for those. */
  missing: ('firstName' | 'lastName' | 'photo')[]
  setup: { completedAt?: number; locationStatus?: string; notificationStatus?: string }
  walkthrough: { completedAt?: number }
  badge: MeDTO['badge']
  checklist: ChecklistItem[]
  canComplete: boolean
}

const EDITABLE = ['firstName', 'lastName', 'phone', 'jobTitle'] as const
const LOCKED = ['email', 'role', 'team'] as const

function view(row: FlowRow, now: number): OnboardingView {
  const checklist = checklistFor(row, now)
  const missing: OnboardingView['missing'] = []
  if (!row.first_name?.trim()) missing.push('firstName')
  if (!row.last_name?.trim()) missing.push('lastName')
  if (!row.avatar_url) missing.push('photo')
  const badge = badgeStatus(row, now)
  return {
    status: onboardingStatus(row, now),
    step: resumeStep(row.onboarding_step),
    steps: ONBOARDING_STEPS,
    version: row.onboarding_version ?? 0,
    requiredVersion: ONBOARDING_VERSION,
    completedAt: row.onboarding_completed_at ?? undefined,
    profile: {
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
      email: row.email,
      phone: row.phone ?? undefined,
      jobTitle: row.job_title ?? undefined,
      teamName: row.team_name ?? undefined,
      hasPhoto: !!row.avatar_url,
      editable: EDITABLE,
      locked: LOCKED,
    },
    missing,
    setup: {
      completedAt: row.setup_completed_at ?? undefined,
      locationStatus: row.location_status ?? undefined,
      notificationStatus: row.notification_status ?? undefined,
    },
    walkthrough: { completedAt: row.walkthrough_completed_at ?? undefined },
    badge: row.badge_id
      ? {
          id: row.badge_id,
          status: badge,
          issuedAt: row.badge_issued_at ?? undefined,
          expiresAt: row.badge_expires_at ?? undefined,
          confirmedAt: row.badge_confirmed_at ?? undefined,
        }
      : null,
    checklist,
    canComplete: canComplete(checklist),
  }
}

export async function readOnboarding(env: Env, user: SessionUser): Promise<OnboardingView | Failure> {
  const row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)
  return view(row, Date.now())
}

/* --- the profile, by its owner ---------------------------------------------- */

export interface ProfileInput {
  firstName?: unknown
  lastName?: unknown
  phone?: unknown
  jobTitle?: unknown
}

/**
 * First and last name cannot be cleared by their owner — a badge with no name
 * is not a badge — so an empty string for either is "no change". Phone and
 * title can be cleared with an empty string; both are optional everywhere.
 */
export async function updateProfile(env: Env, user: SessionUser, input: ProfileInput): Promise<MeDTO | Failure> {
  const row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)

  const first = clean(input.firstName, 60) ?? row.first_name ?? undefined
  const last = clean(input.lastName, 60) ?? row.last_name ?? undefined
  const phone = 'phone' in input ? (clean(input.phone, 40) ?? null) : row.phone
  const jobTitle = 'jobTitle' in input ? (clean(input.jobTitle, 60) ?? null) : row.job_title
  const name = displayName({ first_name: first, last_name: last, name: row.name, email: row.email })

  await env.DB.prepare(
    `UPDATE users SET first_name = ?2, last_name = ?3, name = ?4, phone = ?5, job_title = ?6 WHERE id = ?1`,
  )
    .bind(user.id, first ?? null, last ?? null, name, phone, jobTitle)
    .run()

  const changed: Record<string, unknown> = {}
  if (first !== (row.first_name ?? undefined)) changed.firstName = first
  if (last !== (row.last_name ?? undefined)) changed.lastName = last
  if (phone !== row.phone) changed.phone = phone ? 'set' : 'cleared'
  if (jobTitle !== row.job_title) changed.jobTitle = jobTitle
  if (Object.keys(changed).length) {
    await record(env, user, {
      action: 'user.profile_updated',
      targetType: 'user',
      targetId: user.id,
      targetLabel: name,
      detail: changed,
    })
  }

  const me = await readMe(env, user.id)
  return me ?? fail('Saved, but could not be read back.', 500)
}

/* --- the steps -------------------------------------------------------------- */

export interface StepInput {
  step?: unknown
  data?: unknown
}

/**
 * Complete a step. Applies its writes, then moves the stored step forward if
 * this was the current one. Returns the view the phone should render next.
 */
export async function completeStep(env: Env, user: SessionUser, input: StepInput): Promise<OnboardingView | Failure> {
  const step = input.step
  if (!ONBOARDING_STEPS.includes(step as OnboardingStep)) return fail('Unknown step.', 400)
  const s = step as OnboardingStep
  const data = (input.data ?? {}) as Record<string, unknown>

  let row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)
  const now = Date.now()
  const current = resumeStep(row.onboarding_step)
  /*
    Once complete, every step is behind them and any may be redone — the
    walkthrough from More, the profile after a name change. Until then, and
    again when a new version asks everyone through (status `required`), the
    order holds: redoing an earlier step is fine, skipping ahead is a client
    bug and is refused.
  */
  const finished = onboardingStatus(row, now) === 'complete'
  if (!finished && stepIndex(s) > stepIndex(current)) {
    return fail(`Finish "${current}" first.`, 409)
  }

  switch (s) {
    case 'profile': {
      const applied = await updateProfile(env, user, data)
      if ('error' in applied) return applied
      row = (await rowFor(env, user.id))!
      if (!row.first_name?.trim() || !row.last_name?.trim()) {
        const missing: string[] = []
        if (!row.first_name?.trim()) missing.push('firstName')
        if (!row.last_name?.trim()) missing.push('lastName')
        return fail('First and last name are needed to continue.', 400, missing)
      }
      break
    }
    case 'setup': {
      const PERMISSION = ['granted', 'denied', 'skipped', 'unsupported']
      const status = clean(data.locationStatus, 20) ?? 'skipped'
      if (!PERMISSION.includes(status)) {
        return fail('locationStatus must be granted, denied, skipped or unsupported.', 400)
      }
      // The same four answers for notifications. A phone from before the card
      // existed sends none, which reads as skipped — not as a refusal.
      const notifications = clean(data.notificationStatus, 20) ?? 'skipped'
      if (!PERMISSION.includes(notifications)) {
        return fail('notificationStatus must be granted, denied, skipped or unsupported.', 400)
      }
      await env.DB.prepare(
        'UPDATE users SET setup_completed_at = ?2, location_status = ?3, notification_status = ?4 WHERE id = ?1',
      )
        .bind(user.id, now, status, notifications)
        .run()
      break
    }
    case 'walkthrough': {
      // Kept the first time; watching it again is not a second completion.
      await env.DB.prepare(
        'UPDATE users SET walkthrough_completed_at = COALESCE(walkthrough_completed_at, ?2) WHERE id = ?1',
      )
        .bind(user.id, now)
        .run()
      break
    }
    case 'badge': {
      // "I have confirmed my badge." The confirmation itself is its own call,
      // because the phone has to show the badge before the person can confirm it.
      if (!row.badge_id) return fail('Create your badge first.', 409)
      if (badgeStatus(row, now) !== 'active') {
        return fail(
          badgeStatus(row, now) === 'expired' ? 'Your badge has expired — renew it first.' : 'Confirm your badge first.',
          409,
        )
      }
      break
    }
    case 'checklist': {
      const items = checklistFor(row, now)
      if (!canComplete(items)) {
        const missing = items.filter((i) => i.required && !i.done).map((i) => i.key)
        return fail('Some required items are not done yet.', 409, missing)
      }
      await env.DB.prepare(
        `UPDATE users SET onboarding_completed_at = ?2, onboarding_version = ?3, onboarding_step = NULL WHERE id = ?1`,
      )
        .bind(user.id, now, ONBOARDING_VERSION)
        .run()
      await record(env, user, {
        action: 'user.onboarding_completed',
        targetType: 'user',
        targetId: user.id,
        targetLabel: displayName(row),
        detail: { version: ONBOARDING_VERSION },
      })
      const done = (await rowFor(env, user.id))!
      return view(done, now)
    }
  }

  // Advance only from the current step; a redo leaves the place alone, and a
  // finished flow has no place to advance.
  if (!finished && s === current) {
    const next = nextStep(s)
    await env.DB.prepare('UPDATE users SET onboarding_step = ?2 WHERE id = ?1').bind(user.id, next).run()
  }
  const after = (await rowFor(env, user.id))!
  return view(after, now)
}

/* --- the badge ---------------------------------------------------------------- */

/**
 * Mint the badge, or return the one there is.
 *
 * Needs a first and last name — a badge is printed with them, and one minted
 * before they exist would be issued blank. Not a photo: the badge shows
 * initials until there is one, and the checklist holds completion for it.
 */
export async function mintBadge(env: Env, user: SessionUser): Promise<MeDTO['badge'] | Failure> {
  const row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)
  const now = Date.now()
  if (row.badge_id) {
    return {
      id: row.badge_id,
      status: badgeStatus(row, now),
      issuedAt: row.badge_issued_at ?? undefined,
      expiresAt: row.badge_expires_at ?? undefined,
      confirmedAt: row.badge_confirmed_at ?? undefined,
    }
  }
  if (!row.first_name?.trim() || !row.last_name?.trim()) {
    return fail('Add your first and last name before creating a badge.', 409, ['firstName', 'lastName'])
  }
  const issued = await issue(env, user.id, now)
  if ('error' in issued) return issued
  await record(env, user, {
    action: 'badge.issued',
    targetType: 'user',
    targetId: user.id,
    targetLabel: displayName(row),
    detail: { badgeId: issued.id, expiresAt: issued.expiresAt },
  })
  return issued
}

/**
 * Write a new id and dates. Shared by first issue and by regeneration. The
 * unique index is the collision check; eight digits is wide enough that the
 * retry is a formality written down rather than assumed.
 */
async function issue(env: Env, userId: string, now: number): Promise<NonNullable<MeDTO['badge']> | Failure> {
  const expiresAt = now + BADGE_VALID_DAYS * 86_400_000
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = mintBadgeId()
    try {
      await env.DB.prepare(
        `UPDATE users SET badge_id = ?2, badge_issued_at = ?3, badge_expires_at = ?4, badge_confirmed_at = NULL WHERE id = ?1`,
      )
        .bind(userId, id, now, expiresAt)
        .run()
      return { id, status: 'awaiting_confirmation', issuedAt: now, expiresAt, confirmedAt: undefined }
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err
    }
  }
  return fail('Could not issue a badge id just now. Try again.', 500)
}

/** The person says the badge is right. Kept the first time it is said. */
export async function confirmBadge(env: Env, user: SessionUser): Promise<MeDTO['badge'] | Failure> {
  const row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)
  const now = Date.now()
  if (!row.badge_id) return fail('There is no badge to confirm yet.', 409)
  if (badgeStatus(row, now) === 'expired') return fail('Your badge has expired — renew it first.', 409)
  if (row.badge_confirmed_at == null) {
    await env.DB.prepare('UPDATE users SET badge_confirmed_at = ?2 WHERE id = ?1').bind(user.id, now).run()
    await record(env, user, {
      action: 'badge.confirmed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: displayName(row),
      detail: { badgeId: row.badge_id },
    })
  }
  const after = (await rowFor(env, user.id))!
  return {
    id: after.badge_id!,
    status: badgeStatus(after, now),
    issuedAt: after.badge_issued_at ?? undefined,
    expiresAt: after.badge_expires_at ?? undefined,
    confirmedAt: after.badge_confirmed_at ?? undefined,
  }
}

/**
 * New dates on the same id. The admin may do this at any time (users.ts);
 * the owner may do it only once it has actually expired — otherwise a rep
 * could keep a badge perpetually fresh and confirmation would mean nothing.
 */
export async function renewBadgeDates(env: Env, userId: string, now: number): Promise<NonNullable<MeDTO['badge']> | Failure> {
  const row = await rowFor(env, userId)
  if (!row?.badge_id) return fail('There is no badge to renew.', 409)
  const expiresAt = now + BADGE_VALID_DAYS * 86_400_000
  await env.DB.prepare(
    'UPDATE users SET badge_issued_at = ?2, badge_expires_at = ?3, badge_confirmed_at = NULL WHERE id = ?1',
  )
    .bind(userId, now, expiresAt)
    .run()
  return { id: row.badge_id, status: 'awaiting_confirmation', issuedAt: now, expiresAt, confirmedAt: undefined }
}

export async function renewOwnBadge(env: Env, user: SessionUser): Promise<MeDTO['badge'] | Failure> {
  const row = await rowFor(env, user.id)
  if (!row) return fail('No such account.', 404)
  const now = Date.now()
  if (!row.badge_id) return fail('There is no badge to renew.', 409)
  if (badgeStatus(row, now) !== 'expired') return fail('Your badge has not expired. Ask an admin if it needs renewing early.', 409)
  const renewed = await renewBadgeDates(env, user.id, now)
  if ('error' in renewed) return renewed
  await record(env, user, {
    action: 'badge.renewed',
    targetType: 'user',
    targetId: user.id,
    targetLabel: displayName(row),
    detail: { badgeId: renewed.id, expiresAt: renewed.expiresAt, self: true },
  })
  return renewed
}

/** A brand-new id. For the admin only; see users.ts. */
export async function regenerateBadgeFor(env: Env, userId: string, now: number): Promise<NonNullable<MeDTO['badge']> | Failure> {
  return issue(env, userId, now)
}
