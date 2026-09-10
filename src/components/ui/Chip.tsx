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
  /*
    Both dimensions, not just height.

    `min-h` alone leaves a short label short in the other direction: "All" came
    out 43x44, one pixel under the floor this file claims to hold. Nobody would
    ever have measured it by hand — it was found by a gate that compares every
    control on a screen against the rule rather than checking the ones somebody
    thought to name.
  */
  const tapBase =
    size === 'sm'
      ? 'px-3.5 min-h-[44px] min-w-[44px] justify-center text-xs rounded-full'
      : 'px-4 min-h-tap min-w-tap justify-center text-sm rounded-full'

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
        /*
          `border-transparent`, not a bare `border`.

          A width with no colour falls through to Tailwind's default, which is a
          light grey — invisible on the white ground this started life on, and a
          pale outline on the dark one. The chip's edge comes from `.metal`'s
          ring like every other control's; the transparent border is only here
          to keep the 1px it was already contributing to the chip's size.
        */
        'press focusable inline-flex shrink-0 items-center gap-1.5 border border-transparent font-medium',
        tapBase,
        // Both states wear `.metal` — a filter row is a row of controls, and a
        // flat chip beside a raised button reads as a label rather than a thing
        // to press. Selected takes the teal face, unselected the nickel one, and
        // the material is what makes the pair read as one control.
        selected ? 'metal metal-brand' : 'metal metal-quiet !text-ink-mute',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}
