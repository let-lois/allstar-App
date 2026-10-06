import { useState } from 'react'
import { activePlans, canSetDealValue } from '@allstar/core/deals'
import { Collapsible } from '../ui/Collapsible'
import { Button } from '../ui/Button'
import { Field } from '../ui/Input'
import { BottomSheet } from '../ui/BottomSheet'
import { PlanPicker } from '../visit/PlanPicker'
import { useAppStore } from '../../store/useAppStore'
import { moneyFull } from '../../lib/format'
import { dayKeyIn, dayLabel } from '../../lib/day'
import { describeError } from '../../lib/errors'
import type { Property } from '../../types'

/**
 * A Won lead's sale: what it is worth, on which plan, who won it and when.
 *
 * Anyone who may edit the lead can move it onto another plan — which plan is
 * often settled after the door. Only a manager can set the value to something
 * other than the plan's price, and must say why; the reason stays on the sale
 * and in the lead's activity, so a number that moved can always be explained.
 */
export function SaleSection({ property, nameOf }: { property: Property; nameOf: (id?: string) => string | undefined }) {
  const deal = property.deal
  const plans = useAppStore((s) => s.plans)
  const me = useAppStore((s) => s.user)
  const tz = useAppStore((s) => s.timezone) || undefined
  const updateDeal = useAppStore((s) => s.updateDeal)
  const [sheet, setSheet] = useState<'plan' | 'value' | null>(null)
  const [planId, setPlanId] = useState<string | undefined>(undefined)
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!deal) return null

  const mayOverride = canSetDealValue(me?.role)
  const offered = activePlans(plans)
  const won = `${dayLabel(dayKeyIn(deal.wonAt, tz), { month: 'short', day: 'numeric' })}${deal.repId ? ` by ${nameOf(deal.repId) ?? 'a former teammate'}` : ''}`

  const open = (which: 'plan' | 'value') => {
    setError(null)
    setPlanId(deal.planId)
    setValue(String(deal.value))
    setReason('')
    setSheet(which)
  }
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (sheet === 'plan' && planId) await updateDeal(property.id, { planId })
      if (sheet === 'value') await updateDeal(property.id, { value: Number(value.replace(/[$,\s]/g, '')), reason })
      setSheet(null)
    } catch (err) {
      setError(describeError(err, 'Could not change the sale.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Collapsible flat title="Sale" defaultOpen>
      <div data-testid="lead-sale">
        <p className="nums text-[24px] font-semibold text-good" data-testid="sale-value">
          {moneyFull(deal.value)}
        </p>
        <p className="mt-0.5 text-[14px] font-medium" data-testid="sale-plan">
          {deal.planName ? `${deal.planName} plan` : 'No plan chosen yet'}
          {!deal.planName && <span className="text-ink-mute"> · counting the lead's estimate</span>}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-mute">Won {won}</p>
        {deal.overrideReason && (
          <p className="mt-2 rounded-field bg-surface-tint px-3 py-2 text-[13px] text-ink-soft" data-testid="sale-override">
            Set by {nameOf(deal.overriddenBy) ?? 'a manager'}
            {deal.planValue != null ? ` (plan price ${moneyFull(deal.planValue)})` : ''}: {deal.overrideReason}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {offered.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => open('plan')} data-testid="sale-change-plan">
              {deal.planId ? 'Change plan' : 'Choose plan'}
            </Button>
          )}
          {mayOverride && (
            <Button size="sm" variant="secondary" onClick={() => open('value')} data-testid="sale-change-value">
              Change value
            </Button>
          )}
        </div>
      </div>

      <BottomSheet open={sheet !== null} onClose={() => !busy && setSheet(null)} title={sheet === 'value' ? 'What is this sale worth?' : 'Which plan was sold?'}>
        <div className="space-y-4 px-4 pb-6" data-testid="sale-sheet">
          {sheet === 'plan' ? (
            <>
              <PlanPicker plans={plans} value={planId} onChange={setPlanId} allowUnset={false} />
              <p className="text-[13px] text-ink-mute">The sale takes the plan's price. A manager's own value is replaced.</p>
            </>
          ) : (
            <>
              <Field
                label="Value (whole dollars)"
                inputMode="numeric"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                data-testid="sale-value-input"
              />
              <Field
                label="Why is it different from the plan?"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                data-testid="sale-reason-input"
              />
            </>
          )}
          {error && (
            <p role="alert" className="rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
              {error}
            </p>
          )}
          <Button
            size="lg"
            full
            disabled={busy || (sheet === 'plan' ? !planId || planId === deal.planId : !value.trim() || !reason.trim())}
            onClick={() => void save()}
            data-testid="sale-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </BottomSheet>
    </Collapsible>
  )
}
