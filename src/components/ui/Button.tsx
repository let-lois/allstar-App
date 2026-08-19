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
 * The primary button is `brand-600`, not the brighter brand orange.
 *
 * That is a measured decision rather than a taste one: white text on #FF8A3D is
 * 2.35:1, which fails at every text size. #C2410C is 5.18:1 and still reads
 * unmistakably orange. The bright shade is used for fills — bars, dots, active
 * indicators — where nothing has to be legible on top of it.
 */
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white active:bg-brand-700 shadow-raise',
  secondary: 'bg-surface text-ink ring-1 ring-ink/10 active:bg-surface-field',
  ghost: 'bg-transparent text-ink-mute active:bg-ink/[0.05]',
  danger: 'bg-bad text-white active:brightness-90',
  success: 'bg-good text-white active:brightness-90',
  // For dark/saturated backgrounds (the visit-complete screen). This exists as a
  // variant rather than a `className` override because competing Tailwind
  // utilities resolve by stylesheet order, not by the order they're written —
  // overriding here produced a white button with white text.
  inverse: 'bg-white text-good active:bg-surface-field shadow-raise',
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
  sm: 'min-h-[44px] px-3.5 text-[13.5px] rounded-field gap-1.5',
  md: 'min-h-tap px-4 text-[15px] rounded-field gap-2',
  lg: 'min-h-[54px] px-5 text-[16.5px] rounded-[16px] gap-2.5 font-semibold',
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
