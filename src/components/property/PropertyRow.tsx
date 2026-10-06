import { IconPhone, IconPlay } from '../nav/icons'
import { useNavigate } from 'react-router-dom'
import type { Property } from '../../types'
import { STATUS_COLOR } from '../../data/outcomes'
import { OutcomePill, StatusPill } from '../ui/StatusPill'
import { SwipeRow } from '../ui/SwipeRow'
import { distanceMiles, formatDistance, type Position } from '../../lib/geo'
import { money, relative } from '../../lib/format'
import { homeownerContact } from '../../lib/contact'
import { COULD_NOT_OPEN, openExternal } from '../../lib/external'
import { useAppStore, useQuoteSentAt } from '../../store/useAppStore'
import { leadValue } from '@allstar/core/deals'

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
  const quoteSentAt = useQuoteSentAt(property.id)
  const dist = position ? distanceMiles(position, property) : null
  /*
    Through `homeownerContact` rather than `telHref`, so the swipe obeys Do Not
    Contact. This row offered swipe-left-to-call on any property in any list —
    one gesture, no confirmation — and never looked at the status. It was the
    fourth path to a live `tel:` and the easiest one to miss, because the check
    that should have covered it lived on a different screen.
  */
  const { person: contact, tel } = homeownerContact(property)

  return (
    <SwipeRow
      left={
        tel
          ? {
              label: 'Call',
              glyph: <IconPhone />,
              color: '#166534',
              onAction: () => {
                // Through the shell's hand-off in the phone app — a browser-only
                // location change was the one call path that could not report
                // a failure. Logged once the phone has actually opened it.
                void openExternal(tel).then((opened) => {
                  if (opened) logComm(property.id, 'call', contact?.name)
                  else window.alert(COULD_NOT_OPEN)
                })
              },
            }
          : undefined
      }
      right={{
        label: 'Start visit',
        glyph: <IconPlay />,
        color: '#0A6B7D',
        onAction: () => nav(`/property/${property.id}?start=1`),
      }}
      /*
        A boxed row rather than a divider between rows. The Leads list is
        virtualised and ran edge to edge, so it was the one screen left with no
        boundaries on it at all once everything else became a panel. The 108px
        slot has room: an 84px minimum button, 4px of border and a 12px gap.
      */
      className="panel mx-4 mb-3"
    >
      <button
        onClick={() =>
          onPreview ? onPreview(property.id) : nav(`/property/${property.id}`)
        }
        aria-current={active ? 'true' : undefined}
        /*
          A stable hook for the gates that need to open a lead.

          Two of them used to find one with `button` filtered by "a number
          followed by a word", which describes an address and also describes
          "Last 7 days" — so adding a filter chip to the leads screen sent them
          clicking a filter instead of a lead. The row is a button rather than a
          link because it may open a preview pane instead of navigating, so
          there is no href to aim at; this is the substitute.
        */
        data-testid="lead-row"
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
            {!!leadValue(property) && (
              <span className="nums shrink-0 font-medium text-ink-soft">
                {money(leadValue(property))}
              </span>
            )}
            {/*
              The one fact a status pill cannot carry: a quoted lead whose
              quote has actually gone out. On this line, not the pills row —
              this line never wraps (the name truncates instead), and the list
              draws each row in a fixed-height slot, so a row must not grow.
            */}
            {quoteSentAt !== undefined && (
              <span className="shrink-0 text-[12px] font-medium text-ink-soft" data-testid="lead-quote-sent">
                Quote sent {relative(quoteSentAt)}
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
      </button>
    </SwipeRow>
  )
}
