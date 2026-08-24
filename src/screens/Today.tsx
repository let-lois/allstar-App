import { useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
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
import { Card, SectionHeader } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/ProgressBar'
import { OutcomePill } from '../components/ui/StatusPill'
import { distanceMiles, formatDistance, walkMinutes } from '../lib/geo'
import { money, relative, relativeLower, time } from '../lib/format'
import { drain } from '../lib/sync'
import { outcomeByCode } from '../data/outcomes'
import { DEFAULT_ROUTE_SIZE, routableLeads } from '../lib/route'
import { IconCalendar, IconChevron, IconNavigate } from '../components/nav/icons'
import { useTeamStats } from '../store/teamStats'
import { standings } from '../data/leaderboard'

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
  /*
    The standings, computed here rather than fetched: it is the same team stats
    every other screen derives, so a rep's rank costs nothing and is correct with
    no signal — which is where they will be looking at it.
  */
  const signedIn = useAppStore((s) => s.user)
  const repStats = useTeamStats()
  const board = useMemo(() => standings(repStats), [repStats])
  const myStanding = board.find((r) => r.rep.id === signedIn?.id)
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
        <div className="content-col page anim-rise">
          {/* --- progress ------------------------------------------------- */}
          <Card aria-label="Today's progress">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="eyebrow">Route progress</p>
                <p className="nums mt-1 text-[34px] font-semibold leading-none tracking-[-0.02em] text-ink">
                  {progress.done}
                  <span className="text-[19px] font-medium text-ink-faint"> / {progress.total}</span>
                </p>
                <p className="mt-1 text-[13px] text-ink-mute">
                  {progress.remaining} doors left
                  {progress.skipped ? ` · ${progress.skipped} skipped` : ''}
                </p>
              </div>
              {/* The right column is the outcome, not the effort — so it gets
                  green, and the doors number stays neutral. */}
              <div className="shrink-0 text-right">
                <p className="eyebrow">Conversations</p>
                <p className="nums mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em] text-brand-600">
                  {wins}
                </p>
                {pipelineToday > 0 && (
                  <p className="nums mt-1 text-[13px] font-medium text-ink-mute">
                    +{money(pipelineToday)} pipeline
                  </p>
                )}
              </div>
            </div>
            <ProgressBar
              value={progress.done}
              max={Math.max(progress.total, 1)}
              className="mt-4"
              label={`${progress.done} of ${progress.total} doors`}
            />
          </Card>

          {/* --- next stop: the single most important block --------------- */}
          {nextStop ? (
            /*
              The hero card.

              A tinted band rather than a saturated one. There is no shade of
              this teal that is both bright and safe to put white text on — the
              ramp from #07B3CA to #0A6B7D never clears 4.5:1 with white until it
              is already a deep petrol — and a saturated bar across the top of the
              first card makes the whole screen read heavy. So the band carries
              teal *text* on a tint, and the single saturated teal on the screen
              is the button that starts work. That is what "use the accent
              selectively" means in practice.
            */
            <Card padded={false} className="overflow-hidden" aria-label="Next property">
              <div className="flex items-center justify-between gap-2 bg-brand-50 px-4 py-2.5">
                <p className="text-[12.5px] font-semibold text-brand-600">
                  Next stop
                </p>
                {dist != null && (
                  <p className="nums text-[12.5px] font-semibold text-brand-700">
                    {formatDistance(dist)} · {walkMinutes(dist)} min
                  </p>
                )}
              </div>

              <button
                onClick={() => nav(`/property/${nextStop.id}`)}
                className="flex w-full items-center gap-3 px-4 pb-3 pt-4 text-left active:bg-surface-field"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[23px] font-semibold tracking-[-0.02em]">
                    {nextStop.address1}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-mute">
                    <span className="truncate">
                      {nextStop.contacts[0]?.name ?? 'No contact on file'}
                    </span>
                    <OutcomePill code={nextStop.lastOutcome} />
                  </span>
                  {nextStop.lastVisitAt && (
                    <span className="mt-1.5 block text-[13px] text-ink-mute">
                      Last visit {relativeLower(nextStop.lastVisitAt)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-ink-faint">
                  <IconChevron />
                </span>
              </button>

              <div className="flex gap-2.5 px-4 pb-4 pt-1">
                {/*
                  In-app, like every other Navigate. This is the first screen a
                  rep sees each morning, so it is the one most likely to be
                  tapped — and it kept opening a tab after the lead screen
                  stopped doing so, which is worse than either behaviour on its
                  own: the same button did two different things depending on
                  where you found it.
                */}
                <Link
                  to={`/navigate/${nextStop.id}`}
                  className="metal metal-quiet press focusable flex min-h-[54px] flex-1 items-center justify-center gap-2 rounded-[16px] text-[15px] font-semibold"
                >
                  <IconNavigate />
                  Navigate
                </Link>
                <Button
                  size="lg"
                  buzz
                  className="flex-[1.4]"
                  onClick={() => nav(`/property/${nextStop.id}?start=1`)}
                >
                  Start visit
                </Button>
              </div>
            </Card>
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
            <Card className="px-5 py-6 text-center">
              <p className="text-[19px] font-semibold">Route complete</p>
              <p className="mx-auto mt-1.5 max-w-[34ch] text-[14px] leading-relaxed text-ink-mute">
                {progress.done} of {progress.total} doors knocked today. Nice work.
              </p>
              <div className="mt-5 space-y-2.5">
                <Button size="lg" full onClick={() => void buildTodayRoute()}>
                  Plan more doors
                </Button>
                <Button variant="secondary" size="lg" full onClick={() => nav('/map')}>
                  Find more properties
                </Button>
              </div>
            </Card>
          )}

          {/*
            --- where you stand ------------------------------------------
            One row, under the next door rather than above it. This is the
            motivating thing, not the working thing: it must be visible without
            scrolling and must never sit between a rep and the address they are
            walking to.

            Hidden for a team of one, where a leaderboard is a mirror, and for
            anyone not on the board — a manager has no row and inventing one puts
            an admin with no route at the bottom of a table of people who knock.
          */}
          {myStanding && board.length > 1 && (
            <button
              onClick={() => nav('/standings')}
              className="metal-row focusable -mx-4 flex min-h-[64px] items-center gap-3 px-4 text-left sm:mx-0 sm:rounded-card sm:border sm:border-line"
            >
              <span className="nums shrink-0 text-[20px] font-semibold tracking-[-0.02em] text-brand-700">
                {myStanding.tied ? 'T' : ''}#{myStanding.rank}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium">
                  {myStanding.rank === 1 ? 'Top of the board' : 'Where you stand today'}
                </span>
                <span className="nums block truncate text-[12.5px] text-ink-soft">
                  {myStanding.points.toLocaleString()} points · {board.length} reps
                </span>
              </span>
              <span className="shrink-0 text-brand-700">
                <IconChevron />
              </span>
            </button>
          )}

          {/* --- appointments --------------------------------------------- */}
          {todaysAppointments.length > 0 && (
            <Section title="Appointments" count={todaysAppointments.length}>
              <ul className="row-group">
                {todaysAppointments.map((a) => {
                  const p = properties[a.propertyId]
                  const past = a.startsAt < Date.now()
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => p && nav(`/property/${p.id}`)}
                        className="flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                      >
                        <span
                          className={`nums w-[58px] shrink-0 rounded-field px-1 py-2 text-center text-[12.5px] font-semibold ${
                            past ? 'bg-surface-field text-ink-mute' : 'bg-info-bg text-info'
                          }`}
                        >
                          {time(a.startsAt)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold">
                            {a.title}
                          </span>
                          <span className="block truncate text-[13px] text-ink-mute">
                            {p?.address1 ?? 'Property'}
                          </span>
                        </span>
                        <span className="shrink-0 text-ink-faint">
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
              <ul className="row-group">
                {openTasks.slice(0, 6).map((t) => (
                  <TaskRow key={t.id} id={t.id} />
                ))}
              </ul>
            </Section>
          )}

          {/* --- recent activity ------------------------------------------ */}
          {todayVisits.length > 0 && (
            <Section title="Today's activity" count={todayVisits.length}>
              <ul className="row-group">
                {todayVisits.slice(0, 8).map((ev) => {
                  const def = outcomeByCode(ev.outcome)
                  return (
                    <li key={ev.id}>
                      <button
                        onClick={() => ev.propertyId && nav(`/property/${ev.propertyId}`)}
                        className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-field"
                      >
                        <span
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]"
                          aria-hidden
                        >
                          {def?.glyph ?? '·'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">
                          {ev.summary}
                        </span>
                        <span className="nums shrink-0 text-[12.5px] text-ink-mute">
                          {time(ev.at)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}

          <Button variant="secondary" size="lg" full onClick={() => nav('/route')}>
            View full route
          </Button>
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
    <section className="section">
      <SectionHeader title={title} count={count} standalone />
      {/*
        Full-bleed on a phone, and a card once there is room for a margin. A
        titled band of rows reads as part of this screen; the same rows inside a
        rounded rectangle read as a widget that happens to be on it.
      */}
      <div className="plate -mx-4 overflow-hidden sm:mx-0 sm:rounded-card sm:border">
        {children}
      </div>
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
    <li className="flex items-center">
      {/* 48px checkbox — this gets tapped while walking. */}
      <button
        onClick={() => void toggleTask(task.id)}
        aria-label={`Mark ${task.title} complete`}
        className="focusable grid h-[60px] w-14 shrink-0 place-items-center active:bg-surface-field"
      >
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] border-2 border-ink/20" />
      </button>
      <button
        onClick={() => (property ? nav(`/property/${property.id}`) : undefined)}
        className="flex min-h-[60px] flex-1 items-center gap-2 py-2 pr-4 text-left active:bg-surface-field"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{task.title}</span>
          <span
            className={`block text-[13px] ${overdue ? 'font-semibold text-warn' : 'text-ink-mute'}`}
          >
            {overdue ? 'Overdue · ' : ''}
            {relative(task.dueAt)}
          </span>
        </span>
        <span className="shrink-0 text-ink-faint">
          <IconCalendar />
        </span>
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
      <Card className="px-5 py-6 text-center">
        <p className="text-[19px] font-semibold">No doors to walk yet</p>
        <p className="mx-auto mt-1.5 max-w-[36ch] text-[14px] leading-relaxed text-ink-mute">
          Nothing is assigned to you for today. Your manager can import a lead list
          and assign it — or you can add a house yourself while you’re standing in
          front of it.
        </p>
        <Button variant="secondary" size="lg" className="mt-5" full onClick={() => nav('/lead/new')}>
          Add a lead
        </Button>
      </Card>
    )
  }

  const target = Math.min(DEFAULT_ROUTE_SIZE, available.length)

  return (
    <Card className="px-5 py-6 text-center">
      <p className="text-[19px] font-semibold">Ready to plan your day</p>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-[14px] leading-relaxed text-ink-mute">
        {available.length.toLocaleString()} lead{available.length === 1 ? '' : 's'} waiting.
        We’ll put the closest {target} in walking order
        {position ? ' from where you are now' : ''}.
      </p>
      <Button
        size="lg"
        full
        buzz
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
        {building ? 'Planning…' : `Plan ${target} doors`}
      </Button>
      <Button variant="secondary" size="lg" full className="mt-2.5" onClick={() => nav('/map')}>
        Pick them on the map
      </Button>
    </Card>
  )
}
