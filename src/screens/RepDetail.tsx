import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SectionHeader } from '../components/ui/Card'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { ProgressBar } from '../components/ui/ProgressBar'
import { FieldMap } from '../components/map/FieldMap'
import { useAppStore } from '../store/useAppStore'
import { useTeamStats } from '../store/teamStats'
import { scoreOf, standings } from '../data/leaderboard'
import { money, relative, telHref } from '../lib/format'
import { outcomeByCode } from '../data/outcomes'

/**
 * One rep's day.
 *
 * The manager's question is "how is Alex doing and where is he working", and it
 * gets asked from a truck between meetings. So this is the answer on one screen:
 * the funnel, the patch, the doors left, and the time they have been at it.
 *
 * **On knowing where somebody is.** This shows the last door the rep *logged*,
 * and when. It is not a device position, there is no beacon, and nothing new is
 * collected to make it work — a visit already has to know which house it was, so
 * the location is a fact about the work rather than a fact about the person.
 *
 * That distinction is the whole design. A breadcrumb trail of a phone answers
 * "where is Alex right now", including at lunch, at home, and on a Sunday. This
 * answers "which street is Alex working", goes stale the moment they stop
 * logging, and by construction can say nothing at all about them outside working
 * activity. The screen says so out loud, in front of the manager, because a
 * team that does not know what is shared assumes the worst — and on this the
 * worst is usually what other apps in this category actually do.
 *
 * The rep sees this same screen about themselves, which is the other half of
 * not being creepy: nothing here is visible to a manager that is hidden from the
 * person it describes.
 */
export function RepDetail() {
  const { repId } = useParams()
  const nav = useNavigate()
  const me = useAppStore((s) => s.user)
  const properties = useAppStore((s) => s.properties)
  const territories = useAppStore((s) => s.territories)
  const activity = useAppStore((s) => s.activity)
  const reps = useTeamStats()

  const rep = reps.find((r) => r.id === repId)
  const board = useMemo(() => standings(reps), [reps])
  const rank = board.find((r) => r.rep.id === repId)

  const isSelf = me?.id === repId
  const isOffice = me?.role !== 'field_rep'

  const todaysDoors = useMemo(() => {
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    return activity
      .filter((a) => a.repId === repId && a.type === 'visit' && a.at >= since.getTime())
      .map((a) => (a.propertyId ? properties[a.propertyId] : undefined))
      .filter((p): p is NonNullable<typeof p> => !!p)
  }, [activity, properties, repId])

  if (!rep) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Rep" back />
        <p className="p-6 text-[15px] text-ink-mute">
          Nobody by that name is on this account.
        </p>
      </div>
    )
  }

  /*
    A rep can see their own day; only the office can see somebody else's. Checked
    here as well as in the nav, because a URL is not a permission — this is the
    one screen in the product where the answer to "who can see this about me" has
    to be the same in every path that reaches it.
  */
  if (!isSelf && !isOffice) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Rep" back />
        <div className="p-6">
          <p className="text-[15px] font-semibold">That's not yours to see</p>
          <p className="mt-1 text-[14px] text-ink-mute">
            Another rep's day is visible to managers and admins. Your own is on
            Today.
          </p>
          <Button className="mt-4" onClick={() => nav('/today')}>
            Back to Today
          </Button>
        </div>
      </div>
    )
  }

  const lastDoor = rep.lastPropertyId ? properties[rep.lastPropertyId] : undefined
  const territoryName = rep.territoryId
    ? (territories[rep.territoryId]?.name ?? 'Unnamed patch')
    : null

  /*
    The working window: first logged door to last. Deliberately not "hours
    worked" — it says nothing about breaks, it starts when they knock rather than
    when they clock in, and calling it anything else would be inventing a
    timesheet out of door knocks.
  */
  const windowMs =
    rep.firstActivityAt && rep.lastActivityAt ? rep.lastActivityAt - rep.firstActivityAt : 0
  const windowHours = windowMs / 3_600_000
  const doorsPerHour = windowHours > 0.25 ? rep.knocks / windowHours : null

  const funnel = [
    { label: 'Doors visited', value: rep.knocks },
    { label: 'Conversations', value: rep.conversations },
    { label: 'Interested', value: rep.interested },
    { label: 'Appointments', value: rep.appointments },
    { label: 'Sales', value: rep.sales },
  ]

  const tel = telHref(rep.phone)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title={rep.name} subtitle={territoryName ?? 'No territory yet today'} back />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {/* --- who, where, and how long ------------------------------- */}
          <section className="card p-5">
            <div className="flex items-center gap-3.5">
              <Avatar initials={rep.initials} name={rep.name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-semibold tracking-[-0.01em]">
                  {rep.name}
                </p>
                <p className="truncate text-[13px] text-ink-mute">
                  {territoryName ?? 'No doors logged yet today'}
                  {rank ? ` · ${rank.tied ? 'T' : ''}#${rank.rank} today` : ''}
                </p>
              </div>
              {tel && isOffice && (
                <a
                  href={tel}
                  aria-label={`Call ${rep.name}`}
                  className="metal metal-quiet press focusable grid h-12 w-12 shrink-0 place-items-center rounded-field !text-ink-soft"
                >
                  ☎
                </a>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-y-3 border-t border-line-soft pt-4">
              <dt className="text-[13px] text-ink-mute">Last door</dt>
              <dd className="text-right text-[14px] font-medium">
                {rep.lastActivityAt ? relative(rep.lastActivityAt) : 'Not started'}
              </dd>
              <dt className="text-[13px] text-ink-mute">Working since</dt>
              <dd className="nums text-right text-[14px] font-medium">
                {rep.firstActivityAt
                  ? new Date(rep.firstActivityAt).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : '—'}
              </dd>
              <dt className="text-[13px] text-ink-mute">Doors an hour</dt>
              <dd className="nums text-right text-[14px] font-medium">
                {doorsPerHour ? doorsPerHour.toFixed(1) : '—'}
              </dd>
              <dt className="text-[13px] text-ink-mute">Points today</dt>
              <dd className="nums text-right text-[14px] font-medium">
                {scoreOf(rep).toLocaleString()}
              </dd>
            </dl>
          </section>

          {/* --- the funnel --------------------------------------------- */}
          <section className="section">
            <SectionHeader title="Today" standalone />
            <ul className="plate row-group -mx-4 overflow-hidden sm:mx-0 sm:rounded-card sm:border">
              {funnel.map((row) => (
                <li
                  key={row.label}
                  className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="text-[15px]">{row.label}</span>
                  <span className="nums text-[17px] font-semibold">{row.value}</span>
                </li>
              ))}
              {rep.revenue > 0 && (
                <li className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5">
                  <span className="text-[15px]">Sold today</span>
                  <span className="nums text-[17px] font-semibold text-good">
                    {money(rep.revenue)}
                  </span>
                </li>
              )}
            </ul>
          </section>

          {/* --- the route ---------------------------------------------- */}
          {rep.total > 0 && (
            <section className="section">
              <SectionHeader title="Route" standalone />
              <div className="card p-4">
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="nums font-medium text-ink-soft">
                    {rep.done}/{rep.total} stops
                  </span>
                  <span className="nums text-ink-mute">{rep.remaining} doors left</span>
                </div>
                <ProgressBar
                  value={rep.done}
                  max={Math.max(rep.total, 1)}
                  className="mt-2"
                  label={`${rep.name}: ${rep.done} of ${rep.total} stops`}
                />
              </div>
            </section>
          )}

          {/* --- where the work is -------------------------------------- */}
          <section className="section">
            <SectionHeader title="Where the work is" standalone />
            {todaysDoors.length === 0 ? (
              <p className="card px-6 py-8 text-center text-[14px] text-ink-mute">
                No doors logged yet today, so there is nothing to show on a map.
              </p>
            ) : (
              <div className="overflow-hidden rounded-card border border-line bg-surface">
                <FieldMap
                  className="h-[300px]"
                  properties={todaysDoors}
                  position={null}
                  selectedId={lastDoor?.id ?? null}
                  onSelect={() => {}}
                  disableClustering={todaysDoors.length <= 25}
                />
                <p className="border-t border-line-soft px-4 py-3 text-[13px] leading-relaxed text-ink-mute">
                  {/*
                    Said plainly, on the screen, to the manager. A team that does
                    not know what is shared assumes the worst, and on location the
                    worst is what a lot of apps in this category actually do.
                  */}
                  {lastDoor ? (
                    <>
                      Last logged at <span className="font-medium text-ink">{lastDoor.address1}</span>,{' '}
                      {relative(rep.lastActivityAt ?? 0)}. These are the doors{' '}
                      {isSelf ? 'you have' : `${rep.name.split(' ')[0]} has`} recorded today —
                      not a location trail. The app does not follow a phone, and this
                      goes quiet the moment {isSelf ? 'you stop' : 'they stop'} knocking.
                    </>
                  ) : (
                    <>These are today's logged doors. The app records work, not a phone.</>
                  )}
                </p>
              </div>
            )}
          </section>

          {/* --- the day, in order -------------------------------------- */}
          {todaysDoors.length > 0 && (
            <section className="section">
              <SectionHeader title="Doors today" count={todaysDoors.length} standalone />
              <ul className="plate row-group -mx-4 overflow-hidden sm:mx-0 sm:rounded-card sm:border">
                {activity
                  .filter((a) => a.repId === repId && a.type === 'visit')
                  .slice(0, 12)
                  .map((ev) => {
                    const def = outcomeByCode(ev.outcome)
                    const p = ev.propertyId ? properties[ev.propertyId] : undefined
                    return (
                      <li key={ev.id}>
                        <button
                          onClick={() => p && nav(`/property/${p.id}`)}
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
                          <span className="shrink-0 text-[12.5px] text-ink-mute">
                            {relative(ev.at)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
