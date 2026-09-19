import { record } from './audit'
import type { Env, SessionUser } from './types'

/**
 * Create a territory from an outline drawn on a map.
 *
 * The browser has already worked out which leads fall inside the shape — that is
 * how it showed a count while the manager was drawing. This does the same test
 * again, because the browser tested the leads *it had cached* and the database is
 * the authority on which leads exist. The difference is "the 34 I could see"
 * versus "the leads that are there", and after a fresh import those are not the
 * same number.
 *
 * Every lead inside joins the territory. If a rep was chosen they get the leads
 * too — assigning ground and assigning the person who walks it are one action to
 * whoever is drawing, and splitting them leaves a patch belonging to nobody,
 * which is the state the unassigned bucket already exists to describe.
 */

/**
 * Ray casting, flat. Same reasoning as the client's copy in src/lib/geo.ts.
 *
 * Exported because a lead list drawn round an area asks exactly this question,
 * and a second copy is a second thing for `verify:geo-parity` to fail to notice
 * drifting.
 */
export function inside(point: { lat: number; lng: number }, poly: { lat: number; lng: number }[]) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      hit = !hit
    }
  }
  return hit
}

/**
 * Bounds on the shape itself.
 *
 * A polygon arrives from a browser, so it is untrusted input that gets stored and
 * then run against every property in the tenant. Three points is the minimum for
 * an area; the ceiling is arbitrary, but a hand-drawn patch is a dozen taps and
 * refusing ten thousand vertices costs nobody anything.
 */
const MIN_POINTS = 3
const MAX_POINTS = 200

type Created = { territory: { id: string; name: string }; assigned: number }

/**
 * A polygon from a browser, checked before it is stored or run against a tenant.
 *
 * Shared by territories and lead lists, which both take a drawn outline. The
 * checks are the same because the risk is the same: untrusted input that gets
 * persisted and then evaluated against every property in the tenant.
 */
export function parsePolygon(
  raw: unknown,
): { boundary: { lat: number; lng: number }[] } | { error: string; status: number } {
  if (!Array.isArray(raw)) return { error: 'No outline was sent.', status: 400 }
  if (raw.length < MIN_POINTS) return { error: 'An area needs at least three points.', status: 400 }
  if (raw.length > MAX_POINTS) return { error: 'That outline has too many points.', status: 400 }

  const boundary: { lat: number; lng: number }[] = []
  for (const item of raw as unknown[]) {
    const p = item as { lat?: unknown; lng?: unknown }
    const lat = Number(p?.lat)
    const lng = Number(p?.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: 'That outline has a point with no coordinates.', status: 400 }
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { error: 'That outline is not on Earth.', status: 400 }
    }
    boundary.push({ lat, lng })
  }
  return { boundary }
}

export async function createTerritory(
  env: Env,
  actor: SessionUser,
  input: { name?: unknown; repId?: unknown; boundary?: unknown },
): Promise<Created | { error: string; status: number }> {
  if (actor.role === 'field_rep') return { error: 'Not permitted.', status: 403 }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { error: 'Give the area a name.', status: 400 }
  if (name.length > 120) return { error: 'That name is too long.', status: 400 }

  const parsed = parsePolygon(input.boundary)
  if ('error' in parsed) return parsed
  const { boundary } = parsed

  // A rep from another tenant would silently receive this company's leads.
  const repId = typeof input.repId === 'string' && input.repId ? input.repId : null
  if (repId) {
    const rep = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND client_id = ?2 AND active = 1',
    )
      .bind(repId, actor.clientId)
      .first<{ id: string }>()
    if (!rep) return { error: 'That person is not on this team.', status: 400 }
  }

  const clash = await env.DB.prepare(
    'SELECT id FROM territories WHERE client_id = ?1 AND lower(name) = lower(?2)',
  )
    .bind(actor.clientId, name)
    .first<{ id: string }>()
  if (clash) return { error: 'A territory already has that name.', status: 409 }

  const id = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await env.DB.prepare(
    'INSERT INTO territories (id, client_id, name, rep_id, boundary) VALUES (?1,?2,?3,?4,?5)',
  )
    .bind(id, actor.clientId, name, repId, JSON.stringify(boundary))
    .run()

  /*
    Matched in the Worker rather than in SQL. SQLite has no point-in-polygon, and
    the alternatives are a bounding-box query that over-selects on any concave
    shape — an L-shaped patch would claim the leads sitting in its notch — or a
    pile of generated SQL. Reading the tenant's coordinates and testing them here
    is a few thousand rows of two numbers, and it runs the *same* test the browser
    ran, so the count the manager saw is the count they get.
  */
  const rows = await env.DB.prepare('SELECT id, lat, lng FROM properties WHERE client_id = ?1')
    .bind(actor.clientId)
    .all()

  const ids = (rows.results as { id: string; lat: number; lng: number }[])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && inside(p, boundary))
    .map((p) => p.id)

  const now = Date.now()
  let assigned = 0
  // Chunked for the same reason as the bulk assign: SQLite has a variable limit,
  // and one statement per lead would be one round trip per lead.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const holes = chunk.map((_, n) => `?${n + 5}`).join(',')
    const res = await env.DB.prepare(
      `UPDATE properties
          SET territory_id = ?1,
              assigned_rep_id = COALESCE(?2, assigned_rep_id),
              updated_at = ?3
        WHERE client_id = ?4 AND id IN (${holes})`,
    )
      .bind(id, repId, now, actor.clientId, ...chunk)
      .run()
    assigned += res.meta.changes ?? 0
  }

  await record(env, actor, {
    action: 'territory.created',
    targetType: 'territory',
    targetId: id,
    targetLabel: name,
    detail: { points: boundary.length, leads: assigned, repId },
  })

  return { territory: { id, name }, assigned }
}

/**
 * A stored outline, read back defensively.
 *
 * The column arrived by migration, so old rows hold null and — if anything ever
 * wrote to it by hand — it could hold anything. A territory or list with an
 * unreadable outline is still a perfectly good one, so a parse failure drops the
 * shape rather than the row.
 */
export function parseBoundary(raw: unknown): { lat: number; lng: number }[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 3) return undefined
    const points = parsed
      .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    return points.length >= 3 ? points : undefined
  } catch {
    return undefined
  }
}

/* --- changing one after it exists ----------------------------------------- */

/**
 * Rename and delete, which a drawn territory went without for its whole life.
 *
 * The gap was not obvious from the console, because the console never showed
 * it: a territory could be created and its rep could be changed, and that was
 * the whole vocabulary. So a typo in a name was permanent and a shape drawn
 * round the wrong streets could only be abandoned in place — which is how a
 * list of territories fills up with "Cypress Ridge", "Cypress Ridge 2" and
 * "cypress ridge (real)", none of which can be removed.
 *
 * Both are office actions, permissioned exactly like creation: a rep walks a
 * patch, they do not redraw it. The test is written out in each one rather than
 * shared through a helper, so all three territory writes state their rule in
 * the same words in the same place — a role check one indirection away is one
 * a reader has to go and look up, and `verify:api-access` reads these functions
 * to prove each decides for itself.
 */

export async function renameTerritory(
  env: Env,
  actor: SessionUser,
  id: string,
  input: { name?: unknown },
): Promise<{ territory: { id: string; name: string } } | { error: string; status: number }> {
  if (actor.role === 'field_rep') return { error: 'Not permitted.', status: 403 }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { error: 'Give the area a name.', status: 400 }
  if (name.length > 120) return { error: 'That name is too long.', status: 400 }

  const existing = await env.DB.prepare(
    'SELECT id, name FROM territories WHERE id = ?1 AND client_id = ?2',
  )
    .bind(id, actor.clientId)
    .first<{ id: string; name: string }>()
  if (!existing) return { error: 'No such territory.', status: 404 }

  // Excluding itself, so re-saving a name unchanged — or only its capitalisation
  // — is not refused as a clash with the row being edited.
  const clash = await env.DB.prepare(
    'SELECT id FROM territories WHERE client_id = ?1 AND lower(name) = lower(?2) AND id <> ?3',
  )
    .bind(actor.clientId, name, id)
    .first<{ id: string }>()
  if (clash) return { error: 'A territory already has that name.', status: 409 }

  await env.DB.prepare('UPDATE territories SET name = ?1 WHERE id = ?2 AND client_id = ?3')
    .bind(name, id, actor.clientId)
    .run()

  await record(env, actor, {
    action: 'territory.renamed',
    targetType: 'territory',
    targetId: id,
    targetLabel: name,
    detail: { from: existing.name },
  })

  return { territory: { id, name } }
}

/**
 * Delete a territory, and say how many leads it let go of.
 *
 * The leads are kept. They lose their `territory_id` and land back in the
 * unassigned bucket, which is the state they were in before anybody drew round
 * them — deleting a shape on a map is not a decision about whether those houses
 * exist, and a delete that took a few hundred leads with it would be a
 * catastrophe wearing the same button as a tidy-up.
 *
 * `assigned_rep_id` is deliberately left alone. Who walks a house and which
 * patch it belongs to are two facts, and the console has a separate control for
 * the first; clearing it here would silently unassign a rep's whole day because
 * somebody renamed the map. The returned count is what the console tells the
 * operator, so the sentence on screen is the number the database actually moved.
 */
export async function deleteTerritory(
  env: Env,
  actor: SessionUser,
  id: string,
): Promise<{ ok: true; released: number } | { error: string; status: number }> {
  if (actor.role === 'field_rep') return { error: 'Not permitted.', status: 403 }

  const existing = await env.DB.prepare(
    'SELECT id, name FROM territories WHERE id = ?1 AND client_id = ?2',
  )
    .bind(id, actor.clientId)
    .first<{ id: string; name: string }>()
  if (!existing) return { error: 'No such territory.', status: 404 }

  const res = await env.DB.prepare(
    'UPDATE properties SET territory_id = NULL, updated_at = ?1 WHERE client_id = ?2 AND territory_id = ?3',
  )
    .bind(Date.now(), actor.clientId, id)
    .run()
  const released = res.meta.changes ?? 0

  await env.DB.prepare('DELETE FROM territories WHERE id = ?1 AND client_id = ?2')
    .bind(id, actor.clientId)
    .run()

  await record(env, actor, {
    action: 'territory.deleted',
    targetType: 'territory',
    targetId: id,
    targetLabel: existing.name,
    detail: { released },
  })

  return { ok: true, released }
}
