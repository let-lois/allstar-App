import { propertyIdOf } from './mutation-target'
import { bindChunks } from './d1'
import type { Env, Mutation, SessionUser } from './types'

/**
 * Noticing when late work landed on something that had moved.
 *
 * The conflict rule is settled and this does not touch it: Allstar wins, the
 * rep's answer is applied, and nothing here changes an outcome. What it changes
 * is that somebody finds out.
 *
 * The case it exists for is a real week rather than a hypothetical one. A rep
 * works a rural route with no signal on Monday. On Wednesday the office moves one
 * of those leads in the console — a call came in, the homeowner rescheduled. On
 * Friday the phone reconnects and the rep's Monday answer overwrites Wednesday's
 * edit. That is *correct*: the rep was at the door and the rule says so. It is
 * also invisible, and the office edit does not come back.
 *
 * So the outcome stands and a record is written beside it.
 *
 * ## Why a threshold at all
 *
 * Without one this fires constantly. A rep closing a visit twenty minutes after
 * a manager reassigned the lead is not a story anybody needs told; it is a
 * normal day, and a screen full of those is a screen nobody reads — which is the
 * same as not having built it.
 *
 * Three days is the line. It is long enough that same-day and next-morning syncs
 * never appear, and short enough to catch the multi-day dead-zone route this was
 * built for.
 *
 * ## What it compares, and the trap in that
 *
 * `acted_at` is the rep's clock and `changed_at` is ours, so the comparison
 * crosses two clocks. That is fine only because the gap being looked for is days
 * wide: a phone minutes out of step cannot manufacture a three-day staleness, and
 * one that is genuinely days out has a bigger problem than this.
 *
 * The subtler trap is self-collision. A rep's own earlier mutation in the same
 * batch bumps the lead's `updated_at`, so comparing against the row as it stands
 * would flag every rep who recorded two things about one address — their own
 * first answer reading as somebody else's interference. So the comparison is
 * against a snapshot taken **before the batch is applied**, and a rep's own work
 * within one sync can never collide with itself.
 */

/** Older than this, and a collision is worth telling somebody about. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/** The mutations that assert something about a lead's state. */
const WATCHED = new Set(['visit.complete', 'property.status'])

export type UpdatedSnapshot = Map<string, number>

/**
 * What the leads in this batch looked like before any of it was applied.
 *
 * Read in one query rather than per mutation: a phone reconnecting after a week
 * can arrive with hundreds, and this runs on the path a rep is waiting on.
 */
export async function snapshotUpdatedAt(
  env: Env,
  clientId: string,
  mutations: Mutation[],
): Promise<UpdatedSnapshot> {
  const ids = new Set<string>()
  for (const m of mutations) {
    if (!WATCHED.has(m.kind)) continue
    const id = propertyIdOf(m)
    if (id) ids.add(id)
  }

  const snapshot: UpdatedSnapshot = new Map()
  const list = [...ids]
  for (const slice of bindChunks(list, 1)) {
    const holes = slice.map((_, n) => `?${n + 2}`).join(',')
    const rows = await env.DB.prepare(
      `SELECT id, updated_at FROM properties WHERE client_id = ?1 AND id IN (${holes})`,
    )
      .bind(clientId, ...slice)
      .all<{ id: string; updated_at: number }>()
    for (const r of rows.results ?? []) snapshot.set(r.id, Number(r.updated_at))
  }
  return snapshot
}

/**
 * Record a collision, if this is one.
 *
 * Never throws into the caller. This runs inside the write path a rep is waiting
 * on, and a bookkeeping failure must not turn into "your visit did not save" —
 * the same rule `queueForCrm` follows, for the same reason.
 */
export async function noteIfStale(
  env: Env,
  user: SessionUser,
  m: Mutation,
  snapshot: UpdatedSnapshot,
): Promise<void> {
  try {
    if (!WATCHED.has(m.kind)) return

    const payload = (m.payload ?? {}) as Record<string, unknown>
    const propertyId = propertyIdOf(m)
    if (!propertyId) return

    const actedAt = Number(m.createdAt)
    if (!Number.isFinite(actedAt)) return

    const arrivedAt = Date.now()
    // Not stale: it got here promptly, whatever else happened to the lead.
    if (arrivedAt - actedAt < STALE_AFTER_MS) return

    const changedAt = snapshot.get(propertyId)
    // Nothing known about the lead before this batch — a lead created by this
    // very sync, most likely. Nothing to have collided with.
    if (changedAt === undefined) return

    // The lead did not move while this was in transit, so late is just late.
    if (changedAt <= actedAt) return

    await env.DB.prepare(
      `INSERT INTO sync_conflicts
         (id, client_id, property_id, rep_id, kind, acted_at, arrived_at, changed_at, detail)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind(
        `sc_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        user.clientId,
        propertyId,
        user.id,
        m.kind,
        actedAt,
        arrivedAt,
        changedAt,
        JSON.stringify({
          outcome: typeof payload.outcome === 'string' ? payload.outcome : undefined,
          status: typeof payload.status === 'string' ? payload.status : undefined,
          lateByHours: Math.round((arrivedAt - actedAt) / 3_600_000),
        }),
      )
      .run()
  } catch (err) {
    console.error('stale-sync note failed', err)
  }
}

/* --- what a manager sees -------------------------------------------------- */

/**
 * Who may look at these.
 *
 * Managers included, unlike erasure. The whole point is that somebody notices,
 * and the person who notices is whoever runs the board day to day — restricting
 * it to admins would mean the record exists and nobody reads it.
 */
export function canReviewConflicts(user: SessionUser): boolean {
  return user.role !== 'field_rep'
}

export interface ConflictRow {
  id: string
  propertyId: string
  address: string
  repId: string | null
  repName: string | null
  kind: string
  actedAt: number
  arrivedAt: number
  changedAt: number
  lateByHours: number
  detail: Record<string, unknown>
  reviewedAt: number | null
}

/**
 * The open collisions, newest arrival first.
 *
 * Joined to the lead and the rep because a bare id tells a manager nothing —
 * they need to know which house and which person to go ask. LEFT JOIN on both:
 * a lead erased since (issue #53) still has a story worth reading, and it must
 * not vanish from the list because the row it points at is gone.
 */
export async function listConflicts(
  env: Env,
  clientId: string,
  opts: { includeReviewed?: boolean; limit?: number } = {},
): Promise<ConflictRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const sql = `
    SELECT c.id, c.property_id, c.rep_id, c.kind, c.acted_at, c.arrived_at,
           c.changed_at, c.detail, c.reviewed_at,
           p.address1 AS address, u.name AS rep_name
      FROM sync_conflicts c
      LEFT JOIN properties p ON p.id = c.property_id
      LEFT JOIN users u ON u.id = c.rep_id
     WHERE c.client_id = ?1
       ${opts.includeReviewed ? '' : 'AND c.reviewed_at IS NULL'}
     ORDER BY c.arrived_at DESC
     LIMIT ?2`
  const rows = await env.DB.prepare(sql).bind(clientId, limit).all<{
    id: string
    property_id: string
    rep_id: string | null
    kind: string
    acted_at: number
    arrived_at: number
    changed_at: number
    detail: string | null
    reviewed_at: number | null
    address: string | null
    rep_name: string | null
  }>()

  return (rows.results ?? []).map((r) => {
    let detail: Record<string, unknown> = {}
    try {
      detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {}
    } catch {
      detail = {}
    }
    return {
      id: r.id,
      propertyId: r.property_id,
      address: r.address ?? '(erased)',
      repId: r.rep_id,
      repName: r.rep_name,
      kind: r.kind,
      actedAt: Number(r.acted_at),
      arrivedAt: Number(r.arrived_at),
      changedAt: Number(r.changed_at),
      lateByHours: Math.round((Number(r.arrived_at) - Number(r.acted_at)) / 3_600_000),
      detail,
      reviewedAt: r.reviewed_at == null ? null : Number(r.reviewed_at),
    }
  })
}

/**
 * Mark one as looked at.
 *
 * Deliberately not a delete: what a manager decided to do about a collision is
 * exactly the kind of thing that gets asked about months later, and a list that
 * empties itself leaves no answer. Scoped by client_id so acknowledging cannot
 * reach across tenants.
 */
export async function reviewConflict(
  env: Env,
  clientId: string,
  id: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!id) return { ok: false, status: 400, error: 'Which conflict?' }
  const res = await env.DB.prepare(
    'UPDATE sync_conflicts SET reviewed_at = ?3 WHERE id = ?1 AND client_id = ?2 AND reviewed_at IS NULL',
  )
    .bind(id, clientId, Date.now())
    .run()
  if (!res.meta.changes) return { ok: false, status: 404, error: 'Not found, or already reviewed.' }
  return { ok: true, status: 200 }
}
