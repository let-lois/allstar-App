import type { LeadStatus, OutcomeCode } from '../../types'
import { STATUS_COLOR, STATUS_LABEL, outcomeByCode } from '../../data/outcomes'

export function StatusPill({
  status,
  size = 'md',
}: {
  status: LeadStatus
  size?: 'sm' | 'md'
}) {
  const color = STATUS_COLOR[status]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
      }`}
      style={{ backgroundColor: `${color}1f`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function OutcomePill({ code }: { code?: OutcomeCode }) {
  const def = outcomeByCode(code)
  if (!def) return <span className="text-xs text-ink-mute">Not visited</span>
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-ink-mute">
      <span aria-hidden>{def.glyph}</span>
      {def.label}
    </span>
  )
}

/**
 * Lead score. Shown as a bar rather than a bare number because reps triage by
 * comparison ("which door next?"), not by absolute value.
 */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? '#15803d' : score >= 45 ? '#d97706' : '#94a3b8'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Lead score ${score}`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-200">
        <span
          className="block h-full rounded-full"
          style={{ width: `${score}%`, backgroundColor: tone }}
        />
      </span>
      <span className="nums text-[11px] font-semibold" style={{ color: tone }}>
        {score}
      </span>
    </span>
  )
}
