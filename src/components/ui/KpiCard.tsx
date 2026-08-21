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
 * teal for the metric that is the point of the screen, green for money won.
 * Colouring all four the same is the same as colouring none of them.
 *
 * `size` exists because four equal metrics are four things to compare and no
 * answer. `lead` is for the one number a screen is actually about — it takes the
 * full width and a larger face, and the others sit under it as a quiet row. That
 * is the difference between a dashboard and a screen.
 */
export function KpiCard({
  label,
  value,
  sub,
  tone = 'neutral',
  size = 'md',
  onClick,
  className = '',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'neutral' | 'brand' | 'good'
  size?: 'md' | 'lead'
  onClick?: () => void
  className?: string
}) {
  const valueTone =
    tone === 'brand' ? 'text-brand-600' : tone === 'good' ? 'text-good' : 'text-ink'
  const lead = size === 'lead'

  const body = (
    <>
      {/* Label first and small. The number is the thing being read; the label is
          only there to say what it counts. */}
      <p className="text-[12.5px] font-medium text-ink-mute">{label}</p>
      <p
        className={`nums font-semibold tracking-[-0.02em] ${valueTone} ${
          lead ? 'mt-1 text-[38px] leading-[1.05]' : 'mt-0.5 text-[26px] leading-[1.1]'
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[13px] leading-snug text-ink-mute">{sub}</p>}
    </>
  )

  const box = `${lead ? 'p-5' : 'min-h-[92px] p-4'} ${className}`
  if (onClick) {
    return (
      <button onClick={onClick} className={`card-tap focusable text-left ${box}`}>
        {body}
      </button>
    )
  }
  return <div className={`card ${box}`}>{body}</div>
}
