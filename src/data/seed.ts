import type {
  ActivityEvent,
  Appointment,
  Contact,
  LeadStatus,
  OutcomeCode,
  Property,
  Route,
  Task,
  User,
} from '../types'
import { dayKey } from '../lib/format'

/**
 * Deterministic demo territory for Summit Exteriors.
 *
 * Two rules govern this file:
 *
 *  1. **Deterministic.** Seeded RNG, so every reload and every device in a
 *     demo shows the identical neighborhood. A pitch that looks different on
 *     the second run is a pitch you can't rehearse.
 *  2. **Time-relative.** Every timestamp is derived from "now" at generation
 *     time, never hardcoded, and the whole bundle is regenerated when the day
 *     rolls over (see lib/demo.ts). Otherwise the demo empties out overnight —
 *     today's appointments become yesterday's and vanish from the Today screen.
 *
 * Replace with the real API once the backend lands; nothing outside this file
 * and lib/demo.ts knows the data is synthetic.
 */

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const FIRST = [
  'James', 'Maria', 'Robert', 'Linda', 'David', 'Patricia', 'Michael', 'Barbara',
  'William', 'Susan', 'Carlos', 'Jennifer', 'Tony', 'Denise', 'Marcus', 'Alicia',
  'Hector', 'Grace', 'Omar', 'Rachel', 'Kevin', 'Nadia', 'Sam', 'Priya',
]
const LAST = [
  'Alvarez', 'Whitfield', 'Nguyen', 'Brooks', 'Okafor', 'Delgado', 'Sinclair',
  'Marsh', 'Petrov', 'Hollis', 'Baptiste', 'Reyna', 'Kowalski', 'Ferrell',
  'Osei', 'Lindqvist', 'Mercado', 'Danvers',
]
const STREETS = [
  'Cypress Ridge Dr', 'Marigold Ln', 'Old Mill Rd', 'Harper Way', 'Bellcrest Ave',
  'Juniper Hollow', 'Sable Creek Dr', 'Winslow Ct', 'Ashford Park Blvd', 'Redbud Trail',
]

// Anchor: a real residential grid in Round Rock, TX — the demo territory.
const ANCHOR = { lat: 30.5083, lng: -97.6789 }
const PER_STREET = 16

/**
 * The field team.
 *
 * Five reps with genuinely different days, because a manager demo where every
 * rep shows identical numbers is the fastest way to lose the room. `doneStops`
 * and `conversionBias` drive that spread deterministically.
 */
export interface DemoRep {
  id: string
  name: string
  initials: string
  phone: string
  /** Indexes into STREETS — this rep's patch. */
  streets: [number, number]
  routeName: string
  doneStops: number
  routeStops: number
  /** 0–1; higher means more conversations per door. */
  conversionBias: number
}

export const FIELD_REPS: DemoRep[] = [
  {
    id: 'u_rep',
    name: 'Dana Whitfield',
    initials: 'DW',
    phone: '512-555-0142',
    streets: [0, 1],
    routeName: 'Cypress Ridge — North Loop',
    doneStops: 12,
    routeStops: 25,
    conversionBias: 0.46,
  },
  {
    id: 'u_rep2',
    name: 'Marcus Reyna',
    initials: 'MR',
    phone: '512-555-0188',
    streets: [2, 3],
    routeName: 'Old Mill — East',
    doneStops: 19,
    routeStops: 24,
    conversionBias: 0.31,
  },
  {
    id: 'u_rep3',
    name: 'Alicia Osei',
    initials: 'AO',
    phone: '512-555-0207',
    streets: [4, 5],
    routeName: 'Bellcrest — Storm List',
    doneStops: 22,
    routeStops: 26,
    conversionBias: 0.58,
  },
  {
    id: 'u_rep4',
    name: 'Tony Baptiste',
    initials: 'TB',
    phone: '512-555-0261',
    streets: [6, 7],
    routeName: 'Sable Creek — South',
    doneStops: 7,
    routeStops: 22,
    conversionBias: 0.38,
  },
  {
    id: 'u_rep5',
    name: 'Priya Lindqvist',
    initials: 'PL',
    phone: '512-555-0294',
    streets: [8, 9],
    routeName: 'Ashford Park — Callbacks',
    doneStops: 15,
    routeStops: 20,
    conversionBias: 0.5,
  },
]

/**
 * Sign-in options. Deliberately not every rep — the login screen stays a short
 * one-tap list, and the other four reps exist as teammates in manager views.
 */
export const DEMO_USERS: User[] = [
  {
    id: FIELD_REPS[0].id,
    name: FIELD_REPS[0].name,
    role: 'field_rep',
    clientId: 'c_summit',
    clientName: 'Summit Exteriors',
    avatarInitials: FIELD_REPS[0].initials,
    phone: FIELD_REPS[0].phone,
    email: 'dana@summitexteriors.com',
  },
  {
    id: 'u_mgr',
    name: 'Ray Okafor',
    role: 'manager',
    clientId: 'c_summit',
    clientName: 'Summit Exteriors',
    avatarInitials: 'RO',
    email: 'ray@summitexteriors.com',
  },
  {
    id: 'u_admin',
    name: 'Nadia Petrov',
    role: 'client_admin',
    clientId: 'c_summit',
    clientName: 'Summit Exteriors',
    avatarInitials: 'NP',
    email: 'nadia@summitexteriors.com',
  },
  {
    id: 'u_super',
    name: 'Curtis Lane',
    role: 'super_admin',
    clientId: 'platform',
    clientName: 'Allstar Platform',
    avatarInitials: 'CL',
    email: 'curtis@letlois.com',
  },
]

const STATUS_POOL: LeadStatus[] = [
  'new', 'new', 'new', 'new',
  'contacted', 'contacted', 'contacted',
  'working', 'working',
  'appointment',
  'quoted',
  'won',
  'lost', 'lost',
  'dnc',
]

/** Outcomes that count as a real conversation, for the conversion split. */
const GOOD: OutcomeCode[] = ['interested', 'appointment', 'quote_requested', 'sold']
const MISS: OutcomeCode[] = ['no_answer', 'no_answer', 'no_answer', 'not_interested', 'follow_up']

export interface SeedBundle {
  /** The day this bundle was generated for — used to detect a stale demo. */
  day: string
  properties: Property[]
  routes: Route[]
  appointments: Appointment[]
  tasks: Task[]
  activity: ActivityEvent[]
}

export function buildSeed(now = Date.now()): SeedBundle {
  const rand = rng(20260815)
  const properties: Property[] = []

  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const at = (h: number, m = 0) => startOfDay.getTime() + h * 3_600_000 + m * 60_000

  /** Which rep owns each street. */
  const repOfStreet = new Map<number, DemoRep>()
  FIELD_REPS.forEach((rep) => rep.streets.forEach((s) => repOfStreet.set(s, rep)))

  /* --- properties -------------------------------------------------------- */

  for (let s = 0; s < STREETS.length; s++) {
    const rep = repOfStreet.get(s) ?? FIELD_REPS[0]
    for (let i = 0; i < PER_STREET; i++) {
      const side = i % 2
      const along = Math.floor(i / 2)
      // ~0.0009 deg lat ≈ 100 yd; houses sit ~40 yd apart along the street.
      const lat = ANCHOR.lat + s * 0.0022 + side * 0.0007 + (rand() - 0.5) * 0.00012
      const lng = ANCHOR.lng + along * 0.0011 + (rand() - 0.5) * 0.00012

      const status = STATUS_POOL[Math.floor(rand() * STATUS_POOL.length)]
      const visited = status !== 'new' || rand() < 0.25
      const houseNo = 100 + s * 100 + along * 2 + side

      const contacts: Contact[] = []
      if (rand() > 0.18) {
        const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`
        contacts.push({
          id: `ct_${s}_${i}`,
          name,
          phone: `512-555-0${(100 + Math.floor(rand() * 899)).toString()}`,
          email: `${name.split(' ')[0].toLowerCase()}@example.com`,
          relationship: 'Owner',
          isPrimary: true,
        })
        if (rand() < 0.2) {
          contacts.push({
            id: `ct_${s}_${i}_b`,
            name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${name.split(' ')[1]}`,
            phone: `512-555-0${(100 + Math.floor(rand() * 899)).toString()}`,
            relationship: 'Spouse',
          })
        }
      }

      const hasOpp = ['working', 'appointment', 'quoted', 'won'].includes(status)

      properties.push({
        id: `p_${s}_${i}`,
        address1: `${houseNo} ${STREETS[s]}`,
        city: 'Round Rock',
        state: 'TX',
        zip: '78664',
        lat,
        lng,
        status,
        score: Math.max(
          4,
          Math.min(
            98,
            Math.round(
              30 +
                rand() * 40 +
                (hasOpp ? 25 : 0) +
                (status === 'dnc' || status === 'lost' ? -25 : 0),
            ),
          ),
        ),
        opportunityValue: hasOpp ? Math.round((6 + rand() * 26) * 1000) : undefined,
        contacts,
        ownerOccupied: rand() > 0.22,
        roofAgeYears: Math.round(3 + rand() * 22),
        squareFeet: Math.round(1400 + rand() * 2200),
        lastOutcome: visited ? MISS[Math.floor(rand() * MISS.length)] : undefined,
        lastVisitAt: visited
          ? now - Math.floor(rand() * 21) * 86_400_000 - Math.floor(rand() * 8) * 3_600_000
          : undefined,
        territoryId: `t_${Math.floor(s / 2)}`,
        assignedRepId: rep.id,
        tags: rand() < 0.15 ? ['storm-2026'] : undefined,
      })
    }
  }

  const byRep = (repId: string) => properties.filter((p) => p.assignedRepId === repId)

  /* --- one route per rep, plus today's activity -------------------------- */

  const routes: Route[] = []
  const activity: ActivityEvent[] = []
  const today = dayKey(now)

  FIELD_REPS.forEach((rep, r) => {
    // Each rep knocks at their own pace and started at a slightly different
    // time. Without this every rep's activity lands on identical timestamps and
    // a manager's live feed reads as obviously fabricated.
    const cadenceMin = 11 + ((r * 3) % 7)
    const staggerMs = r * 4 * 60_000

    const candidates = byRep(rep.id)
      .filter((p) => p.status !== 'dnc' && p.status !== 'won')
      .sort((a, b) => a.lat - b.lat || a.lng - b.lng)
      .slice(0, rep.routeStops)

    const done = Math.min(rep.doneStops, candidates.length)

    routes.push({
      id: `r_${rep.id}`,
      repId: rep.id,
      date: today,
      name: rep.routeName,
      // Everyone started somewhere in the last few hours of "this morning".
      startedAt: now - 3 * 3_600_000,
      stops: candidates.map((p, idx) => ({
        propertyId: p.id,
        order: idx,
        status: idx < done ? 'done' : idx === done ? 'active' : 'pending',
        completedAt:
          idx < done ? now - (done - idx) * cadenceMin * 60_000 - staggerMs : undefined,
      })),
    })

    // Completed stops become today's activity, with this rep's hit rate.
    candidates.slice(0, done).forEach((p, idx) => {
      const good = rand() < rep.conversionBias
      const outcome = good
        ? GOOD[Math.floor(rand() * GOOD.length)]
        : MISS[Math.floor(rand() * MISS.length)]
      const ts = now - (done - idx) * cadenceMin * 60_000 - staggerMs
      activity.push({
        id: `ev_${rep.id}_${idx}`,
        propertyId: p.id,
        repId: rep.id,
        type: 'visit',
        summary: p.address1,
        at: ts,
        outcome,
      })
      // Keep the property row consistent with the activity we just fabricated.
      p.lastOutcome = outcome
      p.lastVisitAt = ts
    })
  })

  activity.sort((a, b) => b.at - a.at)

  /* --- appointments and follow-ups --------------------------------------- */

  const appointments: Appointment[] = []
  const tasks: Task[] = []

  FIELD_REPS.forEach((rep, r) => {
    const apptProps = byRep(rep.id).filter((p) => p.status === 'appointment').slice(0, 2)
    apptProps.forEach((p, i) => {
      // Spread across the afternoon, and keep at least one still ahead of "now"
      // so the Today screen always has something upcoming to show.
      const hour = 13 + ((r + i * 2) % 6)
      appointments.push({
        id: `a_${rep.id}_${i}`,
        propertyId: p.id,
        repId: rep.id,
        startsAt: at(hour, i === 0 ? 0 : 30),
        durationMin: 45,
        title: i === 0 ? 'Roof inspection' : 'Estimate review',
        contactId: p.contacts[0]?.id,
        notes: i === 0 ? 'Bring ladder + sample shingles' : undefined,
      })
    })

    const followProps = byRep(rep.id).filter((p) => p.lastOutcome === 'follow_up').slice(0, 4)
    followProps.forEach((p, i) => {
      tasks.push({
        id: `t_${rep.id}_${i}`,
        repId: rep.id,
        propertyId: p.id,
        title: `Follow up — ${p.contacts[0]?.name ?? p.address1}`,
        // Some earlier today (overdue), some later — a believable mix.
        dueAt: at(9 + i * 3),
        done: i === 0,
        kind: 'follow_up',
      })
    })

    tasks.push({
      id: `t_${rep.id}_admin`,
      repId: rep.id,
      title: 'Submit yesterday’s photos',
      dueAt: at(17),
      done: false,
      kind: 'admin',
    })
  })

  return { day: today, properties, routes, appointments, tasks, activity }
}
