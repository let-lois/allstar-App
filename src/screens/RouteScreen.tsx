import { useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { ProgressBar } from '../components/ui/ProgressBar'
import { SwipeRow } from '../components/ui/SwipeRow'
import { OutcomePill } from '../components/ui/StatusPill'
import { useAppStore, useRouteProgress } from '../store/useAppStore'
import { distanceMiles, formatDistance } from '../lib/geo'
import { time } from '../lib/format'
import { IconNavigate } from '../components/nav/icons'
import { DEFAULT_ROUTE_SIZE, routableLeads } from '../lib/route'

/**
 * Today's route as an ordered stop list.
 *
 * Swipe left on a stop to skip it (nobody home, dog in the yard, gate locked) —
 * the route re-points at the next door immediately rather than making the rep
 * hunt for where they were.
 */
export function RouteScreen() {
  const nav = useNavigate()
  const { route, properties, position, skipStop, user } = useAppStore()
  const buildTodayRoute = useAppStore((s) => s.buildTodayRoute)
  const tz = useAppStore((s) => s.timezone)
  const progress = useRouteProgress()
  const [building, setBuilding] = useState(false)

  // What a route *could* be built from, for the empty state below.
  const routable = useMemo(
    () =>
      routableLeads(
        Object.values(properties).filter(
          (p) => user?.role !== 'field_rep' || p.assignedRepId === user?.id,
        ),
        Date.now(),
        tz,
      ),
    [properties, user, tz],
  )

  const stops = useMemo(
    () => [...(route?.stops ?? [])].sort((a, b) => a.order - b.order),
    [route],
  )

  if (!route) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Route" back="/today" />
        <div className="grid flex-1 place-items-center p-8 text-center">
          <div className="max-w-[19rem]">
            <p className="text-[19px] font-semibold">No route planned yet</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">
              {routable.length > 0
                ? `${routable.length.toLocaleString()} lead${routable.length === 1 ? '' : 's'} are waiting. Put the closest ones in walking order and get going.`
                : 'Nothing is assigned to you for today.'}
            </p>
            {routable.length > 0 && (
              <Button
                size="lg"
                full
                className="mt-5"
                disabled={building}
                onClick={async () => {
                  setBuilding(true)
                  try {
                    await buildTodayRoute()
                  } finally {
                    setBuilding(false)
                  }
                }}
              >
                {building ? 'Planning…' : `Plan ${Math.min(DEFAULT_ROUTE_SIZE, routable.length)} doors`}
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={route.name}
        subtitle={`${progress.done} of ${progress.total} complete`}
        back="/today"
      />

      <div className="scroll-pane pad-nav bg-surface">
        <div className="content-col">
        <div className="sticky top-0 z-10 border-b border-line-soft bg-surface px-4 py-3">
          <ProgressBar
            value={progress.done}
            max={Math.max(progress.total, 1)}
            animate={false}
            label={`${progress.done} of ${progress.total} stops`}
          />
          <p className="mt-2 text-[12.5px] text-ink-mute">
            Swipe a stop left to skip it · started {route.startedAt ? time(route.startedAt) : '—'}
          </p>
        </div>

        <ul data-tour="route-list">
          {stops.map((stop) => {
            const p = properties[stop.propertyId]
            if (!p) return null
            const dist = position ? distanceMiles(position, p) : null
            const isActive = stop.status === 'active'
            const isDone = stop.status === 'done'
            const isSkipped = stop.status === 'skipped'

            return (
              <li key={stop.propertyId}>
                <SwipeRow
                  right={
                    !isDone
                      ? {
                          label: 'Skip',
                          glyph: '⤼',
                          color: '#B45309',
                          onAction: () => void skipStop(stop.propertyId),
                        }
                      : undefined
                  }
                  className="border-b border-line-soft"
                >
                  <div
                    className={`flex min-h-[72px] items-center gap-3 px-4 py-3 ${
                      isActive ? 'bg-surface-tint' : ''
                    }`}
                  >
                    <span
                      className={`nums grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold ${
                        isDone
                          ? 'bg-good-bg text-good'
                          : isSkipped
                            ? 'bg-surface-field text-ink-mute'
                            : isActive
                              ? 'bg-brand-600 text-white'
                              : 'bg-surface-field text-ink-mute'
                      }`}
                    >
                      {isDone ? '✓' : isSkipped ? '–' : stop.order + 1}
                    </span>

                    <button
                      onClick={() => nav(`/property/${p.id}`)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span
                        className={`block truncate text-[15px] font-semibold ${
                          isDone || isSkipped ? 'text-ink-mute line-through' : ''
                        }`}
                      >
                        {p.address1}
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-[13px] text-ink-mute">
                        {dist != null && <span className="nums">{formatDistance(dist)}</span>}
                        <OutcomePill code={p.lastOutcome} />
                      </span>
                    </button>

                    {isActive && (
                      <div className="flex shrink-0 gap-1.5">
                        <Link
                          to={`/navigate/${p.id}`}
                          aria-label={`Navigate to ${p.address1}`}
                          className="metal metal-quiet press focusable grid h-11 w-11 place-items-center rounded-field !text-ink-soft"
                        >
                          <IconNavigate />
                        </Link>
                        <Button size="sm" buzz onClick={() => nav(`/property/${p.id}?start=1`)}>
                          Start
                        </Button>
                      </div>
                    )}
                  </div>
                </SwipeRow>
              </li>
            )
          })}
        </ul>
        </div>
      </div>
    </div>
  )
}
