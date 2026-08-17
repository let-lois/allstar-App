import { useState, type ReactNode } from 'react'

interface Props {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
  right?: ReactNode
}

/**
 * Progressive disclosure for the lead profile. A property has ~40 fields; the
 * rep needs 6 of them on the porch. Everything else lives behind one of these.
 */
export function Collapsible({ title, count, defaultOpen = false, children, right }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focusable flex min-h-tap w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-slate-50"
      >
        <span className="flex items-center gap-2 font-semibold">
          {title}
          {count != null && (
            <span className="nums rounded-full bg-slate-100 px-2 py-0.5 text-xs text-ink-mute">
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
      {open && <div className="border-t border-slate-100 px-4 py-3">{children}</div>}
    </section>
  )
}
