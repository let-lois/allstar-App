import { useMemo, useRef, useState } from 'react'
import { INK, SERIES } from './tokens'

export interface TrendPoint {
  day: string
  label: string
  values: number[]
}

interface Props {
  points: TrendPoint[]
  seriesNames: string[]
  height?: number
  /** Formats a value for the tooltip and the table view. */
  format?: (v: number) => string
}

/**
 * Two-series daily trend.
 *
 * One y-axis, always — the two measures here (doors, conversations) are the
 * same unit, which is precisely why they may share a plot. Two measures of
 * different scale would be two charts, never a second axis.
 *
 * Ships a crosshair + tooltip because an HTML chart *is* interactive, and a
 * table view underneath so no value is reachable only by hovering.
 */
export function TrendChart({ points, seriesNames, height = 220, format = String }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  const W = 720
  const H = height
  const PAD = { top: 16, right: 16, bottom: 28, left: 40 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const TICK_COUNT = 4

  /**
   * Nice round ticks.
   *
   * Rounding the *maximum* to a clean number isn't enough — dividing it into
   * four still yields values like 43.75, and an axis reading "0, 44, 88, 131"
   * makes a reader do arithmetic to place a point. Pick a round *step* first,
   * then let the top of the scale fall where it lands.
   */
  const step = useMemo(() => {
    const m = Math.max(1, ...points.flatMap((p) => p.values))
    const rough = m / TICK_COUNT
    const mag = 10 ** Math.floor(Math.log10(rough))
    // 1, 2, 2.5, 5, 10 × magnitude — the steps people read without thinking.
    const nice = [1, 2, 2.5, 5, 10].find((n) => rough <= n * mag) ?? 10
    return nice * mag
  }, [points])

  const max = useMemo(() => {
    const m = Math.max(1, ...points.flatMap((p) => p.values))
    return Math.ceil(m / step) * step
  }, [points, step])

  const x = (i: number) => PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH

  const ticks = useMemo(() => {
    const out: number[] = []
    for (let v = 0; v <= max + 0.0001; v += step) out.push(Math.round(v * 100) / 100)
    return out
  }, [max, step])

  const paths = seriesNames.map((_, s) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.values[s]).toFixed(1)}`).join(' '),
  )

  const onMove = (e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || points.length === 0) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((px - PAD.left) / plotW) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }

  const active = hover != null ? points[hover] : undefined

  return (
    <div>
      {/* Legend is always present for two or more series — identity must never
          rest on color alone. */}
      <div className="mb-2 flex flex-wrap items-center gap-4">
        {seriesNames.map((name, s) => (
          <span key={name} className="flex items-center gap-1.5 text-xs text-ink-mute">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: SERIES[s % SERIES.length] }}
              aria-hidden
            />
            {name}
          </span>
        ))}
        <button
          onClick={() => setShowTable((v) => !v)}
          /* 44px on a phone, 32 at a desk. This is a real control, not a
             caption, and the console is used one-handed now. */
          className="focusable ml-auto min-h-[44px] rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-tint lg:min-h-[32px]"
        >
          {showTable ? 'Hide table' : 'Table view'}
        </button>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none"
          style={{ height }}
          role="img"
          aria-label={`Daily ${seriesNames.join(' and ')} over ${points.length} days`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Recessive grid — solid hairlines, never dashed. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke={INK.grid}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(t) + 4}
                textAnchor="end"
                fontSize={11}
                fill={INK.muted}
              >
                {t}
              </text>
            </g>
          ))}

          {/* x labels, thinned so they never collide */}
          {points.map((p, i) => {
            const every = Math.ceil(points.length / 8)
            const isLast = i === points.length - 1
            // Always show the final date, but not when it would sit on top of
            // the previous label — a collided pair is worse than a missing one.
            const lastCollides = isLast && (points.length - 1) % every < every / 2
            if (i % every !== 0 && (!isLast || lastCollides)) return null
            return (
              <text
                key={p.day}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                fontSize={11}
                fill={INK.muted}
              >
                {p.label}
              </text>
            )
          })}

          {active && (
            <line
              x1={x(hover!)}
              x2={x(hover!)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke={INK.axis}
              strokeWidth={1}
            />
          )}

          {paths.map((d, s) => (
            <path
              key={s}
              d={d}
              fill="none"
              stroke={SERIES[s % SERIES.length]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Marker on the hovered point only — a dot on every point is noise. */}
          {active &&
            seriesNames.map((_, s) => (
              <circle
                key={s}
                cx={x(hover!)}
                cy={y(active.values[s])}
                r={5}
                fill={SERIES[s % SERIES.length]}
                stroke={INK.surface}
                strokeWidth={2}
              />
            ))}
        </svg>

        {active && (
          <div
            className="pointer-events-none absolute top-2 rounded-field border border-line bg-surface px-3 py-2 text-xs shadow-float"
            style={{
              left: `${Math.min(80, ((x(hover!) / W) * 100))}%`,
              transform: 'translateX(8px)',
            }}
          >
            <p className="font-semibold text-ink">{active.label}</p>
            {seriesNames.map((name, s) => (
              <p key={name} className="mt-0.5 flex items-center gap-1.5 text-ink-mute">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: SERIES[s % SERIES.length] }}
                />
                {name}
                <span className="nums ml-1 font-semibold text-ink">
                  {format(active.values[s])}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>

      {showTable && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-field border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-sunk text-xs text-ink-mute">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Day</th>
                {seriesNames.map((n) => (
                  <th key={n} className="px-3 py-2 text-right font-semibold">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day} className="border-t border-line-soft">
                  <td className="px-3 py-1.5">{p.label}</td>
                  {p.values.map((v, i) => (
                    <td key={i} className="nums px-3 py-1.5 text-right">
                      {format(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
