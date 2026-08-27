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
 * A group of rows presented as one surface, with no card around it.
 *
 * Cards are used *selectively* here. A list of people or settings inside a
 * rounded, shadowed rectangle is a widget; the same list as a plain white band
 * with dividers is a phone screen. Full-bleed to the screen edges on a phone,
 * and it takes the card's radius back once there is room for margins beside it.
 */
export function Plate({
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article' | 'ul'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag {...rest} className={`panel ${className}`}>
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
 *
 * `standalone` is for a header that sits on the page ground above a group rather
 * than inside a card with it. That arrangement is what turns a stack of widgets
 * into sections of one screen, so it gets slightly more weight and a little air
 * above it.
 */
export function SectionHeader({
  title,
  count,
  action,
  onAction,
  standalone,
  right,
  className = '',
}: {
  title: string
  count?: number
  action?: string
  onAction?: () => void
  standalone?: boolean
  /** A plain node opposite the title — a date, a total. Not a control; use
   *  `action` for anything tappable so it keeps the focus ring and hit size. */
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className}`}>
      <h2
        className={`flex items-baseline gap-2 font-semibold text-ink ${
          standalone ? 'text-[17px] tracking-[-0.01em]' : 'text-[15px]'
        }`}
      >
        {title}
        {count !== undefined && (
          <span className="nums text-[13px] font-medium text-ink-mute">{count}</span>
        )}
      </h2>
      {right}
      {action && (
        <button
          onClick={onAction}
          className="focusable -mr-1 min-h-[32px] rounded-lg px-1.5 text-[13px] font-semibold text-accent"
        >
          {action}
        </button>
      )}
    </div>
  )
}
