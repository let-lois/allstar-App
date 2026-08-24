import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AdminPage, FilterBar } from './AdminLayout'
import { StatTile } from './charts/StatTile'
import { TrendChart } from './charts/TrendChart'
import { Bars } from './charts/Bars'
import { Chip } from '../components/ui/Chip'
import { useAppStore } from '../store/useAppStore'
import {
  FUNNEL_STAGES,
  RANGES,
  useFunnel,
  useRangeSeries,
  useRangeTotals,
  useRepRangeRows,
  type RangeKey,
} from './useAdminData'
import { STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, moneyFull, relative } from '../lib/format'

/**
 * Console dashboard — the "is the business working?" screen.
 *
 * Reads top to bottom as an argument: headline numbers with a comparison,
 * then the trend that produced them, then where the pipeline is leaking, then
 * who is driving it. One filter row governs the whole page rather than each
 * card carrying its own controls.
 */
export function AdminDashboard() {
  const nav = useNavigate()
  const [range, setRange] = useState<RangeKey>('14d')

  const properties = useAppStore((s) => s.properties)
  const activity = useAppStore((s) => s.activity)
  const propertyList = useMemo(() => Object.values(properties), [properties])

  const totals = useRangeTotals(range)
  const series = useRangeSeries(range)
  const reps = useRepRangeRows(range)
  const { counts, won } = useFunnel(propertyList)

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? ''

  const funnelData = FUNNEL_STAGES.map((s) => ({
    key: s,
    label: STATUS_LABEL[s],
    value: counts.get(s)?.n ?? 0,
    meta: counts.get(s)?.value ? `${moneyFull(counts.get(s)!.value)} open` : undefined,
  }))

  const trendPoints = series.days.map((d, i) => ({
    day: d,
    label: series.labels[i],
    values: [series.knocks[i], series.conversations[i]],
  }))

  return (
    <AdminPage
      title="Dashboard"
      description={`Company performance over the last ${rangeLabel.toLowerCase()}`}
    >
      <FilterBar>
        {RANGES.map((r) => (
          <Chip key={r.key} size="sm" selected={range === r.key} onClick={() => setRange(r.key)}>
            {r.label}
          </Chip>
        ))}
        <span className="ml-auto text-xs text-ink-mute">
          {totals.hasComparison
            ? `vs the previous ${rangeLabel.toLowerCase()}`
            : 'No earlier data to compare against'}
        </span>
      </FilterBar>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label="Doors knocked"
          value={totals.knocks.toLocaleString()}
          delta={totals.knocksDelta}
        />
        <StatTile
          label="Conversations"
          value={totals.conversations.toLocaleString()}
          delta={totals.conversationsDelta}
        />
        <StatTile
          label="Contact rate"
          value={`${totals.contactRate}%`}
          delta={totals.contactRateDelta}
        />
        <StatTile
          label="Deals won"
          value={totals.sold.toLocaleString()}
          delta={totals.soldDelta}
          sub={`${moneyFull(totals.pipelineValue)} closed`}
        />
      </div>

      <section className="mt-4 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-bold">Doors and conversations</h2>
        <p className="mb-3 text-xs text-ink-mute">
          Same unit, one axis — volume and the conversations it produced.
        </p>
        <TrendChart points={trendPoints} seriesNames={['Doors knocked', 'Conversations']} />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-bold">Open pipeline</h2>
            <span className="nums text-xs font-semibold text-good">
              {won.n} won · {moneyFull(won.value)}
            </span>
          </div>
          <p className="mb-3 text-xs text-ink-mute">
            Leads currently sitting in each stage, and how much carries through.
          </p>
          <Bars data={funnelData} variant="funnel" showConversion />
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-bold">Today’s outcomes</h2>
          <p className="mb-3 text-xs text-ink-mute">
            What every knock logged today actually resulted in.
          </p>
          <OutcomeMixCard />
        </section>
      </div>

      <section className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-baseline justify-between px-5 pb-2 pt-4">
          <h2 className="text-sm font-bold">Rep performance</h2>
          <button
            onClick={() => nav('/admin/reports')}
            className="focusable min-h-[44px] rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-tint lg:min-h-[32px]"
          >
            Full report
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              <th className="px-5 py-2 text-left font-semibold">Rep</th>
              <th className="px-3 py-2 text-right font-semibold">Doors</th>
              <th className="px-3 py-2 text-right font-semibold">Conversations</th>
              <th className="px-3 py-2 text-right font-semibold">Contact rate</th>
              <th className="px-3 py-2 text-right font-semibold">Appts</th>
              <th className="px-3 py-2 text-right font-semibold">Quotes</th>
              <th className="px-3 py-2 text-right font-semibold">Won</th>
              <th className="px-5 py-2 text-right font-semibold">Closed</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.id} className="border-t border-line-soft hover:bg-surface-field">
                <td className="px-5 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[11px] font-bold text-accent">
                      {r.initials}
                    </span>
                    <span className="font-medium">{r.name}</span>
                  </span>
                </td>
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
        </table>
      </section>

      <section className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
        <h2 className="px-5 pb-2 pt-4 text-sm font-bold">Live activity</h2>
        <ul className="max-h-72 overflow-y-auto">
          {activity.slice(0, 30).map((ev) => {
            const def = outcomeByCode(ev.outcome)
            const p = ev.propertyId ? properties[ev.propertyId] : undefined
            return (
              <li
                key={ev.id}
                className="flex items-center gap-3 border-t border-line-soft px-5 py-2 text-sm"
              >
                <span className="w-5 shrink-0 text-center" aria-hidden>
                  {def?.glyph ?? '·'}
                </span>
                <span className="min-w-0 flex-1 truncate">{ev.summary}</span>
                <span className="shrink-0 text-xs text-ink-mute">{def?.label}</span>
                {p?.opportunityValue != null && (
                  <span className="nums shrink-0 text-xs font-semibold text-good">
                    {money(p.opportunityValue)}
                  </span>
                )}
                <span className="w-20 shrink-0 text-right text-xs text-ink-mute">
                  {relative(ev.at)}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </AdminPage>
  )
}

function OutcomeMixCard() {
  const activity = useAppStore((s) => s.activity)
  const data = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ev of activity) {
      if (ev.type !== 'visit' || !ev.outcome) continue
      counts.set(ev.outcome, (counts.get(ev.outcome) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([code, n]) => ({
        key: code,
        label: outcomeByCode(code as never)?.label ?? code,
        value: n,
      }))
      .sort((a, b) => b.value - a.value)
  }, [activity])

  if (data.length === 0) {
    return <p className="text-sm text-ink-mute">No visits logged yet today.</p>
  }
  // One measure across nominal categories → one hue. A value-ramp here would
  // imply an order these outcomes don't have.
  return <Bars data={data} variant="single" />
}
