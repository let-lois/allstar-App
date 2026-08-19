import type { ReactNode } from 'react'

/**
 * One headline number.
 *
 * The hierarchy is the whole point: a small quiet label, a number large enough
 * to read at arm's length in a truck, and an optional line of context under it.
 * Reversing that — big label, small number — is the single most common way a
 * dashboard becomes unreadable.
 *
 * `tone` colours the number, and only the number. Everything neutral by default;
 * orange for the metric that is the point of the screen, green for money won.
 * Colouring all four the same is the same as colouring none of them.
 */
export function KpiCard({
  label,
  value,
  sub,
  tone = 'neutral',
  onClick,
  className = '',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'neutral' | 'brand' | 'good'
  onClick?: () => void
  className?: string
}) {
  const valueTone =
    tone === 'brand' ? 'text-brand-600' : tone === 'good' ? 'text-good' : 'text-ink'

  const body = (
    <>
      <p className="eyebrow">{label}</p>
      <p className={`nums mt-1.5 text-kpi font-extrabold ${valueTone}`}>{value}</p>
      {sub && <p className="mt-1 text-[13px] leading-snug text-ink-mute">{sub}</p>}
    </>
  )

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`card-tap focusable min-h-[104px] p-4 text-left ${className}`}
      >
        {body}
      </button>
    )
  }
  return <div className={`card min-h-[104px] p-4 ${className}`}>{body}</div>
}
