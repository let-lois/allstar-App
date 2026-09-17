import { Glyph } from '../components/ui/Glyph'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncBadge } from '../components/sync/SyncBadge'
import { SignOutButton } from '../components/nav/SignOutButton'
import { PullToRefresh } from '../components/ui/PullToRefresh'
import { SectionHeader } from '../components/ui/Card'
import { KpiCard } from '../components/ui/KpiCard'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Avatar } from '../components/ui/Avatar'
import { useAppStore } from '../store/useAppStore'
import { PIPELINE_STAGES, STATUS_LABEL, isOpenStatus, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import { drain } from '../lib/sync'
import { useTeamStats, useTeamTotals } from '../store/teamStats'
import { IconChevron } from '../components/nav/icons'
import { ROLE_LABEL } from '../lib/roles'
import type { Role } from '../types'
import { startOfToday, todayLabel } from '../lib/day'

/**
 * Overview for the office roles on a phone.
 *
 * Managers and admins do their real work at a desk. On a phone they want the
 * answer to one question — "is today going the way it should?" — so this is a
 * read-and-react screen: headline numbers, who's active, what needs attention.
 * The full console (user management, territories, imports, reports) stays on
 * desktop where it belongs.
 */
export function Overview({ role }: { role: Role }) {
  const nav = useNavigate()
  const { user, properties, activity, appointments, refreshFromServer } = useAppStore()
  const tz = useAppStore((s) => s.timezone)
  const teamStats = useTeamStats()
  const totals = useTeamTotals()

  /* Two letters from the name, the same rule the roster uses. */
  const initials = (user?.name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  /*
    Midnight on the company's calendar, not on this phone's. A rep who crosses a
    state line mid-route should not watch their day's count reset at lunchtime,
    and the console beside them has to be counting the same hours.
  */
  const todayStart = useMemo(() => startOfToday(tz), [tz])

  const todayVisits = useMemo(
    () => activity.filter((a) => a.type === 'visit' && a.at >= todayStart),
    [activity, todayStart],
  )

  const stats = useMemo(() => {
    const rows = Object.values(properties)
    const open = rows.filter((p) => isOpenStatus(p.status))
    const openValue = open.reduce((s, p) => s + (p.opportunityValue ?? 0), 0)
    const won = rows.filter((p) => p.status === 'won')
    const wonValue = won.reduce((s, p) => s + (p.opportunityValue ?? 0), 0)
    const conversations = todayVisits.filter(
      (v) =>
        v.outcome &&
        ['interested', 'appointment', 'quote_requested', 'sold'].includes(v.outcome),
    ).length
    return { conversations, openValue, wonValue, openCount: open.length, wonCount: won.length }
  }, [properties, todayVisits])

  const stageCounts = useMemo(() => {
    const map = new Map<string, number>()
    Object.values(properties).forEach((p) => map.set(p.status, (map.get(p.status) ?? 0) + 1))
    return map
  }, [properties])

  const stageMax = useMemo(
    () => Math.max(...PIPELINE_STAGES.map((s) => stageCounts.get(s) ?? 0), 1),
    [stageCounts],
  )

  const upcoming = useMemo(
    () =>
      Object.values(appointments)
        .filter((a) => a.startsAt >= Date.now())
        .sort((a, b) => a.startsAt - b.startsAt)
        .slice(0, 4),
    [appointments],
  )

  const isSuper = role === 'super_admin'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Who is signed in, rather than what the screen is called.

        The screen's name and the date used to sit here, and on the one screen an
        admin opens first that is the least useful thing the header could hold —
        they know which app they opened. What they cannot see anywhere else on a
        phone is which account they are signed in as, which matters most for the
        roles that can be signed into more than one.

        The name is not lost: it is still the h1, read by anything navigating by
        heading. The date moved down to sit opposite "Today", where it is a label
        on the numbers underneath it rather than chrome.
      */}
      <TopBar
        title={isSuper ? 'Platform' : user?.clientName ?? 'Overview'}
        right={
          <>
            <SignOutButton />
            <SyncBadge />
          </>
        }
        identity={
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar
              initials={initials}
              name={user?.name ?? ''}
              src={user?.avatarUrl}
              size="sm"
            />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold leading-tight">
                {user?.name ?? 'Signed in'}
              </span>
              <span className="block truncate text-[12px] leading-tight text-ink-mute">
                {user ? `${ROLE_LABEL[user.role]} · ${user.clientName}` : ''}
              </span>
            </span>
          </div>
        }
      />

      <PullToRefresh
        onRefresh={async () => {
          await Promise.all([drain(), refreshFromServer()])
        }}
        className="pad-nav bg-surface-sunk"
      >
        <div className="content-col page anim-rise">
          {/*
            Two sections, not one grid of four.

            Four tiles of equal size and weight are four things to compare and no
            answer — which is exactly how a dashboard reads and exactly what this
            screen is not for. Today's effort is a pair of small counts; the money
            is one large number with its supporting figures beside it. A manager
            opening this on a phone gets the answer to "is today going the way it
            should" from the top third of the screen.
          */}
          <section className="section">
            <SectionHeader
            title="Today"
            standalone
            /* The date the numbers below belong to. */
            right={
              <span className="shrink-0 text-[12.5px] text-ink-mute">
                {todayLabel(tz)}
              </span>
            }
          />
            <div className="grid grid-cols-2 gap-3" data-tour="overview-kpis">
              <KpiCard label="Doors" value={totals.knocks} />
              <KpiCard
                label="Conversations"
                value={totals.conversations}
                sub={`${totals.contactRate}% contact rate`}
                tone="brand"
              />
            </div>
          </section>

          <section className="section">
            <SectionHeader title="Pipeline" standalone />
            {/*
              The lead metric. It is the number the business is run on, so it gets
              the width and the size rather than a quarter of a grid — and `Won`
              sits under it as context rather than beside it as a rival.
            */}
            <KpiCard
              label="Open pipeline"
              value={money(stats.openValue)}
              sub={`${stats.openCount} leads`}
              size="lead"
              onClick={() => nav('/pipeline')}
            />
            <div className="grid grid-cols-2 gap-3">
              <KpiCard label="Won" value={money(stats.wonValue)} tone="good" />
              {/* The count beside the value, because one large deal and ten small
                  ones are the same number here and very different weeks. */}
              <KpiCard label="Deals won" value={stats.wonCount} />
            </div>
          </section>

          {/*
            The accounts this deployment actually holds — which is one, the
            company the person is signed in to.

            Three invented companies used to sit here, inline, with rep counts
            and health labels: Summit Exteriors, Bright Path Solar, Redline
            Roofing. They rendered in live mode with nothing marking them as
            illustrative, on the home screen of the first administrator a
            deployment ever creates, because setup makes that person a super
            admin. An operator reading their own product had no way to tell
            that two thirds of their customer list was fiction.

            There is no endpoint that lists accounts — `/api/clients` does not
            exist — so the honest version is the one row we can prove and a
            sentence saying why there is only one. When a multi-tenant API
            arrives this becomes a map over its response and nothing else
            changes.
          */}
          {isSuper && (
            <section className="section">
              <SectionHeader title="Account" standalone />
              <ul className="panel row-group" data-testid="overview-accounts">
                <li className="flex min-h-[64px] items-center gap-3 px-4 py-3">
                  <Avatar initials={initials} name={user?.clientName ?? 'This account'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{user?.clientName ?? 'This account'}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-mute">
                      <span className="nums">{teamStats.length}</span>
                      <span>{teamStats.length === 1 ? 'person on the team' : 'people on the team'}</span>
                    </span>
                  </span>
                </li>
              </ul>
              <p className="text-[13px] leading-snug text-ink-mute">
                This deployment serves one account. Full administration, analytics and audit logs are on desktop.
              </p>
            </section>
          )}

          {/* --- team ----------------------------------------------------- */}
          <section className="section">
            <SectionHeader
              title="Team today"
              standalone
              action="All"
              onAction={() => nav('/team')}
            />
            <ul className="panel row-group" data-tour="overview-team">
              {teamStats.map((rep) => (
                <li key={rep.id}>
                  <button
                    onClick={() => nav('/team')}
                    className="flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                  >
                    <Avatar initials={rep.initials} name={rep.name} />
                    <span className="min-w-0 flex-1">
                      {/* Medium, not bold. A list where every name is bold has no
                          emphasis left for the thing that actually matters. */}
                      <span className="block truncate text-[15px] font-medium">{rep.name}</span>
                      {/*
                        Never wrapped, and never truncated mid-word either.

                        Three facts wrapped to a second line at 390px, which made
                        every row a different height. Two facts still truncate to
                        "11 conve…" at 320px, so the narrowest phones drop the
                        second fact rather than mangling it — the mobile-first
                        move is to *add* the detail once there is room for it,
                        not to squeeze it in everywhere and clip the result.
                      */}
                      <span className="nums mt-0.5 block truncate text-[13px] text-ink-mute">
                        {rep.knocks} doors
                        <span className="hidden xs:inline">
                          {' '}
                          · {rep.conversations} conversations
                        </span>
                      </span>
                    </span>
                    {/*
                      Not green. A contact rate is a measurement, not an
                      achievement, and painting 27% the same green as 58% tells a
                      manager the thing they opened the screen to find out is
                      fine when it isn't.
                    */}
                    <span className="nums shrink-0 text-[15px] font-semibold text-ink">
                      {rep.contactRate}%
                    </span>
                    <span className="shrink-0 text-ink-faint">
                      <IconChevron />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* --- pipeline snapshot ---------------------------------------- */}
          <section className="section">
            <SectionHeader title="By stage" standalone />
            <ul className="card space-y-3.5 p-4">
              {PIPELINE_STAGES.map((s) => {
                const count = stageCounts.get(s) ?? 0
                return (
                  <li key={s} className="flex items-center gap-3">
                    <span className="w-[74px] shrink-0 text-[13px] font-medium text-ink-soft">
                      {STATUS_LABEL[s]}
                    </span>
                    <ProgressBar
                      value={count}
                      max={stageMax}
                      tone={s === 'won' ? 'good' : 'brand'}
                      label={`${STATUS_LABEL[s]}: ${count}`}
                      className="flex-1"
                    />
                    <span className="nums w-7 shrink-0 text-right text-[13px] font-semibold">
                      {count}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* --- upcoming ------------------------------------------------- */}
          {upcoming.length > 0 && (
            <section className="section">
              <SectionHeader title="Upcoming" count={upcoming.length} standalone />
              <ul className="panel row-group">
                {upcoming.map((a) => {
                  const p = properties[a.propertyId]
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => p && nav(`/property/${p.id}`)}
                        className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium">
                            {a.title}
                          </span>
                          <span className="block truncate text-[13px] text-ink-mute">
                            {p?.address1} · {relative(a.startsAt)}
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
            </section>
          )}

          {/* --- recent activity ------------------------------------------ */}
          <section className="section">
            <SectionHeader title="Live activity" standalone />
            <ul className="panel row-group">
              {activity.slice(0, 10).map((ev) => {
                const def = outcomeByCode(ev.outcome)
                return (
                  <li key={ev.id} className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
                    <span
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]"
                      aria-hidden
                    >
                      {def ? <Glyph name={def.icon} className="icon-xs" /> : '·'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">
                      {ev.summary}
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-mute">
                      {relative(ev.at)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>

          <p className="px-2 pb-1 pt-2 text-center text-[13px] leading-relaxed text-ink-mute">
            Open Allstar on a larger screen for user management, territories, imports and
            full reporting.
          </p>
        </div>
      </PullToRefresh>
    </div>
  )
}
