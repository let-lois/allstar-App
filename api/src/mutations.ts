import { dayKeyIn, dayRangeIn } from './day'
import { queueForCrm } from './integrations'
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

// The outcomes that count as a real conversation live inline in the aggregate
// query below. The Set that used to sit here existed only to gate the money
// column on the triggering visit's outcome, which was half of why that column
// was wrong.



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

      // The feed is what a manager reads to see the day happening. The client
      // writes this event locally the moment the visit closes; without the
      // mirror here it vanishes the first time the phone re-bootstraps.
      // Keyed off the visit id so a replay overwrites rather than duplicates.
      const address = await env.DB.prepare(
        'SELECT address1 FROM properties WHERE id = ?1 AND client_id = ?2',
      )
        .bind(propertyId, user.clientId)
        .first<{ address1: string }>()
      await env.DB.prepare(
        `INSERT OR REPLACE INTO activity
           (id, client_id, property_id, rep_id, type, summary, outcome, at)
         VALUES (?1,?2,?3,?4,'visit',?5,?6,?7)`,
      )
        .bind(
          `ev_${id}`,
          user.clientId,
          propertyId,
          user.id,
          address?.address1 ?? 'Visit',
          outcome,
          endedAt,
        )
        .run()

      await bumpDailyStats(env, user, endedAt, outcome, propertyId)

      /*
        The lead's new state goes to the customer's CRM, if they have one.

        Queued rather than sent: the rep is standing on a doorstep and their sync
        must never wait on a third party. `queueForCrm` cannot throw — a failure
        here would be reported to the phone as the *visit* failing to save.

        Deduped per property, not per visit, because what is sent is the lead's
        current state rather than an event log. A rep correcting an outcome three
        times costs the customer's API quota once, and the last correction is the
        one that is true.

        This carries `do_not_contact` outward too, and that is the case that
        matters most. A household that told a rep to stop must stop being called
        from the customer's CRM as well, not just from this app — otherwise the
        rep honours it and the office autodialler does not.
      */
      await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId }, `contact:${propertyId}`)
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

      // Deduped on the appointment itself: this is a discrete thing that
      // happened, not a state that gets corrected, so two appointments for one
      // property must both survive.
      await queueForCrm(
        env,
        user.clientId,
        'appointment.create',
        { appointmentId: id, propertyId },
        `appointment:${id}`,
      )
      return
    }

    case 'route.create': {
      const id = str(p.id)
      const date = str(p.date)
      if (!id || !date) throw new Error('route.create: missing fields')
      const stops = Array.isArray(p.stops) ? p.stops : []

      await env.DB.prepare(
        `INSERT INTO routes (id, client_id, rep_id, date, name, started_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date`,
      )
        .bind(id, user.clientId, user.id, date, str(p.name) ?? 'Route', num(p.startedAt))
        .run()

      // Rebuilding a day's route replaces it. The stops that are already done
      // keep their status through the upsert below, but a stop dropped from the
      // new plan has to actually disappear — otherwise yesterday's abandoned
      // half-route quietly accumulates on the rep's screen.
      await env.DB.prepare('DELETE FROM route_stops WHERE route_id = ?1').bind(id).run()

      for (const raw of stops.slice(0, 200)) {
        const stop = obj(raw)
        const propertyId = str(stop.propertyId)
        if (!propertyId) continue
        // Tenant isolation still applies to a route: a route is a list of this
        // company's doors, and an id from anywhere else has no business in it.
        await assertPropertyInTenant(env, user, propertyId)
        await env.DB.prepare(
          `INSERT OR REPLACE INTO route_stops (route_id, property_id, ord, status, completed_at)
           VALUES (?1,?2,?3,?4,?5)`,
        )
          .bind(
            id,
            propertyId,
            num(stop.order) ?? 0,
            str(stop.status) ?? 'pending',
            num(stop.completedAt),
          )
          .run()
      }
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

    case 'user.avatar': {
      /*
        Self only.

        The payload carries a userId, and it is checked rather than trusted:
        without this, any signed-in rep could set anyone's face — including an
        admin's — by editing one field of a queued mutation. Changing a
        colleague's photo is not the worst thing someone could do with that, but
        it is impersonation, and the check costs one comparison.

        Managers do not get an exception. Nobody has asked to set someone else's
        photo, and an office role that can rewrite a rep's identity is a feature
        that should be designed rather than inherited from a missing check.
      */
      const userId = str(p.userId)
      if (userId && userId !== user.id) {
        throw new Error('user.avatar: can only set your own photo')
      }

      const dataUrl = str(p.dataUrl)
      if (dataUrl !== null && dataUrl !== undefined) {
        /*
          Bounded and typed. `avatarFromFile` produces a 256px JPEG at ~20KB;
          64KB is generous headroom for that and still far too small to be a
          way of storing something else in the users table.
        */
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
          throw new Error('user.avatar: not an image data URL')
        }
        if (dataUrl.length > 64_000) {
          throw new Error('user.avatar: image too large')
        }
      }

      await env.DB.prepare('UPDATE users SET avatar_url = ?1 WHERE id = ?2')
        .bind(dataUrl ?? null, user.id)
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
        // A lead added at the door is a new contact for the CRM.
        await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
        return
      }
      await env.DB.prepare(
        'UPDATE properties SET status = ?2, updated_at = ?3 WHERE id = ?1 AND client_id = ?4',
      )
        .bind(id, str(p.status) ?? 'new', Date.now(), user.clientId)
        .run()
      // A status changed from the console reaches the CRM the same way a rep's
      // outcome does — including a manual Do Not Contact.
      await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
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
  /*
    The company's calendar, not the server's. This used to cut the day in UTC,
    which put a Texas crew's evening doors into tomorrow's row while their own
    phones counted them as today — two answers to "which day is this", neither
    of them an error.

    The range comes from `dayRangeIn` rather than start + 24h, because a day
    with a clock change in it is 23 or 25 hours long and a fixed day would drop
    an hour of work on one date a year and double-count an hour on another.
  */
  const day = dayKeyIn(at, user.timezone)
  const id = `${user.id}:${day}`
  const [dayStart, dayEnd] = dayRangeIn(day, user.timezone)

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

  /*
    Money closed on this day, and nothing else.

    This used to ask "what has this rep won, ever" — no date bound at all, on a
    row that is scoped to one day — and then wrap the answer in a check on the
    triggering visit's outcome. Two things followed. Every day's row held the
    rep's career total, so `useRangeTotals` summing the column across a window
    turned one $10k sale into roughly $10k times days-worked. And because the
    last write of the day won the upsert, a day whose final logged door went
    badly stored 0 instead. Not a cumulative series with a known correction —
    noise that skewed high, on the one console figure a manager quotes out loud.

    So it is the same shape as the aggregate above: bounded to this day, read
    from the visits that actually happened, and independent of which visit
    triggered the recompute. It also now matches what the field app computes for
    today in `teamStats.revenue`, so the console and the phone stop answering
    the same question differently.
  */
  const value =
    (
      await env.DB.prepare(
        `SELECT COALESCE(SUM(p.opportunity_value), 0) AS v
           FROM visits v
           JOIN properties p ON p.id = v.property_id
          WHERE v.rep_id = ?1
            AND v.ended_at >= ?2 AND v.ended_at < ?3
            AND v.outcome = 'sold'`,
      )
        .bind(user.id, dayStart, dayEnd)
        .first<{ v: number }>()
    )?.v ?? 0
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
