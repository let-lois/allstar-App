import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { haptic } from '../../lib/haptics'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  full?: boolean
  icon?: ReactNode
  /** Buzz on press. Reserve for state changes the rep must be able to trust. */
  buzz?: boolean
}

const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white active:bg-brand-600 shadow-raise',
  secondary: 'bg-surface text-ink border border-slate-200 active:bg-slate-50',
  ghost: 'bg-transparent text-ink-mute active:bg-slate-100',
  danger: 'bg-red-600 text-white active:bg-red-700',
  success: 'bg-emerald-600 text-white active:bg-emerald-700',
}

// `lg` is the field default — thumb-sized, reachable, readable in sunlight.
const sizes: Record<Size, string> = {
  sm: 'min-h-[44px] px-3.5 text-sm rounded-xl gap-1.5',
  md: 'min-h-tap px-4 text-[15px] rounded-xl gap-2',
  lg: 'min-h-[56px] px-5 text-[17px] rounded-2xl gap-2.5 font-semibold',
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
        'press focusable inline-flex items-center justify-center font-medium',
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
