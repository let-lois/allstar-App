import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Card } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Avatar } from '../components/ui/Avatar'
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
        <div className="content-col page anim-rise">
          {/* Company roll-up first — the "how is today going" answer. */}
          <Card className="grid grid-cols-3 divide-x divide-ink/[0.06]">
            <Stat label="Doors" value={String(totals.knocks)} />
            <Stat label="Contact rate" value={`${totals.contactRate}%`} tone="text-brand-600" />
            <Stat label="Pipeline" value={money(totals.pipelineToday)} tone="text-good" />
          </Card>

          {reps.map((rep, i) => {
            const tel = telHref(rep.phone)
            const repActivity = activity
              .filter((a) => a.repId === rep.id && a.at >= todayStart)
              .slice(0, 3)

            return (
              <Card key={rep.id}>
                <div className="flex items-center gap-3">
                  <span className="relative shrink-0">
                    <Avatar initials={rep.initials} name={rep.name} size="lg" />
                    {i === 0 && totals.conversations > 0 && (
                      <span
                        className="absolute -right-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full bg-good text-[10px] text-white ring-2 ring-white"
                        title="Most conversations today"
                      >
                        ★
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-bold">{rep.name}</p>
                    <p className="truncate text-[13px] text-ink-mute">{rep.routeName}</p>
                  </div>
                  {tel && (
                    <a
                      href={tel}
                      aria-label={`Call ${rep.name}`}
                      className="press focusable grid h-12 w-12 shrink-0 place-items-center rounded-field bg-surface text-ink-soft ring-1 ring-ink/10 active:bg-surface-field"
                    >
                      <IconPhone />
                    </a>
                  )}
                </div>

                <div className="mt-4 flex items-baseline justify-between text-[13px]">
                  <span className="nums font-semibold">
                    {rep.done}/{rep.total} stops
                  </span>
                  <span className="nums text-ink-mute">
                    {rep.conversations} conversations · {rep.contactRate}%
                  </span>
                </div>
                <ProgressBar
                  value={rep.done}
                  max={Math.max(rep.total, 1)}
                  className="mt-2"
                  label={`${rep.name}: ${rep.done} of ${rep.total} stops`}
                />

                {repActivity.length > 0 ? (
                  <ul className="mt-4 space-y-0.5 border-t border-ink/[0.06] pt-2">
                    {repActivity.map((ev) => {
                      const def = outcomeByCode(ev.outcome)
                      const p = ev.propertyId ? properties[ev.propertyId] : undefined
                      return (
                        <li key={ev.id}>
                          <button
                            onClick={() => p && nav(`/property/${p.id}`)}
                            className="-mx-2 flex min-h-[46px] w-[calc(100%+1rem)] items-center gap-2.5 rounded-field px-2 text-left text-[14px] active:bg-surface-field"
                          >
                            <span
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[13px]"
                              aria-hidden
                            >
                              {def?.glyph ?? '·'}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-ink-soft">
                              {ev.summary}
                            </span>
                            {p?.opportunityValue != null && (
                              <span className="nums shrink-0 text-[13px] font-semibold text-good">
                                {money(p.opportunityValue)}
                              </span>
                            )}
                            <span className="shrink-0 text-[12.5px] text-ink-mute">
                              {relative(ev.at)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mt-4 border-t border-ink/[0.06] pt-3 text-[13px] text-ink-mute">
                    No activity logged yet today.
                  </p>
                )}
              </Card>
            )
          })}

          <p className="px-4 pb-1 pt-1 text-center text-[13px] leading-relaxed text-ink-mute">
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
    <div className="px-1 text-center first:pl-0 last:pr-0">
      <p className={`nums text-kpi-sm font-extrabold ${tone}`}>{value}</p>
      <p className="mt-1.5 text-[11.5px] font-medium text-ink-mute">{label}</p>
    </div>
  )
}
