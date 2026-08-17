import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { TopBar } from '../components/nav/TopBar'
import { Collapsible } from '../components/ui/Collapsible'
import { Button } from '../components/ui/Button'
import { BottomSheet } from '../components/ui/BottomSheet'
import { NoteComposer } from '../components/visit/NoteComposer'
import { PhotoStrip } from '../components/visit/PhotoStrip'
import { CommActions } from '../components/property/CommActions'
import { OutcomePill, ScoreBar, StatusPill } from '../components/ui/StatusPill'
import { outcomeByCode } from '../data/outcomes'
import { distanceMiles, formatDistance, walkMinutes } from '../lib/geo'
import { moneyFull, relative, relativeLower, time } from '../lib/format'
import type { NoteTag } from '../types'

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
      <TopBar title={property.address1} subtitle={`${property.city}, ${property.state}`} back />

      <div className="scroll-pane bg-surface-sunk pb-4"><div className="content-col">
        {/* --- header: the porch questions ------------------------------- */}
        <section className="bg-surface px-4 pb-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-2xl font-black leading-tight">{property.address1}</h2>
              <p className="mt-0.5 text-sm text-ink-mute">
                {property.city}, {property.state} {property.zip}
                {dist != null && ` · ${formatDistance(dist)} · ${walkMinutes(dist)} min`}
              </p>
            </div>
            <ScoreBar score={property.score} />
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <StatusPill status={property.status} />
            <OutcomePill code={property.lastOutcome} />
            {property.opportunityValue != null && (
              <span className="nums rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                {moneyFull(property.opportunityValue)}
              </span>
            )}
          </div>

          {contact && (
            <div className="mt-3 rounded-2xl bg-surface-sunk p-3">
              <p className="font-semibold">{contact.name}</p>
              <p className="text-xs text-ink-mute">
                {contact.relationship ?? 'Contact'}
                {contact.phone && ` · ${contact.phone}`}
              </p>
            </div>
          )}

          {property.nextActionLabel && property.nextActionAt && (
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-sm">
              <span className="text-amber-700" aria-hidden>
                ↻
              </span>
              <span className="font-semibold text-amber-800">
                {property.nextActionLabel} {relativeLower(property.nextActionAt)}
              </span>
            </div>
          )}

          <div className="mt-3">
            <CommActions property={property} contact={contact} />
          </div>
        </section>

        {/* --- collapsible detail ---------------------------------------- */}
        <div className="space-y-2.5 p-3">
          <Collapsible title="Notes" count={notes.length} defaultOpen={notes.length > 0}>
            {notes.length === 0 ? (
              <p className="text-sm text-ink-mute">No notes yet.</p>
            ) : (
              <ul className="space-y-3">
                {notes.map((n) => (
                  <li key={n.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                    <p className="text-sm leading-relaxed">{n.body || '(tags only)'}</p>
                    {n.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {n.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-ink-mute"
                          >
                            {t.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="mt-1 text-[11px] text-ink-mute">
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
              className="mt-3"
              onClick={() => setNoteOpen(true)}
            >
              Add note
            </Button>
          </Collapsible>

          <Collapsible title="Photos" count={photos.length} defaultOpen={photos.length > 0}>
            <PhotoStrip propertyId={property.id} photos={photos} />
          </Collapsible>

          <Collapsible title="Visit history" count={visits.length}>
            {visits.length === 0 ? (
              <p className="text-sm text-ink-mute">No completed visits recorded.</p>
            ) : (
              <ul className="space-y-2.5">
                {visits.map((v) => {
                  const def = outcomeByCode(v.outcome)
                  return (
                    <li key={v.id} className="flex items-center gap-3">
                      <span className="w-6 text-center" aria-hidden>
                        {def?.glyph ?? '·'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{def?.label ?? 'Visit'}</span>
                        <span className="block text-xs text-ink-mute">
                          {new Date(v.startedAt).toLocaleDateString('en-US', {
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

          <Collapsible title="Timeline" count={timeline.length}>
            {timeline.length === 0 ? (
              <p className="text-sm text-ink-mute">Nothing recorded yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {timeline.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{ev.summary}</span>
                      <span className="block text-xs text-ink-mute">{relative(ev.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Collapsible>

          <Collapsible title="Property details">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
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
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Other contacts
                </p>
                <ul className="space-y-1.5">
                  {property.contacts.slice(1).map((c) => (
                    <li key={c.id} className="text-sm">
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
        className="shrink-0 border-t border-slate-200 bg-surface px-4 pt-3"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
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
      <dt className="text-xs text-ink-mute">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
