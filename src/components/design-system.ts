/**
 * The design system, by the names the product brief uses.
 *
 * One vocabulary for the pieces every screen is built from, so a component is
 * reached for by what it is rather than by the file it happens to live in —
 * and so nobody writes a second card, a second badge or a second chip because
 * the first was under another name. Nothing here is new: each name points at
 * the one implementation, and adding a variant means editing that file.
 *
 *   PageHeader         the bar at the top of a screen: title, back, actions
 *   Card / Plate       a rounded, elevated surface; Plate is the flat sibling
 *   StatusBadge        a toned pill with a dot — status, state, a count
 *   StatusPill         the lead-status pill, coloured by pipeline stage
 *   ActionButton       the button: sizes, variants, full-width, haptic
 *   BottomSheet        the phone's sheet, with detents and a pinned footer
 *   PropertyImage      the house: Street View when there is one, a frame if not
 *   LeadDetailSection  one collapsible row of a lead's detail
 *   LeadSections       the whole grouped list of them, from the store
 *   BottomNavigation   the persistent dock; SideRail on wide screens
 *   FilterChip         a chip in a horizontal rail
 *   Collapsible        the generic collapsible LeadDetailSection is made of
 */
export { TopBar as PageHeader } from './nav/TopBar'
export { Card, Plate, SectionHeader } from './ui/Card'
export { StatusBadge } from './ui/StatusBadge'
export { StatusPill, OutcomePill, ScoreBar } from './ui/StatusPill'
export { Button as ActionButton } from './ui/Button'
export { BottomSheet } from './ui/BottomSheet'
export { PropertyImage, StreetView } from './property/StreetView'
export { Collapsible as LeadDetailSection, Collapsible } from './ui/Collapsible'
export { LeadSections } from './property/LeadSections'
export type { LeadSection } from './property/LeadSections'
export { BottomNav as BottomNavigation, SideRail } from './nav/BottomNav'
export { Chip as FilterChip } from './ui/Chip'
export { Field, TextArea } from './ui/Input'
