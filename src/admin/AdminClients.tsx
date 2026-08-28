import { DataList } from './DataList'
import { AdminPage } from './AdminLayout'
import { useAppStore } from '../store/useAppStore'
import { StatTile } from './charts/StatTile'
import { Bars } from './charts/Bars'
import { STATUS } from './charts/tokens'
import { moneyFull } from '../lib/format'

/**
 * Platform view — Super Admin only.
 *
 * That line was a comment and nothing else for a while. The console's nav hides
 * this entry from everyone below super admin, which hides the door without
 * locking it: `AdminLayout` admits managers and client admins, so typing the
 * URL rendered the whole screen. Nothing real leaked, because the numbers below
 * are a hardcoded illustration — but a company's own admin seeing what looks
 * like other customers' seat counts and revenue is wrong on its face, and it
 * would have become an actual leak on the day this is wired to an API.
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
  const user = useAppStore((st) => st.user)
  if (user && user.role !== 'super_admin') {
    return (
      <AdminPage title="Clients">
        <div className="card p-8 text-center">
          <p className="text-lg font-semibold">Not available for your role</p>
          <p className="mt-1 text-sm text-ink-mute">
            The platform view is for Allstar staff. Your own company's numbers are on
            the Dashboard.
          </p>
        </div>
      </AdminPage>
    )
  }

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

      <section className="mt-4 overflow-hidden card">
        {/*
          Cards on a phone, table on a desktop — the same clipping fix as the
          Dashboard and Reports. This one is worth noting: the viewport audit
          never caught it, because /admin/clients is super-admin only and the
          audit signs in as a client admin, so the route is not measured at all.
          It was found by reading rather than by a gate.
        */}
        <DataList
          rows={CLIENTS}
          keyOf={(c) => c.name}
          empty="No clients yet."
          className="px-5 pb-5 lg:px-0 lg:pb-0"
          columns={[
            { header: 'Client', cell: (c) => c.name, phone: 'title', className: 'font-medium' },
            { header: 'Seats', cell: (c) => c.seats, align: 'right' },
            { header: 'Active reps', cell: (c) => c.activeReps, align: 'right' },
            {
              // The churn signal, so it rides beside the name rather than
              // waiting in the grid below.
              header: 'Utilization',
              cell: (c) => `${Math.round((c.activeReps / c.seats) * 100)}%`,
              align: 'right',
              phone: 'trailing',
            },
            { header: 'MRR', cell: (c) => moneyFull(c.mrr), align: 'right' },
            {
              header: 'Health',
              // Status ships with a word, never colour alone.
              cell: (c) => (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: STATUS[c.health] }}
                  />
                  {HEALTH_LABEL[c.health]}
                </span>
              ),
            },
          ]}
        />
      </section>

      <section className="mt-4 card p-5">
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
