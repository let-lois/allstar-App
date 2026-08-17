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
 * Deterministic demo territory.
 *
 * Seeded so every reload — and every device in a demo — shows the same
 * neighborhood. Replace with the real API once the backend lands; nothing
 * outside this file knows the data is synthetic.
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

export const DEMO_USERS: User[] = [
  {
    id: 'u_rep',
    name: 'Dana Whitfield',
    role: 'field_rep',
    clientId: 'c_summit',
    clientName: 'Summit Exteriors',
    avatarInitials: 'DW',
    phone: '512-555-0142',
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

const OUTCOME_POOL: OutcomeCode[] = [
  'no_answer', 'no_answer', 'no_answer',
  'interested', 'follow_up', 'not_interested',
  'appointment', 'quote_requested', 'sold',
]

export interface SeedBundle {
  properties: Property[]
  route: Route
  appointments: Appointment[]
  tasks: Task[]
  activity: ActivityEvent[]
}

export function buildSeed(repId = 'u_rep'): SeedBundle {
  const rand = rng(20260815)
  const properties: Property[] = []
  const now = Date.now()

  // ~14 blocks laid out on a grid so the map reads like a real subdivision.
  const PER_STREET = 16
  for (let s = 0; s < STREETS.length; s++) {
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
        score: Math.round(
          30 +
            rand() * 40 +
            (hasOpp ? 25 : 0) +
            (status === 'dnc' || status === 'lost' ? -25 : 0),
        ),
        opportunityValue: hasOpp ? Math.round((6 + rand() * 26) * 1000) : undefined,
        contacts,
        ownerOccupied: rand() > 0.22,
        roofAgeYears: Math.round(3 + rand() * 22),
        squareFeet: Math.round(1400 + rand() * 2200),
        lastOutcome: visited
          ? OUTCOME_POOL[Math.floor(rand() * OUTCOME_POOL.length)]
          : undefined,
        lastVisitAt: visited
          ? now - Math.floor(rand() * 21) * 86_400_000 - Math.floor(rand() * 8) * 3_600_000
          : undefined,
        territoryId: `t_${Math.floor(s / 3)}`,
        assignedRepId: repId,
        tags: rand() < 0.15 ? ['storm-2026'] : undefined,
      })
    }
  }

  // Clamp scores after the modifiers above.
  properties.forEach((p) => {
    p.score = Math.max(4, Math.min(98, p.score))
  })

  /* --- Today's route ---------------------------------------------------- */

  // A believable working route: one contiguous run of streets, 25 stops, with
  // the first 12 already knocked so "Today" has real progress to show.
  const routeCandidates = properties
    .filter((p) => p.status !== 'dnc' && p.status !== 'won')
    .slice(0, 120)
    .sort((a, b) => a.lat - b.lat || a.lng - b.lng)
    .slice(20, 45)

  const route: Route = {
    id: 'r_today',
    repId,
    date: dayKey(now),
    name: 'Cypress Ridge — North Loop',
    startedAt: now - 3 * 3_600_000,
    stops: routeCandidates.map((p, idx) => ({
      propertyId: p.id,
      order: idx,
      status: idx < 12 ? 'done' : idx === 12 ? 'active' : 'pending',
      completedAt: idx < 12 ? now - (12 - idx) * 14 * 60_000 : undefined,
    })),
  }

  /* --- Appointments, tasks, activity ------------------------------------ */

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const at = (h: number, m = 0) => startOfDay.getTime() + h * 3_600_000 + m * 60_000

  const apptProps = properties.filter((p) => p.status === 'appointment').slice(0, 3)
  const appointments: Appointment[] = apptProps.map((p, i) => ({
    id: `a_${i}`,
    propertyId: p.id,
    repId,
    startsAt: at(14 + i * 2, i === 0 ? 0 : 30),
    durationMin: 45,
    title: i === 0 ? 'Roof inspection' : 'Estimate review',
    contactId: p.contacts[0]?.id,
    notes: i === 0 ? 'Bring ladder + sample shingles' : undefined,
  }))

  const followProps = properties.filter((p) => p.lastOutcome === 'follow_up').slice(0, 5)
  const tasks: Task[] = [
    ...followProps.map((p, i) => ({
      id: `t_${i}`,
      repId,
      propertyId: p.id,
      title: `Follow up — ${p.contacts[0]?.name ?? p.address1}`,
      dueAt: at(9 + i * 2),
      done: i < 2,
      kind: 'follow_up' as const,
    })),
    {
      id: 't_admin',
      repId,
      title: 'Submit yesterday’s photos',
      dueAt: at(17),
      done: false,
      kind: 'admin' as const,
    },
  ]

  const doneStops = route.stops.filter((s) => s.status === 'done')
  const activity: ActivityEvent[] = doneStops
    .map((s, i) => {
      const p = properties.find((x) => x.id === s.propertyId)!
      const outcome = OUTCOME_POOL[Math.floor(rand() * OUTCOME_POOL.length)]
      return {
        id: `ev_${i}`,
        propertyId: p.id,
        repId,
        type: 'visit' as const,
        summary: p.address1,
        at: s.completedAt ?? now,
        outcome,
      }
    })
    .sort((a, b) => b.at - a.at)

  // Keep the property rows consistent with the activity we just fabricated.
  activity.forEach((ev) => {
    const p = properties.find((x) => x.id === ev.propertyId)
    if (p && ev.outcome) {
      p.lastOutcome = ev.outcome
      p.lastVisitAt = ev.at
    }
  })

  return { properties, route, appointments, tasks, activity }
}
