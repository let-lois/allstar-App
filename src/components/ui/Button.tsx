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
 * That is a measured decision rather than a taste one: white text on the logo
 * teal #07B3CA is 2.53:1, which fails at every text size. #0A6B7D is 6.15:1 and
 * still reads unmistakably teal. The bright shade is used for fills — bars,
 * dots, active indicators — where nothing has to be legible on top of it.
 */
/*
 * The filled variants carry the embossed treatment; the quiet ones deliberately
 * do not. Their gradients live here as custom properties so `.btn-3d` in
 * index.css stays colour-agnostic — the same arrangement the nav badges use.
 *
 * White text is legible on all three: these gradients stay dark enough that the
 * gloss overlay cannot lift the top stop into the range where it fails, which is
 * exactly what ruled white glyphs out for the light nav badges.
 */
const FILL: Record<string, string> = {
  // #0E8FA6 would be the brighter, more obviously glossy top — and it measures
  // 4.38:1 for the white label once the gloss overlay lifts it, just under AA.
  // #0A8296 is the lightest stop that clears 4.5:1 (5.14:1).
  primary: '[--btn-top:#0A8296] [--btn-bottom:#064E5D]',
  danger: '[--btn-top:#DC2626] [--btn-bottom:#991B1B]',
  success: '[--btn-top:#1D7A44] [--btn-bottom:#14532D]',
}

const variants: Record<Variant, string> = {
  primary: `btn-3d text-white ${FILL.primary}`,
  secondary: 'bg-surface text-ink ring-1 ring-ink/10 active:bg-surface-field',
  ghost: 'bg-transparent text-ink-mute active:bg-ink/[0.05]',
  danger: `btn-3d text-white ${FILL.danger}`,
  success: `btn-3d text-white ${FILL.success}`,
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
