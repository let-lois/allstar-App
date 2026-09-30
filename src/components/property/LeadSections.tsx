import { useEffect, useMemo } from 'react'
import { Collapsible } from '../ui/Collapsible'
import { Button } from '../ui/Button'
import { Glyph } from '../ui/Glyph'
import { PhotoStrip } from '../visit/PhotoStrip'
import { ListMembership } from './ListMembership'
import { useAppStore, useListsContaining } from '../../store/useAppStore'
import { outcomeByCode } from '../../data/outcomes'
import { relative, time } from '../../lib/format'
import { dayKeyIn, dayLabel } from '../../lib/day'
import { syncPropertyPhotos } from '../../lib/photos'
import { EmptyState } from '../ui/EmptyState'

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

export type LeadSection = 'appointments' | 'todo' | 'notes' | 'lists' | 'photos' | 'visits' | 'activity' | 'details'

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
  const timeline = useMemo(() => activity.filter((a) => a.propertyId === propertyId).slice(0, 20), [activity, propertyId])

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

  return (
    <div className="panel" data-testid="lead-sections">
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
              const overdue = t.dueAt < Date.now()
              return (
                <li key={t.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ink/15" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] text-ink-soft">{t.title}</span>
                    <span className={`mt-0.5 block text-[12.5px] ${overdue ? 'font-semibold text-warn' : 'text-ink-mute'}`}>
                      {overdue ? 'Overdue · ' : ''}
                      {relative(t.dueAt)}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
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

      {show('visits') && (
        <Collapsible flat title="Visit history" count={visits.length}>
          {visits.length === 0 ? (
            <EmptyState compact testId="visits-empty" title="No visits yet" body="Each finished visit is recorded here, with its outcome and time." />
          ) : (
            <ul className="space-y-3.5">
              {visits.map((v) => {
                const def = outcomeByCode(v.outcome)
                return (
                  <li key={v.id} className="flex items-center gap-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]" aria-hidden>
                      {def ? <Glyph name={def.icon} className="icon-xs" /> : '·'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] font-medium">{def?.label ?? 'Visit'}</span>
                      <span className="block text-[12.5px] text-ink-mute">
                        {dayLabel(dayKeyIn(v.startedAt, tz), { month: 'short', day: 'numeric' })} at {time(v.startedAt)}
                        {v.startLocation && ' · location confirmed'}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
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
        <Collapsible flat title="Lead details">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[14px]">
            <Detail label="Owner occupied" value={property.ownerOccupied ? 'Yes' : 'No'} />
            <Detail label="Square feet" value={property.squareFeet ? property.squareFeet.toLocaleString() : '—'} />
            <Detail label="Roof age" value={property.roofAgeYears ? `${property.roofAgeYears} yrs` : '—'} />
            <Detail label="Lead score" value={String(property.score)} />
            <Detail label="Territory" value={property.territoryId ?? '—'} />
            <Detail label="Last visit" value={relative(property.lastVisitAt)} />
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-mute">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
