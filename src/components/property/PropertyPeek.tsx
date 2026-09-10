import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { useAppStore } from '../../store/useAppStore'
import { NOTE_TAGS } from '../../data/outcomes'
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
}: {
  property: Property
  position: Position | null
  onOpenFull?: () => void
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
  const note = useMemo(() => {
    let best
    for (const n of Object.values(allNotes)) {
      if (n.propertyId !== property.id) continue
      if (!best || n.createdAt > best.createdAt) best = n
    }
    return best
  }, [allNotes, property.id])

  return (
    <div className="space-y-3 pt-1">
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
        {property.nextActionLabel && ` · Next: ${property.nextActionLabel}`}
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
          {note.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {note.tags.map((t) => (
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

      {/* Primary action last, so it sits closest to the thumb. */}
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
    </div>
  )
}
