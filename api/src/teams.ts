import { randomId } from './auth'
import { record } from './audit'
import { canInvite } from './invites'
import type { Env, SessionUser } from './types'

/**
 * Teams and offices.
 *
 * "Austin", "North crew", "Commercial". A name, owned by a company, that a
 * person can belong to. It appears on their badge and it is what the roster
 * filters by — which is why it is a row and not a text field: two reps who
 * typed "Austin" and "austin " are one team, not two.
 *
 * Who may manage them follows the rest of account administration: the admins
 * (`canInvite`). Managers see teams and filter by them; they do not rename the
 * office. Every signed-in person may *read* the list — a rep's own badge names
 * their team, and the field roster shows who is on which.
 *
 * Deleting a team never deletes a person. `users.team_id` is ON DELETE SET
 * NULL, and it is set explicitly here as well, so a database with foreign keys
 * off would come to the same answer.
 */

export interface TeamDTO {
  id: string
  name: string
  memberCount: number
  createdAt: number
}

type Failure = { error: string; status: number }
const fail = (error: string, status: number): Failure => ({ error, status })

export const MAX_TEAM_NAME = 60
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/

function cleanName(input: unknown): string | Failure {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : ''
  if (!name) return fail('A team needs a name.', 400)
  if (name.length > MAX_TEAM_NAME) return fail(`Keep the name under ${MAX_TEAM_NAME} characters.`, 400)
  return name
}

export async function listTeams(env: Env, clientId: string): Promise<TeamDTO[]> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, t.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS member_count
       FROM teams t
      WHERE t.client_id = ?1
      ORDER BY lower(t.name)`,
  )
    .bind(clientId)
    .all<{ id: string; name: string; created_at: number; member_count: number }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: Number(r.member_count),
    createdAt: Number(r.created_at),
  }))
}

export async function createTeam(
  env: Env,
  actor: SessionUser,
  input: { name?: unknown },
): Promise<TeamDTO | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  const name = cleanName(input.name)
  if (typeof name !== 'string') return name

  const id = `t_${randomId(8)}`
  const now = Date.now()
  try {
    await env.DB.prepare(
      'INSERT INTO teams (id, client_id, name, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(id, actor.clientId, name, now)
      .run()
  } catch (err) {
    // The unique index on (client, lower(name)) is the dedupe; the message says
    // what the person meant rather than what SQLite said.
    if (/UNIQUE/i.test(String(err))) return fail(`There is already a team called “${name}”.`, 409)
    throw err
  }

  await record(env, actor, {
    action: 'team.created',
    targetType: 'team',
    targetId: id,
    targetLabel: name,
  })
  return { id, name, memberCount: 0, createdAt: now }
}

export async function renameTeam(
  env: Env,
  actor: SessionUser,
  teamId: string,
  input: { name?: unknown },
): Promise<TeamDTO | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  if (!ID_SHAPE.test(teamId)) return fail('No such team.', 404)
  const name = cleanName(input.name)
  if (typeof name !== 'string') return name

  const before = await env.DB.prepare(
    'SELECT name, created_at FROM teams WHERE id = ?1 AND client_id = ?2',
  )
    .bind(teamId, actor.clientId)
    .first<{ name: string; created_at: number }>()
  // Not found rather than forbidden: whether an id exists in another company
  // is not something this account gets to learn.
  if (!before) return fail('No such team.', 404)

  try {
    await env.DB.prepare('UPDATE teams SET name = ?3 WHERE id = ?1 AND client_id = ?2')
      .bind(teamId, actor.clientId, name)
      .run()
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return fail(`There is already a team called “${name}”.`, 409)
    throw err
  }

  await record(env, actor, {
    action: 'team.renamed',
    targetType: 'team',
    targetId: teamId,
    targetLabel: name,
    detail: { from: before.name, to: name },
  })
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE team_id = ?1')
    .bind(teamId)
    .first<{ n: number }>()
  return { id: teamId, name, memberCount: Number(count?.n ?? 0), createdAt: Number(before.created_at) }
}

export async function deleteTeam(
  env: Env,
  actor: SessionUser,
  teamId: string,
): Promise<{ ok: true; unassigned: number } | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)
  if (!ID_SHAPE.test(teamId)) return fail('No such team.', 404)

  const team = await env.DB.prepare('SELECT name FROM teams WHERE id = ?1 AND client_id = ?2')
    .bind(teamId, actor.clientId)
    .first<{ name: string }>()
  if (!team) return fail('No such team.', 404)

  // People first, then the team. Explicit, and in one batch: nobody is left
  // pointing at a team that no longer exists whatever the FK pragma says.
  const [unassigned] = await env.DB.batch([
    env.DB.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?1 AND client_id = ?2').bind(
      teamId,
      actor.clientId,
    ),
    env.DB.prepare('DELETE FROM teams WHERE id = ?1 AND client_id = ?2').bind(teamId, actor.clientId),
  ])

  await record(env, actor, {
    action: 'team.deleted',
    targetType: 'team',
    targetId: teamId,
    targetLabel: team.name,
    detail: { unassigned: unassigned?.meta.changes ?? 0 },
  })
  return { ok: true, unassigned: unassigned?.meta.changes ?? 0 }
}
