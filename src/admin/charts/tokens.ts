/**
 * Chart tokens for the office console.
 *
 * Every figure quoted below is measured, and measured *here* — the contrast
 * ratios by `scripts/lib/contrast.mjs`, the colour-vision and lightness figures
 * by `scripts/lib/cvd.mjs`. Both are pinned by `npm run verify:charts`.
 *
 * That is a change worth naming. These values were once validated against a
 * white chart surface by a tool that lived outside this repo. When the app moved
 * to a dark ground the contrast was re-measured, because the means to do that
 * was here; the colour-blindness figures were left inherited and honestly marked
 * as stale, because it was not. A number nobody can re-derive rots the first time
 * somebody edits the thing it describes, so the maths moved in.
 */

/**
 * Categorical slots, assigned in fixed order and never cycled.
 *
 * Blue then orange, through the white redesign and this one. The hue *pair* is
 * the colour-blindness decision — two line series have to be separable by
 * someone with protanopia — and re-picking hues would throw away that result
 * rather than carry it. A data series is also not interface chrome: the ban on
 * orange is about surfaces, and this is the one place in the product where hue
 * carries information nothing else carries.
 *
 * What changed is the *step*, not the hue. Lifting these by hand for the dark
 * card overshot: at L 0.718 and 0.755 they sat above the 0.48–0.67 band a dark
 * ground wants, which is how a mark starts to glare rather than sit on the
 * surface. Stepped properly for the dark surface they measure:
 *
 *   protan/deutan ΔE 26.8 (target ≥ 8) — up from 21.6 before the re-step
 *   normal-vision ΔE 31.8 (floor ≥ 15)
 *   contrast on the card 4.63:1 and 4.34:1 (floor 3:1 for a mark)
 *
 * The contrast is lower than the 6.73 and 7.41 the hand-lifted values had, and
 * that is the trade: both remain comfortably above the floor for a graphic, the
 * separation a colour-blind reader depends on went *up*, and the marks stop
 * shouting. Do not re-lighten these by eye — run the gate.
 */
export const SERIES = ['#3987E5', '#D95926'] as const

/**
 * Ordinal ramp for the funnel — one hue, dim→bright, because funnel stages are
 * *ordered*, not separate identities. The direction flipped with the ground: on
 * white the ramp ran light→dark, and "further along" has to mean "further from
 * the surface" either way.
 *
 * Re-measured on the dark card and unchanged by it: monotone, adjacent ΔL from
 * 0.09 to 0.13 against a 0.06 floor, hue spread 4°, and the dim end at 3.07:1
 * on the card — which is the floor, not a margin. Do not darken step 0.
 *
 * Deliberately five steps: this ramp cannot fit six that simultaneously keep
 * adjacent ΔL over the floor and hold the dim end above it. Rather than ship a
 * ramp whose last two stages are indistinguishable, the funnel covers the five
 * *open* stages and Won is reported separately as the conversion headline —
 * which is the better read anyway.
 */
export const FUNNEL_RAMP = ['#2A6BB0', '#3C8ADA', '#69ABEE', '#9BC9F7', '#CFE5FC'] as const

/**
 * Single-hue fill for one-measure distributions (no legend, no identity).
 * The first categorical slot, so a one-series chart and a two-series chart do
 * not disagree about what blue means.
 */
export const SINGLE = '#3987E5'

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
/**
 * Chart ink, read from the theme rather than pinned to one.
 *
 * These were literal hex, which is why the console's trend arrows measured
 * 1.56:1 on a white card — a green meant for a near-black chart, on paper. Held
 * as `var()` they follow whichever theme is applied, and the light values live
 * beside the dark ones in `index.css` where the rest of the palette is.
 *
 * Every consumer puts these in an inline `style` or an SVG attribute, both of
 * which resolve custom properties, so nothing here needs a computed lookup.
 */
export const INK = {
  primary: 'var(--chart-ink)',
  secondary: 'var(--chart-ink-2)',
  muted: 'var(--chart-ink-muted)',
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
  surface: 'var(--chart-surface)',
  deltaGood: 'var(--chart-good)',
  deltaBad: 'var(--chart-bad)',
} as const
