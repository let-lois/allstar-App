import type { GeocodeProviderDTO, GeocodeUsageDTO } from './http'

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
      /** What is LEFT of the allowance, not what it started at. */
      freeCount: number
      freePeriod: 'day' | 'month'
      /** What we have already sent this period. A floor, not a total. */
      alreadySpent: number
    }
  /** Past the allowance, or there is no allowance. Carries a dollar figure. */
  | {
      kind: 'billable'
      lookups: number
      provider: string
      billableLookups: number
      /** USD, rounded up to the cent. Never rounded down. */
      estimateUsd: number
      /** What is LEFT of the allowance, not what it started at. */
      freeCount: number | null
      freePeriod: 'day' | 'month' | null
      /** What we have already sent this period. A floor, not a total. */
      alreadySpent: number
    }

/**
 * @param provider the company's active geocoding provider, or null for none
 * @param lookups how many addresses this batch will send
 * @param usage what we have already sent on this key — see the note below
 */
export function estimateLookupSpend(
  provider: GeocodeProviderDTO | null,
  lookups: number,
  usage?: GeocodeUsageDTO | null,
): SpendEstimate {
  // No provider configured means the free Census lookup, which bills nobody.
  if (!provider || provider.pricePerThousandUsd === 0 || !provider.needsKey) {
    return { kind: 'free', lookups, provider: provider?.label ?? 'US Census' }
  }

  if (provider.pricePerThousandUsd === null) {
    return { kind: 'unknown', lookups, provider: provider.label }
  }

  const full = provider.freeCount ?? 0
  const period = provider.freePeriod

  /*
    The allowance as it stands, not as it started.
    
    Without subtracting what has already gone, every batch is priced against a
    fresh allowance — so three medium imports in a day each read as free while
    together they cross the vendor's daily cap, and nobody is warned on any of
    them. `spent` is a floor rather than a total: the same key used from
    anywhere else adds to the vendor's count and not to ours, which is why the
    wording never claims to know what is left.
  */
  const spent = period === 'day' ? (usage?.today ?? 0) : period === 'month' ? (usage?.month ?? 0) : 0
  const free = Math.max(0, full - spent)

  if (free > 0 && period && lookups <= free) {
    return {
      kind: 'within-allowance',
      lookups,
      provider: provider.label,
      freeCount: free,
      freePeriod: period,
      alreadySpent: spent,
    }
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
    freeCount: provider.freeCount === null ? null : free,
    freePeriod: provider.freePeriod,
    alreadySpent: spent,
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

    case 'within-allowance': {
      const when = e.freePeriod === 'day' ? 'today' : 'this month'
      // Two sentences, because the honest caveat only applies once something has
      // actually been sent — stating it on a fresh allowance is noise.
      const head =
        e.alreadySpent > 0
          ? `This will use ${count(e.lookups)} of the ${count(e.freeCount)} free ${e.provider} lookups left ${when} — we have sent ${count(e.alreadySpent)} already.`
          : `This will use ${count(e.lookups)} of your ${count(e.freeCount)} free ${e.provider} lookups per ${e.freePeriod}.`
      const caveat =
        e.alreadySpent > 0
          ? ` That count is ours: this key used anywhere else adds to ${e.provider}'s total and not to this one.`
          : ''
      return { tone: 'muted', text: `${head}${caveat}` }
    }

    case 'billable': {
      const head = `This will use ${count(e.lookups)} address lookup${e.lookups === 1 ? '' : 's'} on ${e.provider}.`
      const when = e.freePeriod === 'day' ? 'today' : 'this month'
      const body =
        e.freePeriod && e.freeCount !== null
          ? ` That is ${count(e.billableLookups)} past the ${count(e.freeCount)} free you have left ${when}${e.alreadySpent > 0 ? ` (we have sent ${count(e.alreadySpent)} already)` : ''} — an estimated ${money(e.estimateUsd)}, billed to your ${e.provider} account.`
          : ` ${e.provider} has no free allowance, so the estimate is ${money(e.estimateUsd)}, billed to your ${e.provider} account.`
      return { tone: 'warn', text: `${head}${body} Estimate only — check the rate on your account.` }
    }
  }
}
