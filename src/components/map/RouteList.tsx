import { useMemo } from 'react'
import type { Property, Route } from '../../types'
import { distanceMiles, formatDistance } from '../../lib/geo'
import { STATUS_COLOR, STATUS_LABEL } from '../../data/outcomes'

/**
 * The route as a list — the map screen's stand-in when there is no imagery.
 *
 * This exists because of a licence, not a preference. The map is moving to the
 * Google Maps JavaScript API, which needs a live connection and whose terms
 * prohibit caching its tiles for offline use. So in a dead zone there is no
 * basemap to draw, and the question becomes what a rep sees instead.
 *
 * A grey rectangle is the wrong answer. Imagery is not what makes the map screen
 * useful — the *order* is. A rep standing on a street needs to know which door is
 * next, how far it is, and what happened at the last one. All of that is on the
 * device already, so none of it needs a network.
 *
 * So this is deliberately not a degraded map. It is the same information the map
 * conveys, in the form that survives with no signal:
 *
 *   - **Route order first.** When a route exists, the stops are numbered in
 *     walking order, because that is the decision the rep is making. Falling back
 *     to nearest-first only happens when there is no route to follow.
 *   - **Distance to the next door, not just from the rep.** "0.1 mi away" tells a
 *     rep whether to drive; "then 240 ft to #4" tells them whether to walk. The
 *     second is the one that gets used — but only where a route exists to make
 *     "next" mean something. Filtered without a route the list has no order, the
 *     badge says so with a dot instead of a number, and claiming a distance to
 *     the following row would be inventing a plan.
 *   - **Done stops stay visible, struck through.** Hiding them loses the rep's
 *     sense of progress, which is the thing that gets someone through door forty.
 *
 * Distances are straight-line, computed locally. That is honest rather than
 * ideal: real walking distance needs the Routes API and therefore a network,
 * which is exactly what this screen does not have.
 */
export function RouteList({
  properties,
  route,
  position,
  selectedId,
  onSelect,
  className = '',
}: {
  properties: Property[]
  route: Route | null | undefined
  position: { lat: number; lng: number } | null | undefined
  selectedId?: string | null
  onSelect: (id: string) => void
  className?: string
}) {
  const ordered = useMemo(() => {
    const byId = new Map(properties.map((p) => [p.id, p]))

    // Route order wins when there is one. Only stops that survived the screen's
    // filter are listed, so the count here always matches what the map showed.
    const stops = route?.stops
      ?.slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ property: byId.get(s.propertyId), stop: s }))
      .filter((r): r is { property: Property; stop: Route['stops'][number] } => !!r.property)

    if (stops?.length) return stops

    // No route: nearest first, which is the order a rep freelancing actually
    // wants. Without a position there is nothing to sort by, so the caller's
    // order is left alone rather than shuffled into a false one.
    if (!position) return properties.map((property) => ({ property, stop: undefined }))
    return properties
      .map((property) => ({ property, stop: undefined }))
      .sort((a, b) => distanceMiles(position, a.property) - distanceMiles(position, b.property))
  }, [properties, route, position])

  if (ordered.length === 0) {
    return (
      <div className={`grid place-items-center p-8 ${className}`}>
        <p className="text-center text-[15px] text-ink-mute">
          No doors match this filter.
          <span className="mt-1 block text-[13px]">
            Try “All” above, or build a route from Today.
          </span>
        </p>
      </div>
    )
  }

  return (
    <ol className={`scroll-pane ${className}`} aria-label="Route stops">
      {ordered.map(({ property: p, stop }, i) => {
        const next = ordered[i + 1]?.property
        const done = stop?.status === 'done'
        return (
          <li key={p.id}>
            <button
              onClick={() => onSelect(p.id)}
              aria-current={selectedId === p.id ? 'true' : undefined}
              className={`flex min-h-[72px] w-full items-center gap-3 border-b border-ink/[0.06] px-4 py-2.5 text-left active:bg-surface-field ${
                selectedId === p.id ? 'bg-brand-50' : ''
              }`}
            >
              {/*
                The number is the point of this row, so it gets the weight. Status
                colour rides the badge rather than a separate stripe — one object
                to read instead of two.
              */}
              <span
                className="nums grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[14px] font-bold text-white"
                style={{ backgroundColor: STATUS_COLOR[p.status] }}
                aria-hidden
              >
                {stop ? i + 1 : '·'}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[15px] font-semibold ${
                    done ? 'text-ink-mute line-through' : ''
                  }`}
                >
                  {p.address1}
                </span>
                <span className="block truncate text-[13px] text-ink-mute">
                  {p.contacts[0]?.name ?? 'No contact'} · {STATUS_LABEL[p.status]}
                </span>
                {/*
                  Only when there is a real route. Without one this list has no
                  sequence — the badge shows a dot rather than a number for
                  exactly that reason — and "then 13 mi to ..." between two rows
                  that merely happen to be adjacent is a claim about a walk
                  nobody planned. It read as a terrible route when it was in fact
                  no route at all.
                */}
                {stop && next && (
                  <span className="nums block truncate text-[12px] text-ink-faint">
                    then {formatDistance(distanceMiles(p, next))} to {next.address1}
                  </span>
                )}
              </span>

              {position && (
                <span className="nums shrink-0 text-[13px] font-semibold text-ink-soft">
                  {formatDistance(distanceMiles(position, p))}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
