import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncBadge } from '../components/sync/SyncBadge'
import { PullToRefresh } from '../components/ui/PullToRefresh'
import { useAppStore } from '../store/useAppStore'
import { PIPELINE_STAGES, STATUS_COLOR, STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import { drain } from '../lib/sync'
import { DEMO_USERS } from '../data/seed'
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
  const { user, properties, activity, appointments } = useAppStore()

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
    return {
      knocks: todayVisits.length,
      conversations,
      contactRate: todayVisits.length
        ? Math.round((conversations / todayVisits.length) * 100)
        : 0,
      openValue,
      wonValue,
      openCount: open.length,
    }
  }, [properties, todayVisits])

  const stageCounts = useMemo(() => {
    const map = new Map<string, number>()
    Object.values(properties).forEach((p) => map.set(p.status, (map.get(p.status) ?? 0) + 1))
    return map
  }, [properties])

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

      <PullToRefresh onRefresh={() => drain()} className="pad-nav bg-surface-sunk">
        <div className="content-col space-y-3 p-3">
          {/* --- headline numbers ----------------------------------------- */}
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Doors today" value={String(stats.knocks)} />
            <Stat
              label="Conversations"
              value={String(stats.conversations)}
              sub={`${stats.contactRate}% contact rate`}
              tone="text-emerald-600"
            />
            <Stat label="Open pipeline" value={money(stats.openValue)} sub={`${stats.openCount} leads`} />
            <Stat label="Won" value={money(stats.wonValue)} tone="text-emerald-600" />
          </div>

          {isSuper && (
            <section className="card p-4">
              <h2 className="mb-2 text-sm font-bold">Clients</h2>
              <ul className="space-y-2">
                {[
                  { name: 'Summit Exteriors', reps: 12, status: 'Healthy' },
                  { name: 'Bright Path Solar', reps: 28, status: 'Healthy' },
                  { name: 'Redline Roofing', reps: 7, status: 'Low activity' },
                ].map((c) => (
                  <li
                    key={c.name}
                    className="flex min-h-[52px] items-center gap-3 border-b border-slate-100 last:border-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block text-xs text-ink-mute">{c.reps} reps</span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        c.status === 'Healthy'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {c.status}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-mute">
                Full administration, analytics and audit logs are on desktop.
              </p>
            </section>
          )}

          {/* --- team ----------------------------------------------------- */}
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <h2 className="text-sm font-bold">Team today</h2>
              <button
                onClick={() => nav('/team')}
                className="focusable min-h-[44px] rounded-lg px-3 text-sm font-semibold text-brand-600"
              >
                All
              </button>
            </div>
            <ul>
              {DEMO_USERS.filter((u) => u.role === 'field_rep').map((rep) => (
                <li key={rep.id}>
                  <button
                    onClick={() => nav('/team')}
                    className="flex min-h-[64px] w-full items-center gap-3 border-b border-slate-100 px-4 text-left last:border-0 active:bg-slate-50"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-sm font-bold text-brand-600">
                      {rep.avatarInitials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{rep.name}</span>
                      <span className="nums block text-xs text-ink-mute">
                        {stats.knocks} doors · {stats.conversations} conversations
                      </span>
                    </span>
                    <span className="shrink-0 text-ink-mute">
                      <IconChevron />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* --- pipeline snapshot ---------------------------------------- */}
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold">Pipeline</h2>
            <ul className="space-y-2">
              {PIPELINE_STAGES.map((s) => {
                const count = stageCounts.get(s) ?? 0
                const max = Math.max(...PIPELINE_STAGES.map((x) => stageCounts.get(x) ?? 0), 1)
                return (
                  <li key={s} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs font-medium">{STATUS_LABEL[s]}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(count / max) * 100}%`,
                          backgroundColor: STATUS_COLOR[s],
                        }}
                      />
                    </span>
                    <span className="nums w-8 shrink-0 text-right text-xs font-semibold">
                      {count}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* --- upcoming ------------------------------------------------- */}
          {upcoming.length > 0 && (
            <section className="card overflow-hidden">
              <h2 className="px-4 pb-1 pt-3 text-sm font-bold">Upcoming appointments</h2>
              <ul>
                {upcoming.map((a) => {
                  const p = properties[a.propertyId]
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => p && nav(`/property/${p.id}`)}
                        className="flex min-h-[56px] w-full items-center gap-3 border-b border-slate-100 px-4 text-left last:border-0 active:bg-slate-50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.title}</span>
                          <span className="block truncate text-xs text-ink-mute">
                            {p?.address1} · {relative(a.startsAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* --- recent activity ------------------------------------------ */}
          <section className="card overflow-hidden">
            <h2 className="px-4 pb-1 pt-3 text-sm font-bold">Live activity</h2>
            <ul>
              {activity.slice(0, 10).map((ev) => {
                const def = outcomeByCode(ev.outcome)
                return (
                  <li
                    key={ev.id}
                    className="flex min-h-[48px] items-center gap-3 border-b border-slate-100 px-4 py-2 last:border-0"
                  >
                    <span className="w-6 shrink-0 text-center" aria-hidden>
                      {def?.glyph ?? '·'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{ev.summary}</span>
                    <span className="shrink-0 text-xs text-ink-mute">{relative(ev.at)}</span>
                  </li>
                )
              })}
            </ul>
          </section>

          <p className="px-2 pb-2 text-center text-xs leading-relaxed text-ink-mute">
            Open Allstar on a larger screen for user management, territories, imports and
            full reporting.
          </p>
        </div>
      </PullToRefresh>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone = '',
}: {
  label: string
  value: string
  sub?: string
  tone?: string
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{label}</p>
      <p className={`nums mt-1 text-2xl font-black leading-none ${tone}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-mute">{sub}</p>}
    </div>
  )
}
