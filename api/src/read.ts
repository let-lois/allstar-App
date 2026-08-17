import type { Env, SessionUser } from './types'

/**
 * The read path.
 *
 * One `bootstrap` call returns everything the client caches locally, because a
 * field app can't make eight round trips on one bar of signal — and because the
 * client is offline-first, this is the *only* read it needs to work all day.
 *
 * Scoping is by role, enforced here: a rep gets their own patch, office roles
 * get the whole tenant. The client also scopes its own screens, but a client
 * filter is a convenience, never a security boundary.
 */

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

const isRep = (u: SessionUser) => u.role === 'field_rep'

export async function bootstrap(env: Env, user: SessionUser) {
  const today = dayKey(Date.now())
  // 30 days back is what the console's longest range needs; the phone ignores it.
  const historyFrom = dayKey(Date.now() - 30 * 86_400_000)

  const scope = isRep(user) ? 'AND assigned_rep_id = ?2' : ''
  const bind = (base: unknown[]) => (isRep(user) ? [...base, user.id] : base)

  const [properties, contacts, routes, stops, appointments, tasks, activity, stats] =
    await Promise.all([
      env.DB.prepare(
        `SELECT * FROM properties WHERE client_id = ?1 ${scope} ORDER BY address1`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      env.DB.prepare(
        `SELECT c.* FROM contacts c
           JOIN properties p ON p.id = c.property_id
          WHERE p.client_id = ?1 ${isRep(user) ? 'AND p.assigned_rep_id = ?2' : ''}`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      env.DB.prepare(
        `SELECT * FROM routes WHERE client_id = ?1 AND date = ?2
          ${isRep(user) ? 'AND rep_id = ?3' : ''}`,
      )
        .bind(...(isRep(user) ? [user.clientId, today, user.id] : [user.clientId, today]))
        .all(),

      env.DB.prepare(
        `SELECT s.* FROM route_stops s
           JOIN routes r ON r.id = s.route_id
          WHERE r.client_id = ?1 AND r.date = ?2
          ${isRep(user) ? 'AND r.rep_id = ?3' : ''}
          ORDER BY s.ord`,
      )
        .bind(...(isRep(user) ? [user.clientId, today, user.id] : [user.clientId, today]))
        .all(),

      env.DB.prepare(
        `SELECT * FROM appointments WHERE client_id = ?1
          ${isRep(user) ? 'AND rep_id = ?2' : ''} ORDER BY starts_at`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      env.DB.prepare(
        `SELECT * FROM tasks WHERE client_id = ?1
          ${isRep(user) ? 'AND rep_id = ?2' : ''} ORDER BY due_at`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      // Capped: the feed is a recent-activity view, not an audit log, and an
      // unbounded scan is the query that gets slow first as a tenant grows.
      env.DB.prepare(
        `SELECT * FROM activity WHERE client_id = ?1
          ${isRep(user) ? 'AND rep_id = ?2' : ''} ORDER BY at DESC LIMIT 300`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      env.DB.prepare(
        `SELECT * FROM daily_stats WHERE client_id = ?1 AND day >= ?2 ORDER BY day`,
      )
        .bind(user.clientId, historyFrom)
        .all(),
    ])

  const contactsByProperty = new Map<string, unknown[]>()
  for (const c of contacts.results as Record<string, unknown>[]) {
    const key = String(c.property_id)
    const list = contactsByProperty.get(key)
    const shaped = {
      id: c.id,
      name: c.name,
      phone: c.phone ?? undefined,
      email: c.email ?? undefined,
      relationship: c.relationship ?? undefined,
      isPrimary: !!c.is_primary,
    }
    if (list) list.push(shaped)
    else contactsByProperty.set(key, [shaped])
  }

  const stopsByRoute = new Map<string, unknown[]>()
  for (const s of stops.results as Record<string, unknown>[]) {
    const key = String(s.route_id)
    const shaped = {
      propertyId: s.property_id,
      order: s.ord,
      status: s.status,
      completedAt: s.completed_at ?? undefined,
    }
    const list = stopsByRoute.get(key)
    if (list) list.push(shaped)
    else stopsByRoute.set(key, [shaped])
  }

  // Shaped into the client's camelCase domain model here rather than in the
  // client, so swapping the data source stays a one-file change over there.
  return {
    user,
    properties: (properties.results as Record<string, unknown>[]).map((p) => ({
      id: p.id,
      address1: p.address1,
      city: p.city,
      state: p.state,
      zip: p.zip,
      lat: p.lat,
      lng: p.lng,
      status: p.status,
      score: p.score,
      opportunityValue: p.opportunity_value ?? undefined,
      ownerOccupied: p.owner_occupied == null ? undefined : !!p.owner_occupied,
      roofAgeYears: p.roof_age_years ?? undefined,
      squareFeet: p.square_feet ?? undefined,
      lastOutcome: p.last_outcome ?? undefined,
      lastVisitAt: p.last_visit_at ?? undefined,
      nextActionAt: p.next_action_at ?? undefined,
      nextActionLabel: p.next_action_label ?? undefined,
      territoryId: p.territory_id ?? undefined,
      assignedRepId: p.assigned_rep_id ?? undefined,
      tags: p.tags ? JSON.parse(String(p.tags)) : undefined,
      contacts: contactsByProperty.get(String(p.id)) ?? [],
    })),
    routes: (routes.results as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      repId: r.rep_id,
      date: r.date,
      name: r.name,
      startedAt: r.started_at ?? undefined,
      stops: stopsByRoute.get(String(r.id)) ?? [],
    })),
    appointments: (appointments.results as Record<string, unknown>[]).map((a) => ({
      id: a.id,
      propertyId: a.property_id,
      repId: a.rep_id,
      startsAt: a.starts_at,
      durationMin: a.duration_min,
      title: a.title,
      contactId: a.contact_id ?? undefined,
      notes: a.notes ?? undefined,
    })),
    tasks: (tasks.results as Record<string, unknown>[]).map((t) => ({
      id: t.id,
      repId: t.rep_id,
      propertyId: t.property_id ?? undefined,
      title: t.title,
      dueAt: t.due_at,
      done: !!t.done,
      kind: t.kind,
    })),
    activity: (activity.results as Record<string, unknown>[]).map((a) => ({
      id: a.id,
      propertyId: a.property_id ?? undefined,
      repId: a.rep_id,
      type: a.type,
      summary: a.summary,
      outcome: a.outcome ?? undefined,
      at: a.at,
    })),
    dailyStats: (stats.results as Record<string, unknown>[]).map((s) => ({
      id: s.id,
      repId: s.rep_id,
      day: s.day,
      knocks: s.knocks,
      conversations: s.conversations,
      appointments: s.appointments,
      quotes: s.quotes,
      sold: s.sold,
      pipelineValue: s.pipeline_value,
    })),
    serverTime: Date.now(),
  }
}
