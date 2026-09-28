import type { Env, SessionUser } from './types'
import { record } from './audit'
import { canImport } from './import'
import {
  clearTerritoryReps,
  removeTerritoryRep,
  repsOf,
  syncPrimaryRep,
  writeTerritoryReps,
} from './territory-reps'

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
  /** The reps on the territory after this call; absent for the unassigned bucket. */
  repIds?: string[]
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

/**
 * Put a rep on a territory, take one off, or clear it.
 *
 * A territory holds any number of reps (`territory_reps`), and this never
 * takes a house away from anybody by accident:
 *
 *   `add` (the default) puts `repId` on the patch alongside whoever is already
 *   there. Leads inside that nobody is working are handed to them only when
 *   they are now the patch's sole rep — the single-rep behaviour this call
 *   always had. On a shared patch the houses stay unclaimed and every rep on
 *   it can see them.
 *
 *   `remove` takes `repId` off the patch. Houses they were working keep their
 *   `assigned_rep_id`: who walks a house and which patch it belongs to are two
 *   facts, and the console has a per-lead control for the first.
 *
 *   `repId: null` clears the patch — every rep off it, every house in it back
 *   to nobody. This is the "Unassigned" choice, and it is deliberate: it is the
 *   one action here that does take houses away, and it says so.
 *
 * `territoryId: null` is the unassigned bucket — every lead with no territory —
 * which has no reps to speak of, only houses, so there `repId` still means
 * "hand all of these to this person".
 */
export async function assignTerritory(
  env: Env,
  actor: SessionUser,
  input: { territoryId: string | null; repId: string | null; action?: 'add' | 'remove' },
): Promise<AssignResult | { error: string; status: number }> {
  if (!canImport(actor)) return { error: 'Not permitted.', status: 403 }

  if (input.repId) {
    const rep = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND client_id = ?2 AND active = 1',
    )
      .bind(input.repId, actor.clientId)
      .first<{ id: string }>()
    if (!rep) return { error: 'That person is not on this team.', status: 400 }
  }

  const now = Date.now()

  /* --- the unassigned bucket: houses only ---------------------------------- */
  if (!input.territoryId) {
    const result = await env.DB.prepare(
      `UPDATE properties SET assigned_rep_id = ?1, updated_at = ?2
        WHERE client_id = ?3 AND territory_id IS NULL`,
    )
      .bind(input.repId, now, actor.clientId)
      .run()
    const assigned = result.meta.changes ?? 0
    await record(env, actor, {
      action: 'territory.assigned',
      targetType: 'territory',
      targetLabel: 'Unassigned leads',
      detail: { repId: input.repId, leads: assigned },
    })
    return { assigned }
  }

  const territory = await env.DB.prepare(
    'SELECT id FROM territories WHERE id = ?1 AND client_id = ?2',
  )
    .bind(input.territoryId, actor.clientId)
    .first<{ id: string }>()
  if (!territory) return { error: 'No such territory.', status: 404 }

  let assigned = 0
  const action = input.repId ? (input.action === 'remove' ? 'remove' : 'add') : 'clear'

  if (action === 'clear') {
    await clearTerritoryReps(env, input.territoryId)
    const result = await env.DB.prepare(
      `UPDATE properties SET assigned_rep_id = NULL, updated_at = ?1
        WHERE client_id = ?2 AND territory_id = ?3`,
    )
      .bind(now, actor.clientId, input.territoryId)
      .run()
    assigned = result.meta.changes ?? 0
  } else if (action === 'remove') {
    await removeTerritoryRep(env, input.territoryId, input.repId!)
  } else {
    await writeTerritoryReps(env, actor, input.territoryId, [input.repId!], now)
    const reps = await repsOf(env, input.territoryId)
    if (reps.length === 1) {
      const result = await env.DB.prepare(
        `UPDATE properties SET assigned_rep_id = ?1, updated_at = ?2
          WHERE client_id = ?3 AND territory_id = ?4 AND assigned_rep_id IS NULL`,
      )
        .bind(input.repId, now, actor.clientId, input.territoryId)
        .run()
      assigned = result.meta.changes ?? 0
    }
  }

  const repIds = await syncPrimaryRep(env, actor.clientId, input.territoryId)

  await record(env, actor, {
    action: action === 'remove' ? 'territory.unassigned' : 'territory.assigned',
    targetType: 'territory',
    targetId: input.territoryId,
    detail: { repId: input.repId, leads: assigned, reps: repIds.length, action },
  })
  return { assigned, repIds }
}
