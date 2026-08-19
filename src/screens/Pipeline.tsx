import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Card, SectionHeader } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/ProgressBar'
import { useScopedProperties } from '../store/useAppStore'
import { PIPELINE_STAGES, STATUS_LABEL } from '../data/outcomes'
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
  const properties = useScopedProperties()
  const [stage, setStage] = useState<LeadStatus>('working')

  const byStage = useMemo(() => {
    const map = new Map<LeadStatus, { count: number; value: number }>()
    PIPELINE_STAGES.forEach((s) => map.set(s, { count: 0, value: 0 }))
    for (const p of properties) {
      const bucket = map.get(p.status)
      if (!bucket) continue
      bucket.count += 1
      bucket.value += p.opportunityValue ?? 0
    }
    return map
  }, [properties])

  const stageRows = useMemo(
    () =>
      properties
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
        <div className="content-col page anim-rise">
          {/*
            Funnel summary — tap a bar to switch the list below it.

            Every bar is the brand orange with the won stage in green, rather than
            one colour per stage. Seven hues down a single column reads as
            decoration; one accent plus one outcome colour reads as a funnel, and
            the selected row is what tells you where you are.
          */}
          <Card>
            <SectionHeader title="Stages" className="mb-3.5" />
            <ul className="space-y-1">
              {PIPELINE_STAGES.map((s) => {
                const bucket = byStage.get(s) ?? { count: 0, value: 0 }
                const max = Math.max(
                  ...PIPELINE_STAGES.map((x) => byStage.get(x)?.count ?? 0),
                  1,
                )
                const selected = stage === s
                return (
                  <li key={s}>
                    <button
                      onClick={() => setStage(s)}
                      aria-pressed={selected}
                      className={`focusable w-full rounded-field px-2.5 py-2 text-left transition-colors ${
                        selected ? 'bg-brand-50 ring-1 ring-brand-200' : 'active:bg-surface-field'
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={`text-[14px] font-semibold ${
                            selected ? 'text-brand-600' : 'text-ink'
                          }`}
                        >
                          {STATUS_LABEL[s]}
                        </span>
                        <span className="nums text-[12.5px] text-ink-mute">
                          {bucket.count} · {money(bucket.value)}
                        </span>
                      </span>
                      <ProgressBar
                        value={bucket.count}
                        max={max}
                        tone={s === 'won' ? 'good' : 'brand'}
                        animate={false}
                        label={`${STATUS_LABEL[s]}: ${bucket.count}`}
                        className="mt-1.5"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>

          <Card padded={false} className="overflow-hidden">
            <SectionHeader
              title={STATUS_LABEL[stage]}
              count={stageRows.length}
              className="px-4 pb-2.5 pt-4"
            />
            {stageRows.length === 0 ? (
              <p className="px-6 pb-6 pt-2 text-center text-[14px] text-ink-mute">
                Nothing in {STATUS_LABEL[stage].toLowerCase()} right now.
              </p>
            ) : (
              <ul className="row-group">
                {stageRows.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => nav(`/property/${p.id}`)}
                      className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">
                          {p.address1}
                        </span>
                        <span className="mt-0.5 block truncate text-[13px] text-ink-mute">
                          {p.contacts[0]?.name ?? 'No contact'} ·{' '}
                          {relativeLower(p.lastVisitAt)}
                        </span>
                      </span>
                      {p.opportunityValue != null && (
                        <span className="nums shrink-0 text-[15px] font-bold text-good">
                          {money(p.opportunityValue)}
                        </span>
                      )}
                      <span className="shrink-0 text-ink-faint">
                        <IconChevron />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
