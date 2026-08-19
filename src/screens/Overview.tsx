import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncBadge } from '../components/sync/SyncBadge'
import { PullToRefresh } from '../components/ui/PullToRefresh'
import { Card, SectionHeader } from '../components/ui/Card'
import { KpiCard } from '../components/ui/KpiCard'
import { ProgressBar } from '../components/ui/ProgressBar'
import { StatusBadge } from '../components/ui/StatusBadge'
import { Avatar } from '../components/ui/Avatar'
import { useAppStore } from '../store/useAppStore'
import { PIPELINE_STAGES, STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import { drain } from '../lib/sync'
import { useTeamStats, useTeamTotals } from '../store/teamStats'
import { IconChevron } from '../components/nav/icons'
import type { Role } from '../types'

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
  const teamStats = useTeamStats()
  const totals = useTeamTotals()

  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])

  const todayVisits = useMemo(
    () => activity.filter((a) => a.type === 'visit' && a.at >= todayStart),
    [activity, todayStart],
  )

  const stats = useMemo(() => {
    const rows = Object.values(properties)
    const open = rows.filter((p) => !['won', 'lost', 'dnc'].includes(p.status))
    const openValue = open.reduce((s, p) => s + (p.opportunityValue ?? 0), 0)
    const wonValue = rows
      .filter((p) => p.status === 'won')
      .reduce((s, p) => s + (p.opportunityValue ?? 0), 0)
    const conversations = todayVisits.filter(
      (v) =>
        v.outcome &&
        ['interested', 'appointment', 'quote_requested', 'sold'].includes(v.outcome),
    ).length
    return { conversations, openValue, wonValue, openCount: open.length }
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
      <TopBar
        title={isSuper ? 'Platform' : user?.clientName ?? 'Overview'}
        subtitle={new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
        right={<SyncBadge />}
      />

      <PullToRefresh
        onRefresh={async () => {
          await Promise.all([drain(), refreshFromServer()])
        }}
        className="pad-nav bg-surface-sunk"
      >
        <div className="content-col page anim-rise">
          {/*
            Headline numbers.
            Two columns, and deliberately not four identically-coloured tiles:
            conversations carry the accent because that is the number a manager
            is actually watching, money won carries green, and volume stays
            neutral. Colouring everything is the same as colouring nothing.
          */}
          <div className="grid grid-cols-2 gap-3">
            <KpiCard label="Doors today" value={totals.knocks} />
            <KpiCard
              label="Conversations"
              value={totals.conversations}
              sub={`${totals.contactRate}% contact rate`}
              tone="brand"
            />
            <KpiCard
              label="Open pipeline"
              value={money(stats.openValue)}
              sub={`${stats.openCount} leads`}
            />
            <KpiCard label="Won" value={money(stats.wonValue)} tone="good" />
          </div>

          {isSuper && (
            <Card padded={false}>
              <SectionHeader title="Clients" className="px-4 pb-3 pt-4" />
              <ul className="row-group">
                {[
                  { name: 'Summit Exteriors', reps: 12, status: 'Healthy' },
                  { name: 'Bright Path Solar', reps: 28, status: 'Healthy' },
                  { name: 'Redline Roofing', reps: 7, status: 'Low activity' },
                ].map((c) => (
                  <li key={c.name} className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
                    <Avatar
                      initials={c.name
                        .split(' ')
                        .slice(0, 2)
                        .map((w) => w[0])
                        .join('')}
                      name={c.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{c.name}</span>
                      <span className="nums block text-[13px] text-ink-mute">{c.reps} reps</span>
                    </span>
                    <StatusBadge tone={c.status === 'Healthy' ? 'good' : 'warn'}>
                      {c.status}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
              <p className="px-4 pb-4 pt-3 text-[13px] leading-snug text-ink-mute">
                Full administration, analytics and audit logs are on desktop.
              </p>
            </Card>
          )}

          {/* --- team ----------------------------------------------------- */}
          <Card padded={false} className="overflow-hidden">
            <SectionHeader
              title="Team today"
              className="px-4 pb-2.5 pt-4"
              action="All"
              onAction={() => nav('/team')}
            />
            <ul className="row-group">
              {teamStats.map((rep) => (
                <li key={rep.id}>
                  <button
                    onClick={() => nav('/team')}
                    className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                  >
                    <Avatar initials={rep.initials} name={rep.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{rep.name}</span>
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
                    <span className="nums shrink-0 text-[15px] font-bold text-ink">
                      {rep.contactRate}%
                    </span>
                    <span className="shrink-0 text-ink-faint">
                      <IconChevron />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {/* --- pipeline snapshot ---------------------------------------- */}
          <Card>
            <SectionHeader title="Pipeline" className="mb-3.5" />
            <ul className="space-y-3">
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
                    <span className="nums w-7 shrink-0 text-right text-[13px] font-bold">
                      {count}
                    </span>
                  </li>
                )
              })}
            </ul>
          </Card>

          {/* --- upcoming ------------------------------------------------- */}
          {upcoming.length > 0 && (
            <Card padded={false} className="overflow-hidden">
              <SectionHeader
                title="Upcoming appointments"
                count={upcoming.length}
                className="px-4 pb-2.5 pt-4"
              />
              <ul className="row-group">
                {upcoming.map((a) => {
                  const p = properties[a.propertyId]
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => p && nav(`/property/${p.id}`)}
                        className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-field"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold">
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
            </Card>
          )}

          {/* --- recent activity ------------------------------------------ */}
          <Card padded={false} className="overflow-hidden">
            <SectionHeader title="Live activity" className="px-4 pb-2.5 pt-4" />
            <ul className="row-group">
              {activity.slice(0, 10).map((ev) => {
                const def = outcomeByCode(ev.outcome)
                return (
                  <li key={ev.id} className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
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
                  </li>
                )
              })}
            </ul>
          </Card>

          <p className="px-4 pb-1 pt-1 text-center text-[13px] leading-relaxed text-ink-mute">
            Open Allstar on a larger screen for user management, territories, imports and
            full reporting.
          </p>
        </div>
      </PullToRefresh>
    </div>
  )
}
