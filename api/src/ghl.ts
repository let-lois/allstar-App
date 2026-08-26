/**
 * The GoHighLevel HTTP surface.
 *
 * Everything provider-specific lives here, so the rest of the integration —
 * credential storage, the id-link table, the outbox — knows nothing about GHL
 * and would serve a second CRM without being rewritten.
 *
 * **What is verified and what is not.** The base URL, the `Version` header and
 * the two authentication models below are confirmed. The exact request and
 * response shapes for contacts, opportunities and calendars are *not* — GHL's
 * own documentation hosts are unreachable from the build environment, so those
 * were left out rather than guessed at. They arrive with the events that need
 * them, once the docs can be read. Nothing in this file invents an endpoint it
 * has not been able to check.
 *
 * **Auth.** Two models, and which one a deployment uses is a business decision
 * rather than a technical one:
 *
 *   Private Integration Token — a static bearer token the customer generates
 *     inside their own sub-account, scoped to the permissions they choose. No
 *     refresh cycle, no marketplace review, works today. This is what a native
 *     integration uses.
 *   OAuth 2.0 — required to list in GHL's marketplace and to install across
 *     many sub-accounts at once. Adds a refresh cycle and their review process.
 *
 * The schema carries columns for both; only the first is implemented.
 */

export const GHL_BASE = 'https://services.leadconnectorhq.com'

/**
 * Not optional, and the most commonly missed part of calling this API.
 *
 * GHL pins endpoint behaviour to this header. Omitting it does not produce a
 * clear "missing version" error — it produces failures that read like malformed
 * requests, which is a bad afternoon for whoever debugs it next.
 */
export const GHL_VERSION = '2021-07-28'

/**
 * Where requests go, unless a deployment says otherwise.
 *
 * `GHL_BASE_URL` overrides it. That exists so the integration can be exercised
 * end to end against a stand-in — the gate for this runs a local mock and
 * asserts real HTTP behaviour rather than a stubbed function — and so a
 * deployment could be pointed at a sandbox. It is a Worker variable, settable
 * only by whoever deploys, and it defaults to production when unset.
 */
export function baseFor(env: { GHL_BASE_URL?: string }): string {
  return env.GHL_BASE_URL || GHL_BASE
}

export interface GhlResult<T = unknown> {
  ok: boolean
  status: number
  data?: T
  /** Safe to show an admin. Never contains the token. */
  error?: string
}

/**
 * One request, with the failure modes named.
 *
 * The distinction that matters to a caller is between "your credential is
 * wrong" (which a human must fix, and which should stop us retrying) and
 * "GHL is having a moment" (which retrying fixes on its own). Collapsing those
 * two into a generic failure means either hammering a dead credential forever
 * or giving up on a blip.
 */
export async function ghlFetch<T = unknown>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string>; base?: string } = {},
): Promise<GhlResult<T>> {
  const url = new URL(`${init.base || GHL_BASE}${path}`)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
  } catch (err) {
    // Network-level: never reached GHL at all. Always worth retrying.
    return { ok: false, status: 0, error: `Could not reach GoHighLevel: ${String(err)}` }
  }

  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }

  if (res.ok) return { ok: true, status: res.status, data: data as T }

  return { ok: false, status: res.status, error: describe(res.status, data, text) }
}

/** Whether a failure is worth trying again, or needs a human. */
export function isRetryable(status: number): boolean {
  // 0 is "never reached them". 429 is rate limiting — back off, don't give up.
  if (status === 0 || status === 429) return true
  // 401/403 mean the token is wrong or under-scoped; retrying cannot fix it.
  if (status === 401 || status === 403) return false
  // 4xx generally means we sent something they refused. Our bug, not a blip.
  if (status >= 400 && status < 500) return false
  return true
}

/**
 * A message an admin can act on.
 *
 * Deliberately does not pass GHL's raw body through to the console. It can echo
 * request content, and request content here includes the customer's own contact
 * data — which does not belong on a settings screen that a manager can see.
 */
function describe(status: number, data: unknown, raw: string): string {
  const message =
    data && typeof data === 'object' && 'message' in data
      ? String((data as { message: unknown }).message)
      : ''

  if (status === 401) return 'GoHighLevel rejected the token. It may have been revoked or regenerated.'
  if (status === 403) {
    return message.slice(0, 200) || 'The token is missing a permission this action needs.'
  }
  if (status === 404) {
    return 'GoHighLevel has no record with that ID. Check the location ID is the sub-account you meant.'
  }
  if (status === 429) return 'GoHighLevel is rate limiting us. It will be retried.'
  if (status >= 500) return `GoHighLevel returned ${status}. It will be retried.`
  return message.slice(0, 200) || `GoHighLevel returned ${status}: ${raw.slice(0, 120)}`
}

/**
 * Does this credential actually work?
 *
 * Asked when an admin connects an account, so the answer arrives while they are
 * still looking at the screen and holding the token they just pasted — rather
 * than as silent failures in a queue three days later.
 *
 * `GET /locations/{id}` is the cheapest read that proves three things at once:
 * the token is valid, it is scoped to something, and it can see the sub-account
 * the admin named. A token for the wrong sub-account is the mistake this
 * actually catches — it looks exactly like a working connection otherwise.
 */
export async function ping(
  token: string,
  locationId: string,
  base?: string,
): Promise<GhlResult<{ location?: { id?: string; name?: string } }>> {
  return ghlFetch(token, `/locations/${encodeURIComponent(locationId)}`, { base })
}
