import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { OutcomePill, ScoreBar, StatusPill } from '../ui/StatusPill'
import { CommActions } from './CommActions'
import { Button } from '../ui/Button'
import { distanceMiles, formatDistance, walkMinutes, type Position } from '../../lib/geo'
import { moneyFull, relativeLower } from '../../lib/format'

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

  return (
    <div className="space-y-3 pt-1">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold leading-tight">{property.address1}</h3>
            <p className="truncate text-sm text-ink-mute">
              {property.city}, {property.state} {property.zip}
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
              <p className="nums font-bold text-good">
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
        className="focusable min-h-tap w-full rounded-field text-sm font-semibold text-brand-600 active:bg-brand-50"
      >
        View full profile
      </button>
    </div>
  )
}
