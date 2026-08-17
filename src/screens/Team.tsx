import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { useAppStore } from '../store/useAppStore'
import { useTeamStats, useTeamTotals } from '../store/teamStats'
import { outcomeByCode } from '../data/outcomes'
import { money, relative, telHref } from '../lib/format'
import { IconPhone } from '../components/nav/icons'

/**
 * Team view for managers on a phone.
 *
 * What a manager standing in a parking lot needs: who's out, how far through
 * their route, what's landing, and a one-tap way to call a rep. Sorted by
 * conversations rather than doors, because volume without conversion is the
 * thing a manager wants to spot, not reward. Assignment and territory editing
 * is desktop work.
 */
export function Team() {
  const nav = useNavigate()
  const activity = useAppStore((s) => s.activity)
  const properties = useAppStore((s) => s.properties)
  const reps = useTeamStats()
  const totals = useTeamTotals()

  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Team"
        subtitle={`${totals.reps} reps · ${totals.knocks} doors · ${totals.conversations} conversations`}
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col space-y-3 p-3">
          {/* Company roll-up first — the "how is today going" answer. */}
          <section className="card grid grid-cols-3 divide-x divide-slate-100 p-4">
            <Stat label="Doors" value={String(totals.knocks)} />
            <Stat
              label="Contact rate"
              value={`${totals.contactRate}%`}
              tone="text-emerald-600"
            />
            <Stat label="Pipeline" value={money(totals.pipelineToday)} tone="text-emerald-600" />
          </section>

          {reps.map((rep, i) => {
            const tel = telHref(rep.phone)
            const repActivity = activity
              .filter((a) => a.repId === rep.id && a.at >= todayStart)
              .slice(0, 3)

            return (
              <section key={rep.id} className="card p-4">
                <div className="flex items-center gap-3">
                  <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-50 font-bold text-brand-600">
                    {rep.initials}
                    {i === 0 && totals.conversations > 0 && (
                      <span
                        className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-emerald-600 text-[10px] text-white"
                        title="Most conversations today"
                      >
                        ★
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{rep.name}</p>
                    <p className="truncate text-xs text-ink-mute">{rep.routeName}</p>
                  </div>
                  {tel && (
                    <a
                      href={tel}
                      aria-label={`Call ${rep.name}`}
                      className="press focusable grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-200"
                    >
                      <IconPhone />
                    </a>
                  )}
                </div>

                <div className="mt-3 flex items-baseline justify-between text-xs">
                  <span className="nums font-semibold">
                    {rep.done}/{rep.total} stops
                  </span>
                  <span className="nums text-ink-mute">
                    {rep.conversations} conversations · {rep.contactRate}%
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${rep.pct}%` }}
                  />
                </div>

                {repActivity.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {repActivity.map((ev) => {
                      const def = outcomeByCode(ev.outcome)
                      const p = ev.propertyId ? properties[ev.propertyId] : undefined
                      return (
                        <li key={ev.id}>
                          <button
                            onClick={() => p && nav(`/property/${p.id}`)}
                            className="flex min-h-[44px] w-full items-center gap-2 text-left text-sm active:bg-slate-50"
                          >
                            <span className="w-5 shrink-0 text-center" aria-hidden>
                              {def?.glyph ?? '·'}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{ev.summary}</span>
                            {p?.opportunityValue != null && (
                              <span className="nums shrink-0 text-xs font-semibold text-emerald-700">
                                {money(p.opportunityValue)}
                              </span>
                            )}
                            <span className="shrink-0 text-xs text-ink-mute">
                              {relative(ev.at)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-ink-mute">No activity logged yet today.</p>
                )}
              </section>
            )
          })}

          <p className="px-2 pb-2 text-center text-xs leading-relaxed text-ink-mute">
            Territory assignment, route building and rep performance reports are available
            on desktop.
          </p>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-2 text-center first:pl-0 last:pr-0">
      <p className={`nums text-xl font-black leading-none ${tone}`}>{value}</p>
      <p className="mt-1 text-[11px] text-ink-mute">{label}</p>
    </div>
  )
}
