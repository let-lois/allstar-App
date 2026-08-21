import { useState, type ReactNode } from 'react'

interface Props {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
  right?: ReactNode
  /**
   * Drop the card so several of these read as one grouped list.
   *
   * Five collapsed sections, each in its own rounded shadowed rectangle, is five
   * widgets stacked down a phone screen — and on the lead profile that is most
   * of what is below the fold. Grouped, they read as one table of contents for
   * the property, which is what they are.
   */
  flat?: boolean
}

/**
 * Progressive disclosure for the lead profile. A property has ~40 fields; the
 * rep needs 6 of them on the porch. Everything else lives behind one of these.
 */
export function Collapsible({
  title,
  count,
  defaultOpen = false,
  children,
  right,
  flat,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={flat ? '' : 'card overflow-hidden'}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        /* The header is the control; the body it opens stays flat. */
        className="metal-row focusable flex min-h-tap w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-[15px] font-medium">
          {title}
          {count != null && (
            <span className="nums rounded-full bg-surface-field px-2 py-0.5 text-xs text-ink-mute">
              {count}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {right}
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            className={`shrink-0 text-ink-mute transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && <div className="border-t border-line-soft px-4 py-3.5">{children}</div>}
    </section>
  )
}
