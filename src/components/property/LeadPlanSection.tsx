import { useState } from 'react'
import { activePlans } from '@allstar/core/deals'
import { Collapsible } from '../ui/Collapsible'
import { Button } from '../ui/Button'
import { BottomSheet } from '../ui/BottomSheet'
import { PlanPicker } from '../visit/PlanPicker'
import { useAppStore } from '../../store/useAppStore'
import { moneyFull } from '../../lib/format'
import { describeError } from '../../lib/errors'
import type { Property } from '../../types'

/**
 * The plan a lead is being sold, on a lead not yet won.
 *
 * Chosen before the door says yes — at a quote, on a follow-up, by the office —
 * it is what the lead is worth in the pipeline, and the plan its sale takes
 * when it is won. A sold lead shows its sale instead (SaleSection), where the
 * plan is changed the same way.
 */
export function LeadPlanSection({ property }: { property: Property }) {
  const plans = useAppStore((s) => s.plans)
  const setLeadPlan = useAppStore((s) => s.setLeadPlan)
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offered = activePlans(plans)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await setLeadPlan(property.id, choice ?? null)
      setOpen(false)
    } catch (err) {
      setError(describeError(err, 'Could not change the plan.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Collapsible flat title="Plan" defaultOpen>
      <div data-testid="lead-plan">
        {property.plan ? (
          <p className="text-[15px] font-semibold" data-testid="lead-plan-name">
            {property.plan.name} <span className="nums font-medium text-ink-mute">· {moneyFull(property.plan.value)}</span>
          </p>
        ) : (
          <p className="text-[14px] text-ink-mute" data-testid="lead-plan-name">
            {offered.length ? 'No plan yet' : 'No price list yet — the office adds plans in the console.'}
          </p>
        )}
        {offered.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setChoice(property.plan?.id)
              setError(null)
              setOpen(true)
            }}
            data-testid="lead-plan-change"
          >
            {property.plan ? 'Change plan' : 'Choose plan'}
          </Button>
        )}
      </div>

      <BottomSheet open={open} onClose={() => !busy && setOpen(false)} title="Which plan is this lead for?">
        <div className="space-y-4 px-4 pb-6" data-testid="lead-plan-sheet">
          <PlanPicker plans={plans} value={choice} onChange={setChoice} unsetLabel="No plan" unsetSub="Not decided yet" />
          <p className="text-[13px] text-ink-mute">
            The lead counts at this price in the pipeline, and its sale is on this plan when it is won.
          </p>
          {error && (
            <p role="alert" className="rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
              {error}
            </p>
          )}
          <Button size="lg" full disabled={busy || choice === property.plan?.id} onClick={() => void save()} data-testid="lead-plan-save">
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </BottomSheet>
    </Collapsible>
  )
}
