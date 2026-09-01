import { baseFor, ghlFetch, isRetryable } from './ghl'
import {
  MAX_ATTEMPTS,
  backoffMs,
  linkIds,
  localIdFor,
  readGhlConfig,
  noteFailure,
  noteSuccess,
  remoteIdFor,
  tokenFor,
} from './integrations'
import type { Env } from './types'

/**
 * Emptying the outbox into a customer's CRM.
 *
 * The queue side of this is deliberately dumb: a rep's mutation writes a row and
 * returns. Everything that can be slow, fail, or need retrying happens here,
 * away from anyone standing on a doorstep.
 *
 * **What is verified and what is not.** The transport — base URL, `Version`
 * header, bearer auth, which HTTP statuses are worth retrying — is confirmed and
 * lives in `ghl.ts`. The request *shapes* below are not: GHL's documentation
 * hosts are unreachable from this build environment, so `contactBody` is written
 * from knowledge of their API rather than from their docs, and is marked as such
 * where it sits. That is a departure from the standard `ghl.ts` set for itself
 * and it is called out rather than hidden.
 *
 * It is a contained risk. A wrong shape produces a 4xx, `isRetryable` treats a
 * 4xx as permanent, and the row fails with GHL's own words recorded against the
 * customer's integration where an admin can read them. Nothing is silently
 * dropped and nothing is written incorrectly on their side. The first live send
 * against a real account — step 5 of connecting it — is what turns this from
 * probable into known.
 */

/** A send that never leaves, and why. Distinct from a send that failed. */
interface Unsendable {
  kind: 'unsendable'
  reason: string
}

/**
 * Not sendable *yet* — try again later.
 *
 * The distinction from `unsendable` is the whole point of having three outcomes
 * rather than two. An appointment cannot be booked until the lead it belongs to
 * exists in GoHighLevel, and a rep booking at the door queues both in the same
 * batch: the contact upsert and the appointment. The drain takes them in
 * `next_attempt_at` order, so roughly half the time the appointment is reached
 * first and the contact is not linked yet.
 *
 * Treated as `unsendable`, that failed permanently — an appointment silently
 * absent from the customer's calendar, for a condition that one tick of waiting
 * resolves. It retries instead, and the ordinary retry cap still stops it if the
 * contact genuinely never arrives.
 */
interface Deferred {
  kind: 'defer'
  reason: string
}

interface Sendable {
  kind: 'send'
  method: string
  path: string
  body: unknown
  /** Where to find the created id in the response, so the link can be written. */
  linkAs?: { kind: 'contact' | 'appointment'; localId: string }
}

type Plan = Sendable | Unsendable | Deferred

interface PropertyRow {
  id: string
  address1: string
  city: string | null
  state: string | null
  zip: string | null
  status: string
  score: number
  opportunity_value: number | null
  last_outcome: string | null
  name: string | null
  phone: string | null
  email: string | null
}

/**
 * The lead as GoHighLevel wants it.
 *
 * **Unverified against live GHL.** See the file header. `POST /contacts/upsert`
 * is used rather than a create because it is idempotent on phone or email, which
 * is what makes a retried send safe: the second attempt updates the contact the
 * first one made instead of leaving the customer with duplicates. That property
 * matters more than any individual field name here, and it is the one thing that
 * would be expensive to get wrong.
 *
 * The lead status travels as a tag. Pipeline stages are a per-account
 * configuration — the `config` column exists to map them — and inventing stage
 * ids for somebody else's pipeline would put leads in the wrong column of their
 * board. A tag is additive, visible, and wrong in a way anybody can see and undo.
 */
function contactBody(row: PropertyRow, locationId: string): Record<string, unknown> {
  const [first, ...rest] = (row.name ?? '').trim().split(/\s+/)
  return {
    locationId,
    firstName: first || undefined,
    lastName: rest.join(' ') || undefined,
    phone: row.phone || undefined,
    email: row.email || undefined,
    address1: row.address1,
    city: row.city || undefined,
    state: row.state || undefined,
    postalCode: row.zip || undefined,
    source: 'Allstar',
    /*
      Deduped: the derived status and the outcome that produced it are often the
      same word — an `appointment` outcome sets an `appointment` status — and
      sending `allstar-appointment` twice puts a visibly duplicated tag on the
      customer's contact record.
    */
    tags: [
      ...new Set(
        [`allstar-${row.status}`, row.last_outcome ? `allstar-${row.last_outcome}` : null].filter(
          (t): t is string => Boolean(t),
        ),
      ),
    ],
  }
}

/** What to send for one queued event, or why it can never be sent. */
async function plan(
  env: Env,
  clientId: string,
  event: string,
  payload: Record<string, unknown>,
  locationId: string,
): Promise<Plan> {
  if (event === 'contact.upsert') {
    const propertyId = typeof payload.propertyId === 'string' ? payload.propertyId : ''
    if (!propertyId) return { kind: 'unsendable', reason: 'no property id on the queued event' }

    /*
      Read at send time rather than trusting a snapshot taken when the rep acted.
      A burst of edits collapses to one queued row, and that row must send what is
      true now — not what was true at the first edit in the burst.
    */
    const row = await env.DB.prepare(
      `SELECT p.id, p.address1, p.city, p.state, p.zip, p.status, p.score,
              p.opportunity_value, p.last_outcome,
              c.name AS name, c.phone AS phone, c.email AS email
         FROM properties p
         LEFT JOIN contacts c
           ON c.property_id = p.id
          AND c.id = (SELECT id FROM contacts WHERE property_id = p.id
                       ORDER BY is_primary DESC, id LIMIT 1)
        WHERE p.id = ?1 AND p.client_id = ?2`,
    )
      .bind(propertyId, clientId)
      .first<PropertyRow>()

    if (!row) return { kind: 'unsendable', reason: 'that lead no longer exists' }

    /*
      GHL matches an upsert on phone or email. With neither there is nothing to
      match on, and sending anyway would create a fresh duplicate contact on every
      retry. Door-to-door lists are full of address-only rows, so this is the
      ordinary case rather than an edge one — it is dropped with a reason instead
      of retried into a mess.
    */
    if (!row.phone && !row.email) {
      return { kind: 'unsendable', reason: 'no phone or email, so there is nothing to match on' }
    }

    return {
      kind: 'send',
      method: 'POST',
      path: '/contacts/upsert',
      body: contactBody(row, locationId),
      linkAs: { kind: 'contact', localId: propertyId },
    }
  }

  if (event === 'appointment.create') {
    const appointmentId = typeof payload.appointmentId === 'string' ? payload.appointmentId : ''
    const propertyId = typeof payload.propertyId === 'string' ? payload.propertyId : ''
    if (!appointmentId) return { kind: 'unsendable', reason: 'no appointment id on the queued event' }

    const { calendarId } = await readGhlConfig(env, clientId)

    /*
      Reachable only for a row queued while a calendar *was* configured and then
      cleared — `queueForCrm` refuses to queue appointments without one, so this
      is no longer the ordinary case it used to be. Still a permanent failure:
      nothing about waiting supplies a calendar nobody has named.
    */
    if (!calendarId) {
      return {
        kind: 'unsendable',
        reason: 'no GoHighLevel calendar is configured, so there is nowhere to book this',
      }
    }

    const contactRemoteId = propertyId
      ? await remoteIdFor(env, clientId, 'contact', propertyId)
      : null
    if (!contactRemoteId) {
      return {
        kind: 'defer',
        reason: 'waiting for the lead itself to reach GoHighLevel first',
      }
    }

    const appt = await env.DB.prepare(
      `SELECT starts_at, duration_min, title FROM appointments WHERE id = ?1 AND client_id = ?2`,
    )
      .bind(appointmentId, clientId)
      .first<{ starts_at: number; duration_min: number; title: string }>()
    if (!appt) return { kind: 'unsendable', reason: 'that appointment no longer exists' }

    return {
      kind: 'send',
      method: 'POST',
      path: '/calendars/events/appointments',
      body: {
        calendarId,
        locationId,
        contactId: contactRemoteId,
        title: appt.title,
        startTime: new Date(appt.starts_at).toISOString(),
        endTime: new Date(appt.starts_at + appt.duration_min * 60_000).toISOString(),
      },
      linkAs: { kind: 'appointment', localId: appointmentId },
    }
  }

  return { kind: 'unsendable', reason: `unknown event "${event}"` }
}

/**
 * Record the mapping, and treat a collision as news rather than a failure.
 *
 * `integration_links` is unique in both directions on purpose: without that, two
 * of our properties could each claim the same GHL contact and an inbound webhook
 * would have no single answer to "which lead is this?". That invariant is worth
 * keeping.
 *
 * But a collision here is an ordinary event, not a bug. GHL matches an upsert on
 * phone or email, so two properties sharing a phone number — a landlord with
 * several houses, or the same household twice in a purchased list — come back
 * with the *same* contact id. Door-to-door data is full of both.
 *
 * The send succeeded when that happens: the contact is in their CRM, correctly.
 * Only our mapping is ambiguous, and the first claim keeps it. So this returns a
 * note instead of throwing — before this existed, the raw
 * `UNIQUE constraint failed` propagated, the row retried five times against a
 * condition no amount of waiting changes, and then failed permanently with a
 * D1 error message in front of the admin. Found by deliberately removing the
 * no-phone guard and watching two leads collide on one mock contact id.
 */
async function link(
  env: Env,
  clientId: string,
  linkAs: NonNullable<Sendable['linkAs']>,
  remoteId: string,
): Promise<string | null> {
  try {
    await linkIds(env, clientId, linkAs.kind, linkAs.localId, remoteId)
    return null
  } catch (err) {
    if (!/UNIQUE constraint/i.test(err instanceof Error ? err.message : String(err))) throw err
    const owner = await localIdFor(env, clientId, linkAs.kind, remoteId)
    if (owner === linkAs.localId) return null
    return `sent, but GoHighLevel matched this to the same contact as ${owner ?? 'another lead'} — they share a phone or email, so the link stays with the first`
  }
}

/** The id GHL gave the thing we just created, wherever they put it. */
function remoteIdFrom(data: unknown): string | null {
  const d = data as Record<string, any> | undefined
  return d?.contact?.id ?? d?.id ?? d?.appointment?.id ?? d?.event?.id ?? null
}

export interface DrainReport {
  claimed: number
  sent: number
  retrying: number
  failed: number
}

/**
 * Send what is due, once.
 *
 * Bounded on purpose. A Worker invocation has a wall-clock budget and a customer
 * who reconnects after a week offline could have thousands of rows waiting;
 * draining "everything" would time out part-way and leave no record of how far
 * it got. A capped batch that runs again is slower and always finishes.
 *
 * One failing customer must not stop another's queue, so each row is handled
 * independently and a thrown error is recorded against that row rather than
 * ending the run.
 */
export async function drainOutbox(
  env: Env,
  opts: { clientId?: string; limit?: number } = {},
): Promise<DrainReport> {
  const limit = Math.min(opts.limit ?? 25, 100)
  const now = Date.now()
  const report: DrainReport = { claimed: 0, sent: 0, retrying: 0, failed: 0 }

  const due = await env.DB.prepare(
    `SELECT id, client_id, event, payload, attempts
       FROM integration_outbox
      WHERE status = 'pending'
        AND next_attempt_at <= ?1
        AND (?2 IS NULL OR client_id = ?2)
      ORDER BY next_attempt_at
      LIMIT ?3`,
  )
    .bind(now, opts.clientId ?? null, limit)
    .all<{ id: string; client_id: string; event: string; payload: string; attempts: number }>()

  const rows = due.results ?? []
  report.claimed = rows.length

  /** Token lookups are per-customer; a batch is usually one customer's work. */
  const tokens = new Map<string, { token: string; locationId: string } | null>()

  const fail = async (id: string, reason: string) => {
    await env.DB.prepare(
      `UPDATE integration_outbox SET status = 'failed', last_error = ?2 WHERE id = ?1`,
    )
      .bind(id, reason.slice(0, 300))
      .run()
    report.failed += 1
  }

  const retry = async (id: string, attempts: number, reason: string) => {
    const next = attempts + 1
    if (next >= MAX_ATTEMPTS) {
      await fail(id, `${reason} (gave up after ${next} attempts)`)
      return
    }
    await env.DB.prepare(
      `UPDATE integration_outbox
          SET attempts = ?2, next_attempt_at = ?3, last_error = ?4
        WHERE id = ?1`,
    )
      .bind(id, next, Date.now() + backoffMs(next), reason.slice(0, 300))
      .run()
    report.retrying += 1
  }

  for (const row of rows) {
    try {
      if (!tokens.has(row.client_id)) tokens.set(row.client_id, await tokenFor(env, row.client_id))
      const cred = tokens.get(row.client_id)

      /*
        No usable credential is not a permanent failure of this row. The customer
        may have disconnected mid-queue, or the encryption key may be absent from
        this deployment — both are recoverable, and the work should still be here
        when they are fixed.
      */
      if (!cred) {
        await retry(row.id, row.attempts, 'no usable GoHighLevel credential right now')
        continue
      }

      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>
      } catch {
        await fail(row.id, 'the queued payload is not readable')
        continue
      }

      const step = await plan(env, row.client_id, row.event, payload, cred.locationId)
      if (step.kind === 'unsendable') {
        // Never retried: nothing about waiting makes it sendable.
        await fail(row.id, step.reason)
        continue
      }
      if (step.kind === 'defer') {
        // Waiting genuinely fixes this one, and the retry cap still applies, so
        // a lead that never arrives does not queue forever.
        await retry(row.id, row.attempts, step.reason)
        continue
      }

      const res = await ghlFetch(cred.token, step.path, {
        method: step.method,
        body: step.body,
        base: baseFor(env),
      })

      if (res.ok) {
        const remoteId = remoteIdFrom(res.data)
        // Written before the row is marked sent. If this call is the one that
        // dies, the row retries and the upsert is idempotent — whereas a lost
        // link would mean never knowing which of their records is ours.
        const note = remoteId && step.linkAs ? await link(env, row.client_id, step.linkAs, remoteId) : null
        await env.DB.prepare(
          `UPDATE integration_outbox SET status = 'sent', sent_at = ?2, last_error = ?3 WHERE id = ?1`,
        )
          .bind(row.id, Date.now(), note)
          .run()
        await noteSuccess(env, row.client_id)
        report.sent += 1
        continue
      }

      const reason = res.error ?? `GoHighLevel returned ${res.status}`
      if (isRetryable(res.status)) {
        await noteFailure(env, row.client_id, reason, false)
        await retry(row.id, row.attempts, reason)
      } else {
        /*
          Fatal only for the statuses that mean the credential itself is wrong.
          A 400 means we sent something they refused — our bug, one row, and
          flipping the customer's integration to "broken" over it would train
          them to ignore the indicator that exists for a revoked token.
        */
        await noteFailure(env, row.client_id, reason, res.status === 401 || res.status === 403)
        await fail(row.id, reason)
      }
    } catch (err) {
      // One row's surprise must not end the run for every other customer.
      await retry(row.id, row.attempts, err instanceof Error ? err.message : 'send failed')
    }
  }

  return report
}
