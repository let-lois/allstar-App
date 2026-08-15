import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { OutcomeGrid } from '../components/visit/OutcomeGrid'
import { NoteComposer } from '../components/visit/NoteComposer'
import { PhotoStrip } from '../components/visit/PhotoStrip'
import { Button } from '../components/ui/Button'
import { OutcomePill } from '../components/ui/StatusPill'
import { CommActions } from '../components/property/CommActions'
import { outcomeByCode } from '../data/outcomes'
import { distanceMiles, formatDistance } from '../lib/geo'
import { duration, relative, relativeLower, time } from '../lib/format'
import { haptic } from '../lib/haptics'
import { IconClose } from '../components/nav/icons'
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

  if (!visit || !property) {
    return (
      <div className="app-shell items-center justify-center p-8 text-center">
        <p className="text-ink-mute">This visit is no longer available.</p>
        <Button className="mt-4" onClick={() => nav('/today')}>
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
    haptic('confirm')
    if (noteBody.trim() || noteTags.length) {
      await addNote(property.id, noteBody.trim(), noteTags, visit.id)
    }
    await setNextAction(visit.id, nextType, nextType === 'none' ? undefined : nextAt)
    await completeVisit(visit.id)
    setStep('done')
  }

  const cancel = async () => {
    if (visit.outcome) {
      // Outcome already recorded — leave it as a completed visit rather than
      // silently discarding real work.
      await completeVisit(visit.id)
    } else {
      await abandonVisit(visit.id)
    }
    nav(-1)
  }

  /* --- completed ---------------------------------------------------------- */

  if (step === 'done') {
    return (
      <div className="app-shell bg-emerald-600 text-white">
        <div className="scroll-pane pad-top flex flex-col justify-center px-6 text-center">
          <div className="mx-auto w-full max-w-sm">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-white/15 text-4xl">
              ✓
            </div>
            <h1 className="mt-5 text-2xl font-black">Visit recorded</h1>
            <p className="mt-1 text-white/80">
              {property.address1} · {outcomeDef?.label}
            </p>
            <p className="mt-1 text-sm text-white/60">
              {duration(visit.durationMs ?? elapsed)}
              {photos.length > 0 && ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}`}
              {nextAt && nextType !== 'none' && ` · follow-up ${relativeLower(nextAt)}`}
            </p>
            <p className="mt-3 text-xs text-white/60">
              Saved on this phone. It uploads automatically.
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
              className="bg-white text-emerald-700 active:bg-white/90"
              onClick={() => nav(`/property/${nextProperty.id}?start=1`, { replace: true })}
            >
              Next: {nextProperty.address1}
            </Button>
          ) : (
            <Button
              size="lg"
              full
              className="bg-white text-emerald-700 active:bg-white/90"
              onClick={() => nav('/map', { replace: true })}
            >
              Back to map
            </Button>
          )}
          <button
            onClick={() => nav('/today', { replace: true })}
            className="focusable min-h-tap w-full rounded-xl text-sm font-semibold text-white/80 active:bg-white/10"
          >
            Back to Today
          </button>
        </div>
      </div>
    )
  }

  /* --- active flow -------------------------------------------------------- */

  const stepIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <div className="app-shell bg-surface-sunk">
      {/* Sticky context header: the rep must never lose track of which door. */}
      <header className="pad-top shrink-0 bg-ink text-white">
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            onClick={() => void cancel()}
            aria-label="Exit visit"
            className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full active:bg-white/10"
          >
            <IconClose />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold leading-tight">{property.address1}</p>
            <p className="truncate text-xs text-white/60">
              {contact?.name ?? 'No contact'}
              {dist != null && ` · ${formatDistance(dist)} away`}
            </p>
          </div>
          <span className="nums shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold">
            {duration(elapsed)}
          </span>
        </div>

        <ol className="flex gap-1 px-3 pb-2.5" aria-label="Visit progress">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex-1">
              <div
                className={`h-1 rounded-full ${i <= stepIndex ? 'bg-brand-500' : 'bg-white/20'}`}
              />
              <span
                className={`mt-1 block text-[10px] font-semibold ${
                  i <= stepIndex ? 'text-white' : 'text-white/40'
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
              <div className="card mb-3 flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                    Last time
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-sm">
                    <OutcomePill code={property.lastOutcome} />
                    <span className="text-ink-mute">{relative(property.lastVisitAt)}</span>
                  </p>
                </div>
              </div>
            )}
            <h2 className="mb-3 text-lg font-bold">What happened?</h2>
            <OutcomeGrid value={visit.outcome} onChange={(c) => void chooseOutcome(c)} />
          </>
        )}

        {step === 'capture' && (
          <div className="space-y-4">
            <div className="card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Outcome</span>
                <button
                  onClick={() => setStep('outcome')}
                  className="focusable min-h-[44px] rounded-lg px-3 text-sm font-semibold text-brand-600"
                >
                  Change
                </button>
              </div>
              <p className="mt-1 text-lg font-bold" style={{ color: undefined }}>
                {outcomeDef?.glyph} {outcomeDef?.label}
              </p>
            </div>

            {contact && (
              <div className="card p-3">
                <p className="mb-2 text-sm font-semibold">Reach {contact.name.split(' ')[0]}</p>
                <CommActions property={property} contact={contact} compact />
              </div>
            )}

            <section className="card p-3">
              <h2 className="mb-2 font-bold">Notes</h2>
              <NoteComposer
                body={noteBody}
                tags={noteTags}
                onBody={setNoteBody}
                onTags={setNoteTags}
              />
            </section>

            <section className="card p-3">
              <h2 className="mb-2 font-bold">Photos</h2>
              <PhotoStrip propertyId={property.id} visitId={visit.id} photos={photos} />
            </section>
          </div>
        )}

        {step === 'next' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold">What's next here?</h2>
              <p className="mt-0.5 text-sm text-ink-mute">
                This becomes a follow-up on your Today screen.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  { key: 'none', label: 'Nothing', glyph: '—' },
                  { key: 'follow_up', label: 'Follow up', glyph: '↻' },
                  { key: 'appointment', label: 'Appointment', glyph: '◷' },
                  { key: 'quote', label: 'Send quote', glyph: '$' },
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
                  className={`press focusable flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl border-2 font-bold ${
                    nextType === o.key
                      ? 'border-brand-500 bg-brand-500 text-white'
                      : 'border-slate-200 bg-surface text-ink'
                  }`}
                >
                  <span className="text-xl" aria-hidden>
                    {o.glyph}
                  </span>
                  {o.label}
                </button>
              ))}
            </div>

            {nextType !== 'none' && (
              <div className="card space-y-3 p-3">
                <p className="text-sm font-semibold">When?</p>
                <div className="grid grid-cols-2 gap-2">
                  {quickWhen().map((w) => (
                    <button
                      key={w.label}
                      onClick={() => {
                        haptic('tap')
                        setNextAt(w.at)
                      }}
                      aria-pressed={nextAt === w.at}
                      className={`press focusable min-h-[52px] rounded-xl border-2 text-sm font-semibold ${
                        nextAt === w.at
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-200'
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                    Or pick a time
                  </span>
                  <input
                    type="datetime-local"
                    value={nextAt ? toLocalInput(nextAt) : ''}
                    onChange={(e) =>
                      setNextAt(e.target.value ? new Date(e.target.value).getTime() : undefined)
                    }
                    className="focusable mt-1 min-h-tap w-full rounded-xl border border-slate-200 px-3"
                  />
                </label>
                {nextAt && (
                  <p className="text-xs text-ink-mute">
                    Scheduled for {new Date(nextAt).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    at {time(nextAt)}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action bar pinned to the bottom — the same target every step. */}
      {step !== 'outcome' && (
        <div
          className="shrink-0 border-t border-slate-200 bg-surface px-4 pt-3"
          style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
        >
          {step === 'next' && nextType !== 'none' && !nextAt && (
            <p className="pb-2 text-center text-xs font-medium text-amber-700">
              Pick when to come back, or choose “Nothing”.
            </p>
          )}
          <div className="flex gap-2">
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
                disabled={nextType !== 'none' && !nextAt}
              >
                Complete visit
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

function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
