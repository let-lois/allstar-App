import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Chip } from '../components/ui/Chip'
import { useAppStore } from '../store/useAppStore'
import { PIPELINE_STAGES, STATUS_COLOR, STATUS_LABEL } from '../data/outcomes'
import { money, moneyFull, relativeLower } from '../lib/format'
import { IconChevron } from '../components/nav/icons'
import type { LeadStatus } from '../types'

/**
 * Pipeline.
 *
 * A kanban board is a desktop idea — dragging cards between columns on a phone
 * is miserable and reps don't do it anyway, because stage changes come from
 * recording outcomes. So on mobile this is a stacked summary you tap into: one
 * column at a time, full width, every row a real target. The board layout
 * appears only where there's room for it.
 */
export function Pipeline() {
  const nav = useNavigate()
  const properties = useAppStore((s) => s.properties)
  const [stage, setStage] = useState<LeadStatus>('working')

  const byStage = useMemo(() => {
    const map = new Map<LeadStatus, { count: number; value: number }>()
    PIPELINE_STAGES.forEach((s) => map.set(s, { count: 0, value: 0 }))
    for (const p of Object.values(properties)) {
      const bucket = map.get(p.status)
      if (!bucket) continue
      bucket.count += 1
      bucket.value += p.opportunityValue ?? 0
    }
    return map
  }, [properties])

  const stageRows = useMemo(
    () =>
      Object.values(properties)
        .filter((p) => p.status === stage)
        .sort((a, b) => (b.opportunityValue ?? 0) - (a.opportunityValue ?? 0)),
    [properties, stage],
  )

  const totalValue = useMemo(
    () =>
      PIPELINE_STAGES.filter((s) => s !== 'won').reduce(
        (sum, s) => sum + (byStage.get(s)?.value ?? 0),
        0,
      ),
    [byStage],
  )

  const wonValue = byStage.get('won')?.value ?? 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Pipeline"
        subtitle={`${moneyFull(totalValue)} open · ${moneyFull(wonValue)} won`}
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col">
        {/* Funnel summary — tap a bar to switch the list below it. */}
        <section className="card m-3 p-4">
          <ul className="space-y-2.5">
            {PIPELINE_STAGES.map((s) => {
              const bucket = byStage.get(s) ?? { count: 0, value: 0 }
              const max = Math.max(
                ...PIPELINE_STAGES.map((x) => byStage.get(x)?.count ?? 0),
                1,
              )
              const pct = (bucket.count / max) * 100
              return (
                <li key={s}>
                  <button
                    onClick={() => setStage(s)}
                    aria-pressed={stage === s}
                    className={`focusable w-full rounded-xl px-2 py-1.5 text-left ${
                      stage === s ? 'bg-slate-50 ring-1 ring-slate-200' : ''
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold">{STATUS_LABEL[s]}</span>
                      <span className="nums text-xs text-ink-mute">
                        {bucket.count} · {money(bucket.value)}
                      </span>
                    </span>
                    <span className="mt-1 block h-2.5 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: STATUS_COLOR[s] }}
                      />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <div className="flex items-center gap-2 px-4 pb-2">
          <h2 className="text-sm font-bold">{STATUS_LABEL[stage]}</h2>
          <Chip size="sm" color={STATUS_COLOR[stage]}>
            {stageRows.length}
          </Chip>
        </div>

        <section className="card mx-3 mb-3 overflow-hidden">
          {stageRows.length === 0 ? (
            <p className="p-6 text-center text-sm text-ink-mute">
              Nothing in {STATUS_LABEL[stage].toLowerCase()} right now.
            </p>
          ) : (
            <ul>
              {stageRows.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => nav(`/property/${p.id}`)}
                    className="flex min-h-[68px] w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 active:bg-slate-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{p.address1}</span>
                      <span className="block truncate text-xs text-ink-mute">
                        {p.contacts[0]?.name ?? 'No contact'} ·{' '}
                        {relativeLower(p.lastVisitAt)}
                      </span>
                    </span>
                    {p.opportunityValue != null && (
                      <span className="nums shrink-0 font-bold text-emerald-700">
                        {money(p.opportunityValue)}
                      </span>
                    )}
                    <span className="shrink-0 text-ink-mute">
                      <IconChevron />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>
    </div>
  )
}
