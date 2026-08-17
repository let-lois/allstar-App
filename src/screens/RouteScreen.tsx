import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { SwipeRow } from '../components/ui/SwipeRow'
import { OutcomePill } from '../components/ui/StatusPill'
import { useAppStore, useRouteProgress } from '../store/useAppStore'
import { distanceMiles, formatDistance, navigationUrl } from '../lib/geo'
import { time } from '../lib/format'
import { IconNavigate } from '../components/nav/icons'

/**
 * Today's route as an ordered stop list.
 *
 * Swipe left on a stop to skip it (nobody home, dog in the yard, gate locked) —
 * the route re-points at the next door immediately rather than making the rep
 * hunt for where they were.
 */
export function RouteScreen() {
  const nav = useNavigate()
  const { route, properties, position, skipStop } = useAppStore()
  const progress = useRouteProgress()

  const stops = useMemo(
    () => [...(route?.stops ?? [])].sort((a, b) => a.order - b.order),
    [route],
  )

  if (!route) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Route" back="/today" />
        <div className="grid flex-1 place-items-center p-8 text-center text-ink-mute">
          No route assigned for today.
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
        <div className="sticky top-0 z-10 border-b border-slate-100 bg-surface px-4 py-2.5">
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-mute">
            Swipe a stop left to skip it · started {route.startedAt ? time(route.startedAt) : '—'}
          </p>
        </div>

        <ul>
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
                          color: '#d97706',
                          onAction: () => void skipStop(stop.propertyId),
                        }
                      : undefined
                  }
                  className="border-b border-slate-100"
                >
                  <div
                    className={`flex items-center gap-3 px-4 py-3 ${
                      isActive ? 'bg-brand-50' : ''
                    }`}
                  >
                    <span
                      className={`nums grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold ${
                        isDone
                          ? 'bg-emerald-100 text-emerald-700'
                          : isSkipped
                            ? 'bg-slate-100 text-slate-400'
                            : isActive
                              ? 'bg-brand-500 text-white'
                              : 'bg-slate-100 text-ink-mute'
                      }`}
                    >
                      {isDone ? '✓' : isSkipped ? '–' : stop.order + 1}
                    </span>

                    <button
                      onClick={() => nav(`/property/${p.id}`)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span
                        className={`block truncate font-semibold ${
                          isDone || isSkipped ? 'text-ink-mute line-through' : ''
                        }`}
                      >
                        {p.address1}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-mute">
                        {dist != null && <span className="nums">{formatDistance(dist)}</span>}
                        <OutcomePill code={p.lastOutcome} />
                      </span>
                    </button>

                    {isActive && (
                      <div className="flex shrink-0 gap-1.5">
                        <a
                          href={navigationUrl({ lat: p.lat, lng: p.lng })}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Navigate to ${p.address1}`}
                          className="press focusable grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-surface"
                        >
                          <IconNavigate />
                        </a>
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
