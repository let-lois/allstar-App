import { record } from './audit'
import { inside, parseBoundary, parsePolygon } from './territories'
import type { Env, Role, SessionUser } from './types'

/**
 * Lead lists — a working set of leads, with the reps who work it.
 *
 * "Monday Route", "Follow Ups", "Northwest Territory – Sept 10". A lead can be on
 * several at once; a list can be handed to several reps at once. That is the
 * whole reason this is not a territory: a territory is *whose ground is this*,
 * one rep to a patch, and it drives where an import lands and what coverage
 * counts. Changing its cardinality to get a working set out of it would have
 * meant rewriting a gated pipeline for a feature it was never shaped for. So
 * the two coexist, and the schema note says which is which.
 *
 * ## Who may do what
 *
 * Two levels, and the line between them is the one the rest of the app already
 * draws for imports and assignment:
 *
 *   **Anyone** may make a list of their own over leads they can already see,
 *   rename it, add and remove leads, archive it. A rep organising their own
 *   week is exactly what "Monday Route" is.
 *
 *   **Managers** (the import roles) may additionally draw a list round an area
 *   — which claims leads across the whole tenant, not just theirs — and assign
 *   reps to a list. Both hand a rep leads they did not have before, which is a
 *   thing only a manager gets to do.
 *
 * ## What a rep can see, and why this file decides it
 *
 * A rep's bootstrap used to be `assigned_rep_id = me`, full stop. Assigning a
 * list to three reps means all three need those leads on their phones, and a
 * lead has one `assigned_rep_id`. So the scope becomes "assigned to me, OR in a
 * live list assigned to me" — and the predicate lives here, once, as SQL that
 * both the bootstrap and the membership checks use. Two copies of a visibility
 * rule is how one of them ends up wider than the other.
 *
 * Tenant isolation is enforced per write, as everywhere else: every id crossing
 * in is checked against `client_id`, because ids are client-generated and a
 * buggy or hostile client will send one that belongs to somebody else.
 */

const MANAGER_ROLES: Role[] = ['super_admin', 'client_admin', 'manager']

/** Draw a list round an area, or hand a list to reps. The office roles. */
export function canManageLists(user: SessionUser): boolean {
  return MANAGER_ROLES.includes(user.role)
}

const isRep = (u: SessionUser) => u.role === 'field_rep'

/**
 * The SQL that says whether a rep may see a property.
 *
 * `alias` is the properties table's alias in the enclosing query; `param` is the
 * placeholder holding the rep's id. Three ways in: the house is assigned to
 * them, it is on a live list handed to them, or it sits in a territory they are
 * on (`territory_reps`). Archived lists confer nothing — a list a manager has
 * put away must not keep leads on a phone.
 */
export function repScopeSql(alias: string, param: string): string {
  return `(${alias}.assigned_rep_id = ${param} OR ${alias}.id IN (
    SELECT m.property_id FROM lead_list_members m
      JOIN lead_list_reps r ON r.list_id = m.list_id
      JOIN lead_lists l ON l.id = m.list_id
     WHERE r.user_id = ${param} AND l.archived = 0)
   OR ${alias}.territory_id IN (
    SELECT tr.territory_id FROM territory_reps tr WHERE tr.user_id = ${param}))`
}

export interface LeadListDTO {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  boundary?: { lat: number; lng: number }[]
  archived: boolean
  createdAt: number
  updatedAt: number
  leadIds: string[]
  repIds: string[]
}

type Failure = { error: string; status: number }

const MAX_NAME = 120
const MAX_DESCRIPTION = 500
/** Client-generated ids are accepted from the offline path; this is their shape. */
const ID_SHAPE = /^[A-Za-z0-9_-]{6,40}$/

const newId = () => `ll_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

const chunks = <T,>(xs: T[], n = 100): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/* --- reading ---------------------------------------------------------------- */

/**
 * The lists this person can see, with their members and reps.
 *
 * Managers see every list in the tenant, archived ones included — they are the
 * only people who can bring one back. A rep sees the lists assigned to them and
 * the ones they made, live only. Members and reps come from two more queries
 * grouped here rather than one join, because a list of four hundred houses
 * handed to three people is 1,200 joined rows for 403 facts.
 */
export async function listsFor(env: Env, user: SessionUser): Promise<LeadListDTO[]> {
  const rows = isRep(user)
    ? await env.DB.prepare(
        `SELECT l.* FROM lead_lists l
          WHERE l.client_id = ?1 AND l.archived = 0
            AND (l.created_by = ?2 OR l.id IN (SELECT list_id FROM lead_list_reps WHERE user_id = ?2))
          ORDER BY l.name`,
      )
        .bind(user.clientId, user.id)
        .all<Record<string, unknown>>()
    : await env.DB.prepare(`SELECT * FROM lead_lists WHERE client_id = ?1 ORDER BY archived, name`)
        .bind(user.clientId)
        .all<Record<string, unknown>>()

  const lists = rows.results
  if (lists.length === 0) return []

  const ids = lists.map((l) => String(l.id))
  const members = new Map<string, string[]>()
  const reps = new Map<string, string[]>()
  for (const part of chunks(ids)) {
    const holes = part.map((_, n) => `?${n + 1}`).join(',')
    const [m, r] = await Promise.all([
      env.DB.prepare(`SELECT list_id, property_id FROM lead_list_members WHERE list_id IN (${holes})`)
        .bind(...part)
        .all<{ list_id: string; property_id: string }>(),
      env.DB.prepare(`SELECT list_id, user_id FROM lead_list_reps WHERE list_id IN (${holes})`)
        .bind(...part)
        .all<{ list_id: string; user_id: string }>(),
    ])
    for (const row of m.results) (members.get(row.list_id) ?? members.set(row.list_id, []).get(row.list_id)!).push(row.property_id)
    for (const row of r.results) (reps.get(row.list_id) ?? reps.set(row.list_id, []).get(row.list_id)!).push(row.user_id)
  }

  return lists.map((l) => ({
    id: String(l.id),
    name: String(l.name),
    description: (l.description as string | null) ?? null,
    createdBy: (l.created_by as string | null) ?? null,
    boundary: parseBoundary(l.boundary),
    archived: Number(l.archived) === 1,
    createdAt: Number(l.created_at),
    updatedAt: Number(l.updated_at),
    leadIds: members.get(String(l.id)) ?? [],
    repIds: reps.get(String(l.id)) ?? [],
  }))
}

async function loadList(env: Env, clientId: string, id: string) {
  return env.DB.prepare('SELECT * FROM lead_lists WHERE id = ?1 AND client_id = ?2')
    .bind(id, clientId)
    .first<{ id: string; name: string; created_by: string | null; archived: number }>()
}

/**
 * May this person change this list at all?
 *
 * Owner or manager. An assigned rep works a list; they do not reshape it — that
 * is the manager's job, and letting a rep drop a house from a list they were
 * handed would make "I gave you forty doors" mean thirty-nine by lunchtime.
 */
const mayEdit = (user: SessionUser, list: { created_by: string | null }) =>
  canManageLists(user) || list.created_by === user.id

/* --- writing ---------------------------------------------------------------- */

/**
 * Which of these property ids may this person put on a list?
 *
 * Managers: anything in the tenant. Reps: anything in their scope. Returns the
 * ids that passed, so a mixed batch adds what it may and reports the rest,
 * rather than refusing forty houses over one stray id.
 */
async function permittedProperties(env: Env, user: SessionUser, ids: string[]): Promise<Set<string>> {
  const ok = new Set<string>()
  for (const part of chunks(ids)) {
    const holes = part.map((_, n) => `?${n + 3}`).join(',')
    const scope = isRep(user) ? `AND ${repScopeSql('p', '?2')}` : ''
    const res = await env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.client_id = ?1 ${scope} AND p.id IN (${holes})`,
    )
      .bind(user.clientId, user.id, ...part)
      .all<{ id: string }>()
    for (const r of res.results) ok.add(r.id)
  }
  return ok
}

async function teamMembers(env: Env, clientId: string, ids: string[]): Promise<Set<string>> {
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

const cleanIds = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_SHAPE.test(x)))] : []

export interface CreateListInput {
  id?: unknown
  name?: unknown
  description?: unknown
  propertyIds?: unknown
  repIds?: unknown
  boundary?: unknown
}

export interface CreateListResult {
  list: LeadListDTO
  /** Leads that were asked for and not added — outside the tenant, or outside a rep's scope. */
  skipped: number
}

/**
 * Make a list.
 *
 * Three ways to say which leads: an explicit set of ids, an outline to draw
 * round, or both. The outline is manager-only, because it claims leads across
 * the tenant; explicit ids are checked against what the caller may see.
 */
export async function createList(
  env: Env,
  actor: SessionUser,
  input: CreateListInput,
): Promise<CreateListResult | Failure> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { error: 'Give the list a name.', status: 400 }
  if (name.length > MAX_NAME) return { error: 'That name is too long.', status: 400 }
  const description =
    typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESCRIPTION) : null

  const wantsArea = input.boundary !== undefined && input.boundary !== null
  const repIds = cleanIds(input.repIds)
  if ((wantsArea || repIds.length) && !canManageLists(actor)) {
    return { error: 'Only a manager can draw a list round an area or assign it to reps.', status: 403 }
  }

  let boundary: { lat: number; lng: number }[] | null = null
  if (wantsArea) {
    const parsed = parsePolygon(input.boundary)
    if ('error' in parsed) return parsed
    boundary = parsed.boundary
  }

  /*
    A client-generated id is accepted so a list made offline keeps the id the
    phone already gave it — the same rule as every other row in this system. It
    must not collide: an id that already exists is a retry of a mutation that
    already applied, and the outbox treats that as a duplicate, not a failure.
  */
  const requestedId = typeof input.id === 'string' && ID_SHAPE.test(input.id) ? input.id : null
  if (requestedId) {
    const existing = await loadList(env, actor.clientId, requestedId)
    if (existing) {
      const [only] = (await listsFor(env, actor)).filter((l) => l.id === requestedId)
      if (only) return { list: only, skipped: 0 }
      return { error: 'That list id is already taken.', status: 409 }
    }
  }

  const clash = await env.DB.prepare(
    'SELECT id FROM lead_lists WHERE client_id = ?1 AND archived = 0 AND lower(name) = lower(?2)',
  )
    .bind(actor.clientId, name)
    .first<{ id: string }>()
  if (clash) return { error: 'A list already has that name.', status: 409 }

  // Reps to assign — each checked against the tenant before anything is written.
  if (repIds.length) {
    const team = await teamMembers(env, actor.clientId, repIds)
    const stranger = repIds.find((r) => !team.has(r))
    if (stranger) return { error: 'That person is not on this team.', status: 400 }
  }

  // Leads: the explicit ones the caller may see, plus everything inside the area.
  const asked = cleanIds(input.propertyIds)
  const permitted = asked.length ? await permittedProperties(env, actor, asked) : new Set<string>()
  const memberIds = new Set<string>([...permitted])
  if (boundary) {
    const rows = await env.DB.prepare('SELECT id, lat, lng FROM properties WHERE client_id = ?1')
      .bind(actor.clientId)
      .all<{ id: string; lat: number; lng: number }>()
    for (const p of rows.results) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && inside(p, boundary)) memberIds.add(p.id)
    }
  }

  const id = requestedId ?? newId()
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO lead_lists (id, client_id, name, description, created_by, boundary, archived, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,0,?7,?7)`,
  )
    .bind(id, actor.clientId, name, description, actor.id, boundary ? JSON.stringify(boundary) : null, now)
    .run()

  await writeMembers(env, actor, id, [...memberIds], now)
  await writeReps(env, actor, id, repIds, now)

  await record(env, actor, {
    action: 'list.created',
    targetType: 'list',
    targetId: id,
    targetLabel: name,
    detail: { leads: memberIds.size, reps: repIds.length, drawn: !!boundary },
  })

  const [list] = (await listsFor(env, actor)).filter((l) => l.id === id)
  return { list: list!, skipped: asked.length - permitted.size }
}

async function writeMembers(env: Env, actor: SessionUser, listId: string, ids: string[], now: number) {
  for (const part of chunks(ids)) {
    const values = part.map((_, n) => `(?1, ?${n + 4}, ?2, ?3)`).join(',')
    await env.DB.prepare(
      `INSERT OR IGNORE INTO lead_list_members (list_id, property_id, added_at, added_by) VALUES ${values}`,
    )
      .bind(listId, now, actor.id, ...part)
      .run()
  }
}

async function writeReps(env: Env, actor: SessionUser, listId: string, ids: string[], now: number) {
  for (const part of chunks(ids)) {
    const values = part.map((_, n) => `(?1, ?${n + 4}, ?2, ?3)`).join(',')
    await env.DB.prepare(
      `INSERT OR IGNORE INTO lead_list_reps (list_id, user_id, assigned_at, assigned_by) VALUES ${values}`,
    )
      .bind(listId, now, actor.id, ...part)
      .run()
  }
}

/** Rename, describe, archive or restore. Owner or manager. */
export async function updateList(
  env: Env,
  actor: SessionUser,
  id: string,
  input: { name?: unknown; description?: unknown; archived?: unknown },
): Promise<{ ok: true } | Failure> {
  const list = await loadList(env, actor.clientId, id)
  if (!list) return { error: 'No such list.', status: 404 }
  if (!mayEdit(actor, list)) return { error: 'Not permitted.', status: 403 }

  const sets: string[] = []
  const binds: unknown[] = []
  if (typeof input.name === 'string') {
    const name = input.name.trim()
    if (!name) return { error: 'Give the list a name.', status: 400 }
    if (name.length > MAX_NAME) return { error: 'That name is too long.', status: 400 }
    if (name.toLowerCase() !== list.name.toLowerCase()) {
      const clash = await env.DB.prepare(
        'SELECT id FROM lead_lists WHERE client_id = ?1 AND archived = 0 AND lower(name) = lower(?2) AND id <> ?3',
      )
        .bind(actor.clientId, name, id)
        .first<{ id: string }>()
      if (clash) return { error: 'A list already has that name.', status: 409 }
    }
    binds.push(name)
    sets.push(`name = ?${binds.length}`)
  }
  if (typeof input.description === 'string') {
    binds.push(input.description.trim().slice(0, MAX_DESCRIPTION))
    sets.push(`description = ?${binds.length}`)
  }
  if (typeof input.archived === 'boolean') {
    binds.push(input.archived ? 1 : 0)
    sets.push(`archived = ?${binds.length}`)
  }
  if (!sets.length) return { error: 'Nothing to change.', status: 400 }

  binds.push(Date.now())
  sets.push(`updated_at = ?${binds.length}`)
  binds.push(id, actor.clientId)
  await env.DB.prepare(
    `UPDATE lead_lists SET ${sets.join(', ')} WHERE id = ?${binds.length - 1} AND client_id = ?${binds.length}`,
  )
    .bind(...binds)
    .run()

  if (typeof input.archived === 'boolean') {
    await record(env, actor, {
      action: input.archived ? 'list.archived' : 'list.restored',
      targetType: 'list',
      targetId: id,
      targetLabel: list.name,
    })
  }
  return { ok: true }
}

/** Gone for good. Owner or manager. Memberships and assignments cascade. */
export async function deleteList(env: Env, actor: SessionUser, id: string): Promise<{ ok: true } | Failure> {
  const list = await loadList(env, actor.clientId, id)
  if (!list) return { error: 'No such list.', status: 404 }
  if (!mayEdit(actor, list)) return { error: 'Not permitted.', status: 403 }
  await env.DB.prepare('DELETE FROM lead_lists WHERE id = ?1 AND client_id = ?2').bind(id, actor.clientId).run()
  await record(env, actor, { action: 'list.deleted', targetType: 'list', targetId: id, targetLabel: list.name })
  return { ok: true }
}

/**
 * Add and remove leads. Owner or manager; additions checked against what the
 * caller may see. Returns what happened, so a rep who tried to add a house that
 * is not theirs is told that one was skipped rather than shown a list that is
 * quietly one short.
 */
export async function updateMembers(
  env: Env,
  actor: SessionUser,
  id: string,
  input: { add?: unknown; remove?: unknown },
): Promise<{ added: number; removed: number; skipped: number } | Failure> {
  const list = await loadList(env, actor.clientId, id)
  if (!list) return { error: 'No such list.', status: 404 }
  if (!mayEdit(actor, list)) return { error: 'Not permitted.', status: 403 }

  const add = cleanIds(input.add)
  const remove = cleanIds(input.remove)
  if (!add.length && !remove.length) return { error: 'Nothing to change.', status: 400 }

  const now = Date.now()
  let added = 0
  if (add.length) {
    const permitted = await permittedProperties(env, actor, add)
    const ids = add.filter((p) => permitted.has(p))
    await writeMembers(env, actor, id, ids, now)
    added = ids.length
  }
  let removed = 0
  for (const part of chunks(remove)) {
    const holes = part.map((_, n) => `?${n + 2}`).join(',')
    const res = await env.DB.prepare(
      `DELETE FROM lead_list_members WHERE list_id = ?1 AND property_id IN (${holes})`,
    )
      .bind(id, ...part)
      .run()
    removed += res.meta.changes ?? 0
  }
  await env.DB.prepare('UPDATE lead_lists SET updated_at = ?2 WHERE id = ?1').bind(id, now).run()

  return { added, removed, skipped: add.length - added }
}

/**
 * Who works this list. Manager only; the whole set at once, so "assign to
 * Matthew, John and Sarah" is one action and "take Sarah off" is the same action
 * with two names.
 */
export async function setReps(
  env: Env,
  actor: SessionUser,
  id: string,
  input: { repIds?: unknown },
): Promise<{ repIds: string[] } | Failure> {
  if (!canManageLists(actor)) return { error: 'Not permitted.', status: 403 }
  const list = await loadList(env, actor.clientId, id)
  if (!list) return { error: 'No such list.', status: 404 }

  const repIds = cleanIds(input.repIds)
  if (repIds.length) {
    const team = await teamMembers(env, actor.clientId, repIds)
    const stranger = repIds.find((r) => !team.has(r))
    if (stranger) return { error: 'That person is not on this team.', status: 400 }
  }

  const now = Date.now()
  await env.DB.prepare('DELETE FROM lead_list_reps WHERE list_id = ?1').bind(id).run()
  await writeReps(env, actor, id, repIds, now)
  await env.DB.prepare('UPDATE lead_lists SET updated_at = ?2 WHERE id = ?1').bind(id, now).run()

  await record(env, actor, {
    action: 'list.assigned',
    targetType: 'list',
    targetId: id,
    targetLabel: list.name,
    detail: { reps: repIds.length },
  })
  return { repIds }
}
