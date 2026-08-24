/**
 * Chart tokens for the office console.
 *
 * These were validated against a white chart surface. The app now runs on a dark
 * one, so the values below were lifted to clear 3:1 on the card they actually sit
 * on — that part is measured, with `scripts/lib/contrast.mjs`, and pinned by
 * `npm run verify:contrast`.
 *
 * **What has not been re-run:** the CVD ΔE separation between the two series,
 * and the ordinal ramp's adjacent-ΔL check. Those came from a palette validator
 * that is not in this repo. The hues are unchanged and each pair was moved by
 * the same kind of step, so the separation should hold — but "should" is not
 * "measured", and the honest state of this file is that its contrast figures are
 * current and its colour-blindness figures are inherited. Re-run before treating
 * them as fresh:
 *
 *   node scripts/validate_palette.js "<hex,hex>" --mode dark --surface "#151D2E"
 *   node scripts/validate_palette.js "<ramp>" --ordinal --mode dark --surface "#151D2E"
 */

/**
 * Categorical slots, assigned in fixed order and never cycled.
 * On white these measured: worst adjacent CVD ΔE 24.7 (protan), normal-vision
 * ΔE 33.6. Lightened for the dark card, where they now measure 6.73:1 and
 * 7.41:1 — the darker originals sat at 3.81 and 5.26, over the floor but muddy.
 *
 * Kept blue/orange through both redesigns, deliberately. Two line series have to
 * be separable by someone with protanopia, this pair was measured to be on white,
 * and changing the hues would throw away that result rather than carry it. A data
 * series is also not interface chrome — the ban on orange is about surfaces, and
 * this is the one place in the product where hue carries information that nothing
 * else carries. Revisit with a validator in hand, not by eye.
 */
export const SERIES = ['#6BA6F5', '#F2955E'] as const

/**
 * Ordinal ramp for the funnel — one hue, dim→bright, because funnel stages are
 * *ordered*, not separate identities. The direction flipped with the ground: on
 * white the ramp ran light→dark, and "further along" has to mean "further from
 * the surface" either way. The dim end sits at 3.07:1 on the card, which is the
 * floor, not a margin — do not darken step 0.
 *
 * Deliberately five steps: the documented blue ramp cannot fit six steps that
 * simultaneously keep adjacent ΔL ≥ 0.06 and hold the light end above 2:1 on
 * white. Rather than ship a ramp whose top two stages are indistinguishable,
 * the funnel covers the five *open* stages and Won is reported separately as
 * the conversion headline — which is the better read anyway.
 */
export const FUNNEL_RAMP = ['#2A6BB0', '#3C8ADA', '#69ABEE', '#9BC9F7', '#CFE5FC'] as const

/** Single-hue fill for one-measure distributions (no legend, no identity). */
export const SINGLE = '#6BA6F5'

/** Reserved for state, never for a series. Always paired with an icon or label. */
export const STATUS = {
  good: '#4ADE80',
  warning: '#FBBF24',
  serious: '#FB923C',
  critical: '#F87171',
} as const

/**
 * Chart chrome. Text always wears ink tokens — never the series color.
 *
 * These are the app's own neutrals now, not the warm greys they used to be. A
 * chart is not a separate product: its axis labels and gridlines sit inside a
 * card next to the interface's own text, and a warm grey axis beside a cool grey
 * caption reads as two typefaces rather than one system. The values mirror the
 * `--ink-*` and `--line-*` theme variables in `index.css`; `verify:contrast`
 * fails if they drift apart, because a chart cannot read a CSS variable.
 */
export const INK = {
  primary: '#F2F6FA',
  secondary: '#C6D2E0',
  muted: '#93A2B8',
  grid: '#212B41',
  axis: '#2A3652',
  surface: '#151D2E',
  deltaGood: '#4ADE80',
  deltaBad: '#F87171',
} as const
