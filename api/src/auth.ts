import type { Env, SessionUser } from './types'

/**
 * Authentication.
 *
 * Opaque session tokens stored in D1 rather than self-contained JWTs. The
 * trade is one database read per request against the ability to revoke
 * instantly — and on a product where the credential lives on a phone that gets
 * lost in a customer's hedge, instant revocation is worth more than saving a
 * lookup that rides along with a query we're making anyway.
 */

const SESSION_DAYS = 30

/**
 * The Workers runtime rejects PBKDF2 above 100,000 iterations — this is a hard
 * platform ceiling, not a tuning choice, and asking for more throws rather than
 * clamping.
 *
 * That is below current guidance for PBKDF2-SHA256 used alone, which is why the
 * pepper matters here rather than being belt-and-braces: it's a server-side
 * secret mixed into every hash, so an attacker holding only a dumped database
 * cannot mount an offline attack at any iteration count. They need the Worker's
 * secret too.
 *
 * Note for anyone testing locally: `wrangler dev` runs Node's crypto, which
 * accepts higher counts happily. This limit only appears in production.
 */
export const PBKDF2_ITERATIONS = 100_000

const enc = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(bytes = 24): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return toHex(a.buffer)
}

/**
 * PBKDF2-SHA256. bcrypt/argon2 aren't available in Workers; PBKDF2 with a high
 * iteration count is the standard alternative on this runtime.
 *
 * The pepper is a deployment secret, so a leaked database alone doesn't let an
 * attacker start cracking — they need the Worker's secret too.
 */
export async function hashPassword(
  password: string,
  salt: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`${password}${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return toHex(bits)
}

/** Length-independent compare — a fast reject leaks how much of a hash matched. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface LoginResult {
  token: string
  user: SessionUser
}

/**
 * A signed-in session for a user, as a bearer token.
 *
 * Its own function because two doors now lead here: a password checked by
 * `login`, and a company join code redeemed by `joinWithCode` — which has just
 * *set* the password and must not hash it a second time to sign the person in.
 */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomId(32)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked)
     VALUES (?1, ?2, ?3, ?4, 0)`,
  )
    .bind(token, userId, now, now + SESSION_DAYS * 86_400_000)
    .run()
  return token
}

/**
 * How many accounts sharing one email address a sign-in will try.
 *
 * Email is unique per company, not globally — the same person can be a rep at
 * two contractors — and the login form carries no company. Each attempt is a
 * full PBKDF2 derivation against the Worker's CPU budget, so this is bounded
 * rather than "all of them"; two is the realistic ceiling for one human.
 */
const MAX_TENANTS_PER_LOGIN = 2

export async function login(
  env: Env,
  email: string,
  password: string,
): Promise<LoginResult | null> {
  /*
    Every account with this address, not the first one SQLite happens to hand
    back. The unique index is (client_id, lower(email)) on purpose; reading
    one row here quietly made the same address at a second company a coin
    toss. Oldest first, so the account that has always signed in with these
    words keeps winning ties.
  */
  const rows = await env.DB.prepare(
    `SELECT u.id, u.client_id, u.email, u.name, u.role, u.phone,
            u.password_hash, u.password_salt, u.active, c.name AS client_name,
            c.timezone AS client_tz
       FROM users u JOIN clients c ON c.id = u.client_id
      WHERE lower(u.email) = lower(?1)
      ORDER BY u.created_at`,
  )
    .bind(email)
    .all<Record<string, string | number | null>>()

  const candidates = (rows.results ?? []).filter(
    (r) => r.password_hash && r.password_salt && r.active,
  )

  // Hash anyway when nobody can sign in with this address, so a wrong email
  // and a wrong password take the same time — otherwise the endpoint tells
  // you which accounts exist.
  if (candidates.length === 0) {
    await hashPassword(password, 'decoy-salt', env.SESSION_PEPPER ?? '')
    return null
  }
  if (candidates.length > MAX_TENANTS_PER_LOGIN) {
    console.warn(`[allstar] ${candidates.length} accounts share one email; trying the oldest ${MAX_TENANTS_PER_LOGIN}`)
  }

  let row: Record<string, string | number | null> | null = null
  for (const candidate of candidates.slice(0, MAX_TENANTS_PER_LOGIN)) {
    const attempt = await hashPassword(
      password,
      String(candidate.password_salt),
      env.SESSION_PEPPER ?? '',
    )
    if (safeEqual(attempt, String(candidate.password_hash))) {
      row = candidate
      break
    }
  }
  if (!row) return null

  const token = await createSession(env, String(row.id))

  return {
    token,
    user: {
      id: String(row.id),
      clientId: String(row.client_id),
      clientName: String(row.client_name),
    timezone: String(row.client_tz ?? 'UTC'),
      email: String(row.email),
      name: String(row.name),
      role: String(row.role) as SessionUser['role'],
      phone: row.phone ? String(row.phone) : undefined,
    },
  }
}

export async function resolveSession(env: Env, token: string): Promise<SessionUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.client_id, u.email, u.name, u.role, u.phone, c.name AS client_name,
            c.timezone AS client_tz
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN clients c ON c.id = u.client_id
      WHERE s.id = ?1 AND s.revoked = 0 AND s.expires_at > ?2 AND u.active = 1`,
  )
    .bind(token, Date.now())
    .first<Record<string, string | null>>()

  if (!row) return null
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    timezone: String(row.client_tz ?? 'UTC'),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role) as SessionUser['role'],
    phone: row.phone ? String(row.phone) : undefined,
  }
}

export async function revokeSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?1').bind(token).run()
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token || null
}
