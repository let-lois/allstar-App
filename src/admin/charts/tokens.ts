/**
 * Chart tokens for the office console.
 *
 * Every value here was run through the data-viz palette validator against this
 * app's actual chart surface (`#ffffff`, the card background) — not eyeballed.
 * If you change a hex, re-run the validator before shipping it.
 *
 *   node scripts/validate_palette.js "<hex,hex>" --mode light --surface "#ffffff"
 *   node scripts/validate_palette.js "<ramp>" --ordinal --mode light --surface "#ffffff"
 */

/**
 * Categorical slots, assigned in fixed order and never cycled.
 * Validated: worst adjacent CVD ΔE 24.7 (protan), normal-vision ΔE 33.6, both
 * clear of the floors; both clear 3:1 on white.
 *
 * Kept blue/orange through the teal redesign, deliberately. Two line series have
 * to be separable by someone with protanopia, and this pair is measured to be;
 * a teal-and-something pair would have to clear the same floors and the
 * validator these numbers came from is not in this repo to re-run. A data series
 * is also not interface chrome — the redesign's ban on orange is about surfaces,
 * and this is the one place in the product where hue is carrying information
 * that nothing else carries. Revisit with a validator in hand, not by eye.
 */
export const SERIES = ['#2a78d6', '#eb6834'] as const

/**
 * Ordinal ramp for the funnel — one hue, light→dark, because funnel stages are
 * *ordered*, not separate identities.
 *
 * Deliberately five steps: the documented blue ramp cannot fit six steps that
 * simultaneously keep adjacent ΔL ≥ 0.06 and hold the light end above 2:1 on
 * white. Rather than ship a ramp whose top two stages are indistinguishable,
 * the funnel covers the five *open* stages and Won is reported separately as
 * the conversion headline — which is the better read anyway.
 */
export const FUNNEL_RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'] as const

/** Single-hue fill for one-measure distributions (no legend, no identity). */
export const SINGLE = '#2a78d6'

/** Reserved for state, never for a series. Always paired with an icon or label. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

/**
 * Chart chrome. Text always wears ink tokens — never the series color.
 *
 * These are the app's own neutrals now, not the warm greys they used to be. A
 * chart is not a separate product: its axis labels and gridlines sit inside a
 * card next to the interface's own text, and a warm grey axis beside a cool grey
 * caption reads as two typefaces rather than one system. The values match
 * `ink-*` and `line-*` in tailwind.config.js exactly.
 */
export const INK = {
  primary: '#111827',
  secondary: '#334155',
  muted: '#64748B',
  grid: '#EDF1F3',
  axis: '#E3E8EA',
  surface: '#ffffff',
  deltaGood: '#166534',
  deltaBad: '#B91C1C',
} as const
