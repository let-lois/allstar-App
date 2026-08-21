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
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-surface-field px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
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
/**
 * Lead score as a 36px rail.
 *
 * The scale used to run grey → amber → green, which put an orange bar and an
 * orange number on most lead rows in a teal product — and, worse, borrowed the
 * two colours this app uses for *outcomes* to express a probability. A score is
 * not a warning and a mid score is not a near-miss.
 *
 * So it is one hue at three strengths: the brand teal for a strong lead, a
 * muted teal for a middling one, grey for a weak one. Same three steps of
 * information, none of it pretending to be a status.
 */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? '#087F8C' : score >= 45 ? '#5FA9B3' : '#94A3B8'
  const ink = score >= 70 ? '#056470' : score >= 45 ? '#41707A' : '#64748B'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Lead score ${score}`}>
      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(score, 4)}%`, backgroundColor: tone }}
        />
      </span>
      {/* The number takes a darker step than the bar: the bar only needs to be
          distinguishable, the digits have to be readable at 11.5px. */}
      <span className="nums text-[11.5px] font-semibold" style={{ color: ink }}>
        {score}
      </span>
    </span>
  )
}
