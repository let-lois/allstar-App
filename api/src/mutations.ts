import type { Env, Mutation, MutationResult, SessionUser } from './types'

/**
 * The write path.
 *
 * The client's outbox is the source of truth for ordering and retry; this
 * endpoint's only jobs are to apply each mutation **exactly once** and to be
 * honest about which ones it couldn't.
 *
 * Why exactly-once matters more here than in most APIs: the queue retries on
 * every reconnect, and a retry after a response was lost in flight is
 * indistinguishable from a first attempt. Without the ledger, a rep walking out
 * of a dead zone would silently double every visit they recorded in it — and
 * doors-per-day is the number their pay is calculated from.
 *
 * Mutations are applied in the order the client queued them, and a rejection
 * does not stop the batch: one malformed row from an old app version must not
 * wedge a rep's entire day behind it.
 */

const OUTCOME_TO_STATUS: Record<string, string | undefined> = {
  no_answer: undefined,
  interested: 'working',
  follow_up: 'contacted',
  appointment: 'appointment',
  quote_requested: 'quoted',
  not_interested: 'lost',
  sold: 'won',
  do_not_contact: 'dnc',
}

const GOOD_OUTCOMES = new Set(['interested', 'appointment', 'quote_requested', 'sold'])

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

/** Narrow an unknown payload without trusting it. */
function obj(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export async function applyMutations(
  env: Env,
  user: SessionUser,
  mutations: Mutation[],
): Promise<MutationResult[]> {
  const results: MutationResult[] = []

  // Ordering is the client's. Sort defensively in case a batch arrives shuffled.
  const ordered = [...mutations].sort((a, b) => a.createdAt - b.createdAt)

  for (const m of ordered) {
    if (!m?.id || !m.kind) {
      results.push({ id: m?.id ?? 'unknown', status: 'rejected', error: 'malformed mutation' })
      continue
    }

    // The ledger insert is the idempotency gate. Doing it *first* and letting
    // the primary-key conflict tell us "already applied" means the check and
    // the claim are a single atomic step — a check-then-write would let two
    // concurrent retries both pass the check.
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO applied_mutations (id, client_id, user_id, kind, applied_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(m.id, user.clientId, user.id, m.kind, Date.now())
      .run()

    if (!claimed.meta.changes) {
      results.push({ id: m.id, status: 'duplicate' })
      continue
    }

    try {
      await applyOne(env, user, m)
      results.push({ id: m.id, status: 'applied' })
    } catch (err) {
      // Release the claim so a genuine retry can succeed — otherwise a
      // transient failure would be permanently recorded as "done".
      await env.DB.prepare('DELETE FROM applied_mutations WHERE id = ?1').bind(m.id).run()
      results.push({
        id: m.id,
        status: 'rejected',
        error: err instanceof Error ? err.message : 'apply failed',
      })
    }
  }

  return results
}

async function applyOne(env: Env, user: SessionUser, m: Mutation): Promise<void> {
  const p = obj(m.payload)

  switch (m.kind) {
    case 'visit.start': {
      const id = str(p.id)
      const propertyId = str(p.propertyId)
      const startedAt = num(p.startedAt)
      if (!id || !propertyId || startedAt == null) throw new Error('visit.start: missing fields')
      await assertPropertyInTenant(env, user, propertyId)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO visits
           (id, client_id, property_id, rep_id, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(id, user.clientId, propertyId, user.id, startedAt)
        .run()
      return
    }

    case 'visit.complete': {
      const id = str(p.id)
      const propertyId = str(p.propertyId)
      if (!id || !propertyId) throw new Error('visit.complete: missing fields')
      await assertPropertyInTenant(env, user, propertyId)

      const outcome = str(p.outcome)
      const endedAt = num(p.endedAt) ?? Date.now()
      const loc = obj(p.startLocation)

      // The client may have completed a visit whose `start` never reached us —
      // it was queued behind it in the same dead zone. Upsert rather than
      // update, so the outcome isn't lost waiting for a row that never arrives.
      await env.DB.prepare(
        `INSERT INTO visits
           (id, client_id, property_id, rep_id, started_at, ended_at, outcome,
            duration_ms, start_lat, start_lng, start_accuracy,
            next_action_at, next_action_type)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           outcome = excluded.outcome,
           duration_ms = excluded.duration_ms,
           start_lat = COALESCE(excluded.start_lat, visits.start_lat),
           start_lng = COALESCE(excluded.start_lng, visits.start_lng),
           start_accuracy = COALESCE(excluded.start_accuracy, visits.start_accuracy),
           next_action_at = excluded.next_action_at,
           next_action_type = excluded.next_action_type`,
      )
        .bind(
          id,
          user.clientId,
          propertyId,
          user.id,
          num(p.startedAt) ?? endedAt,
          endedAt,
          outcome,
          num(p.durationMs),
          num(loc.lat),
          num(loc.lng),
          num(loc.accuracy),
          num(p.nextActionAt),
          str(p.nextActionType),
        )
        .run()

      // The outcome is what moves the lead — status is derived, never sent.
      const nextStatus = outcome ? OUTCOME_TO_STATUS[outcome] : undefined
      await env.DB.prepare(
        `UPDATE properties
            SET last_outcome = COALESCE(?2, last_outcome),
                last_visit_at = ?3,
                status = COALESCE(?4, status),
                next_action_at = ?5,
                next_action_label = ?6,
                updated_at = ?3
          WHERE id = ?1 AND client_id = ?7`,
      )
        .bind(
          propertyId,
          outcome,
          endedAt,
          nextStatus ?? null,
          num(p.nextActionAt),
          str(p.nextActionLabel),
          user.clientId,
        )
        .run()

      await bumpDailyStats(env, user, endedAt, outcome, propertyId)
      return
    }

    case 'note.create': {
      const id = str(p.id)
      const propertyId = str(p.propertyId)
      if (!id || !propertyId) throw new Error('note.create: missing fields')
      await assertPropertyInTenant(env, user, propertyId)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO notes
           (id, client_id, property_id, visit_id, body, tags, author_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      )
        .bind(
          id,
          user.clientId,
          propertyId,
          str(p.visitId),
          str(p.body) ?? '',
          JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
          user.id,
          num(p.createdAt) ?? Date.now(),
        )
        .run()
      return
    }

    case 'photo.create': {
      // Metadata only. The image itself is uploaded separately to R2, because a
      // multi-megabyte body has no business inside a batched mutation request
      // that has to succeed atomically on one bar of signal.
      const id = str(p.id)
      const propertyId = str(p.propertyId)
      if (!id || !propertyId) throw new Error('photo.create: missing fields')
      await assertPropertyInTenant(env, user, propertyId)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO photos
           (id, client_id, property_id, visit_id, category, r2_key,
            width, height, bytes, captured_lat, captured_lng, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
        .bind(
          id,
          user.clientId,
          propertyId,
          str(p.visitId),
          str(p.category) ?? 'property',
          `${user.clientId}/${propertyId}/${id}.jpg`,
          num(p.width),
          num(p.height),
          num(p.bytes),
          num(obj(p.capturedAt).lat),
          num(obj(p.capturedAt).lng),
          num(p.createdAt) ?? Date.now(),
        )
        .run()
      return
    }

    case 'task.create': {
      const id = str(p.id)
      if (!id) throw new Error('task.create: missing id')
      await env.DB.prepare(
        `INSERT OR REPLACE INTO tasks
           (id, client_id, rep_id, property_id, title, due_at, done, kind)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      )
        .bind(
          id,
          user.clientId,
          user.id,
          str(p.propertyId),
          str(p.title) ?? 'Follow up',
          num(p.dueAt) ?? Date.now(),
          p.done ? 1 : 0,
          str(p.kind) ?? 'follow_up',
        )
        .run()
      return
    }

    case 'task.complete': {
      const id = str(p.id)
      if (!id) throw new Error('task.complete: missing id')
      await env.DB.prepare(
        'UPDATE tasks SET done = ?2 WHERE id = ?1 AND client_id = ?3',
      )
        .bind(id, p.done ? 1 : 0, user.clientId)
        .run()
      return
    }

    case 'appointment.create': {
      const id = str(p.id)
      const propertyId = str(p.propertyId)
      if (!id || !propertyId) throw new Error('appointment.create: missing fields')
      await assertPropertyInTenant(env, user, propertyId)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO appointments
           (id, client_id, property_id, rep_id, starts_at, duration_min, title, contact_id, notes)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      )
        .bind(
          id,
          user.clientId,
          propertyId,
          user.id,
          num(p.startsAt) ?? Date.now(),
          num(p.durationMin) ?? 45,
          str(p.title) ?? 'Appointment',
          str(p.contactId),
          str(p.notes),
        )
        .run()
      return
    }

    case 'route.stop': {
      const routeId = str(p.routeId)
      const propertyId = str(p.propertyId)
      const status = str(p.status) ?? 'done'
      if (!routeId || !propertyId) throw new Error('route.stop: missing fields')
      await env.DB.prepare(
        `UPDATE route_stops
            SET status = ?3, completed_at = ?4
          WHERE route_id = ?1 AND property_id = ?2`,
      )
        .bind(routeId, propertyId, status, status === 'done' ? Date.now() : null)
        .run()
      return
    }

    case 'comm.log': {
      const propertyId = str(p.propertyId)
      if (!propertyId) throw new Error('comm.log: missing propertyId')
      await assertPropertyInTenant(env, user, propertyId)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO activity
           (id, client_id, property_id, rep_id, type, summary, at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      )
        .bind(
          m.id,
          user.clientId,
          propertyId,
          user.id,
          str(p.kind) ?? 'call',
          `${str(p.kind) ?? 'Contacted'} contact`,
          num(p.at) ?? Date.now(),
        )
        .run()
      return
    }

    case 'property.status': {
      const id = str(p.id)
      if (!id) throw new Error('property.status: missing id')
      // A lead added in the field arrives here as a create.
      if (p.created) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO properties
             (id, client_id, address1, city, state, zip, lat, lng, status, score,
              assigned_rep_id, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',50,?9,?10)`,
        )
          .bind(
            id,
            user.clientId,
            str(p.address1) ?? 'Untitled property',
            str(p.city),
            str(p.state),
            str(p.zip),
            num(p.lat) ?? 0,
            num(p.lng) ?? 0,
            user.id,
            Date.now(),
          )
          .run()
        return
      }
      await env.DB.prepare(
        'UPDATE properties SET status = ?2, updated_at = ?3 WHERE id = ?1 AND client_id = ?4',
      )
        .bind(id, str(p.status) ?? 'new', Date.now(), user.clientId)
        .run()
      return
    }

    default:
      throw new Error(`unknown mutation kind: ${m.kind}`)
  }
}

/**
 * Tenant isolation, enforced per write rather than assumed.
 *
 * Every id in this system is client-generated, so a compromised or buggy client
 * could name a property belonging to another company. The session says who the
 * caller is; this says whether the row is theirs to touch.
 */
async function assertPropertyInTenant(
  env: Env,
  user: SessionUser,
  propertyId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM properties WHERE id = ?1 AND client_id = ?2',
  )
    .bind(propertyId, user.clientId)
    .first<{ ok: number }>()
  if (!row) throw new Error('property not found in this account')
}

/**
 * Keep the reporting roll-up current as visits land.
 *
 * Recomputed from the visits table rather than incremented, so a replayed or
 * out-of-order batch converges on the truth instead of drifting.
 */
async function bumpDailyStats(
  env: Env,
  user: SessionUser,
  at: number,
  outcome: string | null,
  propertyId: string,
): Promise<void> {
  if (!outcome) return
  const day = dayKey(at)
  const id = `${user.id}:${day}`
  const dayStart = Date.parse(`${day}T00:00:00Z`)
  const dayEnd = dayStart + 86_400_000

  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS knocks,
            SUM(CASE WHEN outcome IN ('interested','appointment','quote_requested','sold') THEN 1 ELSE 0 END) AS conversations,
            SUM(CASE WHEN outcome = 'appointment' THEN 1 ELSE 0 END) AS appointments,
            SUM(CASE WHEN outcome = 'quote_requested' THEN 1 ELSE 0 END) AS quotes,
            SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold
       FROM visits
      WHERE rep_id = ?1 AND ended_at >= ?2 AND ended_at < ?3 AND outcome IS NOT NULL`,
  )
    .bind(user.id, dayStart, dayEnd)
    .first<Record<string, number>>()

  const value = GOOD_OUTCOMES.has(outcome)
    ? ((
        await env.DB.prepare(
          `SELECT COALESCE(SUM(opportunity_value), 0) AS v
             FROM properties
            WHERE assigned_rep_id = ?1 AND status = 'won'`,
        )
          .bind(user.id)
          .first<{ v: number }>()
      )?.v ?? 0)
    : 0
  void propertyId

  await env.DB.prepare(
    `INSERT INTO daily_stats
       (id, client_id, rep_id, day, knocks, conversations, appointments, quotes, sold, pipeline_value)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
       knocks = excluded.knocks,
       conversations = excluded.conversations,
       appointments = excluded.appointments,
       quotes = excluded.quotes,
       sold = excluded.sold,
       pipeline_value = excluded.pipeline_value`,
  )
    .bind(
      id,
      user.clientId,
      user.id,
      day,
      agg?.knocks ?? 0,
      agg?.conversations ?? 0,
      agg?.appointments ?? 0,
      agg?.quotes ?? 0,
      agg?.sold ?? 0,
      value,
    )
    .run()
}
