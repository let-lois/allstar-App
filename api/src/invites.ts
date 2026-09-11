import { hashPassword, randomId } from './auth'
import { record } from './audit'
import { mailConfigured, sendMail } from './mail'
import { inviteEmail } from './mailTemplates'
import { displayName, ONBOARDING_VERSION } from './onboarding'
import type { Env, Role, SessionUser } from './types'

/**
 * Account creation without anyone handling a password.
 *
 * An admin names a person and a role; the Worker mints a single-use link; the
 * person sets their own password. Nobody types, generates, or transports a
 * hash — which means the signing pepper never has to leave Cloudflare, and no
 * credential ends up in a chat log, a commit, or a support ticket.
 *
 * Tokens are stored hashed. An invite link is a bearer credential for one
 * account, so a leaked database must not yield a working one.
 *
 * ## One person, one row
 *
 * Every road into this file ends at the same `users` row for a given address
 * within a company. Inviting an address that is already pending re-uses the
 * row and replaces its link; inviting one that already signed in — through an
 * earlier link, or through the company join code — links to that account and
 * mints nothing. There is no path here that creates a second account for an
 * address that has one, however many times the button is pressed.
 *
 * ## Two kinds of token
 *
 * An invitation sets a first password; a reset link (users.ts) replaces one.
 * They share the table because they are the same object — one token, one
 * password — but they must not be confused: an *invitation* opened by someone
 * who already has a password is refused rather than allowed to overwrite it,
 * because a forwarded invite email would otherwise be a way to lock the real
 * owner out. A reset link is exactly for that person, and goes through.
 */

const INVITE_DAYS = 7
const MIN_PASSWORD = 10

const enc = new TextEncoder()

export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * First-run setup: creates the tenant and its first administrator.
 *
 * Guarded twice — a deployment secret the operator sets, *and* the requirement
 * that no user exists yet. Either alone is thin: a secret can leak, and an
 * "only if empty" check is a race between deploy and discovery.
 */
export async function runSetup(
  env: Env,
  input: { token: string; clientName: string; name: string; email: string; password: string },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const expected = env.SETUP_TOKEN
  if (!expected) {
    return { ok: false, status: 503, error: 'Setup is not enabled on this deployment.' }
  }
  if (input.token !== expected) {
    return { ok: false, status: 403, error: 'Setup token is incorrect.' }
  }

  const existing = await env.DB.prepare('SELECT 1 AS ok FROM users LIMIT 1').first<{ ok: number }>()
  if (existing) {
    return { ok: false, status: 409, error: 'Setup has already been completed.' }
  }

  if (!input.email.includes('@')) return { ok: false, status: 400, error: 'Enter a valid email.' }
  if (input.password.length < MIN_PASSWORD) {
    return { ok: false, status: 400, error: `Password must be at least ${MIN_PASSWORD} characters.` }
  }

  const now = Date.now()
  const clientId = `c_${randomId(8)}`
  const userId = `u_${randomId(8)}`
  const salt = randomId(16)
  const hash = await hashPassword(input.password, salt, env.SESSION_PEPPER ?? '')

  await env.DB.batch([
    env.DB.prepare('INSERT INTO clients (id, name, created_at) VALUES (?1, ?2, ?3)').bind(
      clientId,
      input.clientName || 'My Company',
      now,
    ),
    /*
      The founder is onboarded by definition: they are standing up the company,
      not joining one, and the profile, walkthrough and badge steps are written
      for a rep about to knock a door. Without this the first thing the console
      showed its new administrator was the phone's onboarding shell, and the
      only way past it was a badge nobody had asked for.
    */
    env.DB.prepare(
      `INSERT INTO users (id, client_id, email, name, role, password_hash, password_salt, active, created_at,
                          onboarding_completed_at, onboarding_version)
       VALUES (?1, ?2, ?3, ?4, 'super_admin', ?5, ?6, 1, ?7, ?7, ?8)`,
    ).bind(userId, clientId, input.email, input.name || 'Administrator', hash, salt, now, ONBOARDING_VERSION),
  ])

  return { ok: true }
}

/** Admins invite; managers and reps cannot. */
export function canInvite(user: SessionUser): boolean {
  return user.role === 'client_admin' || user.role === 'super_admin'
}

const ROLES: Role[] = ['field_rep', 'manager', 'client_admin', 'super_admin']

/**
 * Which roles this person may hand out.
 *
 * The rule is that nobody can create an account more powerful than their own.
 * Without it, `createInvite` stored whatever role string arrived — the only thing
 * standing between a client admin and a super admin account was the database's
 * CHECK constraint, which `super_admin` passes. That is a privilege escalation
 * reachable from an ordinary form field.
 */
export function grantableRoles(actor: SessionUser): Role[] {
  if (actor.role === 'super_admin') return ROLES
  if (actor.role === 'client_admin') return ['field_rep', 'manager', 'client_admin']
  return []
}

type Failure = { error: string; status: number }
const fail = (error: string, status: number): Failure => ({ error, status })

const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/
const MAX_NAME_PART = 60
const MAX_JOB_TITLE = 60

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, max) : undefined
}

export interface InviteInput {
  email: string
  role: Role
  /** Either the halves, or the whole. Both optional: an address is enough. */
  firstName?: unknown
  lastName?: unknown
  name?: unknown
  phone?: unknown
  jobTitle?: unknown
  /** A team in this company, or null for none. Undefined leaves it alone. */
  teamId?: unknown
}

export type InviteOutcome =
  | {
      alreadyMember: false
      url: string
      email: string
      expiresAt: number
      userId: string
      /** True when this replaced an earlier, still-unaccepted link. */
      resent: boolean
      /**
       * Whether the invitation was actually emailed. The console says
       * "emailed" only when this is true; otherwise it shows the link and says
       * nothing went out. False with `mailError` set is a provider failure;
       * false without one means email is not configured here.
       */
      emailed: boolean
      mailError?: string
    }
  | {
      /**
       * The address already belongs to a working account here. Nothing was
       * minted and nothing was emailed; the admin is told so rather than left
       * believing an invitation went out to somebody who can already sign in.
       */
      alreadyMember: true
      email: string
      userId: string
      message: string
    }

/** Every unaccepted, unrevoked invitation token this person holds, revoked. */
export async function revokeLiveInvites(env: Env, userId: string, kind: 'invite' | 'reset' = 'invite'): Promise<number> {
  const done = await env.DB.prepare(
    `UPDATE invites SET revoked_at = ?2
      WHERE user_id = ?1 AND kind = ?3 AND accepted_at IS NULL AND revoked_at IS NULL`,
  )
    .bind(userId, Date.now(), kind)
    .run()
  return done.meta.changes ?? 0
}

async function mintInvite(env: Env, actor: SessionUser, origin: string, userId: string) {
  const now = Date.now()
  const token = randomId(24)
  const expiresAt = now + INVITE_DAYS * 86_400_000
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, 'invite')`,
  )
    .bind(await sha256(token), userId, actor.id, now, expiresAt)
    .run()
  return { url: `${origin}/invite/${token}`, expiresAt }
}

/**
 * Email the link, if this deployment can. Never throws and never blocks the
 * invitation: the link exists either way, and the caller reports which.
 */
async function deliverInvite(
  env: Env,
  actor: SessionUser,
  to: { email: string; name?: string },
  minted: { url: string; expiresAt: number },
  appUrl: string,
  resent: boolean,
): Promise<{ emailed: boolean; mailError?: string }> {
  if (!mailConfigured(env)) return { emailed: false }
  const result = await sendMail(
    env,
    inviteEmail({ to, clientName: actor.clientName, invitedBy: actor.name, url: minted.url, expiresAt: minted.expiresAt, appUrl, resent }),
  )
  return result.sent ? { emailed: true } : { emailed: false, mailError: result.error }
}

async function teamInTenant(env: Env, clientId: string, teamId: string): Promise<boolean> {
  if (!ID_SHAPE.test(teamId)) return false
  const row = await env.DB.prepare('SELECT 1 AS ok FROM teams WHERE id = ?1 AND client_id = ?2')
    .bind(teamId, clientId)
    .first()
  return !!row
}

export async function createInvite(
  env: Env,
  actor: SessionUser,
  /** The Worker's own origin — it serves the acceptance page, not the app. */
  origin: string,
  input: InviteInput,
  /** Where the app lives, for the email's "then open this and sign in". */
  appUrl = 'https://allstar.letlois.com',
): Promise<InviteOutcome | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (!email.includes('@')) return fail('Enter a valid email.', 400)

  if (!grantableRoles(actor).includes(input.role)) {
    return fail(
      input.role === 'super_admin'
        ? 'Only a super admin can create another super admin.'
        : 'That role cannot be granted.',
      403,
    )
  }

  const firstName = clean(input.firstName, MAX_NAME_PART)
  const lastName = clean(input.lastName, MAX_NAME_PART)
  const jobTitle = clean(input.jobTitle, MAX_JOB_TITLE)
  const phone = clean(input.phone, 40)
  // A whole name typed into one box is split on its last space, so a badge
  // printed later has two lines to work with.
  let whole = clean(input.name, 2 * MAX_NAME_PART + 1)
  let first = firstName
  let last = lastName
  if (!first && !last && whole) {
    const at = whole.lastIndexOf(' ')
    if (at > 0) {
      first = whole.slice(0, at)
      last = whole.slice(at + 1)
    } else {
      first = whole
    }
    whole = undefined
  }
  const name = displayName({ first_name: first, last_name: last, name: whole, email })

  let teamId: string | null | undefined
  if (input.teamId === null) teamId = null
  else if (typeof input.teamId === 'string' && input.teamId) {
    if (!(await teamInTenant(env, actor.clientId, input.teamId))) return fail('No such team.', 404)
    teamId = input.teamId
  }

  const now = Date.now()
  const existing = await env.DB.prepare(
    `SELECT id, password_hash, first_name, last_name, phone, job_title, team_id
       FROM users WHERE client_id = ?1 AND lower(email) = lower(?2)`,
  )
    .bind(actor.clientId, email)
    .first<{
      id: string
      password_hash: string | null
      first_name: string | null
      last_name: string | null
      phone: string | null
      job_title: string | null
      team_id: string | null
    }>()

  /* --- road three: they can already sign in ---------------------------------- */
  if (existing?.password_hash) {
    /*
      Link, do not duplicate and do not fail. The admin's intent was "this
      person should be on the team with this title, on this team" — the parts
      of that which are still empty are filled; nothing they have is
      overwritten, and their role is not touched here (that is `setRole`, with
      its own guards). No token, because they have a password.
    */
    const sets: string[] = []
    const binds: (string | null)[] = []
    if (jobTitle && !existing.job_title) { sets.push(`job_title = ?${binds.length + 2}`); binds.push(jobTitle) }
    if (teamId && !existing.team_id) { sets.push(`team_id = ?${binds.length + 2}`); binds.push(teamId) }
    if (sets.length) {
      await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`).bind(existing.id, ...binds).run()
    }
    await record(env, actor, {
      action: 'user.invited',
      targetType: 'user',
      targetId: existing.id,
      targetLabel: name,
      detail: { email, role: input.role, alreadyMember: true },
    })
    return {
      alreadyMember: true,
      email,
      userId: existing.id,
      message: 'That person already has an account here and can sign in. To change what they can do, use Manage.',
    }
  }

  /* --- road two: pending — replace their link ------------------------------ */
  let userId: string
  let resent = false
  if (existing) {
    userId = existing.id
    resent = (await revokeLiveInvites(env, userId)) > 0
    /*
      A re-invite corrects what the admin names and keeps what they do not.

      The first version wrote every field from the new form, so a second Send
      that only fixed the spelling of a name silently erased the title typed
      the first time — the smoke caught it as a title that had "come back"
      wrong. Role is the exception: it is required on the form, so it is
      always what the form says.
    */
    const mergedFirst = first ?? existing.first_name ?? undefined
    const mergedLast = last ?? existing.last_name ?? undefined
    const mergedName = displayName({ first_name: mergedFirst, last_name: mergedLast, name: whole, email })
    await env.DB.prepare(
      `UPDATE users SET name = ?2, first_name = ?3, last_name = ?4, role = ?5,
                        phone = COALESCE(?6, phone), job_title = COALESCE(?7, job_title),
                        team_id = COALESCE(?8, team_id)
        WHERE id = ?1`,
    )
      .bind(userId, mergedName, mergedFirst ?? null, mergedLast ?? null, input.role, phone ?? null, jobTitle ?? null, teamId ?? null)
      .run()
    if (teamId === null) {
      await env.DB.prepare('UPDATE users SET team_id = NULL WHERE id = ?1').bind(userId).run()
    }
  } else {
    /* --- road one: somebody new ---------------------------------------------- */
    userId = `u_${randomId(8)}`
    await env.DB.prepare(
      `INSERT INTO users (id, client_id, email, name, first_name, last_name, role, phone, job_title, team_id, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)`,
    )
      .bind(userId, actor.clientId, email, name, first ?? null, last ?? null, input.role, phone ?? null, jobTitle ?? null, teamId ?? null, now)
      .run()
  }

  const minted = await mintInvite(env, actor, origin, userId)
  const mail = await deliverInvite(env, actor, { email, name: name || undefined }, minted, appUrl, resent)

  await record(env, actor, {
    action: 'user.invited',
    targetType: 'user',
    targetId: userId,
    targetLabel: name,
    detail: { email, role: input.role, resent, emailed: mail.emailed },
  })

  return { alreadyMember: false, url: minted.url, email, expiresAt: minted.expiresAt, userId, resent, ...mail }
}

/**
 * Mint a fresh link for someone who never opened the last one. Every earlier
 * unaccepted link stops working the moment this runs.
 */
export async function resendInvite(
  env: Env,
  actor: SessionUser,
  origin: string,
  userId: string,
  appUrl = 'https://allstar.letlois.com',
): Promise<{ url: string; email: string; expiresAt: number; revoked: number; emailed: boolean; mailError?: string } | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  if (!ID_SHAPE.test(userId)) return fail('No such person on this team.', 404)
  const target = await env.DB.prepare(
    'SELECT id, email, name, password_hash FROM users WHERE id = ?1 AND client_id = ?2',
  )
    .bind(userId, actor.clientId)
    .first<{ id: string; email: string; name: string; password_hash: string | null }>()
  if (!target) return fail('No such person on this team.', 404)
  if (target.password_hash) {
    return fail('They already have a password, so there is nothing to invite them to. Send a reset link if they have forgotten it.', 409)
  }
  const revoked = await revokeLiveInvites(env, target.id)
  const minted = await mintInvite(env, actor, origin, target.id)
  const mail = await deliverInvite(env, actor, { email: target.email, name: target.name || undefined }, minted, appUrl, true)
  await record(env, actor, {
    action: 'user.invite_resent',
    targetType: 'user',
    targetId: target.id,
    targetLabel: target.name,
    detail: { email: target.email, revoked, emailed: mail.emailed },
  })
  return { url: minted.url, email: target.email, expiresAt: minted.expiresAt, revoked, ...mail }
}

/** Cancel every live invitation link this person holds. The row stays, pending. */
export async function revokeInvite(
  env: Env,
  actor: SessionUser,
  userId: string,
): Promise<{ ok: true; revoked: number } | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  if (!ID_SHAPE.test(userId)) return fail('No such person on this team.', 404)
  const target = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?1 AND client_id = ?2')
    .bind(userId, actor.clientId)
    .first<{ id: string; name: string }>()
  if (!target) return fail('No such person on this team.', 404)
  const revoked = await revokeLiveInvites(env, target.id)
  await record(env, actor, {
    action: 'user.invite_revoked',
    targetType: 'user',
    targetId: target.id,
    targetLabel: target.name,
    detail: { revoked },
  })
  return { ok: true, revoked }
}

export interface InviteView {
  email: string
  name: string
  clientName: string
  /**
   * An *invitation* link for an account that already has a password — the
   * person signed in another way first, or set it through an earlier link.
   * The page shows them the door to the app instead of a password form.
   */
  alreadyActive: boolean
}

export async function readInvite(env: Env, token: string): Promise<InviteView | null> {
  const row = await env.DB.prepare(
    `SELECT u.email, u.name, u.password_hash, i.kind, c.name AS client_name
       FROM invites i
       JOIN users u ON u.id = i.user_id
       JOIN clients c ON c.id = u.client_id
      WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ email: string; name: string; password_hash: string | null; kind: string; client_name: string }>()

  if (!row) return null
  return {
    email: row.email,
    name: row.name,
    clientName: row.client_name,
    alreadyActive: row.kind === 'invite' && !!row.password_hash,
  }
}

export async function acceptInvite(
  env: Env,
  token: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (password.length < MIN_PASSWORD) {
    return { ok: false, status: 400, error: `Password must be at least ${MIN_PASSWORD} characters.` }
  }

  const hashOfToken = await sha256(token)
  const row = await env.DB.prepare(
    `SELECT i.user_id, i.kind, u.password_hash FROM invites i
       JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2`,
  )
    .bind(hashOfToken, Date.now())
    .first<{ user_id: string; kind: string; password_hash: string | null }>()

  if (!row) return { ok: false, status: 410, error: 'This invite has expired or already been used.' }

  /*
    An invitation for someone who already has a password. They joined by the
    company code, or opened an earlier link, before this one was clicked —
    possibly by whoever the email was forwarded to. The token is consumed so it
    cannot be tried again, and the password they chose stays theirs.
  */
  if (row.kind === 'invite' && row.password_hash) {
    await env.DB.prepare('UPDATE invites SET accepted_at = ?2 WHERE token_hash = ?1')
      .bind(hashOfToken, Date.now())
      .run()
    return {
      ok: false,
      status: 409,
      error: 'This account already has a password. Open the app and sign in with it.',
    }
  }

  const salt = randomId(16)
  const hash = await hashPassword(password, salt, env.SESSION_PEPPER ?? '')

  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET password_hash = ?2, password_salt = ?3, active = 1 WHERE id = ?1',
    ).bind(row.user_id, hash, salt),
    // Single use, marked in the same batch so a double submit can't set two
    // different passwords.
    env.DB.prepare('UPDATE invites SET accepted_at = ?2 WHERE token_hash = ?1').bind(
      hashOfToken,
      Date.now(),
    ),
  ])

  return { ok: true }
}
