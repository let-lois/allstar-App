import { hashPassword, randomId } from './auth'
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
 */

const INVITE_DAYS = 7
const MIN_PASSWORD = 10

const enc = new TextEncoder()

export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface CreatedInvite {
  url: string
  email: string
  expiresAt: number
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
    env.DB.prepare(
      `INSERT INTO users (id, client_id, email, name, role, password_hash, password_salt, active, created_at)
       VALUES (?1, ?2, ?3, ?4, 'super_admin', ?5, ?6, 1, ?7)`,
    ).bind(userId, clientId, input.email, input.name || 'Administrator', hash, salt, now),
  ])

  return { ok: true }
}

/** Admins invite; managers and reps cannot. */
export function canInvite(user: SessionUser): boolean {
  return user.role === 'client_admin' || user.role === 'super_admin'
}

export async function createInvite(
  env: Env,
  actor: SessionUser,
  /** The Worker's own origin — it serves the acceptance page, not the app. */
  origin: string,
  input: { email: string; name: string; role: Role; phone?: string },
): Promise<CreatedInvite | { error: string; status: number }> {
  if (!input.email.includes('@')) return { error: 'Enter a valid email.', status: 400 }

  const now = Date.now()
  const userId = `u_${randomId(8)}`

  // Re-inviting someone who never accepted is a normal thing to do, so reuse
  // the existing row rather than failing on the unique index.
  const existing = await env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE client_id = ?1 AND lower(email) = lower(?2)',
  )
    .bind(actor.clientId, input.email)
    .first<{ id: string; password_hash: string | null }>()

  if (existing?.password_hash) {
    return { error: 'That person already has an account.', status: 409 }
  }

  const id = existing?.id ?? userId
  if (existing) {
    await env.DB.prepare('UPDATE users SET name = ?2, role = ?3, phone = ?4 WHERE id = ?1')
      .bind(id, input.name, input.role, input.phone ?? null)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO users (id, client_id, email, name, role, phone, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`,
    )
      .bind(id, actor.clientId, input.email, input.name, input.role, input.phone ?? null, now)
      .run()
  }

  const token = randomId(24)
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(await sha256(token), id, actor.id, now, now + INVITE_DAYS * 86_400_000)
    .run()

  return {
    url: `${origin}/invite/${token}`,
    email: input.email,
    expiresAt: now + INVITE_DAYS * 86_400_000,
  }
}

export interface InviteView {
  email: string
  name: string
  clientName: string
}

export async function readInvite(env: Env, token: string): Promise<InviteView | null> {
  const row = await env.DB.prepare(
    `SELECT u.email, u.name, c.name AS client_name
       FROM invites i
       JOIN users u ON u.id = i.user_id
       JOIN clients c ON c.id = u.client_id
      WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.expires_at > ?2`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ email: string; name: string; client_name: string }>()

  if (!row) return null
  return { email: row.email, name: row.name, clientName: row.client_name }
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
    `SELECT user_id FROM invites
      WHERE token_hash = ?1 AND accepted_at IS NULL AND expires_at > ?2`,
  )
    .bind(hashOfToken, Date.now())
    .first<{ user_id: string }>()

  if (!row) return { ok: false, status: 410, error: 'This invite has expired or already been used.' }

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
