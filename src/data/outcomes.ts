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
  follow_up: 'contacted',
  appointment: 'appointment',
  quote_requested: 'quoted',
  not_interested: 'lost',
  sold: 'won',
  do_not_contact: 'dnc',
}

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  working: 'Working',
  appointment: 'Appointment',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
  dnc: 'Do Not Contact',
}

/** Hex rather than Tailwind classes: the map renderer draws these into SVG. */
export const STATUS_COLOR: Record<LeadStatus, string> = {
  new: '#64748b',
  contacted: '#0284c7',
  working: '#0d9488',
  appointment: '#7c3aed',
  quoted: '#d97706',
  won: '#15803d',
  lost: '#94a3b8',
  dnc: '#b91c1c',
}

/*
 * Status pill tones — a dark foreground on its own light tint.
 *
 * Separate from STATUS_COLOR because that value is a *swatch*: a map dot, a
 * 6px rail, a bar fill, where only hue matters. As pill text those same hues
 * land between 3:1 and 3.5:1 on their own tint, which fails WCAG 1.4.3 at pill
 * sizes. Every pair below is measured and clears 4.5:1.
 */
export const STATUS_TONE: Record<LeadStatus, { fg: string; bg: string }> = {
  new: { fg: '#475569', bg: '#EEF1F5' },
  contacted: { fg: '#1D4ED8', bg: '#E8EEFD' },
  working: { fg: '#0F766E', bg: '#E3F2F0' },
  appointment: { fg: '#6D28D9', bg: '#F1EBFC' },
  quoted: { fg: '#B45309', bg: '#FEF3E2' },
  won: { fg: '#166534', bg: '#E8F5EC' },
  lost: { fg: '#475569', bg: '#F1F2F4' },
  dnc: { fg: '#B91C1C', bg: '#FDECEC' },
}

export const PIPELINE_STAGES: LeadStatus[] = [
  'new',
  'contacted',
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
