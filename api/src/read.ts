import { readSettings } from './settings'
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

  const [
    properties,
    contacts,
    routes,
    stops,
    appointments,
    tasks,
    activity,
    stats,
    territories,
    roster,
  ] = await Promise.all([
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

      // Names, so the console can label a territory instead of printing its id.
      // Not scoped to the rep: a territory is a label on properties they already
      // have, and hiding the name would only show them a hash.
      env.DB.prepare(`SELECT * FROM territories WHERE client_id = ?1 ORDER BY name`)
        .bind(user.clientId)
        .all(),

      /*
        The roster, for everybody — names and initials only.

        A rep could already see the whole team's daily numbers (`daily_stats` is
        not rep-scoped, deliberately, because the standings are the point of the
        thing), but they had no way to turn a `rep_id` into a person: the roster
        comes from `/api/users`, which 403s for a field rep. So a rep's
        leaderboard would have been a list of hashes.

        Deliberately narrower than `/api/users`. Teammates' names are not
        sensitive — they work together every day. E-mail addresses and phone
        numbers are, and those stay behind the office-only endpoint. A profile
        photo sits with the names: it is the face of someone a rep works beside,
        and it is the whole reason a standings row reads as a person.

        It is also the widest column here — ~20KB per teammate — so it rides
        bootstrap rather than being fetched per row. On a ten-person crew that
        is 200KB once, against ten requests a rep on one bar would watch fail
        one at a time.
      */
      env.DB.prepare(
        `SELECT id, name, role, active, avatar_url FROM users WHERE client_id = ?1 ORDER BY name`,
      )
        .bind(user.clientId)
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
  // Bundled with everything else the phone caches: a rep who opens the app with
  // no signal must still see the outcome labels their company chose.
  const settings = await readSettings(env, user.clientId)

  return {
    user,
    settings,
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
    territories: (territories.results as Record<string, unknown>[]).map((t) => ({
      id: t.id,
      name: t.name,
      repId: t.rep_id ?? undefined,
      /*
        Parsed defensively. This column arrived by migration, so old rows hold
        null and — if anything ever wrote to it by hand — it could hold anything.
        A territory with an unreadable outline is still a perfectly good
        territory, so a parse failure drops the shape rather than the row.
      */
      boundary: parseBoundary(t.boundary),
    })),
    team: (roster.results as Record<string, unknown>[]).map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      active: (u.active ?? 1) === 1,
      avatarUrl: u.avatar_url ?? undefined,
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

function parseBoundary(raw: unknown): { lat: number; lng: number }[] | undefined {
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
