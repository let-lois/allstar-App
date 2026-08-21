import { useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { TrendChart } from './charts/TrendChart'
import { Bars } from './charts/Bars'
import { StatTile } from './charts/StatTile'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import {
  RANGES,
  useDailyStats,
  useRangeSeries,
  useRangeTotals,
  useRepRangeRows,
  type RangeKey,
} from './useAdminData'
import { money, moneyFull } from '../lib/format'
import { useAppStore } from '../store/useAppStore'

/**
 * Reports.
 *
 * The dashboard answers "how are we doing"; this answers "why, and who".
 * Adds a rep dimension to the same range filter, a per-rep comparison that
 * reads as a ranking rather than a rainbow, and CSV export — because the first
 * thing an operations manager does with a number is put it in a spreadsheet.
 */
export function AdminReports() {
  const [range, setRange] = useState<RangeKey>('30d')
  const [repId, setRepId] = useState<string | 'all'>('all')

  // The real roster on a live account, the seeded one in the demo. This screen
  // used to resolve names straight from the seed, so a live company's reports
  // named five people who don't work there.
  const team = useAppStore((s) => s.team)
  const reps = useMemo(() => team.filter((m) => m.role === 'field_rep'), [team])

  const scopedRep = repId === 'all' ? undefined : repId
  const totals = useRangeTotals(range, scopedRep)
  const series = useRangeSeries(range, scopedRep)
  const repRows = useRepRangeRows(range)
  const stats = useDailyStats()

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? ''

  const trendPoints = series.days.map((d, i) => ({
    day: d,
    label: series.labels[i],
    values: [series.knocks[i], series.conversations[i]],
  }))

  // One measure per rep, ranked — a single hue, because these are a ranking of
  // the same quantity, not eight different things.
  const doorsByRep = repRows
    .map((r) => ({ key: r.id, label: r.name, value: r.knocks }))
    .sort((a, b) => b.value - a.value)

  const conversionByRep = repRows
    .map((r) => ({
      key: r.id,
      label: r.name,
      value: r.contactRate,
      meta: `${r.conversations} of ${r.knocks} doors`,
    }))
    .sort((a, b) => b.value - a.value)

  const csv = useMemo(() => {
    const header = 'rep,day,knocks,conversations,appointments,quotes,sold,pipeline_value'
    const lines = stats
      .filter((s) => !scopedRep || s.repId === scopedRep)
      .map((s) => {
        const name = team.find((r) => r.id === s.repId)?.name ?? s.repId
        return [
          `"${name}"`,
          s.day,
          s.knocks,
          s.conversations,
          s.appointments,
          s.quotes,
          s.sold,
          s.pipelineValue,
        ].join(',')
      })
    return [header, ...lines].join('\n')
  }, [stats, scopedRep])

  const download = () => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `allstar-report-${range}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <AdminPage
      title="Reports"
      description={`Performance over the last ${rangeLabel.toLowerCase()}`}
      actions={
        <Button size="sm" variant="secondary" onClick={download}>
          Export CSV
        </Button>
      }
    >
      <FilterBar>
        {RANGES.map((r) => (
          <Chip key={r.key} size="sm" selected={range === r.key} onClick={() => setRange(r.key)}>
            {r.label}
          </Chip>
        ))}
        <span className="mx-2 h-6 w-px bg-line" />
        <Chip size="sm" selected={repId === 'all'} onClick={() => setRepId('all')}>
          Whole team
        </Chip>
        {reps.map((r) => (
          <Chip key={r.id} size="sm" selected={repId === r.id} onClick={() => setRepId(r.id)}>
            {r.name.split(' ')[0]}
          </Chip>
        ))}
        <span className="ml-auto text-xs text-ink-mute">
          {totals.hasComparison
            ? `vs the previous ${rangeLabel.toLowerCase()}`
            : 'No earlier data to compare against'}
        </span>
      </FilterBar>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Doors" value={totals.knocks.toLocaleString()} delta={totals.knocksDelta} />
        <StatTile
          label="Conversations"
          value={totals.conversations.toLocaleString()}
          delta={totals.conversationsDelta}
        />
        <StatTile
          label="Appointments"
          value={totals.appointments.toLocaleString()}
          sub={`${totals.quotes} quotes requested`}
        />
        <StatTile
          label="Closed"
          value={moneyFull(totals.pipelineValue)}
          delta={totals.soldDelta}
          sub={`${totals.sold} deals`}
        />
      </div>

      <section className="mt-4 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-bold">
          Daily volume{repId !== 'all' && ` — ${team.find((r) => r.id === repId)?.name ?? repId}`}
        </h2>
        <p className="mb-3 text-xs text-ink-mute">
          Weekends carry the volume in this business; the dip is Sunday.
        </p>
        <TrendChart points={trendPoints} seriesNames={['Doors knocked', 'Conversations']} />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-bold">Doors by rep</h2>
          <p className="mb-3 text-xs text-ink-mute">Volume over the selected range.</p>
          <Bars data={doorsByRep} variant="single" format={(v) => v.toLocaleString()} />
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-bold">Contact rate by rep</h2>
          <p className="mb-3 text-xs text-ink-mute">
            Conversations per door — the number volume alone can hide.
          </p>
          <Bars data={conversionByRep} variant="single" format={(v) => `${v}%`} />
        </section>
      </div>

      <section className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
        <h2 className="px-5 pb-2 pt-4 text-sm font-bold">Full breakdown</h2>
        <table className="w-full text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              <th className="px-5 py-2.5 text-left font-semibold">Rep</th>
              <th className="px-3 py-2.5 text-right font-semibold">Doors</th>
              <th className="px-3 py-2.5 text-right font-semibold">Conversations</th>
              <th className="px-3 py-2.5 text-right font-semibold">Contact rate</th>
              <th className="px-3 py-2.5 text-right font-semibold">Appointments</th>
              <th className="px-3 py-2.5 text-right font-semibold">Quotes</th>
              <th className="px-3 py-2.5 text-right font-semibold">Won</th>
              <th className="px-5 py-2.5 text-right font-semibold">Closed value</th>
            </tr>
          </thead>
          <tbody>
            {repRows.map((r) => (
              <tr key={r.id} className="border-t border-line-soft hover:bg-surface-field">
                <td className="px-5 py-2.5 font-medium">{r.name}</td>
                <td className="nums px-3 py-2.5 text-right">{r.knocks.toLocaleString()}</td>
                <td className="nums px-3 py-2.5 text-right">{r.conversations}</td>
                <td className="nums px-3 py-2.5 text-right font-semibold">{r.contactRate}%</td>
                <td className="nums px-3 py-2.5 text-right">{r.appointments}</td>
                <td className="nums px-3 py-2.5 text-right">{r.quotes}</td>
                <td className="nums px-3 py-2.5 text-right">{r.sold}</td>
                <td className="nums px-5 py-2.5 text-right font-semibold text-good">
                  {money(r.pipelineValue)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line bg-surface-sunk font-semibold">
              <td className="px-5 py-2.5">Team</td>
              <td className="nums px-3 py-2.5 text-right">
                {repRows.reduce((a, r) => a + r.knocks, 0).toLocaleString()}
              </td>
              <td className="nums px-3 py-2.5 text-right">
                {repRows.reduce((a, r) => a + r.conversations, 0)}
              </td>
              <td className="nums px-3 py-2.5 text-right">
                {Math.round(
                  (repRows.reduce((a, r) => a + r.conversations, 0) /
                    Math.max(1, repRows.reduce((a, r) => a + r.knocks, 0))) *
                    100,
                )}
                %
              </td>
              <td className="nums px-3 py-2.5 text-right">
                {repRows.reduce((a, r) => a + r.appointments, 0)}
              </td>
              <td className="nums px-3 py-2.5 text-right">
                {repRows.reduce((a, r) => a + r.quotes, 0)}
              </td>
              <td className="nums px-3 py-2.5 text-right">
                {repRows.reduce((a, r) => a + r.sold, 0)}
              </td>
              <td className="nums px-5 py-2.5 text-right text-good">
                {money(repRows.reduce((a, r) => a + r.pipelineValue, 0))}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </AdminPage>
  )
}
