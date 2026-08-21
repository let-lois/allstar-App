import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

/**
 * A labelled field.
 *
 * Exists mainly so the label, the hint and the error are always in the same
 * place and always styled the same way. Every screen writing its own `<label>`
 * is how a form ends up with four different label sizes and a couple of fields
 * with no label at all.
 *
 * 16px text is not a style choice — below that, iOS Safari zooms the page on
 * focus and the rep has to pinch back out to reach the next field.
 */
interface Common {
  label?: string
  hint?: ReactNode
  error?: string | null
  /** Sits inside the field on the right — a unit, a reveal toggle, a clear button. */
  trailing?: ReactNode
  className?: string
}

export function Field({
  label,
  hint,
  error,
  trailing,
  className = '',
  ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{label}</span>}
      <span className="relative block">
        <input
          {...rest}
          className={`field h-[52px] ${trailing ? 'pr-[76px]' : ''} ${
            error ? 'border-bad focus:border-bad' : ''
          }`}
        />
        {trailing && (
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2">{trailing}</span>
        )}
      </span>
      {error ? (
        <span role="alert" className="mt-1.5 block text-[13px] font-medium text-bad">
          {error}
        </span>
      ) : (
        hint && <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-mute">{hint}</span>
      )}
    </label>
  )
}

export function TextArea({
  label,
  hint,
  error,
  className = '',
  ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{label}</span>}
      <textarea {...rest} className={`field py-3 ${error ? 'border-bad focus:border-bad' : ''}`} />
      {error ? (
        <span role="alert" className="mt-1.5 block text-[13px] font-medium text-bad">
          {error}
        </span>
      ) : (
        hint && <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-mute">{hint}</span>
      )}
    </label>
  )
}
