import { record } from './audit'
import { baseFor, ping } from './ghl'
import { NoIntegrationKey, open, seal, tokenHint } from './secretbox'
import type { Env, SessionUser } from './types'

/**
 * Connecting a company's own CRM.
 *
 * This file is the part that is not GoHighLevel: storing a credential, mapping
 * our ids to theirs, and queuing work for a system that will sometimes be down.
 * `ghl.ts` is the only thing that knows what GoHighLevel is.
 *
 * Three rules shape it, and each one is here because of a specific way this
 * kind of integration goes wrong.
 *
 * **A token is never returned.** Not to the console, not in an error, not in
 * the audit log. An admin can see that a connection exists and the last four
 * characters of the token behind it; that is enough to tell two tokens apart
 * and useless to anyone who steals the response. It is also why connecting is a
 * write-only operation — there is no "edit" that pre-fills the field.
 *
 * **Ids are mapped, never inferred.** Every record we create over there gets a
 * row in `integration_links`. Matching on an address or an email at send time
 * instead would mean a retry after a timeout — where the write succeeded and
 * the response was lost — creates a second contact. Doing that to a customer's
 * CRM is the failure that ends an integration's reputation, and it is silent.
 *
 * **Nothing is sent inline.** A rep's phone syncing a morning of work must
 * never wait on a third party's API. Work is queued and drained separately, so
 * GHL being slow costs a delay in their CRM rather than a delay in the field.
 */

export type Provider = 'ghl'
export type LinkKind = 'contact' | 'opportunity' | 'appointment'

/** Who may connect or disconnect a company's CRM. */
export function canManageIntegrations(user: SessionUser): boolean {
  return user.role === 'client_admin' || user.role === 'super_admin'
}

/* --- what the console is allowed to know ---------------------------------- */

export interface IntegrationStatus {
  provider: Provider
  connected: boolean
  locationId?: string
  /** `••••abcd`. Enough to tell two tokens apart, useless to a thief. */
  tokenHint?: string
  status?: string
  lastOkAt?: number
  lastError?: string
  lastErrorAt?: number
  config?: Record<string, unknown>
}

export async function readIntegration(
  env: Env,
  clientId: string,
  provider: Provider = 'ghl',
): Promise<IntegrationStatus> {
  const row = await env.DB.prepare(
    `SELECT access_token, location_id, config, status, last_ok_at, last_error, last_error_at
       FROM client_integrations WHERE client_id = ?1 AND provider = ?2`,
  )
    .bind(clientId, provider)
    .first<{
      access_token: string
      location_id: string | null
      config: string
      status: string
      last_ok_at: number | null
      last_error: string | null
      last_error_at: number | null
    }>()

  if (!row) return { provider, connected: false }

  /*
    The hint is derived by decrypting and re-masking rather than being stored
    alongside the token. Storing it would mean a plaintext fragment of the
    credential sitting in the same dump the encryption exists to defend against
    — small, but there is no reason to pay it.
  */
  const token = await open(env, row.access_token)

  return {
    provider,
    connected: true,
    locationId: row.location_id ?? undefined,
    tokenHint: token ? tokenHint(token) : undefined,
    // A row whose token will not decrypt is connected in name only. Saying so
    // is better than reporting a healthy connection that silently sends nothing.
    status: token ? row.status : 'unreadable',
    lastOkAt: row.last_ok_at ?? undefined,
    lastError: token ? (row.last_error ?? undefined) : 'The stored credential could not be read. Reconnect the account.',
    lastErrorAt: row.last_error_at ?? undefined,
    config: safeParse(row.config),
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/* --- connecting ------------------------------------------------------------ */

export interface ConnectInput {
  token: string
  locationId: string
}

export type ConnectResult =
  | { ok: true; status: IntegrationStatus; locationName?: string }
  | { ok: false; error: string; status: number }

/**
 * Store a credential, but only after proving it works.
 *
 * The verify-then-store order is deliberate. A stored credential that has never
 * been exercised is a connection that looks healthy on the settings screen and
 * fails in a queue days later, by which point nobody associates the two. Asking
 * GHL first means a mistyped token is an error message while the admin is still
 * holding the token.
 *
 * The mistake this really catches is the right token against the wrong
 * sub-account. That is indistinguishable from a working connection until
 * somebody notices their leads landing in another client's CRM.
 */
export async function connectIntegration(
  env: Env,
  user: SessionUser,
  input: ConnectInput,
  provider: Provider = 'ghl',
): Promise<ConnectResult> {
  const token = input.token.trim()
  const locationId = input.locationId.trim()

  if (!token) return { ok: false, error: 'A token is required.', status: 400 }
  if (!locationId) return { ok: false, error: 'A location ID is required.', status: 400 }

  const probe = await ping(token, locationId, baseFor(env))
  if (!probe.ok) {
    return {
      ok: false,
      // Already scrubbed of anything sensitive by ghl.ts.
      error: probe.error ?? 'GoHighLevel refused the connection.',
      /*
        A 404 here is the admin's typo, not GoHighLevel's outage: a valid token
        pointed at a sub-account it cannot see. It used to be reported as a 502,
        which told the one person who could fix it that somebody else's system
        was broken. Only a genuine upstream failure is a gateway error.
      */
      status: probe.status === 401 || probe.status === 403 || probe.status === 404 ? 400 : 502,
    }
  }

  let sealed: string
  try {
    sealed = await seal(env, token)
  } catch (err) {
    if (err instanceof NoIntegrationKey) {
      /*
        Refusing is the right answer. The alternative is storing the token in
        plaintext "just for now", and a deployment that does that never gets
        noticed until the dump leaks.
      */
      return {
        ok: false,
        error:
          'This deployment cannot store credentials securely yet — INTEGRATION_KEY is not set. Nothing was saved.',
        status: 503,
      }
    }
    throw err
  }

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO client_integrations
       (client_id, provider, auth_type, access_token, location_id, config, status,
        last_ok_at, last_error, last_error_at, created_at, updated_at)
     VALUES (?1,?2,'pit',?3,?4,'{}','active',?5,NULL,NULL,?5,?5)
     ON CONFLICT(client_id, provider) DO UPDATE SET
       access_token  = excluded.access_token,
       location_id   = excluded.location_id,
       auth_type     = excluded.auth_type,
       status        = 'active',
       last_ok_at    = excluded.last_ok_at,
       last_error    = NULL,
       last_error_at = NULL,
       updated_at    = excluded.updated_at`,
  )
    .bind(user.clientId, provider, sealed, locationId, now)
    .run()

  await record(env, user, {
    action: 'integration.connected',
    targetType: 'integration',
    targetId: provider,
    targetLabel: provider.toUpperCase(),
    // The location id is not a secret and is the thing worth having in a log:
    // "which sub-account did we start writing to, and when". The token is not
    // here, and must never be.
    detail: { locationId },
  })

  const data = probe.data as { location?: { name?: string } } | undefined
  return { ok: true, status: await readIntegration(env, user.clientId, provider), locationName: data?.location?.name }
}

/**
 * Disconnect.
 *
 * The credential row goes; the link table stays.
 *
 * That asymmetry is on purpose. A company that disconnects and reconnects a
 * week later — or who disconnects to rotate a token — must not have every one
 * of their leads treated as new on the next sync. Keeping the mapping means a
 * reconnect resumes; dropping it means duplicating their entire database into
 * their CRM. Queued work is dropped, because sending it after an explicit
 * disconnect is exactly what the admin just said not to do.
 */
export async function disconnectIntegration(
  env: Env,
  user: SessionUser,
  provider: Provider = 'ghl',
): Promise<{ ok: true; dropped: number }> {
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM integration_outbox
      WHERE client_id = ?1 AND provider = ?2 AND status = 'pending'`,
  )
    .bind(user.clientId, provider)
    .first<{ n: number }>()

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM client_integrations WHERE client_id = ?1 AND provider = ?2`,
    ).bind(user.clientId, provider),
    env.DB.prepare(
      `DELETE FROM integration_outbox WHERE client_id = ?1 AND provider = ?2 AND status = 'pending'`,
    ).bind(user.clientId, provider),
  ])

  await record(env, user, {
    action: 'integration.disconnected',
    targetType: 'integration',
    targetId: provider,
    targetLabel: provider.toUpperCase(),
    detail: { droppedQueued: pending?.n ?? 0 },
  })

  return { ok: true, dropped: pending?.n ?? 0 }
}

/* --- id mapping ------------------------------------------------------------ */

/** Their id for one of ours, if we have ever created it. */
export async function remoteIdFor(
  env: Env,
  clientId: string,
  kind: LinkKind,
  localId: string,
  provider: Provider = 'ghl',
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT remote_id FROM integration_links
      WHERE client_id = ?1 AND provider = ?2 AND kind = ?3 AND local_id = ?4`,
  )
    .bind(clientId, provider, kind, localId)
    .first<{ remote_id: string }>()
  return row?.remote_id ?? null
}

/** Ours for one of theirs — the lookup an inbound webhook needs. */
export async function localIdFor(
  env: Env,
  clientId: string,
  kind: LinkKind,
  remoteId: string,
  provider: Provider = 'ghl',
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT local_id FROM integration_links
      WHERE client_id = ?1 AND provider = ?2 AND kind = ?3 AND remote_id = ?4`,
  )
    .bind(clientId, provider, kind, remoteId)
    .first<{ local_id: string }>()
  return row?.local_id ?? null
}

/**
 * Record that these two are the same thing.
 *
 * Idempotent in both directions, which is what makes a retried send safe: the
 * second attempt finds the link the first one wrote and updates rather than
 * creating a second record over there.
 */
export async function linkIds(
  env: Env,
  clientId: string,
  kind: LinkKind,
  localId: string,
  remoteId: string,
  provider: Provider = 'ghl',
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO integration_links
       (client_id, provider, kind, local_id, remote_id, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?6)
     ON CONFLICT(client_id, provider, kind, local_id) DO UPDATE SET
       remote_id  = excluded.remote_id,
       updated_at = excluded.updated_at`,
  )
    .bind(clientId, provider, kind, localId, remoteId, now)
    .run()
}

/* --- the queue ------------------------------------------------------------- */

/** Roughly 1m, 5m, 25m, 2h, 10h — a day of trying, then a human is needed. */
export const MAX_ATTEMPTS = 5
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 5 ** attempts, 12 * 3_600_000)
}

export interface QueuedEvent {
  event: string
  payload: unknown
  /**
   * Optional. Two pending events sharing one collapse into a single send.
   *
   * A rep who corrects an outcome three times in a minute should cost the
   * customer's API quota once, and the last correction is the one that is true.
   */
  dedupeKey?: string
}

/**
 * Queue work for a customer's CRM — if they have one.
 *
 * Returns false for a client with nothing connected, which is the overwhelmingly
 * common case and must be cheap: this sits in the path of every mutation a
 * phone syncs, and most companies will never connect anything.
 */
export async function enqueue(
  env: Env,
  clientId: string,
  item: QueuedEvent,
  provider: Provider = 'ghl',
): Promise<boolean> {
  const connected = await env.DB.prepare(
    `SELECT 1 AS ok FROM client_integrations
      WHERE client_id = ?1 AND provider = ?2 AND status = 'active'`,
  )
    .bind(clientId, provider)
    .first<{ ok: number }>()
  if (!connected) return false

  const now = Date.now()
  const id = `io_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

  /*
    The dedupe index is partial — unique only over pending rows — so an event
    that has already been sent never blocks a later one for the same entity.
    `DO UPDATE` rather than `DO NOTHING`: when two edits collapse, the newer
    payload is the one that should survive, and its attempt counter resets
    because it is genuinely new work.
  */
  await env.DB.prepare(
    `INSERT INTO integration_outbox
       (id, client_id, provider, event, payload, dedupe_key, status, attempts, next_attempt_at, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,'pending',0,?7,?7)
     ON CONFLICT(client_id, provider, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending'
     DO UPDATE SET
       payload         = excluded.payload,
       event           = excluded.event,
       attempts        = 0,
       last_error      = NULL,
       next_attempt_at = excluded.next_attempt_at`,
  )
    .bind(id, clientId, provider, item.event, JSON.stringify(item.payload), item.dedupeKey ?? null, now)
    .run()

  return true
}

export interface QueueDepth {
  pending: number
  failed: number
  oldestPendingAt?: number
}

/**
 * What is waiting, for the settings screen.
 *
 * A queue is the part of an integration that fails invisibly, so the number of
 * things stuck in it belongs where the person who can fix it will see it —
 * next to the connection they would have to repair.
 */
export async function queueDepth(
  env: Env,
  clientId: string,
  provider: Provider = 'ghl',
): Promise<QueueDepth> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
       MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest
     FROM integration_outbox WHERE client_id = ?1 AND provider = ?2`,
  )
    .bind(clientId, provider)
    .first<{ pending: number | null; failed: number | null; oldest: number | null }>()

  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    oldestPendingAt: row?.oldest ?? undefined,
  }
}

/**
 * The decrypted token for a client, or null.
 *
 * Deliberately not exported through any route. Everything that needs a token
 * runs inside the Worker; nothing outside it ever holds one.
 */
export async function tokenFor(
  env: Env,
  clientId: string,
  provider: Provider = 'ghl',
): Promise<{ token: string; locationId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT access_token, location_id FROM client_integrations
      WHERE client_id = ?1 AND provider = ?2 AND status = 'active'`,
  )
    .bind(clientId, provider)
    .first<{ access_token: string; location_id: string | null }>()
  if (!row?.location_id) return null

  const token = await open(env, row.access_token)
  if (!token) return null
  return { token, locationId: row.location_id }
}

/**
 * Remember that a send failed, so the settings screen can say so.
 *
 * Marking the connection itself broken is reserved for the errors a human has
 * to fix — a revoked token, a missing scope. A 500 from GHL is their problem
 * and clears itself; flipping the customer's integration to "broken" every time
 * the other end hiccups would train them to ignore the indicator.
 */
export async function noteFailure(
  env: Env,
  clientId: string,
  error: string,
  fatal: boolean,
  provider: Provider = 'ghl',
): Promise<void> {
  await env.DB.prepare(
    `UPDATE client_integrations
        SET last_error = ?3, last_error_at = ?4, status = ?5
      WHERE client_id = ?1 AND provider = ?2`,
  )
    .bind(clientId, provider, error.slice(0, 300), Date.now(), fatal ? 'broken' : 'active')
    .run()
}

export async function noteSuccess(
  env: Env,
  clientId: string,
  provider: Provider = 'ghl',
): Promise<void> {
  await env.DB.prepare(
    `UPDATE client_integrations
        SET last_ok_at = ?3, last_error = NULL, last_error_at = NULL, status = 'active'
      WHERE client_id = ?1 AND provider = ?2`,
  )
    .bind(clientId, provider, Date.now())
    .run()
}

/* --- what the app pushes, and the promise it makes to the rep ------------- */

/**
 * The events this app sends outward, as a closed set.
 *
 * A string union rather than free-form text so a typo becomes a compile error
 * instead of a row that queues forever and drains into nothing — the outbox
 * would accept `contct.upsert` quite happily and no one would find out until a
 * customer asked why their CRM was empty.
 */
export type CrmEvent = 'contact.upsert' | 'appointment.create'

/**
 * Queue an event for a customer's CRM, and never fail the rep's sync doing it.
 *
 * This is called from inside `applyOne`, and `applyMutations` treats a throw
 * from there as the mutation being **rejected** — it releases the idempotency
 * claim and hands the phone back an error. So a CRM queue write that failed
 * would not merely lose a CRM update: it would tell a rep standing on a doorstep
 * that their visit did not save, and the phone would retry the whole mutation.
 *
 * That trade is never worth making. The rep's work is the product; the CRM copy
 * is a convenience for the office. So every failure here is swallowed and
 * reported, and the visit is saved either way.
 *
 * `enqueue` already returns false rather than throwing for the ordinary case —
 * a company with no CRM connected — which is most of them. This exists for the
 * genuine failures underneath that: the database refusing the write, a
 * constraint nobody anticipated.
 */
export async function queueForCrm(
  env: Env,
  clientId: string,
  event: CrmEvent,
  payload: unknown,
  dedupeKey?: string,
): Promise<void> {
  try {
    await enqueue(env, clientId, { event, payload, dedupeKey })
  } catch (err) {
    /*
      Logged, not rethrown, and deliberately not written to `client_integrations`
      either — that row is the *connection's* health, and a failure to queue is
      ours. Recording it there would show an admin a broken CRM when what is
      broken is us.
    */
    console.error('crm queue failed', {
      clientId,
      event,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
