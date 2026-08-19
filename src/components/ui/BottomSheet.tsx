import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Fraction of viewport height per detent, smallest first. */
  detents?: number[]
  initialDetent?: number
  title?: string
  /** Suppress the scrim for map sheets, where the rep still needs to pan. */
  scrim?: boolean
}

/**
 * Drag-to-resize bottom sheet — the primary surface for anything that appears
 * *over* the map or a list. Detents let the same sheet be a peek card and a
 * full detail view without a navigation push, which is what keeps
 * map → property → action at two taps.
 */
export function BottomSheet({
  open,
  onClose,
  children,
  detents = [0.42, 0.9],
  initialDetent = 0,
  title,
  scrim = true,
}: Props) {
  const [detent, setDetent] = useState(initialDetent)
  const [dragY, setDragY] = useState(0)
  const startY = useRef(0)
  const dragging = useRef(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setDetent(initialDetent)
  }, [open, initialDetent])

  // Hardware back / Esc should dismiss the sheet, not leave the screen.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const heightPct = detents[Math.min(detent, detents.length - 1)] * 100

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true
    startY.current = e.clientY
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const dy = e.clientY - startY.current
    // Resist upward drag past the tallest detent instead of hard-stopping.
    setDragY(dy < 0 && detent >= detents.length - 1 ? dy / 3 : dy)
  }

  const onPointerUp = () => {
    if (!dragging.current) return
    dragging.current = false
    const dy = dragY
    setDragY(0)
    const THRESHOLD = 56
    if (dy > THRESHOLD) {
      // Dragging down steps through detents, then dismisses at the smallest.
      if (detent === 0) onClose()
      else setDetent((d) => Math.max(0, d - 1))
    } else if (dy < -THRESHOLD) {
      setDetent((d) => Math.min(detents.length - 1, d + 1))
    }
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      {scrim && (
        <button
          aria-label="Close"
          onClick={onClose}
          className="anim-fade absolute inset-0 bg-ink/35"
        />
      )}
      <div
        ref={sheetRef}
        className="anim-sheet absolute inset-x-0 bottom-0 flex flex-col rounded-t-sheet bg-surface shadow-sheet"
        style={{
          height: `${heightPct}%`,
          transform: dragY ? `translateY(${Math.max(dragY, -40)}px)` : undefined,
          transition: dragging.current ? 'none' : 'height 180ms ease, transform 180ms ease',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Grab area is deliberately tall — a 4px handle is not a touch target. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="flex shrink-0 cursor-grab touch-none flex-col items-center pb-1 pt-3 active:cursor-grabbing"
        >
          <div className="h-1.5 w-10 rounded-full bg-ink/15" />
          {title && (
            <h2 className="mt-2 px-4 text-center text-base font-semibold">{title}</h2>
          )}
        </div>
        <div className="scroll-pane px-4 pb-4">{children}</div>
      </div>
    </div>
  )
}
