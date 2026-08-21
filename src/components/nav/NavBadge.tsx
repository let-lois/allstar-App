import { type ReactNode } from 'react'

/**
 * The pill behind a nav icon.
 *
 * This replaced a glossy embossed badge with a per-destination gradient, a glass
 * reflection and a drop shadow. Five of those across the bottom of every screen
 * was the loudest surface in the product, and the clearest sign the interface had
 * been styled rather than designed: a navigation bar is somewhere a thumb goes,
 * not the centrepiece.
 *
 * What is left is two states. Inactive is nothing — the icon sits on the white
 * bar in mid grey. Selected gets a soft teal pill and a teal icon, which is
 * 4.34:1 against that pill, so shape and colour each carry the state on their
 * own and neither depends on the other being noticed.
 *
 * The accent table went with the gradients. Colour distinguished nothing (the
 * five steps sat 1.3-1.9:1 apart) while costing a file of measured values, so
 * the icon and its label do that job now, as they always actually did.
 */
export function NavBadge({
  active,
  children,
  count,
  size,
}: {
  /** Kept in the signature — the side rail passes a route for its own reasons. */
  to?: string
  active: boolean
  children: ReactNode
  /** Real, actionable count only. Rendered as "9+" past nine. */
  count?: number
  /** The rail is denser than the bar; the bar leaves this alone. */
  size?: number
}) {
  return (
    <span
      data-active={active ? 'true' : 'false'}
      style={size ? { width: size, height: size - 6 } : undefined}
      className="nav-pill relative shrink-0"
    >
      {children}
      {count != null && count > 0 && (
        // aria-hidden: the count is already stated in the link's accessible name,
        // so announcing it here would read it twice.
        <span aria-hidden className="badge-pip">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </span>
  )
}
