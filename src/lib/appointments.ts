import type { Appointment } from '../types'

/**
 * Appointments by lead, for the office's Leads table.
 *
 * Appointments are their own rows (`appointments` table: a start time, a
 * length, a title, the rep who booked it) and until now the only place to see
 * one was the lead itself — a manager looking for "who has an appointment this
 * week" had to open every house. This is the lookup the table's column, filter
 * and sort share, kept apart from the screen so a dedicated Appointments page
 * can reuse it if one is wanted.
 *
 * There is no status on an appointment (no cancelled, no completed, no
 * no-show): the schema does not have one, so "upcoming" here means only that
 * its start time has not passed.
 */
export interface LeadAppointments {
  /** The soonest one that has not started yet. */
  next?: Appointment
  /** The most recent one that has. */
  last?: Appointment
  count: number
}

export function appointmentsByLead(all: Iterable<Appointment>, now = Date.now()): Map<string, LeadAppointments> {
  const by = new Map<string, LeadAppointments>()
  for (const a of all) {
    const cur = by.get(a.propertyId) ?? { count: 0 }
    cur.count++
    if (a.startsAt >= now) {
      if (!cur.next || a.startsAt < cur.next.startsAt) cur.next = a
    } else if (!cur.last || a.startsAt > cur.last.startsAt) {
      cur.last = a
    }
    by.set(a.propertyId, cur)
  }
  return by
}

export type AppointmentFilter = 'any' | 'upcoming' | 'has' | 'none'

export const APPOINTMENT_FILTERS: { key: AppointmentFilter; label: string }[] = [
  { key: 'any', label: 'Appointment: any' },
  { key: 'upcoming', label: 'Upcoming appointment' },
  { key: 'has', label: 'Has an appointment' },
  { key: 'none', label: 'No appointment' },
]

export function matchesAppointment(entry: LeadAppointments | undefined, filter: AppointmentFilter): boolean {
  switch (filter) {
    case 'any':
      return true
    case 'upcoming':
      return !!entry?.next
    case 'has':
      return (entry?.count ?? 0) > 0
    case 'none':
      return !entry || entry.count === 0
  }
}

/** Soonest upcoming first; leads with no upcoming appointment after, in their order. */
export function byNextAppointment(a: LeadAppointments | undefined, b: LeadAppointments | undefined): number {
  const x = a?.next?.startsAt ?? Infinity
  const y = b?.next?.startsAt ?? Infinity
  return x === y ? 0 : x < y ? -1 : 1
}
