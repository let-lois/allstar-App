import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useAppStore,
  useMyActivity,
  useMyAppointments,
  useMyTasks,
  useRouteProgress,
} from '../store/useAppStore'
import { TopBar } from '../components/nav/TopBar'
import { SyncBadge, SyncDetail } from '../components/sync/SyncBadge'
import { BottomSheet } from '../components/ui/BottomSheet'
import { PullToRefresh } from '../components/ui/PullToRefresh'
import { Button } from '../components/ui/Button'
import { OutcomePill } from '../components/ui/StatusPill'
import { distanceMiles, formatDistance, navigationUrl, walkMinutes } from '../lib/geo'
import { money, relative, relativeLower, time } from '../lib/format'
import { drain } from '../lib/sync'
import { outcomeByCode } from '../data/outcomes'
import { DEFAULT_ROUTE_SIZE, routableLeads } from '../lib/route'
import { IconCalendar, IconChevron, IconNavigate } from '../components/nav/icons'

/**
 * The Today screen — the rep's operational home.
 *
 * Ordered strictly by what a rep needs while standing on a sidewalk:
 *   1. how am I doing today   2. where do I go next   3. what's scheduled
 *   4. what's outstanding     5. what did I just do
 *
 * The "Next stop" block is the centre of gravity: address, distance, and the
 * two buttons that start actual work, all above the fold on a 5.4" phone.
 */
export function Today() {
  const nav = useNavigate()
  const { user, properties, route, position, refreshPosition, refreshFromServer } =
    useAppStore()
  const buildTodayRoute = useAppStore((s) => s.buildTodayRoute)
  // Scoped to this rep — with a full team in the data, the unscoped stores hold
  // everyone's work and would report the team's doors as this rep's.
  const appointments = useMyAppointments()
  const tasks = useMyTasks()
  const activity = useMyActivity()
  const progress = useRouteProgress()
  const [syncOpen, setSyncOpen] = useState(false)

  const nextStop = useMemo(() => {
    const stop =
      route?.stops.find((s) => s.status === 'active') ??
      route?.stops.find((s) => s.status === 'pending')
    return stop ? properties[stop.propertyId] : undefined
  }, [route, properties])

  const todaysAppointments = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const end = startOfDay.getTime() + 86_400_000
    return appointments.filter((a) => a.startsAt >= startOfDay.getTime() && a.startsAt < end)
  }, [appointments])

  const openTasks = useMemo(
    () => tasks.filter((t) => !t.done),
    [tasks],
  )

  const todayVisits = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    return activity.filter((a) => a.type === 'visit' && a.at >= startOfDay.getTime())
  }, [activity])

  const wins = todayVisits.filter(
    (v) => v.outcome && ['interested', 'appointment', 'quote_requested', 'sold'].includes(v.outcome),
  ).length

  const pipelineToday = useMemo(
    () =>
      todayVisits.reduce((sum, v) => {
        const p = v.propertyId ? properties[v.propertyId] : undefined
        return sum + (v.outcome === 'sold' || v.outcome === 'quote_requested'
          ? (p?.opportunityValue ?? 0)
          : 0)
      }, 0),
    [todayVisits, properties],
  )

  const dist = position && nextStop ? distanceMiles(position, nextStop) : null
  const greeting = getGreeting()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={`${greeting}, ${user?.name.split(' ')[0] ?? 'there'}`}
        subtitle={new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
        right={<SyncBadge onClick={() => setSyncOpen(true)} />}
      />

      <PullToRefresh
        onRefresh={async () => {
          // Push what's queued, pull what changed, re-fix the GPS. In demo mode
          // the server pull is a no-op, so the gesture behaves identically.
          await Promise.all([drain(), refreshFromServer(), refreshPosition()])
        }}
        className="pad-nav bg-surface-sunk"
      >
        <div className="content-col space-y-3 p-3">
          {/* --- progress ------------------------------------------------- */}
          <section className="card p-4" aria-label="Today's progress">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Route progress
                </p>
                <p className="nums mt-0.5 text-3xl font-black leading-none">
                  {progress.done}
                  <span className="text-lg font-bold text-ink-mute"> / {progress.total}</span>
                </p>
                <p className="mt-1 text-xs text-ink-mute">
                  {progress.remaining} doors left
                  {progress.skipped ? ` · ${progress.skipped} skipped` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className="nums text-2xl font-black leading-none text-emerald-600">{wins}</p>
                <p className="text-xs text-ink-mute">conversations</p>
                {pipelineToday > 0 && (
                  <p className="nums mt-1 text-xs font-semibold text-emerald-700">
                    +{money(pipelineToday)} pipeline
                  </p>
                )}
              </div>
            </div>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width]"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
          </section>

          {/* --- next stop: the single most important block --------------- */}
          {nextStop ? (
            <section className="card overflow-hidden" aria-label="Next property">
              <div className="flex items-center justify-between gap-2 bg-brand-500 px-4 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-white/90">
                  Next stop
                </p>
                {dist != null && (
                  <p className="nums text-xs font-semibold text-white">
                    {formatDistance(dist)} · {walkMinutes(dist)} min
                  </p>
                )}
              </div>

              <button
                onClick={() => nav(`/property/${nextStop.id}`)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-slate-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xl font-bold leading-tight">
                    {nextStop.address1}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-mute">
                    <span className="truncate">
                      {nextStop.contacts[0]?.name ?? 'No contact on file'}
                    </span>
                    <OutcomePill code={nextStop.lastOutcome} />
                  </span>
                  {nextStop.lastVisitAt && (
                    <span className="mt-1 block text-xs text-ink-mute">
                      Last visit {relativeLower(nextStop.lastVisitAt)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-ink-mute">
                  <IconChevron />
                </span>
              </button>

              <div className="flex gap-2 px-3 pb-3">
                <a
                  href={navigationUrl({ lat: nextStop.lat, lng: nextStop.lng })}
                  target="_blank"
                  rel="noreferrer"
                  className="press focusable flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-200 font-semibold active:bg-slate-50"
                >
                  <IconNavigate />
                  Navigate
                </a>
                <Button
                  size="lg"
                  buzz
                  className="flex-[1.4]"
                  onClick={() => nav(`/property/${nextStop.id}?start=1`)}
                >
                  Start visit
                </Button>
              </div>
            </section>
          ) : progress.total === 0 ? (
            /*
              No route at all — a rep's first morning, or a day nobody planned.
              This used to fall through to "Route complete · 0 doors knocked
              today. Nice work.", which congratulates someone for work they
              haven't done and offers no way to start. If there are leads to
              walk, the only thing this card should do is turn them into a day.
            */
            <PlanDayCard />
          ) : (
            <section className="card p-5 text-center">
              <p className="text-base font-semibold">Route complete</p>
              <p className="mt-1 text-sm text-ink-mute">
                {progress.done} of {progress.total} doors knocked today. Nice work.
              </p>
              <div className="mt-3 space-y-2">
                <Button full onClick={() => void buildTodayRoute()}>
                  Plan more doors
                </Button>
                <Button variant="secondary" full onClick={() => nav('/map')}>
                  Find more properties
                </Button>
              </div>
            </section>
          )}

          {/* --- appointments --------------------------------------------- */}
          {todaysAppointments.length > 0 && (
            <Section title="Appointments" count={todaysAppointments.length}>
              <ul>
                {todaysAppointments.map((a) => {
                  const p = properties[a.propertyId]
                  const past = a.startsAt < Date.now()
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => p && nav(`/property/${p.id}`)}
                        className="flex min-h-[64px] w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 active:bg-slate-50"
                      >
                        <span
                          className={`nums w-16 shrink-0 rounded-lg px-1 py-1.5 text-center text-xs font-bold ${
                            past ? 'bg-slate-100 text-ink-mute' : 'bg-violet-50 text-violet-700'
                          }`}
                        >
                          {time(a.startsAt)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{a.title}</span>
                          <span className="block truncate text-xs text-ink-mute">
                            {p?.address1 ?? 'Property'}
                          </span>
                        </span>
                        <span className="shrink-0 text-ink-mute">
                          <IconChevron />
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}

          {/* --- follow-ups / tasks --------------------------------------- */}
          {openTasks.length > 0 && (
            <Section title="Follow-ups" count={openTasks.length}>
              <ul>
                {openTasks.slice(0, 6).map((t) => (
                  <TaskRow key={t.id} id={t.id} />
                ))}
              </ul>
            </Section>
          )}

          {/* --- recent activity ------------------------------------------ */}
          {todayVisits.length > 0 && (
            <Section title="Today's activity" count={todayVisits.length}>
              <ul>
                {todayVisits.slice(0, 8).map((ev) => {
                  const def = outcomeByCode(ev.outcome)
                  return (
                    <li key={ev.id}>
                      <button
                        onClick={() => ev.propertyId && nav(`/property/${ev.propertyId}`)}
                        className="flex min-h-[52px] w-full items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left last:border-0 active:bg-slate-50"
                      >
                        <span className="w-6 shrink-0 text-center" aria-hidden>
                          {def?.glyph ?? '·'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{ev.summary}</span>
                        <span className="shrink-0 text-xs text-ink-mute">{time(ev.at)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}

          <button
            onClick={() => nav('/route')}
            className="focusable min-h-tap w-full rounded-xl text-sm font-semibold text-brand-600 active:bg-brand-50"
          >
            View full route
          </button>
        </div>
      </PullToRefresh>

      <BottomSheet
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        title="Sync status"
        detents={[0.55]}
      >
        <SyncDetail />
      </BottomSheet>
    </div>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {count != null && (
          <span className="nums rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-ink-mute">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/** Own component so toggling one task doesn't re-render the whole screen. */
function TaskRow({ id }: { id: string }) {
  const task = useAppStore((s) => s.tasks[id])
  const property = useAppStore((s) => (task?.propertyId ? s.properties[task.propertyId] : undefined))
  const toggleTask = useAppStore((s) => s.toggleTask)
  const nav = useNavigate()
  if (!task) return null

  const overdue = task.dueAt < Date.now()

  return (
    <li className="flex items-center border-b border-slate-100 last:border-0">
      {/* 48px checkbox — this gets tapped while walking. */}
      <button
        onClick={() => void toggleTask(task.id)}
        aria-label={`Mark ${task.title} complete`}
        className="focusable grid h-[60px] w-14 shrink-0 place-items-center active:bg-slate-50"
      >
        <span className="grid h-6 w-6 place-items-center rounded-md border-2 border-slate-300" />
      </button>
      <button
        onClick={() => (property ? nav(`/property/${property.id}`) : undefined)}
        className="flex min-h-[60px] flex-1 items-center gap-2 py-2 pr-4 text-left active:bg-slate-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{task.title}</span>
          <span
            className={`block text-xs ${overdue ? 'font-semibold text-amber-600' : 'text-ink-mute'}`}
          >
            {overdue ? 'Overdue · ' : ''}
            {relative(task.dueAt)}
          </span>
        </span>
        <IconCalendar />
      </button>
    </li>
  )
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/**
 * The first thing a rep sees on a morning nobody planned.
 *
 * Deliberately a single decision: how many doors. Everything else — which
 * streets, what order, how far — is the app's job, and asking a rep standing in
 * a truck to make those choices is how a product ends up unused. If there is
 * nothing to walk, this says so plainly rather than offering a button that
 * silently does nothing.
 */
function PlanDayCard() {
  const nav = useNavigate()
  const properties = useAppStore((s) => s.properties)
  const user = useAppStore((s) => s.user)
  const position = useAppStore((s) => s.position)
  const buildTodayRoute = useAppStore((s) => s.buildTodayRoute)
  const [building, setBuilding] = useState(false)

  const available = useMemo(() => {
    const mine = Object.values(properties).filter(
      (p) => user?.role !== 'field_rep' || p.assignedRepId === user?.id,
    )
    return routableLeads(mine)
  }, [properties, user])

  if (available.length === 0) {
    return (
      <section className="card p-5 text-center">
        <p className="text-base font-semibold">No doors to walk yet</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-mute">
          Nothing is assigned to you for today. Your manager can import a lead list
          and assign it — or you can add a house yourself while you’re standing in
          front of it.
        </p>
        <Button variant="secondary" className="mt-3" full onClick={() => nav('/lead/new')}>
          Add a lead
        </Button>
      </section>
    )
  }

  const target = Math.min(DEFAULT_ROUTE_SIZE, available.length)

  return (
    <section className="card p-5 text-center">
      <p className="text-base font-semibold">Ready to plan your day</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-mute">
        {available.length.toLocaleString()} lead{available.length === 1 ? '' : 's'} waiting.
        We’ll put the closest {target} in walking order
        {position ? ' from where you are now' : ''}.
      </p>
      <Button
        size="lg"
        full
        buzz
        className="mt-4"
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
        {building ? 'Planning…' : `Plan ${target} doors`}
      </Button>
      <Button variant="secondary" full className="mt-2" onClick={() => nav('/map')}>
        Pick them on the map
      </Button>
    </section>
  )
}
