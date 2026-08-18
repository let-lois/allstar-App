import type { Env, SessionUser } from './types'
import { record } from './audit'
import { canImport } from './import'

/**
 * Territory assignment.
 *
 * Bulk by territory rather than per property, because that's the unit the work
 * is actually organised in: a manager hands someone a patch, not four hundred
 * individual doors. Reassigning a rep who quits is one action, and it has to be.
 *
 * The unassigned bucket is addressable too — `territoryId: null` means "every
 * lead that isn't in a territory yet", which after a plain import is all of
 * them. Without that, a first import would be unassignable except by
 * re-importing, which is a workaround dressed up as a feature.
 */

export interface AssignResult {
  assigned: number
}

/**
 * Assign specific leads rather than a whole patch.
 *
 * Territory-level assignment is the common case, but the one that comes up
 * daily is moving a handful of houses — a rep is off sick, one street belongs
 * with the next patch over, a customer asked for a different person. Without
 * this the only route to that is re-importing, which is a workaround dressed as
 * a feature.
 */
export async function assignProperties(
  env: Env,
  actor: SessionUser,
  input: { propertyIds: string[]; repId: string | null },
): Promise<AssignResult | { error: string; status: number }> {
  if (!canImport(actor)) return { error: 'Not permitted.', status: 403 }

  const ids = Array.isArray(input.propertyIds) ? input.propertyIds.filter(Boolean) : []
  if (ids.length === 0) return { error: 'No leads selected.', status: 400 }
  // Bounded so one request can't be made to rewrite a whole tenant.
  if (ids.length > 500) return { error: 'Select at most 500 leads.', status: 413 }

  if (input.repId) {
    const rep = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND client_id = ?2 AND active = 1',
    )
      .bind(input.repId, actor.clientId)
      .first<{ id: string }>()
    if (!rep) return { error: 'That person is not on this team.', status: 400 }
  }

  const now = Date.now()
  let assigned = 0
  // Chunked because SQLite caps bound parameters per statement. The client_id
  // predicate is what keeps this inside the tenant — an id from anywhere else
  // simply matches nothing rather than being trusted.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const placeholders = chunk.map((_, n) => `?${n + 4}`).join(',')
    const res = await env.DB.prepare(
      `UPDATE properties SET assigned_rep_id = ?1, updated_at = ?2
        WHERE client_id = ?3 AND id IN (${placeholders})`,
    )
      .bind(input.repId, now, actor.clientId, ...chunk)
      .run()
    assigned += res.meta.changes ?? 0
  }

  await record(env, actor, {
    action: 'territory.assigned',
    targetType: 'territory',
    targetLabel: `${assigned} selected lead${assigned === 1 ? '' : 's'}`,
    detail: { repId: input.repId, leads: assigned, selection: true },
  })

  return { assigned }
}

export async function assignTerritory(
  env: Env,
  actor: SessionUser,
  input: { territoryId: string | null; repId: string | null },
): Promise<AssignResult | { error: string; status: number }> {
  if (!canImport(actor)) return { error: 'Not permitted.', status: 403 }

  // A rep from another tenant would silently hand this company's leads to a
  // stranger. Every id crossing this boundary is checked against the tenant.
  if (input.repId) {
    const rep = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND client_id = ?2 AND active = 1',
    )
      .bind(input.repId, actor.clientId)
      .first<{ id: string }>()
    if (!rep) return { error: 'That person is not on this team.', status: 400 }
  }

  if (input.territoryId) {
    const territory = await env.DB.prepare(
      'SELECT id FROM territories WHERE id = ?1 AND client_id = ?2',
    )
      .bind(input.territoryId, actor.clientId)
      .first<{ id: string }>()
    if (!territory) return { error: 'No such territory.', status: 404 }
  }

  const now = Date.now()
  const result = input.territoryId
    ? await env.DB.prepare(
        `UPDATE properties SET assigned_rep_id = ?1, updated_at = ?2
          WHERE client_id = ?3 AND territory_id = ?4`,
      )
        .bind(input.repId, now, actor.clientId, input.territoryId)
        .run()
    : await env.DB.prepare(
        `UPDATE properties SET assigned_rep_id = ?1, updated_at = ?2
          WHERE client_id = ?3 AND territory_id IS NULL`,
      )
        .bind(input.repId, now, actor.clientId)
        .run()

  // Keep the territory's own owner in step, so the next import into it inherits
  // the same rep rather than quietly reverting to whoever created it.
  if (input.territoryId) {
    await env.DB.prepare('UPDATE territories SET rep_id = ?1 WHERE id = ?2 AND client_id = ?3')
      .bind(input.repId, input.territoryId, actor.clientId)
      .run()
  }

  const assigned = result.meta.changes ?? 0

  // Who now owns which doors is the second question any commission dispute
  // asks, right after who recorded the sale.
  await record(env, actor, {
    action: 'territory.assigned',
    targetType: 'territory',
    targetId: input.territoryId ?? undefined,
    targetLabel: input.territoryId ? undefined : 'Unassigned leads',
    detail: { repId: input.repId, leads: assigned },
  })

  return { assigned }
}
