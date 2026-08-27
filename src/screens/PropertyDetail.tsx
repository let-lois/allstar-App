import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { TopBar } from '../components/nav/TopBar'
import { Collapsible } from '../components/ui/Collapsible'
import { Button } from '../components/ui/Button'
import { BottomSheet } from '../components/ui/BottomSheet'
import { NoteComposer } from '../components/visit/NoteComposer'
import { PhotoStrip } from '../components/visit/PhotoStrip'
import { syncPropertyPhotos } from '../lib/photos'
import { CommActions } from '../components/property/CommActions'
import { StreetView } from '../components/property/StreetView'
import { OutcomePill, ScoreBar, StatusPill } from '../components/ui/StatusPill'
import { outcomeByCode } from '../data/outcomes'
import { distanceMiles, formatDistance, walkMinutes } from '../lib/geo'
import { cityLine, moneyFull, relative, relativeLower, time } from '../lib/format'
import type { NoteTag } from '../types'
import { dayKeyIn, dayLabel } from '../lib/day'

/**
 * Lead / property profile.
 *
 * Top third answers the porch questions — where, who, what's the status, what
 * do I do. Everything else (history, notes, photos, property facts) is
 * collapsed by default: a rep should not scroll past forty database fields to
 * find the phone number.
 */
export function PropertyDetail() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()

  const property = useAppStore((s) => (propertyId ? s.properties[propertyId] : undefined))
  const position = useAppStore((s) => s.position)
  const allNotes = useAppStore((s) => s.notes)
  const allPhotos = useAppStore((s) => s.photos)
  const allVisits = useAppStore((s) => s.visits)
  const activity = useAppStore((s) => s.activity)
  const tz = useAppStore((s) => s.timezone)
  const startVisit = useAppStore((s) => s.startVisit)
  const addNote = useAppStore((s) => s.addNote)

  const [noteOpen, setNoteOpen] = useState(params.get('note') === '1')
  const [noteBody, setNoteBody] = useState('')
  const [noteTags, setNoteTags] = useState<NoteTag[]>([])
  const starting = useRef(false)

  const notes = useMemo(
    () =>
      Object.values(allNotes)
        .filter((n) => n.propertyId === propertyId)
        .sort((a, b) => b.createdAt - a.createdAt),
    [allNotes, propertyId],
  )
  const photos = useMemo(
    () =>
      Object.values(allPhotos)
        .filter((p) => p.propertyId === propertyId)
        .sort((a, b) => b.createdAt - a.createdAt),
    [allPhotos, propertyId],
  )

  /*
    Ask the server what photos it holds for this property.

    Here rather than in bootstrap because this is the only screen that shows
    them, and because the photos a device did not take are the whole point: a
    rep's own are already on their phone. Metadata only — the bytes come down
    per thumbnail, and only for the ones actually drawn.

    Failures are deliberately silent. Not being able to reach the server means
    the strip shows what this device has, which is exactly what it showed
    before this existed.
  */
  useEffect(() => {
    if (!propertyId) return
    void syncPropertyPhotos(propertyId)
  }, [propertyId])
  const visits = useMemo(
    () =>
      Object.values(allVisits)
        .filter((v) => v.propertyId === propertyId && v.endedAt)
        .sort((a, b) => b.startedAt - a.startedAt),
    [allVisits, propertyId],
  )
  const timeline = useMemo(
    () => activity.filter((a) => a.propertyId === propertyId).slice(0, 20),
    [activity, propertyId],
  )

  // `?start=1` deep-links straight into Visit Mode — the map sheet, the Today
  // card and the swipe action all route through here so there's one code path.
  useEffect(() => {
    if (params.get('start') !== '1' || !propertyId || starting.current) return
    starting.current = true
    void startVisit(propertyId).then((visitId) => {
      nav(`/visit/${visitId}`, { replace: true })
    })
  }, [params, propertyId, startVisit, nav])

  if (!property) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Property" back />
        <div className="grid flex-1 place-items-center p-8 text-center text-ink-mute">
          This property isn’t on this device.
        </div>
      </div>
    )
  }

  const contact = property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]
  const dist = position ? distanceMiles(position, property) : null

  const saveNote = async () => {
    if (noteBody.trim() || noteTags.length) {
      await addNote(property.id, noteBody.trim(), noteTags)
    }
    setNoteBody('')
    setNoteTags([])
    setNoteOpen(false)
    params.delete('note')
    setParams(params, { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `undefined` rather than an empty string: a blank subtitle would still
          reserve its line. */}
      <TopBar title={property.address1} subtitle={cityLine(property) || undefined} back />

      <div className="scroll-pane bg-surface-sunk pb-4"><div className="content-col">
        {/* --- header: the porch questions ------------------------------- */}
        <section className="bg-surface px-4 pb-5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {/* Semibold and a touch smaller. The address is already in the bar
                  above; repeating it in 26px extrabold made the top of every lead
                  screen shout the one thing the rep is looking straight at. */}
              <h2 className="text-[23px] font-semibold leading-tight tracking-[-0.02em]">
                {property.address1}
              </h2>
              <p className="mt-1 text-[13px] text-ink-mute">
                {[
                  cityLine(property),
                  dist != null ? `${formatDistance(dist)} · ${walkMinutes(dist)} min` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <ScoreBar score={property.score} />
          </div>

          {/*
            Directly under the address, because "is this the right house" is a
            porch question and belongs with the others rather than below the fold.
            Renders nothing at all when there is no coverage or no signal.
          */}
          <StreetView lat={property.lat} lng={property.lng} address={property.address1} />

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <StatusPill status={property.status} />
            <OutcomePill code={property.lastOutcome} />
            {property.opportunityValue != null && (
              <span className="nums rounded-full bg-good-bg px-2.5 py-1 text-[11.5px] font-bold text-good">
                {moneyFull(property.opportunityValue)}
              </span>
            )}
          </div>

          {contact && (
            <div className="mt-4 rounded-field bg-surface-tint px-3.5 py-3">
              <p className="text-[15px] font-semibold">{contact.name}</p>
              <p className="mt-0.5 text-[13px] text-ink-mute">
                {contact.relationship ?? 'Contact'}
                {contact.phone && ` · ${contact.phone}`}
              </p>
            </div>
          )}

          {property.nextActionLabel && property.nextActionAt && (
            <div className="mt-3 flex items-center gap-2 rounded-field bg-warn-bg px-3.5 py-3 text-[14px]">
              <span className="text-warn" aria-hidden>
                ↻
              </span>
              <span className="font-semibold text-warn">
                {property.nextActionLabel} {relativeLower(property.nextActionAt)}
              </span>
            </div>
          )}

          <div className="mt-4">
            <CommActions property={property} contact={contact} />
          </div>
        </section>

        {/*
          --- collapsible detail ----------------------------------------
          One grouped list rather than five separate cards. See the note on
          `Collapsible`'s `flat` prop: this is the whole lower half of the lead
          screen, and as a stack of rectangles it was the most widget-like thing
          in the product.
        */}
        <div className="plate my-4 overflow-hidden sm:mx-4 sm:rounded-card sm:border">
          <Collapsible flat title="Notes" count={notes.length} defaultOpen={notes.length > 0}>
            {notes.length === 0 ? (
              <p className="text-[14px] text-ink-mute">No notes yet.</p>
            ) : (
              <ul className="space-y-3.5">
                {notes.map((n) => (
                  <li key={n.id} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
                    <p className="text-[14.5px] leading-relaxed">{n.body || '(tags only)'}</p>
                    {n.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {n.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-surface-field px-2 py-0.5 text-[11px] font-semibold text-ink-soft"
                          >
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
            <Button
              variant="secondary"
              full
              className="mt-4"
              onClick={() => setNoteOpen(true)}
            >
              Add note
            </Button>
          </Collapsible>

          <Collapsible flat title="Photos" count={photos.length} defaultOpen={photos.length > 0}>
            <PhotoStrip propertyId={property.id} photos={photos} />
          </Collapsible>

          <Collapsible flat title="Visit history" count={visits.length}>
            {visits.length === 0 ? (
              <p className="text-[14px] text-ink-mute">No completed visits recorded.</p>
            ) : (
              <ul className="space-y-3.5">
                {visits.map((v) => {
                  const def = outcomeByCode(v.outcome)
                  return (
                    <li key={v.id} className="flex items-center gap-3">
                      <span
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]"
                        aria-hidden
                      >
                        {def?.glyph ?? '·'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14.5px] font-medium">
                          {def?.label ?? 'Visit'}
                        </span>
                        <span className="block text-[12.5px] text-ink-mute">
                          {dayLabel(dayKeyIn(v.startedAt, tz), {
                            month: 'short',
                            day: 'numeric',
                          })}{' '}
                          at {time(v.startedAt)}
                          {v.startLocation && ' · location confirmed'}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Collapsible>

          <Collapsible flat title="Timeline" count={timeline.length}>
            {timeline.length === 0 ? (
              <p className="text-[14px] text-ink-mute">Nothing recorded yet.</p>
            ) : (
              <ul className="space-y-3.5">
                {timeline.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ink/15" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] text-ink-soft">{ev.summary}</span>
                      <span className="mt-0.5 block text-[12.5px] text-ink-mute">
                        {relative(ev.at)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Collapsible>

          <Collapsible flat title="Property details">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[14px]">
              <Detail label="Owner occupied" value={property.ownerOccupied ? 'Yes' : 'No'} />
              <Detail
                label="Square feet"
                value={property.squareFeet ? property.squareFeet.toLocaleString() : '—'}
              />
              <Detail
                label="Roof age"
                value={property.roofAgeYears ? `${property.roofAgeYears} yrs` : '—'}
              />
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
                      {c.name}{' '}
                      <span className="text-ink-mute">
                        · {c.relationship} {c.phone}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Collapsible>
        </div>
        </div>
      </div>

      {/* Primary action bar — bottom of the screen, thumb range. */}
      <div
        className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="content-col">
        <Button
          size="lg"
          full
          buzz
          onClick={() => {
            params.set('start', '1')
            setParams(params, { replace: true })
          }}
        >
          Start visit
        </Button>
        </div>
      </div>

      <BottomSheet
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Add note"
        detents={[0.75, 0.95]}
      >
        <div className="space-y-4 pt-1">
          <NoteComposer
            body={noteBody}
            tags={noteTags}
            onBody={setNoteBody}
            onTags={setNoteTags}
          />
          <Button size="lg" full onClick={() => void saveNote()}>
            Save note
          </Button>
        </div>
      </BottomSheet>
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
