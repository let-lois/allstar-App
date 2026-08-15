import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { useAppStore, useRouteProgress } from '../store/useAppStore'
import { DEMO_USERS } from '../data/seed'
import { outcomeByCode } from '../data/outcomes'
import { money, relative, telHref } from '../lib/format'
import { IconPhone } from '../components/nav/icons'

/**
 * Team view for managers on a phone.
 *
 * What a manager standing in a parking lot needs: who's out, how far through
 * their route, what's landing, and a one-tap way to call a rep. Assignment and
 * territory editing is desktop work.
 */
export function Team() {
  const nav = useNavigate()
  const { activity, properties } = useAppStore()
  const progress = useRouteProgress()

  const reps = DEMO_USERS.filter((u) => u.role === 'field_rep')

  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])

  const todayActivity = useMemo(
    () => activity.filter((a) => a.at >= todayStart),
    [activity, todayStart],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Team" subtitle={`${reps.length} rep in the field`} />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col space-y-3 p-3">
          {reps.map((rep) => {
            const tel = telHref(rep.phone)
            return (
              <section key={rep.id} className="card p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-50 font-bold text-brand-600">
                    {rep.avatarInitials}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{rep.name}</p>
                    <p className="nums truncate text-xs text-ink-mute">
                      {progress.done}/{progress.total} stops · {todayActivity.length} events today
                    </p>
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

                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${progress.pct}%` }}
                  />
                </div>

                <ul className="mt-3 space-y-1.5">
                  {todayActivity.slice(0, 4).map((ev) => {
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
