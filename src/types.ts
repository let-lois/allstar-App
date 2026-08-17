// Domain model for Allstar field sales.
//
// The shapes here are deliberately flat and small: everything in this file gets
// written to IndexedDB and replayed from a sync queue, so records need to be
// cheap to serialize and safe to merge field-by-field.

export type Role = 'super_admin' | 'client_admin' | 'manager' | 'field_rep'

export interface User {
  id: string
  name: string
  role: Role
  clientId: string
  clientName: string
  avatarInitials: string
  phone?: string
  email?: string
}

/** Outcome codes are stable; labels/colors are client-configurable (see OutcomeDef). */
export type OutcomeCode =
  | 'no_answer'
  | 'interested'
  | 'follow_up'
  | 'appointment'
  | 'quote_requested'
  | 'not_interested'
  | 'sold'
  | 'do_not_contact'

export interface OutcomeDef {
  code: OutcomeCode
  label: string
  /** Tailwind-ish token used for the pill/target color. */
  tone: string
  /** Short glyph shown on the big touch target — readable at arm's length. */
  glyph: string
  /** Outcomes that advance the pipeline get a follow-up prompt by default. */
  promptsFollowUp?: boolean
  /** Terminal outcomes stop the property from being re-routed. */
  terminal?: boolean
}

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'working'
  | 'appointment'
  | 'quoted'
  | 'won'
  | 'lost'
  | 'dnc'

export interface Contact {
  id: string
  name: string
  phone?: string
  email?: string
  relationship?: string
  isPrimary?: boolean
}

export interface Property {
  id: string
  address1: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  /** Denormalized for the map/list — avoids a join on every render. */
  status: LeadStatus
  score: number // 0-100 lead score
  opportunityValue?: number
  contacts: Contact[]
  ownerOccupied?: boolean
  roofAgeYears?: number
  squareFeet?: number
  lastOutcome?: OutcomeCode
  lastVisitAt?: number
  nextActionAt?: number
  nextActionLabel?: string
  territoryId?: string
  assignedRepId?: string
  tags?: string[]
}

export type NoteTag =
  | 'homeowner'
  | 'renter'
  | 'spouse_needed'
  | 'callback'
  | 'gate_code'
  | 'dog'
  | 'storm_damage'
  | 'competitor'

export interface Note {
  id: string
  propertyId: string
  visitId?: string
  body: string
  tags: NoteTag[]
  authorId: string
  createdAt: number
  /** True while the note only exists locally. */
  pending?: boolean
}

export type PhotoCategory =
  | 'property'
  | 'roof'
  | 'damage'
  | 'interior'
  | 'document'
  | 'before'
  | 'after'

export interface Photo {
  id: string
  propertyId: string
  visitId?: string
  category: PhotoCategory
  /** Compressed data URL. Kept local-first; upload happens through the sync queue. */
  dataUrl: string
  width: number
  height: number
  bytes: number
  createdAt: number
  capturedAt?: { lat: number; lng: number }
  pending?: boolean
}

export interface Visit {
  id: string
  propertyId: string
  repId: string
  startedAt: number
  endedAt?: number
  outcome?: OutcomeCode
  noteId?: string
  photoIds: string[]
  /** Where the rep actually was when they started — proof-of-visit. */
  startLocation?: { lat: number; lng: number; accuracy: number }
  nextActionAt?: number
  nextActionType?: 'follow_up' | 'appointment' | 'quote' | 'none'
  durationMs?: number
  pending?: boolean
}

export interface RouteStop {
  propertyId: string
  order: number
  status: 'pending' | 'active' | 'done' | 'skipped'
  completedAt?: number
}

export interface Route {
  id: string
  repId: string
  /** YYYY-MM-DD, local to the rep. */
  date: string
  name: string
  stops: RouteStop[]
  startedAt?: number
}

export interface Appointment {
  id: string
  propertyId: string
  repId: string
  startsAt: number
  durationMin: number
  title: string
  contactId?: string
  notes?: string
  pending?: boolean
}

export interface Task {
  id: string
  repId: string
  propertyId?: string
  title: string
  dueAt: number
  done: boolean
  kind: 'follow_up' | 'call' | 'quote' | 'admin'
  pending?: boolean
}

export interface ActivityEvent {
  id: string
  propertyId?: string
  repId: string
  type: 'visit' | 'note' | 'photo' | 'call' | 'sms' | 'appointment' | 'status'
  summary: string
  at: number
  outcome?: OutcomeCode
}

/**
 * One rep's day, rolled up.
 *
 * Reporting needs weeks of history; storing every individual visit for that
 * would be thousands of rows the phone never reads. The office console works
 * off these aggregates and drills into live records only for today.
 */
export interface DailyStat {
  /** `${repId}:${day}` */
  id: string
  repId: string
  /** YYYY-MM-DD */
  day: string
  knocks: number
  conversations: number
  appointments: number
  quotes: number
  sold: number
  pipelineValue: number
}

/* ---------------------------------------------------------------------------
 * Offline sync
 * ------------------------------------------------------------------------- */

export type MutationKind =
  | 'visit.start'
  | 'visit.complete'
  | 'note.create'
  | 'photo.create'
  | 'property.status'
  | 'task.create'
  | 'task.complete'
  | 'appointment.create'
  | 'route.stop'
  | 'comm.log'

export interface Mutation {
  id: string
  kind: MutationKind
  payload: unknown
  createdAt: number
  attempts: number
  lastError?: string
  /** Set once the server acknowledges; row is then pruned. */
  status: 'queued' | 'sending' | 'failed'
}

export type SyncState = 'synced' | 'syncing' | 'pending' | 'offline' | 'error'
