import { PBKDF2_ITERATIONS, hashPassword, randomId, safeEqual } from './auth'
import { record } from './audit'
import { canInvite, grantableRoles, revokeLiveInvites } from './invites'
import { regenerateBadgeFor, renewBadgeDates } from './onboardingFlow'
import type { Env, Role, SessionUser } from './types'

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
  opts: { allowSelf?: boolean; selfServe?: boolean },
): Promise<{ target: { id: string; role: string; name: string; email: string } } | Failure> {
  // `selfServe` lets anyone act on their own account — a rep changing their own
  // password should not have to ask an admin, and routing every reset through
  // the office is a support burden that scales with headcount.
  const actingOnSelf = opts.selfServe === true && userId === actor.id
  if (!actingOnSelf && !canInvite(actor)) return fail('Not permitted.', 403)

  const target = await env.DB.prepare(
    'SELECT id, role, name, email, active FROM users WHERE id = ?1 AND client_id = ?2',
  )
    .bind(userId, actor.clientId)
    .first<{ id: string; role: string; name: string; email: string; active: number }>()

  // Not found rather than forbidden: whether a user id exists in another
  // tenant is not something this account gets to learn.
  if (!target) return fail('No such person on this team.', 404)

  /*
    Nobody may act on an account more powerful than their own.

    Without this a client admin could reset a super admin's password, which is
    not an administrative action — it is a takeover. The same reasoning covers
    deactivation and deletion: a lower role removing a higher one is how an
    escalation looks from the inside.
  */
  if (
    !actingOnSelf &&
    target.role === 'super_admin' &&
    actor.role !== 'super_admin'
  ) {
    return fail('Only a super admin can manage another super admin.', 403)
  }

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
  const g = await guard(a, { allowSelf: true, selfServe: true })
  if ('error' in g) return g

  if (password.length < MIN_PASSWORD) {
    return fail(`Password must be at least ${MIN_PASSWORD} characters.`, 400)
  }

  const salt = randomId(16)
  const hash = await hashPassword(password, salt, a.env.SESSION_PEPPER ?? '')
  /*
    A first password switches the account on; a replacement does not.

    An invited person is `active = 0` until they accept, and only `acceptInvite`
    flipped that — so an admin setting a password for somebody who never opened
    their link produced an account with a working password that still could not
    sign in, while the Manage sheet promised it would. The CASE reads the *old*
    hash: NULL means this is their first password and they were only ever
    waiting; anything else means a reset, and a reset must never quietly undo a
    deactivation somebody chose.
  */
  await a.env.DB.prepare(
    `UPDATE users
        SET password_hash = ?2, password_salt = ?3,
            active = CASE WHEN password_hash IS NULL THEN 1 ELSE active END
      WHERE id = ?1`,
  )
    .bind(g.target.id, hash, salt)
    .run()

  // Every existing session dies, including the actor's own if they changed
  // their own password. This is the point of a reset after a phone goes missing
  // in a customer's hedge: the old credential has to stop working everywhere.
  await revokeAll(a.env, g.target.id)

  await record(a.env, a.actor, {
    action: 'user.password_set',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    // Whether someone set their own or had it set for them is the first thing
    // anyone asks of this entry.
    detail: { self: g.target.id === a.actor.id },
  })

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
  // Marked 'reset' so the console never reports it as a pending invitation,
  // and so `acceptInvite` knows this one is allowed to replace a password.
  // Earlier unused reset links die here: one live link per person.
  await revokeLiveInvites(a.env, g.target.id, 'reset')
  await a.env.DB.prepare(
    `INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, 'reset')`,
  )
    .bind(hashed, g.target.id, a.actor.id, now, expiresAt)
    .run()

  await record(a.env, a.actor, {
    action: 'user.reset_link',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
  })

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
    await record(a.env, a.actor, {
      action: 'user.reactivated',
      targetType: 'user',
      targetId: g.target.id,
      targetLabel: g.target.name,
    })
    return { ok: true }
  }

  const done = await a.env.DB.prepare(LAST_ADMIN_GUARD('UPDATE users SET active = 0'))
    .bind(g.target.id, a.actor.clientId)
    .run()
  if (!done.meta.changes) return fail(LAST_ADMIN_MESSAGE, 400)

  // Switching someone off has to end the session they're holding right now,
  // otherwise "deactivated" means "deactivated in thirty days".
  await revokeAll(a.env, g.target.id)

  await record(a.env, a.actor, {
    action: 'user.deactivated',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
  })

  return { ok: true }
}

/**
 * Change what somebody is allowed to do.
 *
 * Not permitted on your own account, for the same reason as everything else
 * here: demoting yourself is a lockout, and promoting yourself is the definition
 * of privilege escalation. Demoting the last administrator runs through the same
 * atomic guard as removing one, because "role changed to field_rep" locks a
 * company out exactly as thoroughly as a delete.
 */
export async function setRole(a: Actorable, role: Role): Promise<{ ok: true } | Failure> {
  const VALID: Role[] = ['field_rep', 'manager', 'client_admin', 'super_admin']
  if (!VALID.includes(role)) return fail('Unknown role.', 400)

  const g = await guard(a, {})
  if ('error' in g) return g
  if (g.target.role === role) return { ok: true }

  // Nobody hands out a role they don't hold. Checked through the same helper the
  // invite path uses, so the two cannot drift apart.
  if (!grantableRoles(a.actor).includes(role)) {
    return fail(
      role === 'super_admin'
        ? 'Only a super admin can grant that role.'
        : 'That role cannot be granted.',
      403,
    )
  }

  const losingAdmin = g.target.role === 'client_admin' || g.target.role === 'super_admin'
  const gainingAdmin = role === 'client_admin' || role === 'super_admin'

  if (losingAdmin && !gainingAdmin) {
    const done = await a.env.DB.prepare(LAST_ADMIN_GUARD('UPDATE users SET role = ?4'))
      .bind(g.target.id, a.actor.clientId, null, role)
      .run()
    if (!done.meta.changes) return fail(LAST_ADMIN_MESSAGE, 400)
  } else {
    await a.env.DB.prepare('UPDATE users SET role = ?2 WHERE id = ?1 AND client_id = ?3')
      .bind(g.target.id, role, a.actor.clientId)
      .run()
  }

  // A role change alters what an existing session may do, and sessions carry no
  // role of their own — they resolve it per request. Revoking anyway, because a
  // demotion should take effect on the device in someone's hand, not whenever
  // they next happen to sign out.
  await revokeAll(a.env, g.target.id)

  await record(a.env, a.actor, {
    action: 'user.role_changed',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { from: g.target.role, to: role },
  })

  return { ok: true }
}

/* --- which team, and what it says under their name ------------------------- */

/**
 * Put somebody on a team, or take them off one (`null`).
 *
 * Admin only, through the same guard as every other change to a person's
 * account: a team decides what a roster filter shows and what a badge says,
 * and letting reps move themselves between offices is a feature nobody asked
 * for. The team has to belong to this company — an id from another tenant
 * reads as "no such team", not as a cross-tenant write.
 */
export async function setUserTeam(
  a: Actorable,
  teamId: string | null,
): Promise<{ ok: true; teamName: string | null } | Failure> {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g

  let teamName: string | null = null
  if (teamId !== null) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(teamId)) return fail('No such team.', 404)
    const team = await a.env.DB.prepare('SELECT name FROM teams WHERE id = ?1 AND client_id = ?2')
      .bind(teamId, a.actor.clientId)
      .first<{ name: string }>()
    if (!team) return fail('No such team.', 404)
    teamName = team.name
  }

  await a.env.DB.prepare('UPDATE users SET team_id = ?2 WHERE id = ?1 AND client_id = ?3')
    .bind(g.target.id, teamId, a.actor.clientId)
    .run()

  await record(a.env, a.actor, {
    action: 'user.team_changed',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { teamId, teamName },
  })
  return { ok: true, teamName }
}

export const MAX_JOB_TITLE = 60

/**
 * The line under their name on the badge — "Sales Representative".
 *
 * Distinct from `role`, which is a permission. A rep may write their own title
 * during onboarding (that path is `PATCH /api/me/profile`, self only); this is
 * the admin overwriting it, through the guard.
 */
export async function setUserTitle(
  a: Actorable,
  title: unknown,
): Promise<{ ok: true; jobTitle: string | null } | Failure> {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g

  const clean = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : ''
  if (clean.length > MAX_JOB_TITLE) {
    return fail(`Keep the title under ${MAX_JOB_TITLE} characters.`, 400)
  }
  const jobTitle = clean || null

  await a.env.DB.prepare('UPDATE users SET job_title = ?2 WHERE id = ?1 AND client_id = ?3')
    .bind(g.target.id, jobTitle, a.actor.clientId)
    .run()

  await record(a.env, a.actor, {
    action: 'user.title_changed',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { jobTitle },
  })
  return { ok: true, jobTitle }
}

/* --- onboarding and the badge, from the office ----------------------------- */

/**
 * Ask somebody to go through onboarding again.
 *
 * Keeps everything they entered — name, photo, badge — and clears only the
 * record of having finished, so the flow opens at the top with every field
 * already filled and walks them to the checklist. Their sessions are revoked
 * so it takes effect on the phone in their hand rather than at their next
 * sign-out, the same way a role change does.
 */
export async function resetOnboarding(a: Actorable): Promise<{ ok: true } | Failure> {
  const g = await guard(a, {})
  if ('error' in g) return g
  await a.env.DB.prepare(
    `UPDATE users SET onboarding_completed_at = NULL, onboarding_step = NULL,
                      walkthrough_completed_at = NULL, setup_completed_at = NULL
      WHERE id = ?1 AND client_id = ?2`,
  )
    .bind(g.target.id, a.actor.clientId)
    .run()
  await revokeAll(a.env, g.target.id)
  await record(a.env, a.actor, {
    action: 'user.onboarding_reset',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
  })
  return { ok: true }
}

/** New dates on the same badge id; the person confirms it again. */
export async function renewBadge(a: Actorable) {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g
  const renewed = await renewBadgeDates(a.env, g.target.id, Date.now())
  if ('error' in renewed) return renewed
  await record(a.env, a.actor, {
    action: 'badge.renewed',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { badgeId: renewed.id, expiresAt: renewed.expiresAt, self: false },
  })
  return renewed
}

/**
 * A new badge id. For a badge that was misprinted, lost, or is being carried
 * by somebody who should not have it. The old number stops meaning anything.
 */
export async function regenerateBadge(a: Actorable) {
  const g = await guard(a, { allowSelf: true })
  if ('error' in g) return g
  const before = await a.env.DB.prepare('SELECT badge_id FROM users WHERE id = ?1')
    .bind(g.target.id)
    .first<{ badge_id: string | null }>()
  const issued = await regenerateBadgeFor(a.env, g.target.id, Date.now())
  if ('error' in issued) return issued
  await record(a.env, a.actor, {
    action: 'badge.regenerated',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { from: before?.badge_id ?? null, to: issued.id },
  })
  return issued
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

/*
  Deleting your own account, from inside the app (App Store guideline
  5.1.1(v): an app that lets people make an account must let them delete it).

  The same removal the office uses, with three differences: it asks for the
  password again, so a phone left unlocked cannot close someone's account; it
  is recorded before the row goes, so the audit line still names who did it;
  and the last administrator is told how to hand the company over rather than
  being allowed to lock it. Leads they worked stay the company's, back in the
  unassigned bucket; their sessions, badge, visits and notes go with the
  account, exactly as when the office deletes someone.
*/
export async function deleteOwnAccount(
  env: Env,
  actor: SessionUser,
  body: { password?: unknown; confirm?: unknown },
): Promise<{ ok: true } | Failure> {
  const password = typeof body.password === 'string' ? body.password : ''
  if (body.confirm !== 'DELETE') return fail('Type DELETE to confirm.', 400)
  if (!password) return fail('Enter your password to confirm.', 400)
  const row = await env.DB.prepare(
    'SELECT id, name, email, role, password_hash, password_salt FROM users WHERE id = ?1 AND client_id = ?2',
  )
    .bind(actor.id, actor.clientId)
    .first<{ id: string; name: string; email: string; role: string; password_hash: string | null; password_salt: string | null }>()
  if (!row) return fail('No such account.', 404)
  if (!row.password_hash || !row.password_salt) return fail('This account has no password yet, so it cannot be confirmed. Ask your office to remove it.', 400)
  const attempt = await hashPassword(password, row.password_salt, env.SESSION_PEPPER ?? '')
  if (!safeEqual(attempt, row.password_hash)) return fail('That password is not right.', 403)

  // Refused up front, in words, rather than by the guard's generic message.
  const admins = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE client_id = ?1 AND id != ?2 AND active = 1
        AND role IN ('client_admin','super_admin')`,
  )
    .bind(actor.clientId, actor.id)
    .first<{ n: number }>()
  if ((row.role === 'client_admin' || row.role === 'super_admin') && !admins?.n) {
    return fail('You are the last administrator for your company. Make another team member an administrator first, then delete your account.', 400)
  }

  await record(env, actor, {
    action: 'user.deleted',
    targetType: 'user',
    targetId: row.id,
    targetLabel: row.name,
    detail: { email: row.email, role: row.role, self: true },
  })
  const done = await env.DB.prepare(LAST_ADMIN_GUARD('DELETE FROM users'))
    .bind(row.id, actor.clientId)
    .run()
  if (!done.meta.changes) return fail(LAST_ADMIN_MESSAGE, 400)
  await repointTerritoryMirror(env, actor.clientId)
  return { ok: true }
}

/** After a user is deleted: territories.rep_id went null where it named them; point it at whoever is left. */
async function repointTerritoryMirror(env: Env, clientId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE territories
        SET rep_id = (SELECT r.user_id FROM territory_reps r
                       WHERE r.territory_id = territories.id
                       ORDER BY r.assigned_at, r.user_id LIMIT 1)
      WHERE client_id = ?1 AND rep_id IS NULL`,
  )
    .bind(clientId)
    .run()
}

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

  // Their territory memberships cascaded and `territories.rep_id` was set to
  // null where it named them; re-point that mirror at whoever is still on
  // each patch, so the import's drawn-shape path and older phones do not
  // read a shared territory as unowned.
  await repointTerritoryMirror(a.env, a.actor.clientId)

  // Recorded after the fact and by name, because the row this points at no
  // longer exists — which is exactly why the label was copied rather than
  // joined.
  await record(a.env, a.actor, {
    action: 'user.deleted',
    targetType: 'user',
    targetId: g.target.id,
    targetLabel: g.target.name,
    detail: { email: g.target.email, role: g.target.role },
  })

  return { ok: true }
}
