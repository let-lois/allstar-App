import type { LeadStatus, NoteTag, OutcomeCode, OutcomeDef, PhotoCategory } from '../types'

/**
 * Default outcome set. Client Admins will be able to relabel, reorder and hide
 * these later — the `code` is what the pipeline and reporting key off, so it
 * stays fixed while everything a rep sees is configurable.
 *
 * Order matters: this is the order of the big touch targets on the outcome
 * screen, and it's sorted by real-world frequency. "No answer" is roughly two
 * thirds of all knocks, so it sits first and largest.
 */
export const OUTCOMES: OutcomeDef[] = [
  { code: 'no_answer', label: 'No Answer', tone: 'noanswer', glyph: '—' },
  { code: 'interested', label: 'Interested', tone: 'interested', glyph: '★', promptsFollowUp: true },
  { code: 'follow_up', label: 'Follow Up', tone: 'followup', glyph: '↻', promptsFollowUp: true },
  {
    code: 'appointment',
    label: 'Appointment',
    tone: 'appointment',
    glyph: '◷',
    promptsFollowUp: true,
  },
  { code: 'quote_requested', label: 'Quote', tone: 'quote', glyph: '$', promptsFollowUp: true },
  { code: 'not_interested', label: 'Not Interested', tone: 'notinterested', glyph: '✕' },
  { code: 'sold', label: 'Sold', tone: 'sold', glyph: '✓', terminal: true },
  { code: 'do_not_contact', label: 'Do Not Contact', tone: 'dnc', glyph: '⊘', terminal: true },
]

export const outcomeByCode = (code?: OutcomeCode): OutcomeDef | undefined =>
  OUTCOMES.find((o) => o.code === code)

/** Recording an outcome moves the lead — reps should never set status by hand. */
export const OUTCOME_TO_STATUS: Record<OutcomeCode, LeadStatus | undefined> = {
  no_answer: undefined, // a miss doesn't change where the lead stands
  interested: 'working',
  // Was `contacted`, which lost the obligation: "come back Tuesday" and "we
  // spoke once" landed on the same status and the same pin colour. `contacted`
  // is now reachable from the office and from GoHighLevel rather than from a
  // doorstep, which is the honest split — a rep records what was agreed.
  follow_up: 'follow_up',
  appointment: 'appointment',
  quote_requested: 'quoted',
  not_interested: 'lost',
  sold: 'won',
  do_not_contact: 'dnc',
}

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  follow_up: 'Follow-up',
  working: 'Working',
  appointment: 'Appointment',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
  dnc: 'Do Not Contact',
}

/**
 * Hex rather than Tailwind classes: the map renderer draws these into SVG.
 *
 * Brightened for the dark basemap — the old values were chosen to read as dots
 * on pale paper and measured 1.5-2:1 on this ground. Every one now clears 3:1
 * against it, which is the floor for a graphic that carries meaning; `lost` is
 * closest at 3.73, and deliberately the dimmest, because it should be.
 */
export const STATUS_COLOR: Record<LeadStatus, string> = {
  new: '#94A3B8',
  contacted: '#38A8F0',
  // Orange rather than another amber: `quoted` already owns yellow and the two
  // sit side by side on a map, so this had to move a whole hue away rather than
  // a shade.
  follow_up: '#FB923C',
  working: '#2DD4BF',
  appointment: '#A78BFA',
  quoted: '#FBBF24',
  won: '#4ADE80',
  lost: '#64748B',
  dnc: '#F87171',
}

/*
 * Status pill tones — a light foreground on its own deep tint.
 *
 * Separate from STATUS_COLOR because that value is a *swatch*: a map dot, a 6px
 * rail, a bar fill, where only hue matters. As pill text a swatch hue lands
 * around 3:1 on its own tint, which fails WCAG 1.4.3 at pill sizes. Every pair
 * below is measured and clears 4.5:1 — 5.8 at the tightest, `dnc`.
 *
 * The relationship is the one this table always had, read from the other side:
 * on white these were dark inks on pale tints. The tints are deliberately close
 * to the card (1.05-1.19:1) — a status chip should be a wash of colour behind a
 * word, not a second card sitting inside the first.
 */
export const STATUS_TONE: Record<LeadStatus, { fg: string; bg: string }> = {
  new: { fg: '#A9B6C9', bg: '#1E2637' },
  contacted: { fg: '#7DA6FF', bg: '#16213F' },
  // 8.7:1 on its own tint, and the tint sits 1.13:1 off the card — measured the
  // same way as every pair above it.
  follow_up: { fg: '#FDBA74', bg: '#3A230C' },
  working: { fg: '#5FD3C4', bg: '#10302E' },
  appointment: { fg: '#C0A6FA', bg: '#241C3E' },
  quoted: { fg: '#FBBF24', bg: '#33260A' },
  won: { fg: '#4ADE80', bg: '#0F2C1B' },
  lost: { fg: '#9AA5B4', bg: '#1D222B' },
  dnc: { fg: '#F87171', bg: '#3A1717' },
}

export const PIPELINE_STAGES: LeadStatus[] = [
  'new',
  'contacted',
  'follow_up',
  'working',
  'appointment',
  'quoted',
  'won',
]

export const NOTE_TAGS: { tag: NoteTag; label: string }[] = [
  { tag: 'homeowner', label: 'Homeowner' },
  { tag: 'renter', label: 'Renter' },
  { tag: 'spouse_needed', label: 'Spouse needed' },
  { tag: 'callback', label: 'Callback' },
  { tag: 'gate_code', label: 'Gate code' },
  { tag: 'dog', label: 'Dog' },
  { tag: 'storm_damage', label: 'Storm damage' },
  { tag: 'competitor', label: 'Competitor' },
]

/**
 * One tap instead of thirty characters. These cover the notes reps actually
 * write; anything else goes through dictation or the keyboard.
 */
export const NOTE_TEMPLATES: string[] = [
  'Interested in project',
  'Needs spouse present',
  'Follow up later',
  'Requested estimate',
  'Not homeowner',
  'Already has contractor',
  'Insurance claim in progress',
  'Come back this evening',
  'Roof looks storm damaged',
  'Asked for pricing info',
]

export const PHOTO_CATEGORIES: { key: PhotoCategory; label: string; glyph: string }[] = [
  { key: 'property', label: 'Property', glyph: '🏠' },
  { key: 'roof', label: 'Roof', glyph: '🧱' },
  { key: 'damage', label: 'Damage', glyph: '⚠' },
  { key: 'interior', label: 'Interior', glyph: '🛋' },
  { key: 'document', label: 'Document', glyph: '📄' },
  { key: 'before', label: 'Before', glyph: 'B' },
  { key: 'after', label: 'After', glyph: 'A' },
]
