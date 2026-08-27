import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SectionHeader } from '../components/ui/Card'
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

            Every bar is the brand teal with the won stage in green, rather than
            one colour per stage. Seven hues down a single column reads as
            decoration; one accent plus one outcome colour reads as a funnel, and
            the selected row is what tells you where you are.
          */}
          <section className="section">
            <SectionHeader title="Stages" standalone />
            <ul className="card space-y-0.5 p-2" data-tour="pipeline-stages">
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
                      className={`metal-row focusable w-full rounded-field px-3 py-2.5 text-left ${
                        selected ? 'metal-row-brand' : ''
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        {/* Medium weight, not semibold. Six stage names in a
                            column all set bold is six headings and no funnel —
                            the selected one is the only row that needs weight. */}
                        <span
                          className={`text-[14.5px] ${
                            selected ? 'font-semibold text-accent-strong' : 'font-medium text-ink-soft'
                          }`}
                        >
                          {STATUS_LABEL[s]}
                        </span>
                        {/* ink-soft: on the selected row's deeper face ink-mute
                            measures 2.8:1. */}
                        <span className="nums text-[12.5px] text-ink-soft">
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
          </section>

          <section className="section">
            <SectionHeader title={STATUS_LABEL[stage]} count={stageRows.length} standalone />
            {stageRows.length === 0 ? (
              <p className="card px-6 py-8 text-center text-[14px] text-ink-mute">
                Nothing in {STATUS_LABEL[stage].toLowerCase()} right now.
              </p>
            ) : (
              <ul className="panel row-group">
                {stageRows.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => nav(`/property/${p.id}`)}
                      className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">
                          {p.address1}
                        </span>
                        <span className="mt-0.5 block truncate text-[13px] text-ink-mute">
                          {p.contacts[0]?.name ?? 'No contact'} ·{' '}
                          {relativeLower(p.lastVisitAt)}
                        </span>
                      </span>
                      {/*
                        Not green. Green means *won* everywhere else in this
                        product, and painting every open deal's value green tells
                        a rep the pipeline is money in the bank. It is a number,
                        so it is set as one.
                      */}
                      {p.opportunityValue != null && (
                        <span className="nums shrink-0 text-[15px] font-semibold text-ink">
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
          </section>
        </div>
      </div>
    </div>
  )
}
