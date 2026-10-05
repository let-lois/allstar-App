import { toLocalInput } from '../../lib/day'

/**
 * A date-and-time field that is exactly as wide as its card.
 *
 * Reported from an iPhone, on the visit's "What's next here?" step: the
 * "Or pick a time" field ran past the right edge of its card and the whole
 * step slid sideways. WebKit draws a native `datetime-local` input at an
 * intrinsic width of its own, and neither `width: 100%` nor dropping its
 * appearance overrides that on iOS — the first fix tried exactly that and the
 * phone still showed it.
 *
 * So the native input is not what is drawn. What is drawn is an ordinary
 * full-width box with the chosen time in it; the real input lies over it,
 * transparent and absolutely positioned at the box's size, so a tap still
 * lands on it and opens the iPhone's own picker. An absolutely positioned
 * element inside a box that clips cannot widen anything around it, whatever
 * width the browser would have given it.
 */
export function DateTimeField({
  label,
  value,
  onChange,
  placeholder = 'Choose a date and time',
  testId,
}: {
  label: string
  /** Epoch ms, or undefined for nothing chosen yet. */
  value: number | undefined
  onChange: (at: number | undefined) => void
  placeholder?: string
  testId?: string
}) {
  const shown = value
    ? new Date(value).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''
  return (
    <label className="block min-w-0">
      <span className="eyebrow">{label}</span>
      <span className="relative mt-1.5 block h-[52px] w-full min-w-0 overflow-hidden rounded-field">
        <input
          type="datetime-local"
          value={value ? toLocalInput(value) : ''}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : undefined)}
          aria-label={label}
          className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          data-testid={testId}
        />
        <span
          aria-hidden
          className={`field pointer-events-none flex h-full items-center truncate peer-focus-visible:border-brand-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/30 ${
            shown ? '' : 'text-ink-faint'
          }`}
        >
          {shown || placeholder}
        </span>
      </span>
    </label>
  )
}
