import type { Deal, Plan, Property } from './types'

/**
 * What a lead is worth, in whole dollars, for every screen that adds money up.
 *
 * A Won lead is worth its sale — the plan's price, or what a manager set it
 * to. Every other lead is worth its imported estimate, which is the only
 * figure an open lead has. One function, so the pipeline, the map card, the
 * leaderboard and the console cannot disagree about the same house.
 */
export function leadValue(p: Pick<Property, 'status' | 'deal' | 'opportunityValue'> | null | undefined): number | undefined {
  if (!p) return undefined
  if (p.status === 'won' && p.deal) return p.deal.value
  return p.opportunityValue
}

/** The plans a rep may pick for a new sale, in the office's order. */
export function activePlans(plans: Plan[] | null | undefined): Plan[] {
  return (plans ?? []).filter((p) => p.active).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

/**
 * Who may change what a sale is worth: the roles that run the office. Mirrors
 * the server's rule (`canImport` in api/src/import.ts), and is only a mirror —
 * the server refuses regardless.
 */
export function canSetDealValue(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'client_admin' || role === 'super_admin'
}

/**
 * A lead's sale as it stands once the lead is Won, worked out on the phone the
 * same way the server works it out, so the card is right before the sync lands.
 *
 * A lead that already has a sale keeps it, its rep and its moment; a plan
 * chosen now is applied to it. A new sale is the plan's price, or the lead's
 * imported estimate until a plan is chosen.
 */
export function dealOnWin(
  lead: Pick<Property, 'deal' | 'opportunityValue'>,
  plans: Plan[],
  opts: { planId?: string; repId?: string; at: number },
): Deal {
  const plan = plans.find((p) => p.id === opts.planId && p.active)
  const existing = lead.deal
  if (existing) {
    if (!plan || plan.id === existing.planId) return existing
    return { ...existing, ...onPlan(plan) }
  }
  return {
    repId: opts.repId,
    ...(plan ? onPlan(plan) : { value: lead.opportunityValue ?? 0 }),
    wonAt: opts.at,
  }
}

/** A sale moved onto a plan: its price, and any manager's override cleared. */
export function onPlan(plan: Plan): Pick<Deal, 'planId' | 'planName' | 'planValue' | 'value' | 'overriddenBy' | 'overrideReason'> {
  return { planId: plan.id, planName: plan.name, planValue: plan.value, value: plan.value, overriddenBy: undefined, overrideReason: undefined }
}
