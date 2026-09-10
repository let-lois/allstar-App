import { useRef, useState, type ReactNode } from 'react'
import { haptic } from '../../lib/haptics'

export interface SwipeAction {
  label: string
  /**
   * The icon shown as the row is dragged. A node rather than a string: these
   * were `📞` and `▶`, emoji and a dingbat rendered by the OS at whatever size
   * and in whatever house style, on the one control a rep uses forty times a
   * day without looking at it properly.
   */
  glyph: ReactNode
  color: string
  onAction: () => void
}

interface Props {
  children: ReactNode
  /** Revealed by swiping right (finger moves right). */
  left?: SwipeAction
  /** Revealed by swiping left. */
  right?: SwipeAction
  className?: string
  /**
   * A `data-tour` anchor for the walkthrough.
   *
   * Explicit rather than a props spread: TypeScript does not check hyphenated
   * JSX attributes on a component, so `data-tour` passed from outside compiles
   * cleanly and then goes nowhere — the anchor is simply absent, the tour skips
   * the step, and nothing anywhere says why.
   */
  'data-tour'?: string
}

const REVEAL = 84
const COMMIT = 132

/**
 * Swipe actions on list rows.
 *
 * These exist because the alternative is open-row → find-button → tap → back,
 * four interactions deep, for something a rep does forty times a day. Past the
 * commit threshold the row fires without needing an accurate release, so it
 * works one-handed while walking.
 */
export function SwipeRow({
  children,
  left,
  right,
  className = '',
  'data-tour': tour,
}: Props) {
  const [dx, setDx] = useState(0)
  const startX = useRef(0)
  const startY = useRef(0)
  const axis = useRef<'none' | 'x' | 'y'>('none')
  const committed = useRef(false)

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    axis.current = 'none'
    committed.current = false
  }

  const onTouchMove = (e: React.TouchEvent) => {
    const x = e.touches[0].clientX - startX.current
    const y = e.touches[0].clientY - startY.current

    // Lock the axis on first meaningful movement so vertical scrolling wins
    // ties — a swipe row that eats scroll is worse than no swipe row.
    if (axis.current === 'none') {
      if (Math.abs(x) < 8 && Math.abs(y) < 8) return
      axis.current = Math.abs(x) > Math.abs(y) * 1.4 ? 'x' : 'y'
    }
    if (axis.current !== 'x') return

    const allowed = (x > 0 && left) || (x < 0 && right)
    if (!allowed) return

    const clamped = Math.max(-COMMIT - 24, Math.min(COMMIT + 24, x))
    setDx(clamped)
    if (Math.abs(clamped) >= COMMIT && !committed.current) {
      committed.current = true
      haptic('tap')
    } else if (Math.abs(clamped) < COMMIT) {
      committed.current = false
    }
  }

  const onTouchEnd = () => {
    if (axis.current === 'x') {
      const action = dx > 0 ? left : right
      if (action && Math.abs(dx) >= COMMIT) {
        haptic('confirm')
        action.onAction()
      }
    }
    setDx(0)
    axis.current = 'none'
    committed.current = false
  }

  const revealed = dx > 0 ? left : dx < 0 ? right : undefined
  const progress = Math.min(1, Math.abs(dx) / COMMIT)

  return (
    <div className={`relative overflow-hidden ${className}`} data-tour={tour}>
      {revealed && (
        <div
          className="absolute inset-y-0 flex items-center px-5 text-white"
          style={{
            backgroundColor: revealed.color,
            left: dx > 0 ? 0 : undefined,
            right: dx < 0 ? 0 : undefined,
            width: Math.abs(dx) + 8,
            justifyContent: dx > 0 ? 'flex-start' : 'flex-end',
          }}
        >
          <span
            className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold"
            style={{ opacity: progress, transform: `scale(${0.85 + progress * 0.15})` }}
          >
            <span aria-hidden>{revealed.glyph}</span>
            {Math.abs(dx) > REVEAL && revealed.label}
          </span>
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 190ms cubic-bezier(0.2,0.8,0.3,1)' : 'none',
        }}
        className="relative bg-surface"
      >
        {children}
      </div>
    </div>
  )
}
