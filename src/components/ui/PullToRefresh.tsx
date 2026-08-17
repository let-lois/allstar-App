import { useRef, useState, type ReactNode } from 'react'
import { haptic } from '../../lib/haptics'

interface Props {
  onRefresh: () => Promise<void> | void
  children: ReactNode
  className?: string
}

const TRIGGER = 72

/**
 * Pull-to-refresh on the scrolling panes. Reps reach for this instinctively
 * after regaining signal, so it's wired to the sync drain rather than a reload.
 */
export function PullToRefresh({ onRefresh, children, className = '' }: Props) {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const startY = useRef<number | null>(null)
  const armed = useRef(false)
  const paneRef = useRef<HTMLDivElement>(null)

  const onTouchStart = (e: React.TouchEvent) => {
    // Only arm when already at the top, or we'd fight normal scrolling.
    if ((paneRef.current?.scrollTop ?? 0) <= 0) {
      startY.current = e.touches[0].clientY
      armed.current = false
    } else {
      startY.current = null
    }
  }

  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current == null || busy) return
    const dy = e.touches[0].clientY - startY.current
    if (dy <= 0) {
      setPull(0)
      return
    }
    // Rubber band: 200px of finger travel yields ~90px of pull.
    const eased = Math.min(110, dy * 0.45)
    setPull(eased)
    if (eased >= TRIGGER && !armed.current) {
      armed.current = true
      haptic('tap')
    }
  }

  const onTouchEnd = async () => {
    if (pull >= TRIGGER && !busy) {
      setBusy(true)
      setPull(TRIGGER)
      try {
        await onRefresh()
      } finally {
        setBusy(false)
        setPull(0)
      }
    } else {
      setPull(0)
    }
    startY.current = null
    armed.current = false
  }

  return (
    <div
      ref={paneRef}
      className={`scroll-pane ${className}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        className="flex items-center justify-center overflow-hidden text-xs font-medium text-ink-mute"
        style={{ height: pull, transition: startY.current ? 'none' : 'height 180ms ease' }}
      >
        {pull > 8 && (
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-brand-500 border-t-transparent ${
                busy ? 'animate-spin' : ''
              }`}
              style={{ transform: busy ? undefined : `rotate(${pull * 3}deg)` }}
            />
            {busy ? 'Syncing…' : pull >= TRIGGER ? 'Release to sync' : 'Pull to sync'}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
