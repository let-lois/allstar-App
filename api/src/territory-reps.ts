import type { Env, SessionUser } from './types'

/**
 * The reps on a territory.
 *
 * `territory_reps` is the truth about who walks a patch — any number of people
 * per territory, any number of territories per person. `territories.rep_id`
 * is a mirror of the first of them, kept because an import inherits it for
 * the leads it drops into a drawn shape and because older clients read it.
 * Every write here keeps the mirror in step, so nothing that reads the old
 * column sees a territory with reps and no `rep_id`.
 */

const chunks = <T,>(xs: T[], n = 100): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Territory id → rep ids, oldest assignment first, for one tenant. */
export async function territoryRepsFor(env: Env, clientId: string): Promise<Map<string, string[]>> {
  const res = await env.DB.prepare(
    `SELECT r.territory_id, r.user_id FROM territory_reps r
       JOIN territories t ON t.id = r.territory_id
      WHERE t.client_id = ?1
      ORDER BY r.assigned_at, r.user_id`,
  )
    .bind(clientId)
    .all<{ territory_id: string; user_id: string }>()
  const out = new Map<string, string[]>()
  for (const row of res.results) {
    const list = out.get(row.territory_id)
    if (list) list.push(row.user_id)
    else out.set(row.territory_id, [row.user_id])
  }
  return out
}

/** The reps on one territory, oldest assignment first. */
export async function repsOf(env: Env, territoryId: string): Promise<string[]> {
  const res = await env.DB.prepare(
    'SELECT user_id FROM territory_reps WHERE territory_id = ?1 ORDER BY assigned_at, user_id',
  )
    .bind(territoryId)
    .all<{ user_id: string }>()
  return res.results.map((r) => r.user_id)
}

/** Add reps to a territory. Already-present rows are left alone. */
export async function writeTerritoryReps(
  env: Env,
  actor: SessionUser,
  territoryId: string,
  repIds: string[],
  now: number,
): Promise<void> {
  for (const part of chunks(repIds)) {
    const values = part.map((_, n) => `(?1, ?${n + 4}, ?2, ?3)`).join(',')
    await env.DB.prepare(
      `INSERT OR IGNORE INTO territory_reps (territory_id, user_id, assigned_at, assigned_by) VALUES ${values}`,
    )
      .bind(territoryId, now, actor.id, ...part)
      .run()
  }
}

export async function removeTerritoryRep(env: Env, territoryId: string, repId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM territory_reps WHERE territory_id = ?1 AND user_id = ?2')
    .bind(territoryId, repId)
    .run()
}

export async function clearTerritoryReps(env: Env, territoryId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM territory_reps WHERE territory_id = ?1').bind(territoryId).run()
}

/**
 * Keep `territories.rep_id` equal to the first rep on the patch, or null.
 * Returns the reps as they stand, so a caller can answer with them.
 */
export async function syncPrimaryRep(env: Env, clientId: string, territoryId: string): Promise<string[]> {
  const reps = await repsOf(env, territoryId)
  await env.DB.prepare('UPDATE territories SET rep_id = ?1 WHERE id = ?2 AND client_id = ?3')
    .bind(reps[0] ?? null, territoryId, clientId)
    .run()
  return reps
}

/** Ids that are members of this company and active. */
export async function activeTeamMembers(env: Env, clientId: string, ids: string[]): Promise<Set<string>> {
  const ok = new Set<string>()
  for (const part of chunks(ids)) {
    const holes = part.map((_, n) => `?${n + 2}`).join(',')
    const res = await env.DB.prepare(
      `SELECT id FROM users WHERE client_id = ?1 AND active = 1 AND id IN (${holes})`,
    )
      .bind(clientId, ...part)
      .all<{ id: string }>()
    for (const r of res.results) ok.add(r.id)
  }
  return ok
}

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

/** A list of ids from a request body: strings only, de-duplicated, shape-checked. */
export const cleanRepIds = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_SHAPE.test(x)))]
    : []
