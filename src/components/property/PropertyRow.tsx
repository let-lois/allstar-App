import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { OutcomePill, ScoreBar, StatusPill } from '../ui/StatusPill'
import { SwipeRow } from '../ui/SwipeRow'
import { distanceMiles, formatDistance, type Position } from '../../lib/geo'
import { money, relative, telHref } from '../../lib/format'
import { useAppStore } from '../../store/useAppStore'

/**
 * Dense list row, ~76px tall.
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
}: {
  property: Property
  position: Position | null
  showDistance?: boolean
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
              color: '#0d9488',
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
        color: '#2563eb',
        onAction: () => nav(`/property/${property.id}?start=1`),
      }}
      className="border-b border-slate-100 last:border-0"
    >
      <button
        onClick={() =>
          onPreview ? onPreview(property.id) : nav(`/property/${property.id}`)
        }
        aria-current={active ? 'true' : undefined}
        className={`flex min-h-[76px] w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50 ${
          active ? 'bg-brand-50' : ''
        }`}
      >
        <span
          className="h-11 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColorOf(property) }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{property.address1}</span>
            {showDistance && dist != null && (
              <span className="nums shrink-0 text-xs font-medium text-ink-mute">
                {formatDistance(dist)}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-mute">
            <span className="truncate">{contact?.name ?? 'No contact on file'}</span>
            {property.opportunityValue && (
              <span className="nums shrink-0 font-semibold text-emerald-700">
                {money(property.opportunityValue)}
              </span>
            )}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill status={property.status} size="sm" />
            <OutcomePill code={property.lastOutcome} />
            {property.lastVisitAt && (
              <span className="text-[11px] text-ink-mute">{relative(property.lastVisitAt)}</span>
            )}
          </span>
        </span>
        <ScoreBar score={property.score} />
      </button>
    </SwipeRow>
  )
}

function statusColorOf(p: Property) {
  const map: Record<string, string> = {
    new: '#64748b',
    contacted: '#0284c7',
    working: '#0d9488',
    appointment: '#7c3aed',
    quoted: '#d97706',
    won: '#15803d',
    lost: '#cbd5e1',
    dnc: '#b91c1c',
  }
  return map[p.status] ?? '#64748b'
}
