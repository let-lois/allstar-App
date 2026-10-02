import type { Env } from './types'

/**
 * Making failures visible.
 *
 * Until now an unhandled error did two things: returned a generic 500, and wrote
 * a stack trace to `console.error` where nobody would ever read it. The practical
 * consequence is that you find out about an outage from a phone call.
 *
 * Two changes fix most of that without adding a vendor:
 *
 * **Every request carries an id**, returned on the response and quoted in the
 * error the user sees. "Something went wrong" is unactionable; "something went
 * wrong, reference 7f3a91" turns a support message into a log query.
 *
 * **Logs are structured**, one JSON object per line, so Cloudflare's Workers Logs
 * can filter on `level`, `status` and `route` instead of on substrings of a
 * stack trace. Reaching for Sentry later is then a matter of forwarding these
 * same objects rather than re-instrumenting.
 */

export interface RequestContext {
  id: string
  method: string
  route: string
  started: number
  /** Who, once the session is known — for the error log, never the response. */
  clientId?: string
  userId?: string
  /** What the request was doing, in words ("leads.import"), and over how many records. */
  operation?: string
  records?: number
}

/** Short enough to read aloud over a phone, long enough not to collide in a day. */
export function newRequestId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Path with the variable parts removed, so that ten thousand photo fetches
 * aggregate into one route rather than ten thousand.
 */
export function routeOf(path: string): string {
  return path
    .replace(/^\/api\/users\/[^/]+/, '/api/users/:id')
    .replace(/^\/api\/photos\/[^/]+/, '/api/photos/:id')
    .replace(/^\/invite\/[^/]+/, '/invite/:token')
}

type Level = 'info' | 'warn' | 'error'

function emit(level: Level, ctx: RequestContext, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    requestId: ctx.id,
    method: ctx.method,
    route: ctx.route,
    ms: Date.now() - ctx.started,
    ...fields,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Called for every response. Only failures are logged at warn or error — logging
 * every 200 turns the log into a stream nobody reads, which is the same problem
 * as logging nothing.
 */
export function logResponse(ctx: RequestContext, status: number, extra: Record<string, unknown> = {}): void {
  if (status >= 500) emit('error', ctx, { status, ...extra })
  else if (status === 429 || status === 403) emit('warn', ctx, { status, ...extra })
}

export function logUnhandled(ctx: RequestContext, err: unknown): void {
  emit('error', ctx, {
    status: 500,
    unhandled: true,
    message: err instanceof Error ? err.message : String(err),
    // The stack is the whole reason this exists; keep it on the same line so a
    // log viewer shows it with its context rather than three entries apart.
    stack: err instanceof Error ? err.stack : undefined,
  })
}

/**
 * A rolling count of recent failures, so /api/health can answer "is it broken
 * right now" without a log query.
 *
 * Per-isolate and therefore approximate — it undercounts across a fleet and
 * resets when an isolate recycles. That is stated rather than hidden: it's a
 * smoke alarm, not an accounting record, and a non-zero value is worth a look
 * while a zero proves nothing.
 */
const recent: number[] = []
const WINDOW_MS = 15 * 60_000

export function noteFailure(): void {
  const now = Date.now()
  recent.push(now)
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift()
  if (recent.length > 500) recent.splice(0, recent.length - 500)
}

export function recentFailures(): { count: number; windowMinutes: number; approximate: true } {
  const now = Date.now()
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift()
  return { count: recent.length, windowMinutes: WINDOW_MS / 60_000, approximate: true }
}

/** Response headers every reply carries, so an id exists even on a success. */
export function traceHeaders(ctx: RequestContext): Record<string, string> {
  return { 'x-request-id': ctx.id }
}

export type { Env }
