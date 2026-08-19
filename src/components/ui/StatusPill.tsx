import type { LeadStatus, OutcomeCode } from '../../types'
import { STATUS_LABEL, STATUS_TONE, outcomeByCode } from '../../data/outcomes'

/**
 * Lead status, as a pill.
 *
 * Reads its colours from STATUS_TONE rather than STATUS_COLOR: the map swatch
 * hues are the wrong thing to put text on — a teal or amber dot is fine, the
 * same hue as 11px pill text on its own 12% tint is around 3:1 and fails.
 */
export function StatusPill({
  status,
  size = 'md',
}: {
  status: LeadStatus
  size?: 'sm' | 'md'
}) {
  const { fg, bg } = STATUS_TONE[status]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[11.5px]'
      }`}
      style={{ backgroundColor: bg, color: fg }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: fg }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function OutcomePill({ code }: { code?: OutcomeCode }) {
  const def = outcomeByCode(code)
  if (!def) return <span className="text-[12.5px] text-ink-mute">Not visited</span>
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
      <span aria-hidden>{def.glyph}</span>
      {def.label}
    </span>
  )
}

/**
 * Lead score. Shown as a bar rather than a bare number because reps triage by
 * comparison ("which door next?"), not by absolute value.
 *
 * The three tones are the app's semantic pair values, not their own set of
 * hexes — and none of them is ink-faint, which at 2.56:1 on white is a swatch
 * colour that had no business carrying a number.
 */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? '#166534' : score >= 45 ? '#B45309' : '#64748B'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Lead score ${score}`}>
      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-ink/10">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(score, 4)}%`, backgroundColor: tone }}
        />
      </span>
      <span className="nums text-[11.5px] font-bold" style={{ color: tone }}>
        {score}
      </span>
    </span>
  )
}
