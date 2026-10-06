import { useMemo, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { Button } from '../components/ui/Button'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../lib/errors'
import { moneyFull } from '../lib/format'
import { leadValue } from '@allstar/core/deals'
import type { Plan } from '../types'

/**
 * The price list.
 *
 * What a sale is worth comes from here: a rep picks a plan when a door says
 * yes, and the sale takes that plan's price. Repricing a plan changes what the
 * next sale on it is worth — sales already made keep the price they were made
 * at. A plan is retired rather than deleted, so last spring's sales can still
 * say which plan they were.
 */
export function AdminPlans() {
  const plans = useAppStore((s) => s.plans)
  const properties = useAppStore((s) => s.properties)
  const createPlan = useAppStore((s) => s.createPlan)
  const updatePlan = useAppStore((s) => s.updatePlan)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...plans].sort((a, b) => Number(b.active) - Number(a.active) || a.sort - b.sort || a.name.localeCompare(b.name)),
    [plans],
  )
  // How much each plan has sold, from the sales on the leads this console holds.
  const sold = useMemo(() => {
    const by = new Map<string, { n: number; value: number }>()
    let unplanned = { n: 0, value: 0 }
    for (const p of Object.values(properties)) {
      if (p.status !== 'won' || !p.deal) continue
      const v = leadValue(p) ?? 0
      if (!p.deal.planId) unplanned = { n: unplanned.n + 1, value: unplanned.value + v }
      else {
        const was = by.get(p.deal.planId) ?? { n: 0, value: 0 }
        by.set(p.deal.planId, { n: was.n + 1, value: was.value + v })
      }
    }
    return { by, unplanned }
  }, [properties])

  const dollars = (s: string) => Number(s.replace(/[$,\s]/g, ''))
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      await createPlan({ name, value: dollars(price) })
      setName('')
      setPrice('')
    } catch (err) {
      setError(describeError(err, 'Could not add the plan.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminPage
      title="Plans"
      description="Your price list. Reps pick a plan when a door says yes, and the sale is worth that plan's price."
    >
      <section className="card p-5" data-testid="plans-panel">
        <h2 className="text-sm font-bold">Add a plan</h2>
        <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
          Use the total a sale is worth to the company, in whole dollars. A manager can still change a single sale's
          value from the lead, with a reason.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <label className="block min-w-0 flex-[2_1_180px]">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Plan name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="focusable min-h-[38px] w-full rounded-lg border border-line px-3 text-sm"
              data-testid="plan-name"
            />
          </label>
          <label className="block min-w-0 flex-[1_1_120px]">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Price ($)</span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="numeric"
              className="nums focusable min-h-[38px] w-full rounded-lg border border-line px-3 text-sm"
              data-testid="plan-price"
            />
          </label>
          <Button size="sm" type="submit" disabled={busy || !name.trim() || !price.trim()} data-testid="plan-add">
            Add plan
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
            {error}
          </p>
        )}
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-sm font-bold">Price list</h2>
        {sorted.length === 0 ? (
          <p className="mt-2 text-sm text-ink-mute" data-testid="plans-empty">
            No plans yet. Until there are, a sale counts at the lead's imported estimate.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line-soft" data-testid="plans-list">
            {sorted.map((p) => (
              <PlanRow key={p.id} plan={p} sold={sold.by.get(p.id)} onSave={updatePlan} />
            ))}
          </ul>
        )}
        {sold.unplanned.n > 0 && (
          <p className="mt-3 text-xs text-ink-mute" data-testid="plans-unplanned">
            {sold.unplanned.n} {sold.unplanned.n === 1 ? 'sale has' : 'sales have'} no plan yet ({moneyFull(sold.unplanned.value)} at
            estimate). Open the lead and choose one.
          </p>
        )}
      </section>
    </AdminPage>
  )
}

function PlanRow({
  plan,
  sold,
  onSave,
}: {
  plan: Plan
  sold?: { n: number; value: number }
  onSave: (id: string, patch: Partial<Pick<Plan, 'name' | 'value' | 'active'>>) => Promise<Plan>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(plan.name)
  const [price, setPrice] = useState(String(plan.value))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (patch: Partial<Pick<Plan, 'name' | 'value' | 'active'>>) => {
    setBusy(true)
    setError(null)
    try {
      await onSave(plan.id, patch)
      setEditing(false)
    } catch (err) {
      setError(describeError(err, 'Could not save the plan.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="py-3" data-testid="plan-row">
      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            aria-label="Plan name"
            className="focusable min-h-[38px] min-w-0 flex-[2_1_160px] rounded-lg border border-line px-3 text-sm"
            data-testid="plan-edit-name"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="numeric"
            aria-label="Price in dollars"
            className="nums focusable min-h-[38px] min-w-0 flex-[1_1_100px] rounded-lg border border-line px-3 text-sm"
            data-testid="plan-edit-price"
          />
          <Button
            size="sm"
            disabled={busy || !name.trim() || !price.trim()}
            onClick={() => void run({ name, value: Number(price.replace(/[$,\s]/g, '')) })}
            data-testid="plan-edit-save"
          >
            Save
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${plan.active ? '' : 'text-ink-mute'}`}>
              {plan.name}
              {!plan.active && <span className="ml-2 text-xs font-medium">Retired</span>}
            </p>
            <p className="nums text-xs text-ink-mute">
              {moneyFull(plan.value)}
              {sold ? ` · ${sold.n} sold · ${moneyFull(sold.value)}` : ' · none sold yet'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)} data-testid="plan-edit">
              Edit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void run({ active: !plan.active })}
              data-testid="plan-toggle"
            >
              {plan.active ? 'Retire' : 'Restore'}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </li>
  )
}

export default AdminPlans
