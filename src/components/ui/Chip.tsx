import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  color?: string
  selected?: boolean
  onClick?: () => void
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Filter / tag pill. When interactive it gets a 40px min height — chips are the
 * one place a "small" control still has to be tappable while walking.
 */
export function Chip({ children, color, selected, onClick, size = 'md', className = '' }: Props) {
  // A static chip is a label and can be compact. An interactive one is a
  // control the rep taps while walking, so `size` only shrinks the *text* —
  // the target itself never drops below 44px.
  const staticBase =
    size === 'sm' ? 'px-2.5 py-1 text-xs rounded-full' : 'px-3.5 py-1.5 text-sm rounded-full'
  const tapBase =
    size === 'sm'
      ? 'px-3.5 min-h-[44px] text-xs rounded-full'
      : 'px-4 min-h-tap text-sm rounded-full'

  if (!onClick) {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${staticBase} ${className}`}
        style={
          color
            ? { backgroundColor: `${color}1a`, color }
            : undefined
        }
      >
        {children}
      </span>
    )
  }

  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'press focusable inline-flex shrink-0 items-center gap-1.5 border font-medium',
        tapBase,
        // Selected is a filled teal; unselected is a white chip with a hairline.
        // Both keep the same border width so the row does not shift by a pixel
        // when a filter is tapped.
        selected
          ? 'border-brand-600 bg-brand-600 text-white'
          : 'border-line bg-surface text-ink-mute active:bg-surface-field',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}
