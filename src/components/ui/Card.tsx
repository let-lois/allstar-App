import type { ReactNode } from 'react'

/**
 * The card, and the section header that sits above one.
 *
 * These exist so spacing and radius are decided once. Before, every screen
 * chose its own padding — which is how an interface ends up looking assembled
 * rather than designed, even when every individual screen is fine.
 */

export function Card({
  children,
  className = '',
  padded = true,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  /** Off when the card holds full-bleed rows or a map. */
  padded?: boolean
  as?: 'section' | 'div' | 'article'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag {...rest} className={`card ${padded ? 'p-4' : ''} ${className}`}>
      {children}
    </Tag>
  )
}

/**
 * Heading for a group, with an optional action on the right.
 *
 * The action is a link-weight control rather than a button: it sits beside a
 * heading, and a second solid button on every section is how a screen stops
 * having one obvious next step.
 */
export function SectionHeader({
  title,
  count,
  action,
  onAction,
  className = '',
}: {
  title: string
  count?: number
  action?: string
  onAction?: () => void
  className?: string
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className}`}>
      <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-ink">
        {title}
        {count !== undefined && (
          <span className="nums text-[13px] font-medium text-ink-mute">{count}</span>
        )}
      </h2>
      {action && (
        <button
          onClick={onAction}
          className="focusable -mr-1 min-h-[32px] rounded-lg px-1.5 text-[13px] font-semibold text-brand-600"
        >
          {action}
        </button>
      )}
    </div>
  )
}
