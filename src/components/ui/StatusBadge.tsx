import type { ReactNode } from 'react'

/**
 * A small state label.
 *
 * Every tone pairs a dark foreground with its own tinted background, measured to
 * pass AA rather than eyeballed — a pale pill with pale text is the most common
 * accessibility failure in this kind of interface, and it always looks fine to
 * the person who chose it.
 *
 * The dot is not decoration. Colour alone can't carry meaning, so the word is
 * always present and the dot only reinforces it.
 */
type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand'

const tones: Record<Tone, string> = {
  good: 'bg-good-bg text-good',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-info',
  brand: 'bg-brand-50 text-brand-600',
  neutral: 'bg-ink/[0.06] text-ink-mute',
}

const dots: Record<Tone, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
  brand: 'bg-brand-400',
  neutral: 'bg-ink-faint',
}

export function StatusBadge({
  tone = 'neutral',
  dot = true,
  children,
  className = '',
}: {
  tone?: Tone
  dot?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`emboss inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${tones[tone]} ${className}`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dots[tone]}`} />}
      {children}
    </span>
  )
}
