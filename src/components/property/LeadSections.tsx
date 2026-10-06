import { useEffect, useMemo } from 'react'
import { Collapsible } from '../ui/Collapsible'
import { Button } from '../ui/Button'
import { Glyph } from '../ui/Glyph'
import { PhotoImage, PhotoStrip } from '../visit/PhotoStrip'
import { ListMembership } from './ListMembership'
import { SaleSection } from './SaleSection'
import { useAppStore, useListsContaining, useQuoteSentAt } from '../../store/useAppStore'
import { STATUS_LABEL, outcomeByCode } from '../../data/outcomes'
import { duration, relative, time } from '../../lib/format'
import { dayKeyIn, dayLabel } from '../../lib/day'
import { syncPropertyPhotos } from '../../lib/photos'
import { EmptyState } from '../ui/EmptyState'
import { FOLLOW_UP_LABEL, followUpState } from '../../lib/followups'

/**
 * Everything below the fold about a lead, as one grouped list.
 *
 * Notes, lists, photos, visit history, activity and the lead's details, each
 * behind a collapsible row. One implementation, rendered on the lead's profile
 * and on the map's sheet when a rep drags it up — so the two never disagree
 * about what a house has on record, and a section added here appears in both.
 *
 * Reads its own data from the store by property id. The callers pass only what
 * differs between them: which sections to leave out (the sheet already carries
 * a compact list control above this) and what "Add note" should do.
 */

export type LeadSection = 'sales' | 'appointments' | 'todo' | 'notes' | 'lists' | 'photos' | 'visits' | 'activity' | 'details'

export function LeadSections({
  propertyId,
  hide = [],
  onAddNote,
}: {
  propertyId: string
  hide?: LeadSection[]
  /** Opens the note composer. Left out, the Notes section offers no button. */
  onAddNote?: () => void
}) {
  const property = useAppStore((s) => s.properties[propertyId])
  const allNotes = useAppStore((s) => s.notes)
  const allPhotos = useAppStore((s) => s.photos)
  const allVisits = useAppStore((s) => s.visits)
  const activity = useAppStore((s) => s.activity)
  const allAppointments = useAppStore((s) => s.appointments)
  const allTasks = useAppStore((s) => s.tasks)
  // What is still owed on this door — a quote to send, a call to make. These
  // lived only on Today, so a rep reading the lead could not tell a quote was
  // waiting to go out; and the day it was ticked off is in Activity below.
  const todo = useMemo(
    () => Object.values(allTasks).filter((t) => t.propertyId === propertyId && !t.done).sort((a, b) => a.dueAt - b.dueAt),
    [allTasks, propertyId],
  )
  const tz = useAppStore((s) => s.timezone)
  // Coming ones first, soonest at the top; then the ones that have happened.
  const appointments = useMemo(() => {
    const now = Date.now()
    const mine = Object.values(allAppointments).filter((a) => a.propertyId === propertyId)
    const ahead = mine.filter((a) => a.startsAt >= now).sort((a, b) => a.startsAt - b.startsAt)
    const past = mine.filter((a) => a.startsAt < now).sort((a, b) => b.startsAt - a.startsAt)
    return [...ahead, ...past]
  }, [allAppointments, propertyId])
  const onLists = useListsContaining(propertyId)

  const notes = useMemo(
    () => Object.values(allNotes).filter((n) => n.propertyId === propertyId).sort((a, b) => b.createdAt - a.createdAt),
    [allNotes, propertyId],
  )
  const photos = useMemo(
    () => Object.values(allPhotos).filter((p) => p.propertyId === propertyId).sort((a, b) => b.createdAt - a.createdAt),
    [allPhotos, propertyId],
  )
  const visits = useMemo(
    () => Object.values(allVisits).filter((v) => v.propertyId === propertyId && v.endedAt).sort((a, b) => b.startedAt - a.startedAt),
    [allVisits, propertyId],
  )
  // Found by the photo's own visit id and by the visit's list, so a photo whose
  // server row predates the visit link still shows with the visit on this phone.
  const photosByVisit = useMemo(() => {
    const by = new Map<string, typeof photos>()
    for (const v of visits) {
      const own = photos.filter((p) => p.visitId === v.id || v.photoIds?.includes(p.id))
      if (own.length) by.set(v.id, own)
    }
    return by
  }, [photos, visits])
  const quoteSentAt = useQuoteSentAt(propertyId)
  const timeline = useMemo(() => activity.filter((a) => a.propertyId === propertyId).slice(0, 20), [activity, propertyId])
  // A rep id as a name, without a hook per row (see useRepName for the order).
  const team = useAppStore((s) => s.team)
  const roster = useAppStore((s) => s.roster)
  const me = useAppStore((s) => s.user)
  const territories = useAppStore((s) => s.territories)
  const nameOf = (id?: string) =>
    !id ? undefined : team.find((m) => m.id === id)?.name ?? roster.find((m) => m.id === id)?.name ?? (me?.id === id ? me.name : undefined)
  // The note written on each visit, shown with that visit as well as in Notes.
  const notesByVisit = useMemo(() => {
    const by = new Map<string, typeof notes>()
    for (const n of notes) if (n.visitId) by.set(n.visitId, [...(by.get(n.visitId) ?? []), n])
    return by
  }, [notes])

  /*
    Ask the server what photos it holds for this lead, whenever its Photos
    section is on screen.

    It used to be asked by the lead's own screen only, which left the map's
    sheet — the same sections, dragged up — showing just the photos this phone
    took. The ones a device did not take are the whole point: a rep's own are
    already here, and a manager has none of their own at all. Metadata only;
    the bytes come down per thumbnail, and only for the ones actually drawn.

    Failures are deliberately silent. Not reaching the server means the strip
    shows what this device has, which is exactly what it showed before.
  */
  const photosShown = !hide.includes('photos')
  useEffect(() => {
    if (photosShown) void syncPropertyPhotos(propertyId)
  }, [propertyId, photosShown])

  if (!property) return null
  const show = (s: LeadSection) => !hide.includes(s)

  /*
    The sale at a glance, from the records that already exist — nothing here
    is stored separately. Quote: an open "Send quote" to-do is scheduled, a
    ticked one is sent (the "Quote sent" line in Activity); there is no
    accepted or declined in the data. Sold: the lead's status, with the date of
    the visit that recorded the sale when there is one.
  */
  const nextAppt = appointments.find((a) => a.startsAt >= Date.now())
  const openQuote = todo.find((t) => t.kind === 'quote')
  const openFollow = todo.find((t) => t.kind !== 'quote')
  const soldVisit = visits.find((v) => v.outcome === 'sold')
  const quoteText = openQuote
    ? `Scheduled ${relative(openQuote.dueAt).toLowerCase()}`
    : quoteSentAt
      ? `Sent ${relative(quoteSentAt).toLowerCase()}`
      : 'Not started'
  const followText = openFollow
    ? `${FOLLOW_UP_LABEL[followUpState(openFollow.dueAt, tz)]} · ${relative(openFollow.dueAt).toLowerCase()}`
    : 'None open'
  // The sale's own moment when it has one; the Sold visit's otherwise.
  const wonAt = property.deal?.wonAt ?? soldVisit?.startedAt
  const soldText =
    property.status === 'won'
      ? wonAt
        ? `Won · ${dayLabel(dayKeyIn(wonAt, tz), { month: 'short', day: 'numeric' })}`
        : 'Won'
      : 'Not yet'

  return (
    <div className="panel" data-testid="lead-sections">
      {show('sales') && (
        <Collapsible flat title="Sales activity" defaultOpen>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[14px] sm:grid-cols-[repeat(2,minmax(0,240px))] sm:gap-x-8" data-testid="lead-sales">
            <Detail label="Status" value={STATUS_LABEL[property.status] ?? property.status} />
            <Detail
              label="Next action"
              value={property.nextActionLabel ? `${property.nextActionLabel}${property.nextActionAt ? ` · ${relative(property.nextActionAt).toLowerCase()}` : ''}` : 'None'}
            />
            <Detail label="Appointment" value={nextAppt ? `${dayLabel(dayKeyIn(nextAppt.startsAt, tz), { month: 'short', day: 'numeric' })} at ${time(nextAppt.startsAt)}` : 'None upcoming'} />
            <Detail label="Quote" value={quoteText} />
            <Detail label="Follow-up" value={followText} />
            <Detail label="Sold" value={soldText} />
          </dl>
        </Collapsible>
      )}

      {show('sales') && property.status === 'won' && property.deal && <SaleSection property={property} nameOf={nameOf} />}

      {show('appointments') && appointments.length > 0 && (
        <Collapsible flat title="Appointments" count={appointments.length} defaultOpen>
          <ul className="space-y-3" data-testid="lead-appointments">
            {appointments.map((a) => {
              const past = a.startsAt < Date.now()
              return (
                <li key={a.id} className="flex items-start gap-3">
                  <span
                    className={`nums mt-0.5 w-[58px] shrink-0 rounded-field px-1 py-1.5 text-center text-[12px] font-semibold leading-tight ${
                      past ? 'bg-surface-field text-ink-mute' : 'bg-info-bg text-info'
                    }`}
                  >
                    {dayLabel(dayKeyIn(a.startsAt, tz), { month: 'short', day: 'numeric' })}
                    <span className="block">{time(a.startsAt)}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-medium">{a.title}</span>
                    <span className="block text-[12.5px] text-ink-mute">
                      {relative(a.startsAt)}
                      {a.durationMin ? ` · ${a.durationMin} min` : ''}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </Collapsible>
      )}

      {show('todo') && todo.length > 0 && (
        <Collapsible flat title="To do" count={todo.length} defaultOpen>
          <ul className="space-y-3" data-testid="lead-todo">
            {todo.map((t) => {
              const state = followUpState(t.dueAt, tz)
              const overdue = state === 'overdue'
              return (
                <li key={t.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ink/15" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] text-ink-soft">{t.title}</span>
                    <span className={`mt-0.5 block text-[12.5px] ${overdue ? 'font-semibold text-warn' : 'text-ink-mute'}`}>
                      {state !== 'upcoming' ? `${FOLLOW_UP_LABEL[state]} · ` : ''}
                      {relative(t.dueAt)}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </Collapsible>
      )}

      {show('visits') && (
        <Collapsible flat title="Visit history" count={visits.length} defaultOpen={visits.length > 0}>
          {visits.length === 0 ? (
            <EmptyState compact testId="visits-empty" title="No visits yet" body="Each finished visit is recorded here, with its outcome and time." />
          ) : (
            <ul className="space-y-3.5" data-testid="visit-history">
              {visits.map((v) => {
                const def = outcomeByCode(v.outcome)
                const who = nameOf(v.repId)
                const visitNotes = notesByVisit.get(v.id) ?? []
                const next =
                  v.nextActionType && v.nextActionType !== 'none'
                    ? `${NEXT_LABEL[v.nextActionType] ?? 'Next step'}${v.nextActionAt ? ` ${relative(v.nextActionAt).toLowerCase()}` : ''}`
                    : null
                return (
                  <li key={v.id} className="flex items-start gap-3 border-b border-line-soft pb-3 last:border-0 last:pb-0" data-testid="visit-row">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]" aria-hidden>
                      {def ? <Glyph name={def.icon} className="icon-xs" /> : '·'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] font-medium">{def?.label ?? 'Visit'}</span>
                      <span className="block text-[12.5px] text-ink-mute">
                        {dayLabel(dayKeyIn(v.startedAt, tz), { month: 'short', day: 'numeric' })} at {time(v.startedAt)}
                        {v.durationMs != null && v.durationMs > 0 && <> · <span data-testid="visit-duration">{duration(v.durationMs)}</span></>}
                        {who && ` · ${who}`}
                        {v.startLocation && ' · location confirmed'}
                      </span>
                      {next && <span className="mt-0.5 block text-[12.5px] text-ink-soft">{next}</span>}
                      {visitNotes.map((n) => (
                        <span key={n.id} className="mt-1 block text-[13.5px] leading-snug text-ink-soft">
                          {n.body}
                          {n.tags.length > 0 && (
                            <span className="ml-1 text-[12px] text-ink-mute">({n.tags.map((t) => t.replace(/_/g, ' ')).join(', ')})</span>
                          )}
                        </span>
                      ))}
                      {/* The photos taken on this visit, with the visit — not only in Photos above. */}
                      {(photosByVisit.get(v.id)?.length ?? 0) > 0 && (
                        <span className="mt-1.5 flex gap-1.5" data-testid="visit-photos">
                          {photosByVisit.get(v.id)!.slice(0, 4).map((ph) => (
                            <PhotoImage key={ph.id} photo={ph} alt="Visit photo" className="h-11 w-11 rounded-md object-cover" />
                          ))}
                          {photosByVisit.get(v.id)!.length > 4 && (
                            <span className="grid h-11 w-11 place-items-center rounded-md bg-surface-field text-[12px] font-semibold text-ink-soft">
                              +{photosByVisit.get(v.id)!.length - 4}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Collapsible>
      )}

      {show('notes') && (
        <Collapsible flat title="Notes" count={notes.length} defaultOpen={notes.length > 0}>
          {notes.length === 0 ? (
            <EmptyState compact testId="notes-empty" title="No notes yet" body={onAddNote ? 'Anything worth remembering about this home goes here.' : undefined} />
          ) : (
            <ul className="space-y-3.5">
              {notes.map((n) => (
                <li key={n.id} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
                  <p className="text-[14.5px] leading-relaxed">{n.body || '(tags only)'}</p>
                  {n.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {n.tags.map((t) => (
                        <span key={t} className="rounded-full bg-surface-field px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                          {t.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-1.5 text-[11.5px] text-ink-mute">
                    {relative(n.createdAt)}
                    {n.pending && ' · waiting to upload'}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {onAddNote && (
            <Button variant="secondary" full className="mt-4" onClick={onAddNote}>
              Add note
            </Button>
          )}
        </Collapsible>
      )}

      {show('lists') && (
        <Collapsible flat title="Lists" count={onLists.length} defaultOpen={onLists.length > 0}>
          <ListMembership propertyId={propertyId} />
        </Collapsible>
      )}

      {show('photos') && (
        <Collapsible flat title="Photos" count={photos.length} defaultOpen={photos.length > 0}>
          <PhotoStrip propertyId={propertyId} photos={photos} />
        </Collapsible>
      )}

      {show('activity') && (
        <Collapsible flat title="Activity" count={timeline.length}>
          {timeline.length === 0 ? (
            <EmptyState compact title="Nothing recorded yet" body="Status changes, visits and notes on this lead appear here." />
          ) : (
            <ul className="space-y-3.5">
              {timeline.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ink/15" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] text-ink-soft">{ev.summary}</span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-mute">{relative(ev.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Collapsible>
      )}

      {show('details') && (
        <Collapsible flat title="Property & assignment">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[14px] sm:grid-cols-[repeat(2,minmax(0,240px))] sm:gap-x-8" data-testid="lead-details">
            <Detail label="Territory" value={property.territoryId ? territories[property.territoryId]?.name ?? 'Removed territory' : '—'} />
            <Detail label="Assigned rep" value={property.assignedRepId ? nameOf(property.assignedRepId) ?? 'Former teammate' : 'Unassigned'} />
            <Detail label="Last visit" value={property.lastVisitAt ? relative(property.lastVisitAt) : 'Never'} />
            {/*
              Only when somebody actually recorded it. Nothing in the app writes
              this field, so on every live lead it was empty — and an empty field
              printed as "No", a false statement on every house. Square feet,
              roof age and the lead score are gone from this screen for the same
              family of reasons: see docs/sales-data-audit.md.
            */}
            {property.ownerOccupied !== undefined && property.ownerOccupied !== null && (
              <Detail label="Owner occupied" value={property.ownerOccupied ? 'Yes' : 'No'} />
            )}
          </dl>
          {property.contacts.length > 1 && (
            <div className="mt-4">
              <p className="eyebrow mb-2">Other contacts</p>
              <ul className="space-y-2">
                {property.contacts.slice(1).map((c) => (
                  <li key={c.id} className="text-[14px]">
                    {c.name} <span className="text-ink-mute">· {c.relationship} {c.phone}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Collapsible>
      )}
    </div>
  )
}

const NEXT_LABEL: Record<string, string> = {
  follow_up: 'Follow-up',
  appointment: 'Appointment',
  quote: 'Send quote',
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-mute">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
