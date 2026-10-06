import { erasedAmong } from './erase'
import { propertyIdOf } from './mutation-target'
import { queueForCrm } from './integrations'
import { noteIfStale, snapshotUpdatedAt } from './stale'
import { createList, repScopeSql, setReps, updateList, updateMembers } from './lists'
import { canImport } from './import'
import { parseBoundary, polygonAreaSqMiles, territoryFor, type TerritoryShape } from './geo'
import { cancelDeal, recomputeDailyStats, syncDealToStatus, updateDeal, winDeal } from './deals'

/** The statuses a person may set by hand; the same list the office's bulk change allows. */
const SETTABLE_STATUSES = new Set(['new', 'contacted', 'follow_up', 'working', 'appointment', 'quoted', 'won', 'lost', 'dnc'])
const STATUS_WORDS: Record<string, string> = {
  new: 'New', contacted: 'Contacted', follow_up: 'Follow-up', working: 'Working', appointment: 'Appointment',
  quoted: 'Quoted', won: 'Won', lost: 'Lost', dnc: 'Do Not Contact',
}
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

export const OUTCOME_TO_STATUS: Record<string, string | undefined> = {
  no_answer: undefined,
  interested: 'working',
  follow_up: 'follow_up',
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
/**
 * The type a photo carries, which is only ever the one typed for "other".
 * Decided here rather than trusted from the phone, so a type left behind by an
 * older bundle — or a hand-made request — cannot attach itself to a named
 * category. Trimmed and bounded: it is a label, not a note.
 */
const photoType = (category: string, v: unknown): string | null =>
  category === 'other' && typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null

export async function applyMutations(
  env: Env,
  user: SessionUser,
  mutations: Mutation[],
): Promise<MutationResult[]> {
  const results: MutationResult[] = []

  // Ordering is the client's. Sort defensively in case a batch arrives shuffled.
  const ordered = [...mutations].sort((a, b) => a.createdAt - b.createdAt)

  // Taken before a single mutation is applied. Comparing against the live row
  // would make a rep's own first mutation in this batch look like somebody
  // else's interference on their second. See stale.ts.
  const before = await snapshotUpdatedAt(env, user.clientId, ordered)

  /*
    Leads erased while this batch sat in an outbox.

    A phone that was in a dead zone when an erasure happened is still carrying
    work for that lead, and two of those kinds would each do the wrong thing.
    `property.status` with `created` is an INSERT: it would put the erased
    address back, under the same derived id, with nobody told — the import and
    webhook paths are both guarded against exactly this and the sync path was
    not. Every other kind would throw in `assertPropertyInTenant`, be reported
    as rejected, and retry forever: the permanently-failing outbox row again.

    So the batch is checked once, up front, and anything aimed at an erased lead
    is discarded rather than applied or refused.
  */
  const erased = await erasedAmong(
    env,
    user.clientId,
    [...new Set(ordered.map(propertyIdOf).filter(Boolean))],
  )

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

    /*
      Claimed first, then discarded. Doing it in this order rather than before
      the ledger insert means a retry of the same mutation gets `duplicate`
      instead of being re-evaluated, so the outcome cannot change if the batch
      is sent twice.

      Reported as `obsolete`, not `applied`: nothing was applied, and calling it
      applied would put a lie in the one record that says what happened to a
      rep's work. The phone treats it as settled and drops it, the same as an
      applied row.
    */
    const target = propertyIdOf(m)
    if (target && erased.has(target)) {
      results.push({ id: m.id, status: 'obsolete' })
      continue
    }

    try {
      await applyOne(env, user, m)
      results.push({ id: m.id, status: 'applied' })
      // Bookkeeping only, and deliberately after the result is recorded: the
      // outcome above stands whatever this does.
      await noteIfStale(env, user, m, before)
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
      /*
        A door nobody owned belongs to whoever knocked it.

        Houses on a list handed to a rep carry no assigned_rep_id: the list
        confers visibility, and handing it out was deliberately not a
        reassignment. But once a rep has stood at the door and recorded what
        happened, "Assigned: nobody" in the console is simply wrong, and the
        export would say the same. COALESCE keeps every explicit assignment —
        a house the office gave to someone else stays theirs.
      */
      await env.DB.prepare(
        `UPDATE properties
            SET last_outcome = COALESCE(?2, last_outcome),
                last_visit_at = ?3,
                status = COALESCE(?4, status),
                next_action_at = ?5,
                next_action_label = ?6,
                assigned_rep_id = COALESCE(assigned_rep_id, ?8),
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
          user.id,
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

      /*
        The sale follows the lead's status. A Sold visit opens it — at the plan
        the rep picked at the door, if they picked one — and an outcome that
        moves a sold lead somewhere else cancels it, so "Won" and "has a sale"
        never disagree. Before the roll-up, which reads the sale's value.
      */
      if (outcome === 'sold') {
        await winDeal(env, user, {
          propertyId,
          repId: user.id,
          wonAt: endedAt,
          planId: str(obj(p.deal).planId),
          visitId: id,
        })
      } else if (nextStatus) {
        await cancelDeal(env, user, propertyId)
      }

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
      const category = str(p.category) ?? 'property'
      /*
        The visit it was taken on, now that the phone sends it — but only a
        visit of this tenant's that the server already holds. A missing one
        (its own mutation refused) must not cost the photo its row, and a
        foreign one must never be linked.
      */
      const wantVisit = str(p.visitId)
      const visitId = wantVisit
        ? ((await env.DB.prepare('SELECT id FROM visits WHERE id = ?1 AND client_id = ?2')
            .bind(wantVisit, user.clientId)
            .first<{ id: string }>())?.id ?? null)
        : null
      await env.DB.prepare(
        `INSERT OR REPLACE INTO photos
           (id, client_id, property_id, visit_id, category, type, r2_key,
            width, height, bytes, captured_lat, captured_lng, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
      )
        .bind(
          id,
          user.clientId,
          propertyId,
          visitId,
          category,
          photoType(category, p.type),
          `${user.clientId}/${propertyId}/${id}.jpg`,
          num(p.width),
          num(p.height),
          num(p.bytes),
          num(obj(p.capturedAt).lat),
          num(obj(p.capturedAt).lng),
          num(p.createdAt) ?? Date.now(),
        )
        .run()
      /*
        Its line in the lead's history, keyed by the mutation id — the id the
        phone gave its own copy of this line — so the two are one row. OR IGNORE
        for the reason the status line gives: a replace keyed on a phone-chosen
        id could clobber another tenant's row.

        The label is the category as the company names it, sent by the phone
        because the server does not keep the renamed list; it is display text
        in this tenant's own history, trimmed and bounded.
      */
      const label = (str(p.label) ?? category).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Photo'
      await env.DB.prepare(
        `INSERT OR IGNORE INTO activity
           (id, client_id, property_id, rep_id, type, summary, at)
         VALUES (?1,?2,?3,?4,'photo',?5,?6)`,
      )
        .bind(m.id, user.clientId, propertyId, user.id, `Photo added · ${label}`, num(p.createdAt) ?? Date.now())
        .run()
      return
    }
    case 'photo.update': {
      // Refiling, after the fact: a different category, a different type, or
      // both. Only these two columns — the bytes and where they were taken
      // are facts about the photo, not opinions about it.
      const id = str(p.id)
      const category = str(p.category)
      if (!id || !category) throw new Error('photo.update: missing fields')
      const owned = await env.DB.prepare('SELECT 1 AS ok FROM photos WHERE id = ?1 AND client_id = ?2')
        .bind(id, user.clientId)
        .first()
      if (!owned) throw new Error('photo.update: unknown photo')
      await env.DB.prepare('UPDATE photos SET category = ?2, type = ?3 WHERE id = ?1 AND client_id = ?4')
        .bind(id, category, photoType(category, p.type), user.clientId)
        .run()
      return
    }

    case 'task.create': {
      const id = str(p.id)
      if (!id) throw new Error('task.create: missing id')
      // A to-do may point at a lead, and only at one of this company's: the
      // lead's history is written from it when a quote to-do is ticked off.
      const taskProperty = str(p.propertyId)
      if (taskProperty) await assertPropertyInTenant(env, user, taskProperty)
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
      /*
        A Send-quote to-do ticked off is the only record that a quote went
        out. It used to vanish from Today and leave nothing behind, so nobody
        could tell a quoted lead from one still waiting on its quote. Now it
        is a line in the lead's history, at the time the rep ticked it (sent
        by the phone, so a day offline keeps its real time). One row per task,
        so a retried write is the same row, and unticking takes it back.

        Writing a lead's history is editing the lead: the same rule as a
        status set by hand, so a rep cannot stamp "Quote sent" on a door they
        cannot see — checked before anything is written, so a refused write
        changes nothing, not even the tick.
      */
      const task = await env.DB.prepare('SELECT property_id, kind FROM tasks WHERE id = ?1 AND client_id = ?2')
        .bind(id, user.clientId)
        .first<{ property_id: string | null; kind: string }>()
      const stamps = task?.kind === 'quote' && !!task.property_id
      if (stamps) await assertMayEditProperty(env, user, task!.property_id!)
      await env.DB.prepare(
        'UPDATE tasks SET done = ?2 WHERE id = ?1 AND client_id = ?3',
      )
        .bind(id, p.done ? 1 : 0, user.clientId)
        .run()
      if (stamps) {
        const eventId = `quote:${id}`
        if (p.done) {
          // One row per to-do, so a retried tick is the same line. The
          // conflict clause is tenant-guarded: task ids are chosen by phones,
          // and a colliding id must never overwrite another company's row.
          await env.DB.prepare(
            `INSERT INTO activity
               (id, client_id, property_id, rep_id, type, summary, at)
             VALUES (?1,?2,?3,?4,'quote','Quote sent',?5)
             ON CONFLICT(id) DO UPDATE SET at = excluded.at, rep_id = excluded.rep_id
               WHERE activity.client_id = excluded.client_id`,
          )
            .bind(eventId, user.clientId, task!.property_id, user.id, num(p.at) ?? Date.now())
            .run()
        } else {
          await env.DB.prepare('DELETE FROM activity WHERE id = ?1 AND client_id = ?2').bind(eventId, user.clientId).run()
        }
      }
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
        /*
          The patch the new door is in.

          A lead added from the map used to arrive with no territory at all, so
          the Console filed it under Unassigned even when it sat in the middle
          of a drawn patch, and the other reps on that patch never saw it. The
          same geometry the import and the CRM use decides it here.
        */
        const lat = num(p.lat)
        const lng = num(p.lng)
        const territoryId = lat != null && lng != null ? await territoryAtPoint(env, user.clientId, lat, lng) : null
        await env.DB.prepare(
          `INSERT OR IGNORE INTO properties
             (id, client_id, address1, city, state, zip, lat, lng, status, score,
              assigned_rep_id, territory_id, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',50,?9,?11,?10)`,
        )
          .bind(
            id,
            user.clientId,
            str(p.address1) ?? 'Untitled property',
            str(p.city),
            str(p.state),
            str(p.zip),
            lat ?? 0,
            lng ?? 0,
            user.id,
            Date.now(),
            territoryId,
          )
          .run()
        /*
          The homeowner's name and number, typed at the door.

          These used to stay on the phone: the create carried only an id, so
          the office saw "Untitled property" at 0,0 with nobody in it, and the
          rep's own copy was replaced by that on the next refresh. The contacts
          ride the same mutation now, and are written the same way the import
          writes them.
        */
        await upsertContacts(env, id, p.contacts)
        // A lead added at the door is a new contact for the CRM.
        await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
        return
      }
      /*
        A status set by hand, from the phone or the console.

        A rep who marked the wrong door Not interested, or Lost, fixes it here
        without inventing a visit that never happened. Three rules, and an
        activity row so a manager can see the correction for what it is:

        - only a lead they may see (`assertMayEditProperty`) — this branch used
          to check the tenant alone, so a rep's session could set any status
          on any lead in the company;
        - only a real status;
        - a Do Not Contact stays one unless the office lifts it. A homeowner
          who asked not to be knocked is protected from an accidental edit,
          which is the same guard the office's bulk change carries.
      */
      const status = str(p.status) ?? ''
      if (!SETTABLE_STATUSES.has(status)) throw new Error('property.status: not a lead status')
      await assertMayEditProperty(env, user, id)
      const before = await env.DB.prepare(
        'SELECT status, assigned_rep_id FROM properties WHERE id = ?1 AND client_id = ?2',
      )
        .bind(id, user.clientId)
        .first<{ status: string; assigned_rep_id: string | null }>()
      if (!before) throw new Error('property not found in this account')
      if (before.status === 'dnc' && status !== 'dnc' && !canImport(user)) {
        throw new Error('This lead is marked Do Not Contact. Ask the office to lift that.')
      }
      if (before.status === status) return
      const at = Date.now()
      await env.DB.prepare(
        'UPDATE properties SET status = ?2, updated_at = ?3 WHERE id = ?1 AND client_id = ?4',
      )
        .bind(id, status, at, user.clientId)
        .run()
      // OR IGNORE, not OR REPLACE: the row's id is the mutation id the phone
      // chose, and `activity.id` is a global key. A replace would let a
      // colliding id delete whatever row already held it — another tenant's
      // visit included. A retry of this mutation never reaches here (the
      // ledger above answers it), so nothing legitimate is ever ignored.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO activity
           (id, client_id, property_id, rep_id, type, summary, at)
         VALUES (?1,?2,?3,?4,'status',?5,?6)`,
      )
        .bind(m.id, user.clientId, id, user.id, `Status set to ${STATUS_WORDS[status] ?? status} (was ${STATUS_WORDS[before.status] ?? before.status})`, at)
        .run()
      // Won by hand is still a sale — the lead's rep's, or whoever marked it.
      await syncDealToStatus(env, user, id, status, { repId: before.assigned_rep_id ?? user.id, wonAt: at })
      // A status changed by hand reaches the CRM the same way a rep's outcome
      // does — including a manual Do Not Contact.
      await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
      return
    }

    /*
      A sale changed after the door: a different plan, by anyone who may edit
      the lead, or a different value, by a manager with a reason. The rules
      are in deals.ts; the activity line is what a manager reads later to see
      why a number moved.
    */
    case 'deal.update': {
      const propertyId = str(p.propertyId)
      if (!propertyId) throw new Error('deal.update: missing propertyId')
      await assertMayEditProperty(env, user, propertyId)
      const summary = await updateDeal(env, user, { propertyId, planId: p.planId, value: p.value, reason: p.reason })
      if (!summary) return
      await env.DB.prepare(
        `INSERT OR IGNORE INTO activity
           (id, client_id, property_id, rep_id, type, summary, at)
         VALUES (?1,?2,?3,?4,'deal',?5,?6)`,
      )
        .bind(m.id, user.clientId, propertyId, user.id, summary, Date.now())
        .run()
      return
    }

    /*
      The details a rep learns at the door, after the lead exists.

      Address as read off the house, the homeowner's name, a number, an email,
      the lead's own tags — any of them may be wrong or missing when the lead
      is made and right five minutes later. Reps may only edit what they can
      see: their own leads, a house on a list handed to them, a territory they
      are on. The office may edit anything in the tenant. Status is not here;
      it has its own mutation above, with its own rules.
    */
    case 'property.update': {
      const id = str(p.id)
      if (!id) throw new Error('property.update: missing id')
      await assertMayEditProperty(env, user, id)
      // Tags the rep put on the lead itself — a bounded list of short words.
      // Absent means untouched; an empty list clears them.
      const tags = Array.isArray(p.tags)
        ? JSON.stringify(
            [...new Set(p.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 12),
          )
        : null
      await env.DB.prepare(
        `UPDATE properties
            SET address1 = COALESCE(?2, address1),
                city = COALESCE(?3, city),
                state = COALESCE(?4, state),
                zip = COALESCE(?5, zip),
                tags = COALESCE(?8, tags),
                -- A person who changed the street line has read it off the
                -- house: an estimated address stops being an estimate.
                address_confidence = CASE WHEN ?2 IS NOT NULL AND ?2 != address1 THEN 'MANUAL' ELSE address_confidence END,
                address_source = CASE WHEN ?2 IS NOT NULL AND ?2 != address1 THEN 'manual' ELSE address_source END,
                updated_at = ?6
          WHERE id = ?1 AND client_id = ?7`,
      )
        .bind(id, str(p.address1)?.trim() || null, str(p.city), str(p.state), str(p.zip), Date.now(), user.clientId, tags)
        .run()
      await upsertContacts(env, id, p.contacts)
      await queueForCrm(env, user.clientId, 'contact.upsert', { propertyId: id }, `contact:${id}`)
      return
    }

    /*
      Lead lists from the phone.

      A rep organising their week in a dead zone makes a list, drops houses on
      it, renames it — and all of that queues like every other edit and lands
      here when there is signal. Each case calls the same function the REST
      route calls, so a list made offline and a list made in the console obey
      the same permission checks and the same tenant isolation; there is one
      implementation of "may this person do this", not one per transport.

      A refusal (403, 404, 409) is thrown, which the caller records as a
      rejected mutation that the phone drops. That is right: a rep whose list
      name clashed, or who tried to add a house that is not theirs, gets told
      and does not retry for ever.
    */
    case 'list.create': {
      const r = await createList(env, user, {
        id: p.id,
        name: p.name,
        description: p.description,
        propertyIds: p.propertyIds,
        repIds: p.repIds,
        boundary: p.boundary,
      })
      if ('error' in r) throw new Error(`list.create: ${r.error}`)
      return
    }
    case 'list.update': {
      const id = str(p.id)
      if (!id) throw new Error('list.update: missing id')
      const r = await updateList(env, user, id, {
        name: p.name,
        description: p.description,
        archived: p.archived,
      })
      if ('error' in r) throw new Error(`list.update: ${r.error}`)
      return
    }
    case 'list.members': {
      const id = str(p.id)
      if (!id) throw new Error('list.members: missing id')
      const r = await updateMembers(env, user, id, { add: p.add, remove: p.remove })
      if ('error' in r) throw new Error(`list.members: ${r.error}`)
      return
    }
    case 'list.reps': {
      const id = str(p.id)
      if (!id) throw new Error('list.reps: missing id')
      const r = await setReps(env, user, id, { repIds: p.repIds })
      if ('error' in r) throw new Error(`list.reps: ${r.error}`)
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
/**
 * Write the contacts a phone sent, by id, so a retry is not a second person.
 *
 * Only the fields a rep types. `relationship` is kept if the office set it.
 */
async function upsertContacts(env: Env, propertyId: string, raw: unknown): Promise<void> {
  if (!Array.isArray(raw)) return
  for (const c of raw.slice(0, 10)) {
    const contact = obj(c)
    const cid = str(contact.id)
    const name = str(contact.name)?.trim()
    if (!cid || !name) continue
    await env.DB.prepare(
      `INSERT INTO contacts (id, property_id, name, phone, email, is_primary)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         phone = excluded.phone,
         email = excluded.email,
         is_primary = excluded.is_primary`,
    )
      .bind(cid, propertyId, name, str(contact.phone)?.trim() || null, str(contact.email)?.trim() || null, contact.isPrimary ? 1 : 0)
      .run()
  }
}

/**
 * The tenant check, and for a rep the scope check on top of it.
 *
 * The same line the phone draws (see canSee in src/lib/leadLists.ts): a rep
 * may touch a lead assigned to them or on a list handed to them, and nothing
 * else, however they came by its id.
 */
async function assertMayEditProperty(env: Env, user: SessionUser, propertyId: string): Promise<void> {
  await assertPropertyInTenant(env, user, propertyId)
  if (user.role !== 'field_rep') return
  // The same predicate bootstrap uses, so what a rep may edit is exactly
  // what their phone shows — one definition, not two that can drift.
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM properties p
      WHERE p.id = ?1 AND p.client_id = ?2 AND ${repScopeSql('p', '?3')}`,
  )
    .bind(propertyId, user.clientId, user.id)
    .first<{ ok: number }>()
  if (!row) throw new Error('not your lead')
}

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
 * Keep the reporting roll-up current as visits land. The recompute itself is
 * in deals.ts, because a sale changed after the fact moves the same row.
 */
async function bumpDailyStats(
  env: Env,
  user: SessionUser,
  at: number,
  outcome: string | null,
  propertyId: string,
): Promise<void> {
  if (!outcome) return
  void propertyId
  await recomputeDailyStats(env, user.clientId, user.id, user.timezone, at)
}

/**
 * The drawn territory a point falls in, for a lead added from the map.
 *
 * Built exactly as the CSV import and the CRM inbound build their shapes, so a
 * door added on the phone and the same door arriving in a file land in the same
 * patch. Null for a point in no patch: that lead stays with the rep who added it
 * and waits for a manager to place it.
 */
async function territoryAtPoint(env: Env, clientId: string, lat: number, lng: number): Promise<string | null> {
  const drawn = await env.DB.prepare('SELECT id, rep_id, boundary FROM territories WHERE client_id = ?1 AND boundary IS NOT NULL')
    .bind(clientId)
    .all<{ id: string; rep_id: string | null; boundary: string }>()
  const shapes: TerritoryShape[] = []
  for (const t of drawn.results ?? []) {
    const boundary = parseBoundary(t.boundary)
    if (!boundary) continue
    shapes.push({ id: String(t.id), repId: t.rep_id == null ? null : String(t.rep_id), boundary, areaSqMiles: polygonAreaSqMiles(boundary) })
  }
  return shapes.length ? (territoryFor({ lat, lng }, shapes)?.id ?? null) : null
}
