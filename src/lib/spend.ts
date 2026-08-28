import type { GeocodeProviderDTO } from './http'

/**
 * What an address lookup batch will cost, before it runs.
 *
 * A company that connects their own geocoding key is billed by the vendor,
 * directly, per address. This app has no spend cap and no cut-off, so the only
 * thing standing between an operator and a surprise invoice is knowing the
 * number before they press the button. That is all this file does.
 *
 * Three rules, and they are all about not lying:
 *
 * **Never undershoot.** Where a vendor quotes a price range the registry
 * carries the top of it, and where the free allowance may already be partly
 * spent the wording says so. An estimate that reads low produces exactly the
 * outcome the estimate exists to prevent.
 *
 * **Never invent a number.** Several vendors publish no simple per-thousand
 * rate, and for those this returns `unknown` and says to check the account
 * rather than guessing. A confident wrong figure is worse than an honest gap —
 * the operator would stop checking.
 *
 * **Never call it a quote.** The registry's prices came from search results,
 * not from vendor pages, because every vendor host is unreachable from the
 * build container. The copy says "estimate" and names the provider so the
 * number can be checked against the account it will actually be billed to.
 */

export type SpendEstimate =
  /** Nothing to bill: no provider key, or a free provider like Census. */
  | { kind: 'free'; lookups: number; provider: string }
  /** The vendor prices by volume or by plan — we cannot compute a figure. */
  | { kind: 'unknown'; lookups: number; provider: string }
  /** Inside the free allowance, assuming none of it has been used yet. */
  | {
      kind: 'within-allowance'
      lookups: number
      provider: string
      freeCount: number
      freePeriod: 'day' | 'month'
    }
  /** Past the allowance, or there is no allowance. Carries a dollar figure. */
  | {
      kind: 'billable'
      lookups: number
      provider: string
      billableLookups: number
      /** USD, rounded up to the cent. Never rounded down. */
      estimateUsd: number
      freeCount: number | null
      freePeriod: 'day' | 'month' | null
    }

/**
 * @param provider the company's active geocoding provider, or null for none
 * @param lookups how many addresses this batch will send
 */
export function estimateLookupSpend(
  provider: GeocodeProviderDTO | null,
  lookups: number,
): SpendEstimate {
  // No provider configured means the free Census lookup, which bills nobody.
  if (!provider || provider.pricePerThousandUsd === 0 || !provider.needsKey) {
    return { kind: 'free', lookups, provider: provider?.label ?? 'US Census' }
  }

  if (provider.pricePerThousandUsd === null) {
    return { kind: 'unknown', lookups, provider: provider.label }
  }

  const free = provider.freeCount ?? 0
  const period = provider.freePeriod

  if (free > 0 && period && lookups <= free) {
    return { kind: 'within-allowance', lookups, provider: provider.label, freeCount: free, freePeriod: period }
  }

  const billableLookups = Math.max(0, lookups - free)
  // Rounded UP to the cent. A batch that costs $1.234 is reported as $1.24,
  // because the one direction this must never be wrong in is cheap.
  const estimateUsd = Math.ceil((billableLookups / 1000) * provider.pricePerThousandUsd * 100) / 100

  return {
    kind: 'billable',
    lookups,
    provider: provider.label,
    billableLookups,
    estimateUsd,
    freeCount: provider.freeCount,
    freePeriod: provider.freePeriod,
  }
}

const money = (n: number) =>
  n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`

const count = (n: number) => n.toLocaleString()

/**
 * The estimate as a sentence for the person about to press the button.
 *
 * Returns null when there is nothing worth saying — a free provider with no
 * cost to warn about. Everything else gets a line, including the good news,
 * because "this is inside your free allowance" is the reassurance that makes
 * the warning credible when it does appear.
 */
export function describeSpend(e: SpendEstimate): { tone: 'muted' | 'warn'; text: string } | null {
  switch (e.kind) {
    case 'free':
      return null

    case 'unknown':
      return {
        tone: 'warn',
        text: `This will use ${count(e.lookups)} address lookup${e.lookups === 1 ? '' : 's'} on ${e.provider}, which prices by volume — check your ${e.provider} account before running a batch this size.`,
      }

    case 'within-allowance':
      return {
        tone: 'muted',
        text: `This will use ${count(e.lookups)} of your ${count(e.freeCount)} free ${e.provider} lookups per ${e.freePeriod}. Anything you have already used ${e.freePeriod === 'day' ? 'today' : 'this month'} counts against the same allowance.`,
      }

    case 'billable': {
      const head = `This will use ${count(e.lookups)} address lookup${e.lookups === 1 ? '' : 's'} on ${e.provider}.`
      const body =
        e.freeCount && e.freePeriod
          ? ` That is ${count(e.billableLookups)} past your ${count(e.freeCount)} free per ${e.freePeriod} — an estimated ${money(e.estimateUsd)}, billed to your ${e.provider} account. More will be billable if you have already used part of ${e.freePeriod === 'day' ? "today's" : "this month's"} allowance.`
          : ` ${e.provider} has no free allowance, so the estimate is ${money(e.estimateUsd)}, billed to your ${e.provider} account.`
      return { tone: 'warn', text: `${head}${body} Estimate only — check the rate on your account.` }
    }
  }
}
