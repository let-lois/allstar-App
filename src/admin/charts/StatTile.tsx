import type { ReactNode } from 'react'
import { INK } from './tokens'

interface Props {
  label: string
  value: string
  /** Percentage change vs the comparison window. */
  delta?: number
  deltaLabel?: string
  sub?: ReactNode
  /** Higher is worse for this measure (e.g. cost per lead). */
  invert?: boolean
}

/**
 * A headline number, not a chart.
 *
 * The most common way to get a dashboard wrong is drawing a chart when the
 * story is one number. These tiles are that number.
 *
 * The figure deliberately does *not* use tabular figures — equal-width digits
 * make a large standalone number look gappy. Tabular numerals belong in the
 * tables, where columns must line up.
 */
export function StatTile({ label, value, delta, deltaLabel, sub, invert }: Props) {
  const good = delta == null ? null : invert ? delta < 0 : delta > 0
  const arrow = delta == null ? '' : delta > 0 ? '↑' : delta < 0 ? '↓' : '→'

  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{label}</p>
      <p className="mt-1.5 text-[28px] font-black leading-none text-ink">{value}</p>
      {delta != null && (
        <p
          className="mt-1.5 flex items-center gap-1 text-xs font-semibold"
          style={{ color: good ? INK.deltaGood : delta === 0 ? INK.muted : INK.deltaBad }}
        >
          {/* Arrow + sign, never color alone. */}
          <span aria-hidden>{arrow}</span>
          {Math.abs(delta)}%
          {deltaLabel && <span className="font-normal text-ink-mute">{deltaLabel}</span>}
        </p>
      )}
      {sub && <div className="mt-1 text-xs text-ink-mute">{sub}</div>}
    </div>
  )
}
