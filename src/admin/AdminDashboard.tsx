import { Glyph } from '../components/ui/Glyph'
import { dayKeyIn } from '../lib/day'
import { IconChevron } from '../components/nav/icons'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DataList } from './DataList'
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
  useUnassigned,
} from './useAdminData'
import { SyncConflictsPanel } from './SyncConflictsPanel'
import { STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, moneyFull, relative } from '../lib/format'
import { leadValue } from '@allstar/core/deals'

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
  const unassigned = useUnassigned(propertyList)

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

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-tour="console-kpis">
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
          // Counted from visits recorded as Sold in this period. A lead set to
          // Won by hand is in the pipeline's "won" count below, not here — the
          // two answer different questions (docs/sales-data-audit.md).
          sub={`${moneyFull(totals.closedValue)} closed · sold at the door`}
        />
      </div>

      {/*
        Shown only when there is something to say, and it is not a KPI tile —
        it is a job somebody has to do. A rep's phone only receives leads
        assigned to them, so an unassigned lead is work that exists nowhere a
        rep can see it, while every total above counts it as healthy.
      */}
      {/*
        Sits beside the unassigned-leads banner and for the same reason: neither
        is a number, both are a job somebody has to do today. See
        SyncConflictsPanel.
      */}
      <SyncConflictsPanel />

      {unassigned.count > 0 && (
        <button
          onClick={() => nav('/admin/leads')}
          className="focusable press mt-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-warn/40 bg-warn/5 p-4 text-left"
        >
          <span className="text-sm font-semibold text-warn">
            {unassigned.count.toLocaleString()} open lead
            {unassigned.count === 1 ? '' : 's'} assigned to nobody
          </span>
          <span className="text-[13px] text-ink-soft">
            {unassigned.count === 1 ? 'It is' : 'They are'} on no rep&rsquo;s phone until
            somebody owns {unassigned.count === 1 ? 'it' : 'them'}.
          </span>
          <span className="icon-xs ml-auto flex items-center gap-1 text-[13px] font-semibold text-accent">
            Assign
            <IconChevron />
          </span>
        </button>
      )}

      <section className="mt-4 card p-5">
        <h2 className="text-sm font-bold">Doors and conversations</h2>
        <p className="mb-3 text-xs text-ink-mute">
          Same unit, one axis — volume and the conversations it produced.
        </p>
        <TrendChart points={trendPoints} seriesNames={['Doors knocked', 'Conversations']} />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="card p-5">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-bold">Open pipeline</h2>
            <span className="nums text-xs font-semibold text-good">
              {won.n} lead{won.n === 1 ? '' : 's'} marked Won · {moneyFull(won.value)}
            </span>
          </div>
          <p className="mb-3 text-xs text-ink-mute">
            Leads currently sitting in each stage, and how much carries through.
          </p>
          <Bars data={funnelData} variant="funnel" showConversion />
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-bold">Today’s outcomes</h2>
          <p className="mb-3 text-xs text-ink-mute">
            What every knock logged today actually resulted in.
          </p>
          <OutcomeMixCard />
        </section>
      </div>

      <section className="mt-4 overflow-hidden card">
        <div className="flex items-baseline justify-between px-5 pb-2 pt-4">
          <h2 className="text-sm font-bold">Rep performance</h2>
          <button
            onClick={() => nav('/admin/reports')}
            className="focusable min-h-[44px] rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-tint lg:min-h-[32px]"
          >
            Full report
          </button>
        </div>
        {/*
          Same move as Reports, and the same reason: eight columns at 622px
          inside an `overflow-hidden` card meant everything past "Doors" was
          cut off on a phone with no way to reach it. Cards here, the table a
          manager compares reps in on a desktop.
        */}
        <DataList
          rows={reps}
          keyOf={(r) => r.id}
          empty="No rep activity yet today."
          className="px-5 pb-5 lg:px-0 lg:pb-0"
          columns={[
            {
              header: 'Rep',
              phone: 'title',
              cell: (r) => (
                <span className="flex items-center gap-2.5">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-tint text-[11px] font-bold text-accent">
                    {r.initials}
                  </span>
                  <span className="font-medium">{r.name}</span>
                </span>
              ),
            },
            { header: 'Doors', cell: (r) => r.knocks.toLocaleString(), align: 'right' },
            { header: 'Conversations', cell: (r) => r.conversations, align: 'right' },
            {
              // What a manager glances at, so it sits beside the name.
              header: 'Contact rate',
              cell: (r) => `${r.contactRate}%`,
              align: 'right',
              phone: 'trailing',
              className: 'font-semibold',
            },
            { header: 'Appts', cell: (r) => r.appointments, align: 'right' },
            { header: 'Quotes', cell: (r) => r.quotes, align: 'right' },
            { header: 'Won', cell: (r) => r.sold, align: 'right' },
            {
              header: 'Closed',
              cell: (r) => <span className="text-good">{money(r.closedValue)}</span>,
              align: 'right',
              className: 'font-semibold',
            },
          ]}
        />
      </section>

      <section className="mt-4 overflow-hidden card">
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
                  {def ? <Glyph name={def.icon} className="icon-xs" /> : '·'}
                </span>
                <span className="min-w-0 flex-1 truncate">{ev.summary}</span>
                <span className="shrink-0 text-xs text-ink-mute">{def?.label}</span>
                {leadValue(p) != null && (
                  <span className="nums shrink-0 text-xs font-semibold text-good">
                    {money(leadValue(p))}
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
  const tz = useAppStore((s) => s.timezone)
  const data = useMemo(() => {
    const counts = new Map<string, number>()
    // Today's, on the company's calendar. This card said "today" and counted
    // every visit the console had loaded, which on a busy week was days of them.
    const today = dayKeyIn(Date.now(), tz)
    for (const ev of activity) {
      if (ev.type !== 'visit' || !ev.outcome) continue
      if (dayKeyIn(ev.at, tz) !== today) continue
      counts.set(ev.outcome, (counts.get(ev.outcome) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([code, n]) => ({
        key: code,
        label: outcomeByCode(code as never)?.label ?? code,
        value: n,
      }))
      .sort((a, b) => b.value - a.value)
  }, [activity, tz])

  if (data.length === 0) {
    return <p className="text-sm text-ink-mute">No visits logged yet today.</p>
  }
  // One measure across nominal categories → one hue. A value-ramp here would
  // imply an order these outcomes don't have.
  return <Bars data={data} variant="single" />
}
