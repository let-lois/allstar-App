/**
 * A magnitude, as a bar.
 *
 * Rounded, and the fill keeps its radius even at 2% — a sliver with square ends
 * looks like a rendering fault. Below that it holds a minimum width so "some"
 * never renders as "none", which matters on a pipeline where one lead in a stage
 * is meaningfully different from zero.
 *
 * The track is recessed and the fill lit from the top, so the bar reads as
 * something sitting in a channel rather than two flat rectangles.
 */
export function ProgressBar({
  value,
  max,
  tone = 'brand',
  className = '',
  animate = true,
  label,
}: {
  value: number
  max: number
  tone?: 'brand' | 'good' | 'neutral'
  className?: string
  animate?: boolean
  /** Screen-reader text; the visible number lives beside the bar. */
  label?: string
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const width = value > 0 ? Math.max(pct, 4) : 0
  const fill =
    tone === 'good' ? 'bg-good' : tone === 'neutral' ? 'bg-ink-faint' : 'bg-brand-400'

  return (
    <div
      className={`sunk h-2.5 overflow-hidden rounded-full bg-ink/[0.07] ${className}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className={`fill-gloss h-full rounded-full ${fill} ${animate ? 'anim-bar' : ''}`}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}
