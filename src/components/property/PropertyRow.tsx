import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { STATUS_COLOR } from '../../data/outcomes'
import { OutcomePill, ScoreBar, StatusPill } from '../ui/StatusPill'
import { SwipeRow } from '../ui/SwipeRow'
import { distanceMiles, formatDistance, type Position } from '../../lib/geo'
import { money, relative, telHref } from '../../lib/format'
import { useAppStore } from '../../store/useAppStore'

/**
 * Dense list row, ~84px tall.
 *
 * Answers the four questions a rep asks while scanning a list — where, who,
 * what happened last, how far — and nothing else. Swipe right to call, swipe
 * left to start the visit, so the common cases never require opening the row.
 */
export function PropertyRow({
  property,
  position,
  showDistance = true,
  onPreview,
  active,
  tour,
}: {
  property: Property
  position: Position | null
  showDistance?: boolean
  /** A `data-tour` anchor, so the walkthrough can point at one row. */
  tour?: string
  /**
   * Wide layouts pass this to show the row in an adjacent pane instead of
   * navigating. On a phone it's omitted and the row pushes a detail screen —
   * same row component, different behaviour per form factor.
   */
  onPreview?: (id: string) => void
  active?: boolean
}) {
  const nav = useNavigate()
  const logComm = useAppStore((s) => s.logComm)
  const contact = property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]
  const dist = position ? distanceMiles(position, property) : null
  const tel = telHref(contact?.phone)

  return (
    <SwipeRow
      left={
        tel
          ? {
              label: 'Call',
              glyph: '📞',
              color: '#166534',
              onAction: () => {
                logComm(property.id, 'call', contact?.name)
                window.location.href = tel
              },
            }
          : undefined
      }
      right={{
        label: 'Start visit',
        glyph: '▶',
        color: '#0A6B7D',
        onAction: () => nav(`/property/${property.id}?start=1`),
      }}
      className="border-b border-line-soft last:border-0"
      data-tour={tour}
    >
      <button
        onClick={() =>
          onPreview ? onPreview(property.id) : nav(`/property/${property.id}`)
        }
        aria-current={active ? 'true' : undefined}
        className={`flex min-h-[84px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field ${
          active ? 'bg-surface-tint' : ''
        }`}
      >
        {/* A 3px rail, not 6. The stage is already stated in words on the pill
            below; this only has to be findable while scanning, and at 6px thirty
            rows of it read as a stacked bar chart down the left edge. */}
        <span
          className="h-11 w-[3px] shrink-0 rounded-full"
          style={{ backgroundColor: STATUS_COLOR[property.status] }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-medium">{property.address1}</span>
            {showDistance && dist != null && (
              <span className="nums shrink-0 text-[12.5px] font-medium text-ink-mute">
                {formatDistance(dist)}
              </span>
            )}
          </span>
          <span className="mt-1 flex items-center gap-2 text-[13px] text-ink-mute">
            <span className="truncate">{contact?.name ?? 'No contact on file'}</span>
            {/* Green is reserved for won. An open opportunity is a number. */}
            {property.opportunityValue && (
              <span className="nums shrink-0 font-medium text-ink-soft">
                {money(property.opportunityValue)}
              </span>
            )}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill status={property.status} size="sm" />
            <OutcomePill code={property.lastOutcome} />
            {property.lastVisitAt && (
              <span className="text-[11.5px] text-ink-mute">{relative(property.lastVisitAt)}</span>
            )}
          </span>
        </span>
        <ScoreBar score={property.score} />
      </button>
    </SwipeRow>
  )
}
