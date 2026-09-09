import { record } from './audit'
import { canImport } from './import'
import { queueForCrm } from './integrations'
import type { Env, SessionUser } from './types'

/**
 * Editing leads in bulk from the office.
 *
 * The daily complaint this answers: a list comes back from a canvass, or a
 * street turns out to be rentals, or a vendor file was mis-scored, and somebody
 * has four hundred leads to move. Doing that one lead at a time is not a
 * workflow, it is a reason to stop using the product.
 *
 * ## Why this is office-only, and reps still record outcomes
 *
 * A rep cannot set a status by hand anywhere in this app: they record what
 * happened at the door and the status follows. That is what makes every status
 * answerable — there is a visit behind it, with a time, usually a note, and a
 * position. This endpoint is the deliberate exception, and it is deliberately
 * not on a phone. An office correcting a batch is doing bookkeeping about a list;
 * a rep at a door is reporting a fact. Letting the second one edit a status
 * directly would make the first indistinguishable from the second.
 *
 * So the audit row is not decoration here. It is the only thing that
 * distinguishes a bulk correction from four hundred visits nobody made.
 */

/** The statuses the office may set. */
const SETTABLE = new Set([
  'new',
  'contacted',
  'follow_up',
  'working',
  'appointment',
  'quoted',
  'won',
  'lost',
  'dnc',
])

export interface StatusResult {
  updated: number
  /** Selected leads left alone because they carry a Do Not Contact. */
  protectedDnc: number
}

export async function setLeadStatus(
  env: Env,
  actor: SessionUser,
  input: { propertyIds: string[]; status: string },
): Promise<StatusResult | { error: string; status: number }> {
  if (!canImport(actor)) return { error: 'Not permitted.', status: 403 }

  const status = String(input.status ?? '')
  if (!SETTABLE.has(status)) return { error: 'Not a lead status.', status: 400 }

  const ids = Array.isArray(input.propertyIds) ? input.propertyIds.filter(Boolean) : []
  if (ids.length === 0) return { error: 'No leads selected.', status: 400 }
  // The same ceiling as assignment, for the same reason: one request must not be
  // able to rewrite a whole tenant.
  if (ids.length > 500) return { error: 'Select at most 500 leads.', status: 413 }

  const now = Date.now()
  let updated = 0
  const changed: string[] = []

  /*
    Do Not Contact is never overwritten, and this is the rule the whole endpoint
    is shaped around.

    Once a household has asked a rep to stop, nothing may quietly undo that —
    not a re-import, not a GoHighLevel webhook, and least of all somebody
    selecting four hundred rows and setting them to New. It would be silent: the
    lead would look ordinary again, its Do Not Contact history buried, and the
    next rep on that street would knock. The exception is setting `dnc` itself,
    which is the one direction that is always safe.

    Enforced in the `WHERE` clause rather than by filtering ids beforehand. A
    pre-filter is a read followed by a write, and a household marked between the
    two would be missed; a predicate cannot be raced.
  */
  const guard = status === 'dnc' ? '' : "AND status != 'dnc'"

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const holes = chunk.map((_, n) => `?${n + 4}`).join(',')
    // Returning the ids rather than counting them: the CRM queue below needs to
    // know *which* leads moved, and a count cannot say.
    const res = await env.DB.prepare(
      `UPDATE properties SET status = ?1, updated_at = ?2
        WHERE client_id = ?3 AND id IN (${holes}) ${guard}
        RETURNING id`,
    )
      .bind(status, now, actor.clientId, ...chunk)
      .all<{ id: string }>()
    const rows = res.results ?? []
    updated += rows.length
    for (const r of rows) changed.push(r.id)
  }

  /*
    How many were held back, worked out rather than guessed.

    An id that matched nothing and an id protected by Do Not Contact are
    different facts, and the office needs the second one said out loud — "380 of
    400 updated" with no reason is a support ticket. Counted with a second query
    against the ids that did not move, so a lead belonging to another tenant is
    not reported as protected.
  */
  let protectedDnc = 0
  if (status !== 'dnc') {
    const moved = new Set(changed)
    const missed = ids.filter((id) => !moved.has(id))
    for (let i = 0; i < missed.length; i += 100) {
      const chunk = missed.slice(i, i + 100)
      const holes = chunk.map((_, n) => `?${n + 2}`).join(',')
      const res = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM properties
          WHERE client_id = ?1 AND status = 'dnc' AND id IN (${holes})`,
      )
        .bind(actor.clientId, ...chunk)
        .first<{ n: number }>()
      protectedDnc += Number(res?.n ?? 0)
    }
  }

  /*
    Pushed to the CRM the same way a rep's outcome is.

    One queued upsert per lead, which for a 500-row change is 500 rows in the
    outbox. That is deliberate rather than overlooked: the drain is bounded and
    retries per row, so a partial failure costs the rows that failed instead of
    the batch. It does mean a large correction spends a large number of CRM
    calls, which is worth an operator knowing before they select everything.
  */
  for (const id of changed) {
    await queueForCrm(env, actor.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
  }

  await record(env, actor, {
    action: 'leads.status_changed',
    targetType: 'lead',
    targetLabel: `${updated} lead${updated === 1 ? '' : 's'} → ${status}`,
    detail: { status, requested: ids.length, updated, protectedDnc },
  })

  return { updated, protectedDnc }
}
