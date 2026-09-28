import type { GlyphName } from './glyphs'
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
  firstName?: string
  lastName?: string
  /** Display text for the badge — not `role`, which is a permission. */
  jobTitle?: string
  teamId?: string
  teamName?: string
  /**
   * Where this person is in onboarding, as the server says. Absent on a
   * session cached before the field existed and on the demo — and absent
   * means "nothing to do", so an upgrade never throws a working rep into a
   * flow they finished under another name.
   */
  onboarding?: {
    status: OnboardingStatus
    step?: OnboardingStep
    version: number
    completedAt?: number
  }
  badge?: BadgeInfo | null
  /** The company as it appears on a badge. */
  company?: { name: string; timezone: string; logoUrl?: string; website?: string; badgeQrUrl?: string }
}

export type OnboardingStatus = 'not_started' | 'in_progress' | 'complete' | 'required'
export type OnboardingStep = 'profile' | 'setup' | 'walkthrough' | 'badge' | 'checklist'
export type BadgeStatus = 'none' | 'awaiting_confirmation' | 'active' | 'expired'

export interface BadgeInfo {
  id: string
  status: BadgeStatus
  issuedAt?: number
  expiresAt?: number
  confirmedAt?: number
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
  /**
   * The icon on the big touch target, by name — resolved by `<Glyph>`.
   *
   * These were characters: ★ ↻ ◷ $ ✕ ✓ ⊘ and an em dash. A designed set rather
   * than emoji, which is why they lasted longer than the rest, but still text —
   * taking the system font's idea of a tick at 15px inside a coloured pill.
   */
  icon: GlyphName
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
  /** Anything the seven above do not name — with `Photo.type` saying what. */
  | 'other'

export interface Photo {
  id: string
  propertyId: string
  visitId?: string
  category: PhotoCategory
  /**
   * What an `other` photo is of, in the rep's words — "skylight", "gutter",
   * "permit". Present only when the category is `other`; choosing any of the
   * named categories clears it, because a type that describes a category the
   * photo no longer has is a lie waiting to be read.
   */
  type?: string
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
  /*
    The onboarding facts the console's roster shows. Derived on the server
    (see api/src/onboarding.ts) and cached here with the rest of the roster,
    so the console reads the same way with no signal. Absent on the demo
    roster and on a cache written before these existed.
  */
  firstName?: string
  lastName?: string
  jobTitle?: string
  teamId?: string
  teamName?: string
  invitation?: 'not_sent' | 'pending' | 'opened' | 'accepted' | 'expired' | 'revoked'
  invitedAt?: number
  /** When the current link was sent, when that was not the first. */
  resentAt?: number
  /** When the current link was first opened in a browser. */
  openedAt?: number
  onboarding?: OnboardingStatus
  onboardingStep?: OnboardingStep
  badge?: BadgeStatus
  badgeExpiresAt?: number
  createdAt?: number
  lastSeenAt?: number
}

export interface Territory {
  id: string
  name: string
  /** The first rep on the patch, for callers that read one. `repIds` is the list. */
  repId?: string
  /** Everyone who walks this patch, oldest assignment first. */
  repIds?: string[]
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

/**
 * A working set of leads, and the reps who work it.
 *
 * "Monday Route", "Follow Ups", "Northwest Territory – Sept 10". A lead can be
 * on several at once; a list can be handed to several reps at once. Not a
 * territory — a territory is whose ground this is, one rep to a patch; a list is
 * what we are working on together. See the note above the tables in
 * api/schema.sql for why the two coexist.
 *
 * `leadIds` and `repIds` are carried flat rather than normalised, because the
 * phone reads them a hundred times for every time it writes one, and the server
 * is the authority on both — the join tables live there.
 */
export interface LeadList {
  id: string
  name: string
  description?: string
  /** Who made it. A rep's own lists are theirs to reshape; a manager's are not. */
  createdBy?: string
  /** The outline it was drawn from, when it was drawn rather than typed. */
  boundary?: { lat: number; lng: number }[]
  archived: boolean
  createdAt: number
  updatedAt: number
  leadIds: string[]
  repIds: string[]
  /** Made on this device and not yet acknowledged by the server. */
  pending?: boolean
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
  /** A photo filed under a different category, or a different `type`, after the fact. */
  | 'photo.update'
  | 'property.status'
  /** Address and contact details corrected at the door. Never status. */
  | 'property.update'
  | 'task.create'
  | 'task.complete'
  | 'appointment.create'
  | 'route.create'
  | 'route.stop'
  | 'comm.log'
  | 'user.avatar'
  /*
    Lead lists from the phone. Each is applied by the same server function the
    REST route calls, so a list made in a dead zone obeys the same permission
    checks as one made in the console — see api/src/lists.ts.
  */
  | 'list.create'
  | 'list.update'
  | 'list.members'
  | 'list.reps'

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
