import { randomId } from './auth'
import type { Env, SessionUser } from './types'

/**
 * The audit log.
 *
 * Written for the conversation that starts "I never did that". An admin can
 * reset a rep's password, hand their territory to someone else, change what they
 * are allowed to see, or delete them outright — and until this existed, none of
 * it left a trace. The first commission dispute is the wrong moment to discover
 * that, because the evidence cannot be created retroactively.
 *
 * Two decisions carry the weight:
 *
 * **Names are copied, not joined.** `actorName` and `targetLabel` are snapshots
 * taken at the moment of the action. The single most important entry in any
 * audit log is the one recording a deletion, and a join would render precisely
 * that entry as two nulls.
 *
 * **Recording never fails the operation.** If the log write throws, the action it
 * describes has already happened; refusing it afterwards would be a lie in the
 * other direction. The failure is logged loudly instead.
 */

export type AuditAction =
  | 'user.invited'
  | 'user.password_set'
  | 'user.reset_link'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.deleted'
  | 'user.role_changed'
  | 'user.invite_resent'
  | 'user.invite_revoked'
  /* Somebody made their own account with the company join code. */
  | 'user.joined'
  | 'company.join_code_rotated'
  | 'company.join_code_disabled'
  | 'user.profile_updated'
  | 'user.onboarding_completed'
  | 'user.onboarding_reset'
  | 'badge.issued'
  | 'badge.confirmed'
  | 'badge.renewed'
  | 'badge.regenerated'
  | 'user.team_changed'
  | 'user.title_changed'
  | 'team.created'
  | 'team.renamed'
  | 'team.deleted'
  | 'company.changed'
  | 'territory.assigned'
  | 'territory.unassigned'
  | 'territory.created'
  | 'territory.renamed'
  | 'territory.deleted'
  | 'list.created'
  | 'list.assigned'
  | 'list.archived'
  | 'list.restored'
  | 'list.deleted'
  | 'leads.imported'
  /*
    A status set from the office rather than earned at a door.

    Recorded because it is the only thing that tells the two apart. Every other
    status in the product has a visit behind it; these have a person who
    selected some rows. Six months later "why is this lead New when we sold it
    in March" has exactly one answer, and it is this row.
  */
  | 'leads.status_changed'
  | 'settings.changed'
  | 'settings.timezone'
  | 'integration.connected'
  | 'integration.disconnected'
  | 'geocoder.connected'
  | 'geocoder.disconnected'
  | 'geocoder.changed'
  /*
    Erasure. Kept in the audit log deliberately and permanently: the whole point
    of a destructive action with no undo is that somebody can afterwards say who
    did it, when, and why. This is the one record of an erased lead that
    survives, and it holds the address as it read at the time — an erasure nobody
    can identify afterwards cannot be checked by an auditor or by the customer.
  */
  | 'lead.erased'
  | 'leads.bulk_erased'
  | 'leads.unblocked'
  | 'leads.exported'

export interface AuditEntry {
  action: AuditAction
  targetType?:
    | 'user'
    | 'territory'
    | 'list'
    | 'import'
    | 'settings'
    | 'integration'
    | 'geocoder'
    | 'lead'
    | 'team'
    | 'company'
  targetId?: string
  /** The name as it read at the time. Never resolved later. */
  targetLabel?: string
  detail?: Record<string, unknown>
}

export async function record(
  env: Env,
  actor: SessionUser,
  entry: AuditEntry,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log
         (id, client_id, actor_id, actor_name, action, target_type, target_id, target_label, detail, at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(
        `au_${randomId(10)}`,
        actor.clientId,
        actor.id,
        actor.name,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.targetLabel ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        Date.now(),
      )
      .run()
  } catch (err) {
    // Never fails the caller: the thing being recorded already happened.
    console.error('audit write failed', entry.action, err)
  }
}

export interface AuditRow {
  id: string
  actorName: string
  action: string
  targetType?: string
  targetLabel?: string
  detail?: unknown
  at: number
}

/** Newest first. Capped — this is a review surface, not an export. */
export async function readAudit(
  env: Env,
  actor: SessionUser,
  opts: { limit?: number; before?: number } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 200)
  const before = opts.before ?? Number.MAX_SAFE_INTEGER

  const rows = await env.DB.prepare(
    `SELECT * FROM audit_log
      WHERE client_id = ?1 AND at < ?2
      ORDER BY at DESC LIMIT ?3`,
  )
    .bind(actor.clientId, before, limit)
    .all()

  return (rows.results as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    actorName: String(r.actor_name),
    action: String(r.action),
    targetType: r.target_type ? String(r.target_type) : undefined,
    targetLabel: r.target_label ? String(r.target_label) : undefined,
    detail: r.detail ? safeParse(String(r.detail)) : undefined,
    at: Number(r.at),
  }))
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
