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
  /**
   * A profile photo, as a compressed data URL.
   *
   * Inline rather than a URL because this app is offline-first: a rep opening
   * the team list in a basement gets faces or nothing, and "nothing" would mean
   * a screen of grey circles exactly when the network is the reason they cannot
   * be filled. At 256px it is ~20KB, which is the price of that.
   */
  avatarUrl?: string
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
  /**
   * Somebody asked us to come back.
   *
   * Distinct from `contacted`, which only says a conversation happened. This one
   * carries an obligation, which is why it is worth its own colour on the map: a
   * street full of follow-ups is a route, and a street full of "contacted" is
   * just history.
   */
  | 'follow_up'
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
  /**
   * How well `lat`/`lng` above are actually known.
   *
   * `rooftop` is on the building. `interpolated` is a house number estimated
   * along a block — right street, right side, probably not the right house.
   * `approximate` is coarser still.
   *
   * Undefined means *unknown*, not bad: leads imported before this was recorded
   * have no answer either way, and the map says so rather than accusing them of
   * being wrong. Treating "we don't know" as "it's approximate" would put a
   * warning on thousands of pins that may well be exact.
   */
  geoPrecision?: 'rooftop' | 'interpolated' | 'approximate'
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
  /**
   * The compressed image itself.
   *
   * Optional, because a photo can exist on this device without its bytes: the
   * office opening a roof shot a rep took on their own phone has the row from
   * the server and nothing to draw yet. Present means the bytes are here and the
   * photo works with no signal; absent means they are a fetch away.
   */
  dataUrl?: string
  width: number
  height: number
  bytes: number
  createdAt: number
  capturedAt?: { lat: number; lng: number }
  /**
   * The bytes are not on the server yet.
   *
   * This flag *is* the upload queue. A second store listing photos to send
   * could disagree with the photos themselves — a row for a photo that was
   * deleted, a photo with no row — and the failure mode of that disagreement is
   * a rep whose sync chip never goes green with nothing to point at. Reading
   * the queue off the photos is one source of truth by construction.
   */
  pending?: boolean
  /** Failed upload attempts, for backoff and for giving up. */
  attempts?: number
  /** Why the last attempt failed, so the queue screen can say. */
  lastError?: string
  /** When the bytes reached the server. */
  uploadedAt?: number
  /**
   * The deployment has no photo storage bound, so there is nothing to retry
   * and nothing wrong. Distinct from a failure: the photo is fine, it simply
   * lives here and only here.
   */
  localOnly?: boolean
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

/**
 * Somebody with an account, as the console sees them.
 *
 * Distinct from `User`, which is the signed-in identity. This is a roster entry:
 * it carries whether they've accepted their invite, which `User` never needs to
 * know about itself.
 */
export interface TeamMember {
  id: string
  name: string
  email?: string
  role: Role
  phone?: string
  active: boolean
  /** Invited but hasn't set a password yet. */
  pending?: boolean
  initials: string
  /** A profile photo, as a compressed data URL. See `User.avatarUrl`. */
  avatarUrl?: string
}

export interface Territory {
  id: string
  name: string
  repId?: string
  /**
   * The outline a manager drew, if this territory was drawn rather than named by
   * an import.
   *
   * Kept after the leads inside it have been assigned, for two reasons: it is
   * what lets the shape be shown again next to its coverage figure, and it is
   * what a later import can be matched against so new leads on those streets
   * land in the right patch instead of the unassigned bucket.
   */
  boundary?: { lat: number; lng: number }[]
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
  closedValue: number
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
  | 'route.create'
  | 'route.stop'
  | 'comm.log'
  | 'user.avatar'

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
