import { useState } from 'react'
import { FUNNEL_RAMP, INK, SINGLE } from './tokens'

export interface BarDatum {
  key: string
  label: string
  value: number
  /** Optional second line under the label, e.g. a currency roll-up. */
  meta?: string
}

interface Props {
  data: BarDatum[]
  /** `funnel` uses the ordered ramp; `single` uses one hue for one measure. */
  variant?: 'funnel' | 'single'
  format?: (v: number) => string
  /** Shown under each bar's label when the funnel is stage-to-stage. */
  showConversion?: boolean
}

/**
 * Horizontal bars.
 *
 * Horizontal because the categories are words — "Quote requested", "Do not
 * contact" — and vertical bars would either clip them or turn them 45°.
 *
 * Two variants, because the *job* differs:
 *  - `funnel`: ordered stages → one hue, light→dark, so the ramp itself carries
 *    progression.
 *  - `single`: one measure across nominal categories → one flat color. A
 *    value-ramp here would imply an order the categories don't have.
 *
 * Every bar is direct-labeled, so nothing depends on hover and nothing depends
 * on color.
 */
export function Bars({ data, variant = 'single', format = String, showConversion }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const max = Math.max(1, ...data.map((d) => d.value))

  return (
    <ul className="space-y-2.5">
      {data.map((d, i) => {
        const pct = (d.value / max) * 100
        const color =
          variant === 'funnel' ? FUNNEL_RAMP[Math.min(i, FUNNEL_RAMP.length - 1)] : SINGLE
        // Stage-to-stage conversion, not conversion from the top — a manager
        // acts on the step that leaks, not on the cumulative number.
        const prev = i > 0 ? data[i - 1].value : undefined
        const conv = prev && prev > 0 ? Math.round((d.value / prev) * 100) : undefined

        return (
          <li
            key={d.key}
            onPointerEnter={() => setHover(d.key)}
            onPointerLeave={() => setHover(null)}
            className="group"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">{d.label}</span>
              <span className="flex items-baseline gap-2">
                {showConversion && conv != null && (
                  <span className="nums text-[11px] text-ink-mute">{conv}% of prev</span>
                )}
                <span className="nums text-sm font-semibold text-ink">{format(d.value)}</span>
              </span>
            </div>
            {/*
              Depth only — the channel and the top light. The bar colours stay
              exactly as the dataviz tokens define them, because those were
              chosen and validated as a palette; restyling them for consistency
              with the nav would be trading a considered decision for a
              decorative one.
            */}
            <div
              className="sunk mt-1 h-3 w-full overflow-hidden rounded-md"
              style={{ backgroundColor: INK.grid }}
            >
              <div
                // 4px rounded data-end, anchored to the baseline at the left.
                className="fill-gloss h-full rounded-md transition-[width]"
                style={{
                  width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                  backgroundColor: color,
                  opacity: hover && hover !== d.key ? 0.55 : 1,
                }}
              />
            </div>
            {d.meta && <p className="mt-0.5 text-[11px] text-ink-mute">{d.meta}</p>}
          </li>
        )
      })}
    </ul>
  )
}
