import { AdminPage } from './AdminLayout'
import { StatTile } from './charts/StatTile'
import { Bars } from './charts/Bars'
import { STATUS } from './charts/tokens'
import { moneyFull } from '../lib/format'

/**
 * Platform view — Super Admin only.
 *
 * Deliberately thin, and honest about why: with a single-tenant local dataset
 * there is no second client's data to aggregate. The shape is real (accounts,
 * seats, activity health, revenue) so it slots onto a multi-tenant API without
 * redesign, but the numbers beyond Summit Exteriors are illustrative and the
 * screen says so rather than implying the platform already has three customers.
 */

const CLIENTS = [
  { name: 'Summit Exteriors', seats: 12, activeReps: 5, mrr: 1188, health: 'good' as const },
  { name: 'Bright Path Solar', seats: 28, activeReps: 24, mrr: 2772, health: 'good' as const },
  { name: 'Redline Roofing', seats: 7, activeReps: 2, mrr: 693, health: 'warning' as const },
]

const HEALTH_LABEL = { good: 'Healthy', warning: 'Low activity' } as const

export function AdminClients() {
  const totalSeats = CLIENTS.reduce((a, c) => a + c.seats, 0)
  const totalActive = CLIENTS.reduce((a, c) => a + c.activeReps, 0)
  const mrr = CLIENTS.reduce((a, c) => a + c.mrr, 0)

  return (
    <AdminPage title="Clients" description="Platform overview across all accounts">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Accounts" value={String(CLIENTS.length)} />
        <StatTile label="Seats" value={String(totalSeats)} />
        <StatTile
          label="Active reps"
          value={String(totalActive)}
          sub={`${Math.round((totalActive / totalSeats) * 100)}% of seats used`}
        />
        <StatTile label="MRR" value={moneyFull(mrr)} />
      </div>

      <section className="mt-4 overflow-hidden rounded-card border border-ink/10 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              <th className="px-5 py-2.5 text-left font-semibold">Client</th>
              <th className="px-3 py-2.5 text-right font-semibold">Seats</th>
              <th className="px-3 py-2.5 text-right font-semibold">Active reps</th>
              <th className="px-3 py-2.5 text-right font-semibold">Utilization</th>
              <th className="px-3 py-2.5 text-right font-semibold">MRR</th>
              <th className="px-5 py-2.5 text-left font-semibold">Health</th>
            </tr>
          </thead>
          <tbody>
            {CLIENTS.map((c) => (
              <tr key={c.name} className="border-t border-ink/[0.06] hover:bg-surface-field">
                <td className="px-5 py-3 font-medium">{c.name}</td>
                <td className="nums px-3 py-3 text-right">{c.seats}</td>
                <td className="nums px-3 py-3 text-right">{c.activeReps}</td>
                <td className="nums px-3 py-3 text-right">
                  {Math.round((c.activeReps / c.seats) * 100)}%
                </td>
                <td className="nums px-3 py-3 text-right">{moneyFull(c.mrr)}</td>
                <td className="px-5 py-3">
                  {/* Status ships with a word, never color alone. */}
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: STATUS[c.health] }}
                    />
                    {HEALTH_LABEL[c.health]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-4 rounded-card border border-ink/10 bg-surface p-5">
        <h2 className="text-sm font-bold">Seat utilization</h2>
        <p className="mb-3 text-xs text-ink-mute">
          Reps active in the last 7 days as a share of seats sold — the earliest churn
          signal in this business.
        </p>
        <Bars
          data={CLIENTS.map((c) => ({
            key: c.name,
            label: c.name,
            value: Math.round((c.activeReps / c.seats) * 100),
            meta: `${c.activeReps} of ${c.seats} seats`,
          })).sort((a, b) => b.value - a.value)}
          variant="single"
          format={(v) => `${v}%`}
        />
      </section>

      <p className="mt-4 rounded-field bg-warn-bg px-4 py-3 text-xs leading-relaxed text-warn">
        Only Summit Exteriors has real data on this device. The other accounts are
        illustrative — this screen shows the shape of the platform view, not three live
        customers.
      </p>
    </AdminPage>
  )
}
