import { useCallback, useRef, useState, type ReactNode } from 'react'
import { accentVars } from './accents'

/**
 * The embossed badge that wraps a nav icon.
 *
 * Owns the tap bounce rather than leaving it to `:active`, for two reasons: an
 * animation bound to `:active` restarts unpredictably when a press turns into a
 * scroll, which on a nav bar at the bottom of a scrolling screen is most presses;
 * and the selected badge holds a persistent transform that `:active` would fight.
 *
 * Motion is neutralised globally by the reduced-motion rule in the base layer, so
 * this stays a class toggle rather than growing its own media query.
 */
export function NavBadge({
  to,
  active,
  children,
  count,
  size = 44,
}: {
  to: string
  active: boolean
  children: ReactNode
  /** Real, actionable count only. Rendered as "9+" past nine. */
  count?: number
  size?: number
}) {
  const [popping, setPopping] = useState(false)
  const timer = useRef<number | null>(null)

  const pop = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    setPopping(true)
    timer.current = window.setTimeout(() => setPopping(false), 220)
  }, [])

  return (
    <span
      onPointerDown={pop}
      data-active={active ? 'true' : 'false'}
      style={{ ...accentVars(to), width: size, height: size }}
      className={`badge-3d grid shrink-0 place-items-center ${popping ? 'anim-pop' : ''}`}
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
