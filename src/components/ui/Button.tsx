import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { haptic } from '../../lib/haptics'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'inverse'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  full?: boolean
  icon?: ReactNode
  /** Buzz on press. Reserve for state changes the rep must be able to trust. */
  buzz?: boolean
}

/*
 * Every filled variant wears `.metal` — see the note on that rule in index.css
 * for why the teal face is light and its label near-black, and why red and green
 * keep white ones.
 *
 * `ghost` deliberately does not. It is the one variant whose job is to *not*
 * look like a button: a text control beside a heading, or a tertiary action in a
 * row. Giving it the material would mean a screen of equal-weight controls and
 * no obvious next step, which is the failure mode a tactile treatment invites.
 */
const variants: Record<Variant, string> = {
  primary: 'metal metal-brand',
  secondary: 'metal metal-quiet',
  ghost: 'bg-transparent text-ink-mute active:bg-ink/[0.04]',
  danger: 'metal metal-danger',
  success: 'metal metal-success',
  // For dark/saturated backgrounds (the visit-complete screen). This exists as a
  // variant rather than a `className` override because competing Tailwind
  // utilities resolve by stylesheet order, not by the order they're written —
  // overriding here produced a white button with white text.
  inverse: 'metal metal-quiet !text-good',
}

/*
 * `lg` is the field default — thumb-sized, reachable, readable in sunlight.
 *
 * Radii step with the size so a small control never looks like a shrunken big
 * one, but `lg` deliberately stops at 16px rather than following the card's
 * 20px: on a 54px-tall button that much radius is 37% of the height and reads as
 * a pill, and a screen of pills has no way left to signal shape hierarchy.
 */
const sizes: Record<Size, string> = {
  sm: 'min-h-[44px] px-4 text-[13.5px] rounded-field gap-1.5',
  md: 'min-h-tap px-4 text-[15px] rounded-field gap-2',
  lg: 'min-h-[52px] px-5 text-[16px] rounded-[16px] gap-2.5 font-semibold',
}

export function Button({
  variant = 'primary',
  size = 'md',
  full,
  icon,
  buzz,
  className = '',
  children,
  onClick,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        if (buzz) haptic('tap')
        onClick?.(e)
      }}
      className={[
        'press focusable inline-flex items-center justify-center font-semibold',
        'disabled:opacity-40 disabled:active:scale-100',
        variants[variant],
        sizes[size],
        full ? 'w-full' : '',
        className,
      ].join(' ')}
    >
      {icon}
      {children}
    </button>
  )
}
