import type { RequestContext } from './observe'
import type { Env, SessionUser } from './types'

/**
 * Failed requests, where an administrator can read them.
 *
 * The person who hit the failure sees one sentence and a reference
 * ("Import failed. Reference: ERR-7f3a91c2"). This keeps the rest: when, who,
 * which endpoint, what they were doing and over how many records, and the
 * error's message. Not the stack and not the request body — those stay in the
 * Worker's own log (`observe.ts`), because this table is read in the console
 * and a stack trace or a pasted CSV row is not something to put on a screen.
 *
 * Best-effort by design: a failure to write here must never turn into a second
 * failure for the request it is describing.
 */
export async function persistError(env: Env, ctx: RequestContext, status: number, message: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO error_log (id, client_id, user_id, at, method, route, status, operation, records, message, ms)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
      .bind(
        ctx.id,
        ctx.clientId ?? null,
        ctx.userId ?? null,
        Date.now(),
        ctx.method,
        ctx.route,
        status,
        ctx.operation ?? null,
        Number.isFinite(ctx.records) ? ctx.records : null,
        message.slice(0, 500),
        Date.now() - ctx.started,
      )
      .run()
  } catch {
    // The table may not exist yet on a database mid-migration; the Worker log has it.
  }
}

export interface ErrorEntry {
  reference: string
  at: number
  userId: string | null
  userName: string | null
  method: string | null
  route: string | null
  status: number
  operation: string | null
  records: number | null
  message: string | null
  ms: number | null
}

/** The company's recent failures, newest first. Office roles only (checked at the route). */
export async function readErrors(env: Env, user: SessionUser, limit = 100): Promise<ErrorEntry[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)))
  const res = await env.DB.prepare(
    `SELECT e.*, u.name AS user_name FROM error_log e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.client_id = ?1
      ORDER BY e.at DESC LIMIT ?2`,
  )
    .bind(user.clientId, n)
    .all<Record<string, unknown>>()
  return (res.results ?? []).map((r) => ({
    reference: String(r.id),
    at: Number(r.at),
    userId: (r.user_id as string) ?? null,
    userName: (r.user_name as string) ?? null,
    method: (r.method as string) ?? null,
    route: (r.route as string) ?? null,
    status: Number(r.status),
    operation: (r.operation as string) ?? null,
    records: r.records == null ? null : Number(r.records),
    message: (r.message as string) ?? null,
    ms: r.ms == null ? null : Number(r.ms),
  }))
}
