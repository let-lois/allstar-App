import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { useAppStore } from '../../store/useAppStore'
import { NOTE_TAGS } from '../../data/outcomes'
import type { NoteTag } from '../../types'
import { OutcomePill, ScoreBar, StatusPill } from '../ui/StatusPill'
import { CommActions } from './CommActions'
import { Button } from '../ui/Button'
import { distanceMiles, formatDistance, walkMinutes, type Position } from '../../lib/geo'
import { moneyFull, relativeLower, cityLine } from '../../lib/format'

/**
 * The map's property sheet — map → tap pin → this → action, in two taps.
 *
 * Everything on it is either an answer to "who and what is this?" or a button
 * that starts real work. Detail lives one tap further, in the full profile.
 */
export function PropertyPeek({
  property,
  position,
  onOpenFull,
  actionsInFooter,
}: {
  property: Property
  position: Position | null
  onOpenFull?: () => void
  /** The caller is pinning Start visit and View full profile itself. See below. */
  actionsInFooter?: boolean
}) {
  const nav = useNavigate()
  const contact = property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]
  const dist = position ? distanceMiles(position, property) : null

  /*
    The last thing anybody wrote about this door.

    This sheet answers "should I walk over there and knock", and until now it
    answered it without the one field that most often says no. A note tagged
    `dog` or `gate_code` is not colour on a profile — it is the difference
    between opening a side gate and not, and it was two taps away behind "View
    full profile", which is one tap more than a rep standing in the street will
    spend.

    Newest only. This is a peek: the whole history is on the profile, and a
    stack of notes here would push the button that starts work below the fold.
  */
  const allNotes = useAppStore((s) => s.notes)
  const { note, tags } = useMemo(() => {
    let best
    /*
      The newest body, but every note's tags.

      "Big dog in the side yard" stops being the newest note the moment anybody
      writes anything after it, and a rep who does not know about the dog is
      the reason that tag exists. Bodies do not merge — a wall of them would
      push the button that starts work below the fold — but the tags are a
      handful of words and they are the part that has to survive.
    */
    const seen = new Set<NoteTag>()
    for (const n of Object.values(allNotes)) {
      if (n.propertyId !== property.id) continue
      if (!best || n.createdAt > best.createdAt) best = n
      for (const t of n.tags) seen.add(t)
    }
    return { note: best, tags: [...seen] }
  }, [allNotes, property.id])

  return (
    <div className="space-y-3 pt-1" data-testid="property-peek">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold leading-tight">{property.address1}</h3>
            <p className="truncate text-sm text-ink-mute">
              {cityLine(property)}
            </p>
          </div>
          <ScoreBar score={property.score} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusPill status={property.status} />
          <OutcomePill code={property.lastOutcome} />
          {dist != null && (
            <span className="nums text-xs font-medium text-ink-mute">
              {formatDistance(dist)} · {walkMinutes(dist)} min walk
            </span>
          )}
        </div>
      </div>

      {(contact || property.opportunityValue) && (
        <div className="flex items-center justify-between gap-3 rounded-field bg-surface-sunk px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{contact?.name ?? 'No contact'}</p>
            <p className="truncate text-xs text-ink-mute">
              {contact?.phone ?? 'Add a contact during your visit'}
            </p>
          </div>
          {property.opportunityValue != null && (
            <div className="shrink-0 text-right">
              <p className="nums font-semibold text-good">
                {moneyFull(property.opportunityValue)}
              </p>
              <p className="text-[11px] text-ink-mute">Opportunity</p>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-ink-mute">
        Last visit {relativeLower(property.lastVisitAt)}
        {/*
          With its date. "Next: Appointment" alone does not tell a rep whether
          it is in twenty minutes or three weeks, which is the only thing about
          it that changes what they do in the next hour.
        */}
        {property.nextActionLabel &&
          ` · Next: ${property.nextActionLabel}${
            property.nextActionAt ? ` ${relativeLower(property.nextActionAt)}` : ''
          }`}
      </p>

      {note && (
        <div
          className="rounded-field bg-surface-sunk px-3 py-2.5"
          data-testid="peek-note"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="eyebrow">Last note</p>
            <p className="shrink-0 text-[11.5px] text-ink-mute">{relativeLower(note.createdAt)}</p>
          </div>
          {/*
            Two lines, then it stops. A rep reads this standing up; anything
            longer is a profile, and the profile is one tap away and says so.
          */}
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-soft">{note.body}</p>
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-semibold text-accent-strong"
                >
                  {NOTE_TAGS.find((x) => x.tag === t)?.label ?? t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <CommActions property={property} contact={contact} />

      {/*
        Rendered here only when the caller has nowhere better to put them.

        On a phone the map's sheet pins these to its footer instead: at the
        opening detent on a 320px screen every one of them was below the fold,
        so a sheet whose whole purpose is "tap a pin, then act" showed an
        address and nothing to press. The wide layout has no sheet and no
        footer, so there they stay in flow.
      */}
      {!actionsInFooter && (
        <>
      <Button
        size="lg"
        full
        buzz
        onClick={() => nav(`/property/${property.id}?start=1`)}
        className="mt-1"
      >
        Start visit
      </Button>

      <button
        onClick={() => (onOpenFull ? onOpenFull() : nav(`/property/${property.id}`))}
        className="focusable min-h-tap w-full rounded-field text-sm font-semibold text-accent active:bg-surface-tint"
      >
        View full profile
      </button>
        </>
      )}
    </div>
  )
}
