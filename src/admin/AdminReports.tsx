import { useMemo, useState } from 'react'
import { saveFile } from '../lib/download'
import { AdminPage, FilterBar } from './AdminLayout'
import { DataList } from './DataList'
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
    /*
      `closed_value`, not `pipeline_value`. The old header named a thing this
      column has never actually held: pipeline is money in play, this is money
      committed. Anyone with a saved spreadsheet keyed on the old name has to
      remap one column — worth it, because the figure under that header used to
      be a lifetime total summed across days and was wrong by an order of
      magnitude.
    */
    const header = 'rep,day,knocks,conversations,appointments,quotes,sold,closed_value'
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
          s.closedValue,
        ].join(',')
      })
    return [header, ...lines].join('\n')
  }, [stats, scopedRep])

  const download = () => {
    saveFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `allstar-report-${range}.csv`)
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
          value={moneyFull(totals.closedValue)}
          delta={totals.soldDelta}
          sub={`${totals.sold} deals`}
        />
      </div>

      <section className="mt-4 card p-5">
        <h2 className="text-sm font-bold">
          Daily volume{repId !== 'all' && ` — ${team.find((r) => r.id === repId)?.name ?? repId}`}
        </h2>
        <p className="mb-3 text-xs text-ink-mute">
          Weekends carry the volume in this business; the dip is Sunday.
        </p>
        <TrendChart points={trendPoints} seriesNames={['Doors knocked', 'Conversations']} />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-bold">Doors by rep</h2>
          <p className="mb-3 text-xs text-ink-mute">Volume over the selected range.</p>
          <Bars data={doorsByRep} variant="single" format={(v) => v.toLocaleString()} />
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-bold">Contact rate by rep</h2>
          <p className="mb-3 text-xs text-ink-mute">
            Conversations per door — the number volume alone can hide.
          </p>
          <Bars data={conversionByRep} variant="single" format={(v) => `${v}%`} />
        </section>
      </div>

      {/*
        The breakdown was a plain eight-column table inside `overflow-hidden`,
        which on a phone meant columns three onward were clipped with no
        scrollbar and no hint they existed — a manager checking closed value
        from a truck saw a name and two numbers. DataList renders the same data
        as cards there and keeps the table on a desktop, where eight columns
        lining up across every rep is the whole point of it.

        The team totals moved with it rather than being dropped: `footer` was
        added to DataList for this, because a list component that could not
        carry them would have meant trading the team's own numbers for a phone
        layout.
      */}
      <section className="mt-4">
        <h2 className="mb-2 text-sm font-bold">Full breakdown</h2>
        <DataList
          rows={repRows}
          keyOf={(r) => r.id}
          empty="No rep activity in this period."
          columns={[
            { header: 'Rep', cell: (r) => r.name, phone: 'title', className: 'font-medium' },
            {
              header: 'Doors',
              cell: (r) => r.knocks.toLocaleString(),
              align: 'right',
            },
            { header: 'Conversations', cell: (r) => r.conversations, align: 'right' },
            {
              header: 'Contact rate',
              // The one a manager scans for, so it rides beside the name on a
              // phone instead of waiting in the grid below.
              cell: (r) => `${r.contactRate}%`,
              align: 'right',
              phone: 'trailing',
              className: 'font-semibold',
            },
            { header: 'Appointments', cell: (r) => r.appointments, align: 'right' },
            { header: 'Quotes', cell: (r) => r.quotes, align: 'right' },
            { header: 'Won', cell: (r) => r.sold, align: 'right' },
            {
              header: 'Closed value',
              cell: (r) => <span className="text-good">{money(r.closedValue)}</span>,
              align: 'right',
              className: 'font-semibold',
            },
          ]}
          footer={{
            label: 'Team',
            cell: (c) => {
              const sum = (pick: (r: (typeof repRows)[number]) => number) =>
                repRows.reduce((a, r) => a + pick(r), 0)
              switch (c.header) {
                case 'Doors':
                  return sum((r) => r.knocks).toLocaleString()
                case 'Conversations':
                  return sum((r) => r.conversations)
                case 'Contact rate':
                  // Recomputed from the totals, never averaged from the rows:
                  // a mean of per-rep rates weights a rep who knocked four
                  // doors the same as one who knocked four hundred.
                  return `${Math.round((sum((r) => r.conversations) / Math.max(1, sum((r) => r.knocks))) * 100)}%`
                case 'Appointments':
                  return sum((r) => r.appointments)
                case 'Quotes':
                  return sum((r) => r.quotes)
                case 'Won':
                  return sum((r) => r.sold)
                case 'Closed value':
                  return <span className="text-good">{money(sum((r) => r.closedValue))}</span>
                default:
                  return null
              }
            },
          }}
        />
      </section>
    </AdminPage>
  )
}
