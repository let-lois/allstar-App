import { Glyph } from '../components/ui/Glyph'
import { toLocalInput } from '../lib/day'
import { IconCheck } from '../components/nav/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { OutcomeGrid } from '../components/visit/OutcomeGrid'
import { NoteComposer } from '../components/visit/NoteComposer'
import { VisitContact } from '../components/visit/VisitContact'
import { PhotoStrip } from '../components/visit/PhotoStrip'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { OutcomePill } from '../components/ui/StatusPill'
import { CommActions } from '../components/property/CommActions'
import { outcomeByCode } from '../data/outcomes'
import { distanceMiles, formatDistance } from '../lib/geo'
import { duration, relative, relativeLower, time } from '../lib/format'
import { haptic } from '../lib/haptics'
import { IconClose } from '../components/nav/icons'
import { useSync } from '../components/sync/SyncBadge'
import type { NoteTag, OutcomeCode, Visit } from '../types'

type Step = 'outcome' | 'capture' | 'next' | 'done'

const STEPS: { key: Step; label: string }[] = [
  { key: 'outcome', label: 'Outcome' },
  { key: 'capture', label: 'Details' },
  { key: 'next', label: 'Next' },
]

/**
 * Visit Mode.
 *
 * A deliberately sealed flow: no bottom nav, no side trips, one decision per
 * screen, and the primary action pinned to the bottom of the viewport the whole
 * way through. The rep taps the same place four times and the visit is done.
 *
 * Everything is written locally at each step, so closing the app mid-visit
 * loses nothing and the visit is resumable.
 */
export function VisitMode() {
  const { visitId } = useParams<{ visitId: string }>()
  const nav = useNavigate()
  const location = useLocation()

  const visit = useAppStore((s) => (visitId ? s.visits[visitId] : undefined))
  const property = useAppStore((s) => (visit ? s.properties[visit.propertyId] : undefined))
  const position = useAppStore((s) => s.position)
  const allPhotos = useAppStore((s) => s.photos)
  const route = useAppStore((s) => s.route)
  const properties = useAppStore((s) => s.properties)
  const { recordOutcome, addNote, setNextAction, completeVisit, abandonVisit } = useAppStore()

  const [step, setStep] = useState<Step>('outcome')
  const [noteBody, setNoteBody] = useState('')
  const [noteTags, setNoteTags] = useState<NoteTag[]>([])
  const [nextType, setNextType] = useState<Visit['nextActionType']>('none')
  const [nextAt, setNextAt] = useState<number | undefined>()
  const [elapsed, setElapsed] = useState(0)
  const sync = useSync()
  /** Saves a contact typed in the Details step but not yet saved; see VisitContact. */
  const contactFlush = useRef<(() => Promise<void>) | null>(null)

  const photos = useMemo(
    () => Object.values(allPhotos).filter((p) => p.visitId === visitId),
    [allPhotos, visitId],
  )

  // Live timer. Reps are measured on doors-per-hour; showing the clock keeps a
  // visit from quietly turning into a ten-minute conversation.
  useEffect(() => {
    if (!visit) return
    const tick = () => setElapsed(Date.now() - visit.startedAt)
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [visit])

  const nextProperty = useMemo(() => {
    const stop = route?.stops.find(
      (s) => s.status === 'pending' && s.propertyId !== visit?.propertyId,
    )
    return stop ? properties[stop.propertyId] : undefined
  }, [route, properties, visit])

  /*
    Every hook above this line, none below it.

    `finishing` used to be declared further down, after the early return for
    a visit that no longer exists. Exiting a visit with no outcome discards
    it, the store drops it, and the next render took that early return with
    one hook fewer — React threw (#300) and unmounted the whole app. On a
    phone that was a blank screen with no way out but closing the app:
    reported as "the X on Today's route breaks navigation".
  */
  // Held while the visit is being saved, so a second tap cannot start a
  // second save — the store guards it too; this keeps the button honest.
  const [finishing, setFinishing] = useState(false)
  /** Set by the X; one exit per visit, however many times it is tapped. */
  const exiting = useRef(false)
  const [leaving, setLeaving] = useState(false)

  if (!visit || !property) {
    // Mid-exit the visit is expected to be gone: draw nothing for the frame
    // before the navigation lands rather than a "no longer available" flash.
    if (leaving) return <div className="app-shell bg-surface-sunk" />
    return (
      <div className="app-shell items-center justify-center p-8 text-center">
        <p className="text-ink-mute">This visit is no longer available.</p>
        <Button className="mt-4" onClick={() => nav('/today', { replace: true })}>
          Back to Today
        </Button>
      </div>
    )
  }

  const outcomeDef = outcomeByCode(visit.outcome)
  const dist = position ? distanceMiles(position, property) : null
  const contact = property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]

  const chooseOutcome = async (code: OutcomeCode) => {
    await recordOutcome(visit.id, code)
    const def = outcomeByCode(code)
    // A no-answer needs nothing else — skip straight to the end so the rep is
    // back on the sidewalk in two taps. Everything else earns the detail step.
    if (code === 'no_answer') {
      setStep('next')
      setNextType('none')
    } else {
      setStep('capture')
      if (def?.promptsFollowUp) {
        // Pre-fill both the type *and* a default time. Selecting a type without
        // a time leaves "Complete visit" disabled, which reads as a broken
        // button — the rep should always be able to finish in one tap and only
        // adjust the date if the default is wrong.
        setNextType(code === 'appointment' ? 'appointment' : code === 'quote_requested' ? 'quote' : 'follow_up')
        setNextAt((cur) => cur ?? defaultFollowUp())
      }
    }
  }

  const finish = async () => {
    if (finishing) return
    setFinishing(true)
    haptic('confirm')
    try {
      // A number typed and not saved is still the rep's work: keep it. A failed
      // contact save is shown on that card and never blocks finishing the visit.
      try {
        await contactFlush.current?.()
      } catch {
        /* reported by the card */
      }
      if (noteBody.trim() || noteTags.length) {
        await addNote(property.id, noteBody.trim(), noteTags, visit.id)
      }
      await setNextAction(visit.id, nextType, nextType === 'none' ? undefined : nextAt)
      await completeVisit(visit.id)
      setStep('done')
    } finally {
      setFinishing(false)
    }
  }

  /*
    The X. Back to where the visit was started from — Today, the map, the
    lead — when there is such a screen, and to Today when there is not: a
    visit opened as the first screen of the session (a cold start, a
    restored app) has nothing behind it, and `nav(-1)` there did nothing at
    all. `location.key` is "default" exactly for that first entry, in the
    browser's router and in the app's in-memory one alike.

    Once only: a double tap used to run the store action twice and step
    back twice, past the screen the rep came from.
  */
  const cancel = async () => {
    if (exiting.current) return
    exiting.current = true
    setLeaving(true)
    const canGoBack = location.key !== 'default'
    try {
      if (visit.outcome) {
        // Outcome already recorded — leave it as a completed visit rather than
        // silently discarding real work.
        await completeVisit(visit.id)
      } else {
        await abandonVisit(visit.id)
      }
    } finally {
      if (canGoBack) nav(-1)
      else nav('/today', { replace: true })
    }
  }

  /* --- completed ---------------------------------------------------------- */

  if (step === 'done') {
    /*
      The confirmation is a deep green ground with the theme's bright green on
      it, not a bright green ground with white on it. `good` inverted when the
      app did — it is the green that has to be *readable* on a dark screen — and
      white over it measures 1.7:1.
    */
    return (
      <div className="app-shell bg-good-bg text-ink">
        <div className="scroll-pane pad-top flex flex-col justify-center px-6 text-center">
          <div className="mx-auto w-full max-w-sm">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-good/15 text-good [&>svg]:h-9 [&>svg]:w-9">
              <IconCheck />
            </div>
            <h1 className="mt-5 text-[23px] font-semibold tracking-[-0.02em]">Visit recorded</h1>
            <p className="mt-1 text-ink-soft">
              {property.address1} · {outcomeDef?.label}
            </p>
            <p className="mt-1 text-sm text-ink-mute">
              {duration(visit.durationMs ?? elapsed)}
              {photos.length > 0 && ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}`}
              {nextAt && nextType !== 'none' && ` · follow-up ${relativeLower(nextAt)}`}
            </p>
            {/* State the truth for the situation the rep is actually in. */}
            <p className="mt-5 inline-flex items-center gap-2 rounded-full bg-ink/10 px-3.5 py-2 text-[12.5px] font-semibold">
              <span
                className={`h-2 w-2 rounded-full ${
                  sync.state === 'offline'
                    ? 'bg-ink-mute'
                    : sync.state === 'synced'
                      ? 'bg-good'
                      : 'bg-warn'
                }`}
              />
              {sync.state === 'offline'
                ? 'Saved on this phone — uploads when you have signal'
                : sync.state === 'synced'
                  ? 'Saved and uploaded'
                  : `Saved — uploading${sync.pending ? ` (${sync.pending})` : ''}…`}
            </p>
          </div>
        </div>

        <div
          className="shrink-0 space-y-2 px-4 pb-4 pt-2"
          style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
        >
          {nextProperty ? (
            <Button
              size="lg"
              full
              buzz
              variant="inverse"
              onClick={() => nav(`/property/${nextProperty.id}?start=1`, { replace: true })}
            >
              Next: {nextProperty.address1}
            </Button>
          ) : (
            <Button
              size="lg"
              full
              variant="inverse"
              data-testid="visit-done-map"
              // The map opens on this house with its sheet up, not wherever the
              // store's first lead happens to be (see lib/map-view).
              onClick={() => nav(`/map?lead=${encodeURIComponent(property.id)}`, { replace: true })}
            >
              Back to map
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              data-testid="visit-done-lead"
              onClick={() => nav(`/property/${encodeURIComponent(property.id)}`, { replace: true })}
              className="focusable min-h-tap w-full rounded-field text-[15px] font-semibold text-ink-soft active:bg-ink/10"
            >
              View lead
            </button>
            <button
              onClick={() => nav('/today', { replace: true })}
              className="focusable min-h-tap w-full rounded-field text-[15px] font-semibold text-ink-soft active:bg-ink/10"
            >
              Back to Today
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* --- active flow -------------------------------------------------------- */

  const stepIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <div className="app-shell bg-surface-sunk">
      {/* Sticky context header: the rep must never lose track of which door. */}
      <header className="pad-top shrink-0 border-b border-line bg-surface-raised text-ink">
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            onClick={() => void cancel()}
            aria-label="Exit visit"
            className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full active:bg-ink/10"
          >
            <IconClose />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">{property.address1}</p>
            <p className="truncate text-[12.5px] text-ink-mute">
              {contact?.name ?? 'No contact'}
              {dist != null && ` · ${formatDistance(dist)} away`}
            </p>
          </div>
          <span className="nums shrink-0 rounded-full bg-ink/10 px-2.5 py-1 text-[12px] font-semibold">
            {duration(elapsed)}
          </span>
        </div>

        {/*
          Visit Mode renders its own shell, so it doesn't inherit the app-wide
          offline banner. Without this the rep gets no signal at all during the
          one activity where "is my work safe?" matters most — so the state is
          stated here, in the rep's terms, rather than as a status icon.
        */}
        {sync.state === 'offline' && (
          <p className="flex items-center gap-2 bg-ink/10 px-4 py-1.5 text-[11px] font-medium text-ink-soft">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#FCD34D]" />
            Offline — this visit is saving to your phone
          </p>
        )}

        <ol className="flex gap-1 px-3 pb-2.5" aria-label="Visit progress">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex-1">
              <div
                className={`h-1 rounded-full ${i <= stepIndex ? 'bg-brand-400' : 'bg-ink/20'}`}
              />
              {/*
                11px and white/60 rather than 10px and white/40. The old pair
                measured 3.79:1 on this header, which fails AA for text at any
                size under 18px — and this is the one label a rep reads with the
                sun behind them while someone waits at the door.
              */}
              <span
                className={`mt-1 block text-[11px] font-semibold ${
                  i <= stepIndex ? 'text-ink' : 'text-ink-mute'
                }`}
              >
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      </header>

      <div className="scroll-pane px-4 pb-4 pt-4">
        {step === 'outcome' && (
          <>
            {property.lastVisitAt && (
              <Card className="mb-3.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="eyebrow">Last time</p>
                  <p className="mt-1.5 flex items-center gap-2 text-[14px]">
                    <OutcomePill code={property.lastOutcome} />
                    <span className="text-ink-mute">{relative(property.lastVisitAt)}</span>
                  </p>
                </div>
              </Card>
            )}
            <h2 className="mb-3.5 text-[20px] font-semibold">What happened?</h2>
            <OutcomeGrid value={visit.outcome} onChange={(c) => void chooseOutcome(c)} />
          </>
        )}

        {step === 'capture' && (
          <div className="space-y-4">
            <Card className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Outcome</span>
                <button
                  onClick={() => setStep('outcome')}
                  className="focusable -mr-1.5 min-h-[36px] rounded-field px-1.5 text-[13px] font-semibold text-accent"
                >
                  Change
                </button>
              </div>
              <p className="mt-1 flex items-center gap-2 text-[19px] font-semibold">
                {outcomeDef && <Glyph name={outcomeDef.icon} className="icon-sm" />}
                {outcomeDef?.label}
              </p>
            </Card>

            <Card>
              <VisitContact
                property={property}
                encourage={!!outcomeDef?.promptsFollowUp}
                flushRef={contactFlush}
              />
            </Card>

            {contact && (
              <Card>
                <p className="mb-3 text-[15px] font-semibold">
                  Reach {contact.name.split(' ')[0]}
                </p>
                <CommActions property={property} contact={contact} compact />
              </Card>
            )}

            <Card as="section">
              <h2 className="mb-3 text-[15px] font-semibold">Notes</h2>
              <NoteComposer
                body={noteBody}
                tags={noteTags}
                onBody={setNoteBody}
                onTags={setNoteTags}
              />
            </Card>

            <Card as="section">
              <h2 className="mb-3 text-[15px] font-semibold">Photos</h2>
              <PhotoStrip propertyId={property.id} visitId={visit.id} photos={photos} />
            </Card>
          </div>
        )}

        {step === 'next' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-[20px] font-semibold">What's next here?</h2>
              <p className="mt-1 text-[14px] text-ink-mute">
                This becomes a follow-up on your Today screen.
              </p>
            </div>

            <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2.5">
              {(
                [
                  { key: 'none', label: 'Nothing', icon: null },
                  { key: 'follow_up', label: 'Follow up', icon: 'refresh' },
                  { key: 'appointment', label: 'Appointment', icon: 'calendar' },
                  { key: 'quote', label: 'Send quote', icon: 'money' },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  onClick={() => {
                    haptic('tap')
                    setNextType(o.key)
                    if (o.key !== 'none' && !nextAt) setNextAt(defaultFollowUp())
                  }}
                  aria-pressed={nextType === o.key}
                  className={`press focusable flex min-h-[80px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-card px-2 text-center text-[15px] font-semibold transition-shadow ${
                    nextType === o.key
                      ? 'bg-brand-600 text-white shadow-raise'
                      : 'bg-surface text-ink ring-1 ring-line active:bg-surface-field'
                  }`}
                >
                  {/* "Nothing" is the absence of a next action — a shape for it
                      would be inventing one. */}
                  {o.icon && <Glyph name={o.icon} />}
                  {o.label}
                </button>
              ))}
            </div>

            {nextType !== 'none' && (
              <Card className="space-y-3.5">
                <p className="text-[15px] font-semibold">When?</p>
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2.5">
                  {quickWhen().map((w) => (
                    <button
                      key={w.label}
                      onClick={() => {
                        haptic('tap')
                        setNextAt(w.at)
                      }}
                      aria-pressed={nextAt === w.at}
                      className={`press focusable min-h-[52px] min-w-0 rounded-field px-2 text-[14px] font-semibold transition-colors ${
                        nextAt === w.at
                          ? 'bg-surface-tint text-accent-strong ring-2 ring-brand-500'
                          : 'bg-surface text-ink ring-1 ring-line active:bg-surface-field'
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <label className="block">
                  <span className="eyebrow">Or pick a time</span>
                  <input
                    type="datetime-local"
                    value={nextAt ? toLocalInput(nextAt) : ''}
                    onChange={(e) =>
                      setNextAt(e.target.value ? new Date(e.target.value).getTime() : undefined)
                    }
                    className="field mt-1.5 h-[52px]"
                  />
                </label>
                {nextAt && (
                  <p className="text-[13px] text-ink-mute">
                    Scheduled for {new Date(nextAt).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    at {time(nextAt)}
                  </p>
                )}
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Action bar pinned to the bottom — the same target every step. */}
      {step !== 'outcome' && (
        <div
          className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
          style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
        >
          {step === 'next' && nextType !== 'none' && !nextAt && (
            <p className="pb-2.5 text-center text-[13px] font-semibold text-warn">
              Pick when to come back, or choose “Nothing”.
            </p>
          )}
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              size="lg"
              onClick={() => setStep(step === 'next' ? 'capture' : 'outcome')}
              className="px-5"
            >
              Back
            </Button>
            {step === 'capture' ? (
              <Button size="lg" full buzz onClick={() => setStep('next')}>
                Continue
              </Button>
            ) : (
              <Button
                size="lg"
                full
                variant="success"
                onClick={() => void finish()}
                disabled={finishing || (nextType !== 'none' && !nextAt)}
              >
                {finishing ? 'Saving…' : 'Complete visit'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function defaultFollowUp(): number {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  d.setHours(17, 0, 0, 0)
  return d.getTime()
}

/** The four windows reps actually pick. Anything else uses the picker. */
function quickWhen(): { label: string; at: number }[] {
  const mk = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  return [
    { label: 'This evening', at: mk(0, 18) },
    { label: 'Tomorrow AM', at: mk(1, 9) },
    { label: 'In 3 days', at: mk(3, 17) },
    { label: 'Next week', at: mk(7, 10) },
  ]
}

