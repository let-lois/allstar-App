import { IconArrowDown, IconArrowUp } from '../../components/nav/icons'
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
  /*
    A drawn arrow rather than `↑ ↓ →`. Those are text characters: they take the
    figure's font, sit on its baseline rather than beside it, and at 12px in a
    condensed system font the up and down arrows are two nearly identical
    strokes. The icon is the same shape at any size, and `flat` says the number
    did not move without pretending that is a direction.
  */
  const Arrow = delta == null || delta === 0 ? null : delta > 0 ? IconArrowUp : IconArrowDown

  return (
    <div className="card p-4">
      {/* Sentence case, medium weight, and the number in semibold — matching
          `KpiCard` in the field app. Small-caps labels over black numerals are
          the house style of a reporting tool, which is the thing this console
          most needed to stop looking like. */}
      <p className="text-[12.5px] font-medium text-ink-mute">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink md:text-[28px]">
        {value}
      </p>
      {delta != null && (
        <p
          className="mt-1.5 flex items-center gap-1 text-xs font-semibold"
          style={{ color: good ? INK.deltaGood : delta === 0 ? INK.muted : INK.deltaBad }}
        >
          {/* Direction + sign, never colour alone. */}
          {Arrow && (
            <span aria-hidden className="icon-xs grid place-items-center">
              <Arrow />
            </span>
          )}
          {Math.abs(delta)}%
          {deltaLabel && <span className="font-normal text-ink-mute">{deltaLabel}</span>}
        </p>
      )}
      {sub && <div className="mt-1 text-xs text-ink-mute">{sub}</div>}
    </div>
  )
}
