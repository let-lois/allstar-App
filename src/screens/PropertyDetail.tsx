import { IconRefresh } from '../components/nav/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { LeadSections } from '../components/property/LeadSections'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { BottomSheet } from '../components/ui/BottomSheet'
import { NoteComposer } from '../components/visit/NoteComposer'
import { PhotoStrip } from '../components/visit/PhotoStrip'
import { CommActions } from '../components/property/CommActions'
import { StreetView } from '../components/property/StreetView'
import { OutcomePill, ScoreBar, StatusPill } from '../components/ui/StatusPill'
import { distanceMiles, formatDistance, walkMinutes } from '../lib/geo'
import { cityLine, moneyFull, relativeLower } from '../lib/format'
import type { LeadStatus, NoteTag } from '../types'
import { NOTE_TAGS, STATUS_LABEL } from '../data/outcomes'

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
  const startVisit = useAppStore((s) => s.startVisit)
  const addNote = useAppStore((s) => s.addNote)
  const updateLeadDetails = useAppStore((s) => s.updateLeadDetails)

  /*
    Correcting what the door taught. The address as it is actually painted on
    the house, the name the homeowner gave, a number, an email — the lead was
    made in seconds from a map tap and any of these can be wrong or missing.
    One sheet, the fields a rep types, and Save. Status is not in it.
  */
  const [editOpen, setEditOpen] = useState(false)
  const [edit, setEdit] = useState({ address1: '', city: '', state: '', zip: '', name: '', phone: '', email: '' })
  /*
    Status and tags, in the same sheet since a wrong Not interested and a
    forgotten tag are the two corrections reps actually make. A status set
    here is its own write with its own rules on the server; a Do Not Contact
    is shown locked for a rep, because lifting one is the office's call.
  */
  const [editStatus, setEditStatus] = useState<LeadStatus>('new')
  const [editTags, setEditTags] = useState<string[]>([])
  const user = useAppStore((s) => s.user)
  const dncLocked = property?.status === 'dnc' && user?.role === 'field_rep'
  const [editBusy, setEditBusy] = useState(false)
  // Newest first, the same order the Photos section shows them in.
  const allPhotos = useAppStore((s) => s.photos)
  const leadPhotos = useMemo(
    () => Object.values(allPhotos).filter((p) => p.propertyId === propertyId).sort((a, b) => b.createdAt - a.createdAt),
    [allPhotos, propertyId],
  )
  const [editError, setEditError] = useState<string | null>(null)

  const [noteOpen, setNoteOpen] = useState(params.get('note') === '1')
  const [noteBody, setNoteBody] = useState('')
  const [noteTags, setNoteTags] = useState<NoteTag[]>([])
  const starting = useRef(false)


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

  const openEdit = () => {
    setEdit({
      address1: property.address1,
      city: property.city ?? '',
      state: property.state ?? '',
      zip: property.zip ?? '',
      name: contact?.name ?? '',
      phone: contact?.phone ?? '',
      email: contact?.email ?? '',
    })
    setEditStatus(property.status)
    setEditTags(property.tags ?? [])
    setEditError(null)
    setEditOpen(true)
  }
  const saveEdit = async () => {
    setEditBusy(true)
    setEditError(null)
    try {
      await updateLeadDetails(property.id, {
        address1: edit.address1,
        city: edit.city,
        state: edit.state,
        zip: edit.zip,
        contact: { name: edit.name, phone: edit.phone, email: edit.email },
        tags: editTags,
        ...(dncLocked ? {} : { status: editStatus }),
      })
      setEditOpen(false)
    } catch (err) {
      setEditError(err instanceof Error && err.message ? err.message : 'Could not save that. Nothing was changed.')
    } finally {
      setEditBusy(false)
    }
  }

  // One note per tap: a quick double tap on Save wrote the note twice.
  const savingNote = useRef(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const saveNote = async () => {
    if (savingNote.current) return
    savingNote.current = true
    setNoteBusy(true)
    try {
      if (noteBody.trim() || noteTags.length) {
        await addNote(property.id, noteBody.trim(), noteTags)
      }
    } finally {
      savingNote.current = false
      setNoteBusy(false)
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

          {/*
            Said in words, next to the picture a rep would use to check.

            The map draws an estimated pin as a hollow dashed dot, which is
            enough to notice and not enough to act on — so the one screen where
            somebody decides which door to knock says it plainly. Placed under
            the Street View rather than above it because the image is the answer
            to the doubt this sentence raises.

            Nothing renders for a rooftop match, and nothing renders when we have
            no verdict: a lead imported before this was recorded may well be
            exact, and warning about it would be a guess dressed as information.
          */}
          {(property.geoPrecision === 'interpolated' ||
            property.geoPrecision === 'approximate') && (
            <p className="mt-2 text-[12.5px] text-warn" data-testid="pin-estimated">
              Pin is estimated from the street — check the house number before you knock.
            </p>
          )}
          {/* The pin is on the real roof; only the house number is an estimate. */}
          {property.addressConfidence === 'INTERPOLATED' && (
            <p className="mt-2 text-[12.5px] leading-snug text-warn" data-testid="address-estimated">
              House number estimated from the street's Census range — confirm it at the door, then fix it with Edit if it is wrong.
            </p>
          )}

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <StatusPill status={property.status} />
            <OutcomePill code={property.lastOutcome} />
            {(property.tags ?? []).map((t) => (
              <span
                key={t}
                className="rounded-full border border-line bg-surface-sunk px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft"
                data-testid="lead-tag"
              >
                {NOTE_TAGS.find((n) => n.tag === t)?.label ?? t}
              </span>
            ))}
            {property.opportunityValue != null && (
              <span className="nums rounded-full bg-good-bg px-2.5 py-1 text-[11.5px] font-bold text-good">
                {moneyFull(property.opportunityValue)}
              </span>
            )}
          </div>

          <div className="mt-4 rounded-field bg-surface-tint px-3.5 py-3" data-testid="lead-contact">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {contact ? (
                  <>
                    <p className="text-[15px] font-semibold">{contact.name}</p>
                    <p className="mt-0.5 text-[13px] text-ink-mute">
                      {[contact.relationship ?? 'Contact', contact.phone, contact.email].filter(Boolean).join(' · ')}
                    </p>
                  </>
                ) : (
                  <p className="text-[13.5px] text-ink-mute">No contact yet — add the homeowner when you meet them.</p>
                )}
              </div>
              {/*
                A word, not a pencil: this is how a rep fixes a wrong house
                number while standing in front of the right one.
              */}
              <button
                type="button"
                onClick={openEdit}
                className="focusable min-h-tap shrink-0 rounded-lg px-2 text-sm font-semibold text-accent"
                data-testid="lead-edit-open"
              >
                Edit details
              </button>
            </div>
          </div>

          {property.nextActionLabel && property.nextActionAt && (
            <div className="mt-3 flex items-center gap-2 rounded-field bg-warn-bg px-3.5 py-3 text-[14px]">
              <span className="icon-sm grid shrink-0 place-items-center text-warn" aria-hidden>
                <IconRefresh />
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
          One grouped list rather than five separate cards, and the same list
          the map's sheet shows when dragged up — see LeadSections.
        */}
        <div className="my-4 sm:mx-4">
          <LeadSections propertyId={property.id} onAddNote={() => setNoteOpen(true)} />
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
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit details"
        detents={[0.85, 0.95]}
        footer={
          <Button size="lg" full disabled={editBusy || !edit.address1.trim()} onClick={() => void saveEdit()} data-testid="lead-edit-save">
            {editBusy ? 'Saving…' : 'Save details'}
          </Button>
        }
      >
        <div className="space-y-4 pt-1" data-testid="lead-edit">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">Status</span>
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as LeadStatus)}
              disabled={editBusy || dncLocked}
              className="field h-[52px]"
              data-testid="lead-edit-status"
            >
              {(Object.keys(STATUS_LABEL) as LeadStatus[]).map((st) => (
                <option key={st} value={st}>
                  {STATUS_LABEL[st]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12.5px] leading-snug text-ink-mute">
              {dncLocked
                ? 'Marked Do Not Contact. Only the office can lift that.'
                : 'For fixing a wrong outcome. What happened at the door still goes through Start visit.'}
            </span>
          </label>
          <fieldset>
            <legend className="mb-1.5 block text-[13px] font-medium text-ink-soft">Tags</legend>
            <div className="flex flex-wrap gap-2">
              {NOTE_TAGS.map(({ tag, label }) => {
                const on = editTags.includes(tag)
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={on}
                    disabled={editBusy}
                    onClick={() => setEditTags((cur) => (on ? cur.filter((t) => t !== tag) : [...cur, tag]))}
                    className={`focusable min-h-[44px] rounded-full border px-3.5 text-[13px] font-medium ${
                      on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-ink-soft'
                    }`}
                    data-testid="lead-edit-tag"
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </fieldset>
          <Field
            label="Address"
            value={edit.address1}
            onChange={(e) => setEdit((d) => ({ ...d, address1: e.target.value }))}
            autoComplete="street-address"
            disabled={editBusy}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] gap-3">
            <Field label="City" value={edit.city} onChange={(e) => setEdit((d) => ({ ...d, city: e.target.value }))} disabled={editBusy} />
            <Field label="State" value={edit.state} onChange={(e) => setEdit((d) => ({ ...d, state: e.target.value }))} disabled={editBusy} />
            <Field label="ZIP" value={edit.zip} onChange={(e) => setEdit((d) => ({ ...d, zip: e.target.value }))} inputMode="numeric" disabled={editBusy} />
          </div>
          <Field
            label="Contact name"
            hint="Clearing the name removes the contact."
            value={edit.name}
            onChange={(e) => setEdit((d) => ({ ...d, name: e.target.value }))}
            autoComplete="name"
            disabled={editBusy}
          />
          <Field
            label="Phone"
            value={edit.phone}
            onChange={(e) => setEdit((d) => ({ ...d, phone: e.target.value }))}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            disabled={editBusy}
          />
          <Field
            label="Email"
            value={edit.email}
            onChange={(e) => setEdit((d) => ({ ...d, email: e.target.value }))}
            type="email"
            inputMode="email"
            autoComplete="email"
            disabled={editBusy}
          />
          {/*
            The lead's photos, here as well as under Photos. Somebody fixing the
            details is often the person who just took the pictures, and a sheet
            that showed everything about the house except them read as the
            photos having been dropped. They are saved as they are taken, not
            with this form, so Save details neither needs nor touches them.
          */}
          <section aria-label="Photos" data-testid="lead-edit-photos">
            <p className="mb-1.5 text-[13px] font-medium text-ink-soft">Photos</p>
            <PhotoStrip propertyId={property.id} photos={leadPhotos} />
          </section>
          {editError && (
            <p role="alert" className="rounded-field bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
              {editError}
            </p>
          )}
        </div>
      </BottomSheet>

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
          <Button size="lg" full disabled={noteBusy} onClick={() => void saveNote()}>
            Save note
          </Button>
        </div>
      </BottomSheet>
    </div>
  )
}
