import { PBKDF2_ITERATIONS, hashPassword, randomId } from './auth'
import { canInvite } from './invites'
import type { Env, SessionUser } from './types'

/**
 * Account management.
 *
 * Three operations, and the distinction between them is the whole design:
 *
 *   deactivate  — they can't sign in, their work stays. This is what "remove
 *                 someone from the team" nearly always means.
 *   delete      — the row and everything hanging off it is gone. Every table
 *                 keyed on a user cascades: visits, notes, activity, tasks,
 *                 routes, daily stats. That isn't just their login, it's the
 *                 company's reporting history with a hole in it.
 *   set password— they can sign in again with something the admin chose.
 *
 * Collapsing those into one "delete" button is how a company loses a quarter of
 * its numbers because a rep quit.
 */

export const MIN_PASSWORD = 10

interface Actorable {
  env: Env
  actor: SessionUser
  userId: string
}

type Failure = { error: string; status: number }
const fail = (error: string, status: number): Failure => ({ error, status })

/**
 * Shared preflight. Every one of these operations can lock a company out of its
 * own account if it's allowed on the wrong target, so the checks live in one
 * place rather than being repeated three times and drifting.
 */
async function guard(
  { env, actor, userId }: Actorable,
  opts: { allowSelf?: boolean },
): Promise<{ target: { id: string; role: string; name: string; email: string } } | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)

  const target = await env.DB.prepare(
    'SELECT id, role, name, email, active FROM users WHERE id = ?1 AND client_id = ?2',
  )
    .bind(userId, actor.clientId)
    .first<{ id: string; role: string; name: string; email: string; active: number }>()

  // Not found rather than forbidden: whether a user id exists in another
  // tenant is not something this account gets to learn.
  if (!target) return fail('No such person on this team.', 404)

  if (!opts.allowSelf && target.id === actor.id) {
    return fail('You can’t do that to your own account.', 400)
  }

  return { target }
}

const LAST_ADMIN_MESSAGE = 'That’s the last administrator — the account would be locked.'

/**
 * Refuse to remove the last administrator, atomically.
 *
 * The condition is part of the write rather than a check before it, and that
 * matters: two admins deactivating each other at the same moment would both pass
 * a separate check — each still sees the other as active — and the company would
 * end up with nobody who can administer it. Expressing it as one statement means
 * the second write sees the first one's effect.
 *
 * `meta.changes === 0` is how the caller learns it was refused, since a
 * conditional UPDATE that matches nothing is not an error.
 */
const LAST_ADMIN_GUARD = (verb: string) => `${verb}
   WHERE id = ?1 AND client_id = ?2
     AND (
       role NOT IN ('client_admin','super_admin')
       OR EXISTS (
         SELECT 1 FROM users other
          WHERE other.client_id = ?2
            AND other.id != ?1
            AND other.active = 1
            AND other.password_hash IS NOT NULL
            AND other.role IN ('client_admin','super_admin')
       )
     )`

/** Kill every session a user holds. */
async function revokeAll(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?1').bind(userId).run()
}

/* --- set a password ------------------------------------------------------- */

export async function setPassword(
  a: Actorable,
  password: string,
): Promise<{ ok: true; iterations: number } | Failure> {
  // Self-service is allowed: possession of a valid session already proves
  // control of the account, so requiring the old password would only lock out
  // the one person who can't be reset by anybody else.
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g

  if (password.length < MIN_PASSWORD) {
    return fail(`Password must be at least ${MIN_PASSWORD} characters.`, 400)
  }

  const salt = randomId(16)
  const hash = await hashPassword(password, salt, a.env.SESSION_PEPPER ?? '')
  await a.env.DB.prepare('UPDATE users SET password_hash = ?2, password_salt = ?3 WHERE id = ?1')
    .bind(g.target.id, hash, salt)
    .run()

  // Every existing session dies, including the actor's own if they changed
  // their own password. This is the point of a reset after a phone goes missing
  // in a customer's hedge: the old credential has to stop working everywhere.
  await revokeAll(a.env, g.target.id)

  return { ok: true, iterations: PBKDF2_ITERATIONS }
}

/* --- a link they use themselves ------------------------------------------- */

/**
 * The safer half of the pair. The admin never learns the password, so a rep
 * can't later claim their manager signed in as them — and nothing has to be read
 * aloud over a phone.
 */
export async function createResetLink(
  a: Actorable,
  origin: string,
): Promise<{ url: string; email: string; expiresAt: number } | Failure> {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g

  const token = randomId(24)
  const now = Date.now()
  const expiresAt = now + 2 * 86_400_000
  const hashed = await sha256(token)

  // Reuses the invite table: an invite and a reset are the same object — a
  // one-time token that lets exactly one person choose exactly one password.
  await a.env.DB.prepare(
    `INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(hashed, g.target.id, a.actor.id, now, expiresAt)
    .run()

  return { url: `${origin}/invite/${token}`, email: g.target.email, expiresAt }
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* --- switch access on and off --------------------------------------------- */

export async function setActive(
  a: Actorable,
  active: boolean,
): Promise<{ ok: true } | Failure> {
  const g = await guard(a, {})
  if ('error' in g) return g

  if (active) {
    await a.env.DB.prepare('UPDATE users SET active = 1 WHERE id = ?1').bind(g.target.id).run()
    return { ok: true }
  }

  const done = await a.env.DB.prepare(LAST_ADMIN_GUARD('UPDATE users SET active = 0'))
    .bind(g.target.id, a.actor.clientId)
    .run()
  if (!done.meta.changes) return fail(LAST_ADMIN_MESSAGE, 400)

  // Switching someone off has to end the session they're holding right now,
  // otherwise "deactivated" means "deactivated in thirty days".
  await revokeAll(a.env, g.target.id)

  return { ok: true }
}

/* --- what a delete would actually destroy --------------------------------- */

export interface Footprint {
  visits: number
  notes: number
  photos: number
  tasks: number
  appointments: number
  activity: number
  assignedProperties: number
}

/**
 * Counted and shown before the fact, because "are you sure?" is not informed
 * consent. An admin deleting a rep who worked for eight months is deleting eight
 * months of doors-per-day, and they should see the number first.
 */
export async function footprint(a: Actorable): Promise<Footprint | Failure> {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g

  const one = async (sql: string) =>
    (await a.env.DB.prepare(sql).bind(g.target.id, a.actor.clientId).first<{ n: number }>())?.n ?? 0

  return {
    visits: await one('SELECT COUNT(*) AS n FROM visits WHERE rep_id = ?1 AND client_id = ?2'),
    notes: await one('SELECT COUNT(*) AS n FROM notes WHERE author_id = ?1 AND client_id = ?2'),
    photos: await one(
      `SELECT COUNT(*) AS n FROM photos p JOIN visits v ON v.id = p.visit_id
        WHERE v.rep_id = ?1 AND p.client_id = ?2`,
    ),
    tasks: await one('SELECT COUNT(*) AS n FROM tasks WHERE rep_id = ?1 AND client_id = ?2'),
    appointments: await one(
      'SELECT COUNT(*) AS n FROM appointments WHERE rep_id = ?1 AND client_id = ?2',
    ),
    activity: await one('SELECT COUNT(*) AS n FROM activity WHERE rep_id = ?1 AND client_id = ?2'),
    assignedProperties: await one(
      'SELECT COUNT(*) AS n FROM properties WHERE assigned_rep_id = ?1 AND client_id = ?2',
    ),
  }
}

/* --- delete --------------------------------------------------------------- */

export async function deleteUser(a: Actorable): Promise<{ ok: true } | Failure> {
  const g = await guard(a, {})
  if ('error' in g) return g

  // Properties are ON DELETE SET NULL, so leads survive and fall back into the
  // unassigned bucket rather than disappearing with the person who held them.
  // Everything else keyed on the user cascades, which is what the caller was
  // shown the counts for.
  const done = await a.env.DB.prepare(LAST_ADMIN_GUARD('DELETE FROM users'))
    .bind(g.target.id, a.actor.clientId)
    .run()
  if (!done.meta.changes) return fail(LAST_ADMIN_MESSAGE, 400)

  return { ok: true }
}
