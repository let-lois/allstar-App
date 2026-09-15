import { readSettings } from './settings'
import { dayKeyIn } from './day'
import { readMe } from './me'
import type { Env, SessionUser } from './types'
import { parseBoundary } from './territories'
import { listsFor, repScopeSql } from './lists'

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



const isRep = (u: SessionUser) => u.role === 'field_rep'

export async function bootstrap(env: Env, user: SessionUser) {
  // The company's calendar — the same one the rows were bucketed on. Asking in
  // UTC would clip or over-serve a day at each end of the window.
  const today = dayKeyIn(Date.now(), user.timezone)
  // 30 days back is what the console's longest range needs; the phone ignores it.
  const historyFrom = dayKeyIn(Date.now() - 30 * 86_400_000, user.timezone)

  /*
    A rep's leads: assigned to them, OR on a live list assigned to them.

    The second half is new, and it is the whole point of lead lists — a manager
    hands forty houses to three people, and all three need those houses on their
    phones, while each house still has one `assigned_rep_id`. The predicate is
    written once in lists.ts and used here, so the bootstrap and the "may this
    rep add that lead" check can never disagree about what a rep may see.
  */
  const scope = isRep(user) ? `AND ${repScopeSql('properties', '?2')}` : ''
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
    erased,
    notes,
  ] = await Promise.all([
      env.DB.prepare(
        `SELECT * FROM properties WHERE properties.client_id = ?1 ${scope} ORDER BY address1`,
      )
        .bind(...bind([user.clientId]))
        .all(),

      env.DB.prepare(
        `SELECT c.* FROM contacts c
           JOIN properties p ON p.id = c.property_id
          WHERE p.client_id = ?1 ${isRep(user) ? `AND ${repScopeSql('p', '?2')}` : ''}`,
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

      /*
        Leads that have been erased, so the phones can erase their copies too.

        This is the only part of bootstrap that describes what is *not* here.
        Every other list is "what you should have"; a device can work out
        removals by comparing that against what it holds — except for the three
        stores bootstrap never sends. Visits, notes and photographs are the work
        a rep did on their own phone and the server does not return them, so
        nothing in a normal refresh ever removes one. Those are also the rows
        that hold the actual personal data: the free text a rep typed about a
        household, and the pictures of their house. Without this list an erasure
        stops at the server and the photographs stay in a pocket.

        Not scoped to the rep, unlike almost everything else here. A lead can be
        reassigned and then erased, and the phone that worked it in March still
        holds the notes in June — narrowing this to the current assignee would
        leave exactly those copies behind.

        Every one, with no window and no watermark. The tempting version keeps a
        cursor and sends only what is new, and its failure mode is a device that
        misses its window and keeps the data forever, silently. An id is about
        thirty bytes: a thousand erasures is 30KB against the 200KB of profile
        photographs already in this response. If a company ever erases enough
        leads for that to matter, the answer is a watermark done carefully — not
        a cap, which is the same silent failure with a friendlier name.
      */
      env.DB.prepare(
        `SELECT entity_id FROM deletions
          WHERE client_id = ?1 AND entity = 'property' ORDER BY at`,
      )
        .bind(user.clientId)
        .all<{ entity_id: string }>(),

      /*
        Notes, so the office can read what a rep learned at the door.

        Bootstrap never sent these: a note was work a phone did and kept. That
        held until a manager asked, reasonably, to see what their rep wrote
        about a house — and found the only place the text existed off the phone
        was the CSV export. Scoped like properties, so a rep receives notes on
        houses they can see (including a teammate's on a shared list) and
        nothing else. Newest first and capped: this is what the office reads
        today, not an archive, and an unbounded scan is the query that slows
        first as a tenant grows.
      */
      env.DB.prepare(
        `SELECT n.* FROM notes n
           JOIN properties p ON p.id = n.property_id
          WHERE p.client_id = ?1 ${isRep(user) ? `AND ${repScopeSql('p', '?2')}` : ''}
          ORDER BY n.created_at DESC LIMIT 3000`,
      )
        .bind(...bind([user.clientId]))
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
    /*
      The whole person, not the session's eight fields. The phone re-reads its
      user from every bootstrap, and a bootstrap that carried less than the
      login payload would erase `onboarding` from state mid-flow — the shell
      would vanish under a rep at step three the first time the outbox
      refreshed. Falls back to the session user if the read fails, so a
      failed migration still degrades this and never the bootstrap.
    */
    user: (await readMe(env, user.id).catch(() => null)) ?? user,
    settings,
    erased: (erased.results ?? []).map((r) => r.entity_id),
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
      // How well the pin is known. Sent to the phone because the honesty has to
      // reach the person standing on the pavement, not just the office.
      geoPrecision: p.geo_precision ?? undefined,
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
    /*
      The lists this person can see, members and reps included. Fetched after
      the batch above rather than inside it because it is two-to-four queries of
      its own and reads cleanest as one call; on a ten-list account it is
      milliseconds either way.
    */
    leadLists: await listsFor(env, user),
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
      /*
        The column is still called `pipeline_value` in D1 — renaming it needs a
        migration and buys nothing the client can see. What it *holds* changed:
        money closed on that day, not a running lifetime total. So the wire name
        is the honest one, and this line is the seam between them.
      */
      closedValue: s.pipeline_value,
    })),
    notes: (notes.results as Record<string, unknown>[]).map((n) => ({
      id: n.id,
      propertyId: n.property_id,
      visitId: n.visit_id ?? undefined,
      body: n.body ?? '',
      tags: n.tags ? JSON.parse(String(n.tags)) : [],
      authorId: n.author_id,
      createdAt: n.created_at,
    })),
    serverTime: Date.now(),
    /*
      The calendar the rows above were bucketed on.

      Sent so the client can agree with the server about which day it is rather
      than guessing from the device. A phone in the right timezone would get the
      same answer; a phone that has travelled, or is set wrong, would not — and
      a rep whose board disagrees with their manager's console has no way to
      tell which one is lying.
    */
    timezone: user.timezone,
  }
}

