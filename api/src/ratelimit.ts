import type { Env } from './types'

/**
 * Sign-in rate limiting.
 *
 * Password hashing is deliberately slow, which raises the cost of each guess but
 * does not bound the total — a patient attacker still gets unlimited attempts,
 * and this Worker pays real CPU for every one of them.
 *
 * Two buckets, because they stop different attacks:
 *
 *   per email — someone grinding one known account. Tight, because a real person
 *               who has forgotten their password does not need fifty tries.
 *   per address — someone spraying one common password across many accounts,
 *               which never trips a per-email limit at all.
 *
 * Deliberately **fails open**. If the table is missing or D1 is unhappy, sign-in
 * still works. A rate limiter that locks every customer out of their own account
 * when its bookkeeping breaks has done more damage than the attack it prevents.
 */

const WINDOW_MS = 15 * 60_000
/** A person who has forgotten their password does not need more than this. */
const PER_EMAIL = 8
/** Generous: a whole crew can share one office address and one bad morning. */
const PER_IP = 40

export interface LimitVerdict {
  allowed: boolean
  /** Seconds until the caller may try again. Only set when blocked. */
  retryAfter?: number
}

/** Only ever counts failures — a correct password clears the bucket. */
export async function checkLoginRate(
  env: Env,
  email: string,
  ip: string | null,
): Promise<LimitVerdict> {
  const now = Date.now()
  const keys: [string, number][] = [[`email:${email.toLowerCase()}`, PER_EMAIL]]
  if (ip) keys.push([`ip:${ip}`, PER_IP])

  try {
    for (const [key, limit] of keys) {
      const row = await env.DB.prepare(
        'SELECT window_start, attempts FROM login_attempts WHERE id = ?1',
      )
        .bind(key)
        .first<{ window_start: number; attempts: number }>()

      if (!row) continue
      if (now - row.window_start >= WINDOW_MS) continue // stale window, ignore
      if (row.attempts >= limit) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((row.window_start + WINDOW_MS - now) / 1000)),
        }
      }
    }
  } catch (err) {
    // Fail open, loudly enough to notice in logs.
    console.error('rate limit check failed', err)
  }
  return { allowed: true }
}

export async function recordFailure(env: Env, email: string, ip: string | null): Promise<void> {
  const now = Date.now()
  const keys = [`email:${email.toLowerCase()}`, ...(ip ? [`ip:${ip}`] : [])]
  try {
    for (const key of keys) {
      // Upsert that also rolls the window: a row older than the window starts
      // over at one rather than inheriting a count from an hour ago.
      await env.DB.prepare(
        `INSERT INTO login_attempts (id, window_start, attempts) VALUES (?1, ?2, 1)
         ON CONFLICT(id) DO UPDATE SET
           window_start = CASE WHEN ?2 - login_attempts.window_start >= ?3
                               THEN ?2 ELSE login_attempts.window_start END,
           attempts     = CASE WHEN ?2 - login_attempts.window_start >= ?3
                               THEN 1 ELSE login_attempts.attempts + 1 END`,
      )
        .bind(key, now, WINDOW_MS)
        .run()
    }
  } catch (err) {
    console.error('rate limit record failed', err)
  }
}

/** A correct password means this was never an attack. Clear the buckets. */
export async function clearFailures(env: Env, email: string, ip: string | null): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM login_attempts WHERE id = ?1')
      .bind(`email:${email.toLowerCase()}`)
      .run()
    if (ip) {
      await env.DB.prepare('DELETE FROM login_attempts WHERE id = ?1').bind(`ip:${ip}`).run()
    }
  } catch (err) {
    console.error('rate limit clear failed', err)
  }
}
