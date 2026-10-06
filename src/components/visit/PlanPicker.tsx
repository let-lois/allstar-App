import { activePlans } from '@allstar/core/deals'
import { moneyFull } from '../../lib/format'
import { haptic } from '../../lib/haptics'
import type { Plan } from '../../types'

/**
 * Which plan a door said yes to.
 *
 * One tap per plan, its price on the button, and a way to leave it for the
 * office — a rep on a doorstep who is not sure must still be able to record
 * the sale. Retired plans are not offered. With no price list at all, it says
 * so and what the sale will be worth instead, rather than showing an empty box.
 */
export function PlanPicker({
  plans,
  value,
  onChange,
  estimate,
  allowUnset = true,
}: {
  plans: Plan[]
  value: string | undefined
  onChange: (planId: string | undefined) => void
  /** The lead's imported estimate: what an unplanned sale is worth. */
  estimate?: number
  /** Offer "the office will set it". Off when changing an existing sale's plan. */
  allowUnset?: boolean
}) {
  const offered = activePlans(plans)
  if (!offered.length) {
    return (
      <p className="text-[14px] text-ink-mute" data-testid="plan-picker-empty">
        Your company has no price list yet, so this sale counts at{' '}
        {estimate ? `the lead's estimate, ${moneyFull(estimate)}` : '$0'} until the office sets a plan.
      </p>
    )
  }
  const option = (key: string, selected: boolean, onPick: () => void, label: string, sub: string) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        haptic('tap')
        onPick()
      }}
      aria-pressed={selected}
      data-testid={`plan-option-${key}`}
      className={`press focusable flex min-h-[64px] min-w-0 flex-col items-start justify-center rounded-field px-3 text-left transition-shadow ${
        selected ? 'bg-brand-600 text-white shadow-raise' : 'bg-surface text-ink ring-1 ring-line active:bg-surface-field'
      }`}
    >
      <span className="w-full truncate text-[15px] font-semibold">{label}</span>
      <span className={`nums text-[13px] ${selected ? 'text-white/85' : 'text-ink-mute'}`}>{sub}</span>
    </button>
  )
  return (
    <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2.5" data-testid="plan-picker">
      {offered.map((p) => option(p.id, value === p.id, () => onChange(p.id), p.name, moneyFull(p.value)))}
      {allowUnset &&
        option('unset', !value, () => onChange(undefined), 'Not sure', 'Office sets it')}
    </div>
  )
}
