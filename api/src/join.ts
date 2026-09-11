import { createSession, hashPassword, randomId } from './auth'
import { record } from './audit'
import { canInvite } from './invites'
import { readMe, touchLastSeen, type MeDTO } from './me'
import { displayName } from './onboarding'
import { checkLoginRate, clearFailures, recordFailure } from './ratelimit'
import { MIN_PASSWORD } from './users'
import type { Env, SessionUser } from './types'

/**
 * The other way in: a rep opens the app first.
 *
 * Nobody invited them. They downloaded the app because a manager said to, and
 * the app has to attach them to the right company — which email alone cannot
 * do, because an address is unique per company, not across them. So a company
 * has a **join code**: eight characters an admin shares once, in a group text
 * or on a whiteboard, and anyone who types it becomes a field rep of that
 * company, signed in, with onboarding ahead of them.
 *
 * ## What the code is, and is not
 *
 * It is a credential for *creating a field rep account*, and nothing more. It
 * cannot grant a role above field rep, cannot read anything, and cannot act on
 * an existing account except in one case: an address the admin has *already*
 * invited but who never opened their link. Joining with that address *is* the
 * acceptance — same row, password set, invitation marked used — because two
 * roads to one person must end at one account.
 *
 * It is not a secret in the way a password is. It leaks the moment it is
 * written on a whiteboard, which is why it is rotatable (the old one dies at
 * once), why it can be switched off (`NULL`), and why redeeming it runs
 * through the login rate limiter: a leaked code lets somebody create accounts
 * at eight per address per quarter hour, which is a nuisance, not a breach —
 * every account it makes is a field rep the admin can see on the roster and
 * deactivate.
 */

/** Unambiguous in a text message or on a whiteboard: no 0/O, no 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const JOIN_CODE_LENGTH = 8

type Failure = { error: string; status: number }
const fail = (error: string, status: number): Failure => ({ error, status })

function newCode(): string {
  const bytes = new Uint8Array(JOIN_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** As typed by a person: any case, spaces and dashes allowed. */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length === JOIN_CODE_LENGTH ? code : null
}

export interface JoinLinkDTO {
  code: string | null
  createdAt?: number
  /** Where the code takes somebody: the app, at its join screen. */
  url?: string
}

const joinUrl = (appUrl: string, code: string) => `${appUrl.replace(/\/$/, '')}/join/${code}`

export async function readJoinLink(env: Env, actor: SessionUser, appUrl: string): Promise<JoinLinkDTO | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  const row = await env.DB.prepare('SELECT join_code, join_code_created_at FROM clients WHERE id = ?1')
    .bind(actor.clientId)
    .first<{ join_code: string | null; join_code_created_at: number | null }>()
  if (!row?.join_code) return { code: null }
  return { code: row.join_code, createdAt: row.join_code_created_at ?? undefined, url: joinUrl(appUrl, row.join_code) }
}

/** A new code. The old one stops working in the same statement. */
export async function rotateJoinCode(env: Env, actor: SessionUser, appUrl: string): Promise<JoinLinkDTO | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  const now = Date.now()
  // The unique index is the collision check; 31^8 is wide enough that a retry
  // is a formality, but a formality that is written down rather than assumed.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode()
    try {
      await env.DB.prepare('UPDATE clients SET join_code = ?2, join_code_created_at = ?3 WHERE id = ?1')
        .bind(actor.clientId, code, now)
        .run()
      await record(env, actor, {
        action: 'company.join_code_rotated',
        targetType: 'company',
        targetId: actor.clientId,
        targetLabel: actor.clientName,
      })
      return { code, createdAt: now, url: joinUrl(appUrl, code) }
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err
    }
  }
  return fail('Could not make a code just now. Try again.', 500)
}

export async function disableJoinCode(env: Env, actor: SessionUser): Promise<{ ok: true } | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  await env.DB.prepare('UPDATE clients SET join_code = NULL, join_code_created_at = NULL WHERE id = ?1')
    .bind(actor.clientId)
    .run()
  await record(env, actor, {
    action: 'company.join_code_disabled',
    targetType: 'company',
    targetId: actor.clientId,
    targetLabel: actor.clientName,
  })
  return { ok: true }
}

export interface JoinInput {
  code?: unknown
  email?: unknown
  password?: unknown
  firstName?: unknown
  lastName?: unknown
  phone?: unknown
}

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, max) : undefined
}

/**
 * Redeem a code: create the account, or claim the pending one, and sign in.
 *
 * Returns a session, not a "now go and log in": the person has just chosen a
 * password and is holding the phone. Hashing it a second time to check it
 * would be pure cost against the Worker's CPU budget.
 */
export async function joinWithCode(
  env: Env,
  input: JoinInput,
  ip: string | null,
): Promise<{ token: string; user: MeDTO; claimedInvite: boolean } | Failure & { code?: string; retryAfter?: number }> {
  const email = clean(input.email, 200) ?? ''
  const password = typeof input.password === 'string' ? input.password : ''
  const code = normaliseCode(input.code)

  // Rate-limited like a password, and for the same reason: the code is the
  // only thing standing between the internet and an account in this company.
  const limit = await checkLoginRate(env, email || 'join', ip)
  if (!limit.allowed) {
    return { error: 'Too many attempts. Wait a few minutes and try again.', status: 429, code: 'rate_limited', retryAfter: limit.retryAfter }
  }

  if (!code) {
    await recordFailure(env, email || 'join', ip)
    return fail(`A join code is ${JOIN_CODE_LENGTH} letters and numbers.`, 400)
  }
  if (!email.includes('@')) return fail('Enter a valid email.', 400)
  if (password.length < MIN_PASSWORD) {
    return fail(`Password must be at least ${MIN_PASSWORD} characters.`, 400)
  }

  const company = await env.DB.prepare('SELECT id, name FROM clients WHERE join_code = ?1')
    .bind(code)
    .first<{ id: string; name: string }>()
  if (!company) {
    await recordFailure(env, email, ip)
    // The same sentence whether the code was never issued or was rotated away.
    return fail('That code did not match a company. Check it with whoever gave it to you.', 404)
  }

  const first = clean(input.firstName, 60)
  const last = clean(input.lastName, 60)
  const phone = clean(input.phone, 40)

  const existing = await env.DB.prepare(
    'SELECT id, password_hash, first_name, last_name FROM users WHERE client_id = ?1 AND lower(email) = lower(?2)',
  )
    .bind(company.id, email)
    .first<{ id: string; password_hash: string | null; first_name: string | null; last_name: string | null }>()

  if (existing?.password_hash) {
    return fail('You already have an account with this company. Sign in instead.', 409)
  }

  const salt = randomId(16)
  const hash = await hashPassword(password, salt, env.SESSION_PEPPER ?? '')
  const now = Date.now()
  let userId: string
  let claimedInvite = false

  if (existing) {
    /*
      The admin got here first and this person never opened the link. Joining
      is the acceptance: the password lands on the row the admin made, the
      admin's title and team stay, and every live invitation is marked used so
      the link in their inbox cannot later be used to set a *different*
      password by whoever finds it.
    */
    userId = existing.id
    const name = displayName({
      first_name: first ?? existing.first_name,
      last_name: last ?? existing.last_name,
      email,
    })
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET password_hash = ?2, password_salt = ?3, active = 1,
                first_name = COALESCE(?4, first_name), last_name = COALESCE(?5, last_name),
                name = ?6, phone = COALESCE(?7, phone)
          WHERE id = ?1`,
      ).bind(userId, hash, salt, first ?? null, last ?? null, name, phone ?? null),
      env.DB.prepare(
        `UPDATE invites SET accepted_at = ?2
          WHERE user_id = ?1 AND kind = 'invite' AND accepted_at IS NULL AND revoked_at IS NULL`,
      ).bind(userId, now),
    ])
    claimedInvite = true
  } else {
    userId = `u_${randomId(8)}`
    const name = displayName({ first_name: first, last_name: last, email })
    await env.DB.prepare(
      `INSERT INTO users (id, client_id, email, name, first_name, last_name, role, phone, password_hash, password_salt, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'field_rep', ?7, ?8, ?9, 1, ?10)`,
    )
      .bind(userId, company.id, email, name, first ?? null, last ?? null, phone ?? null, hash, salt, now)
      .run()
  }

  await clearFailures(env, email, ip)
  const token = await createSession(env, userId)
  await touchLastSeen(env, userId)
  const me = await readMe(env, userId)
  if (!me) return fail('The account was made but could not be read back. Sign in.', 500)

  // Recorded as their own act — nobody else was in the room.
  await record(env, me, {
    action: 'user.joined',
    targetType: 'user',
    targetId: userId,
    targetLabel: me.name,
    detail: { email, claimedInvite, company: company.name },
  })

  return { token, user: me, claimedInvite }
}
