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
 * How long after opening a scrim click is treated as the tail of the click that
 * opened the sheet rather than a dismissal. The entrance animation's own length
 * (`.anim-sheet`, 190ms) rounded up — before it finishes there is nothing on
 * screen for the person to have decided about.
 */
const GRACE_MS = 200

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

  /*
    When this sheet appeared, and whether the press that is closing it started
    on the scrim. Both exist to answer the same question — did the person mean
    to dismiss this? — and both were needed because of one bug.

    **The scrim opens underneath the pointer and eats the next click.** Whatever
    opened the sheet is a control the person just clicked, and the scrim now
    covers that exact spot. Double-click the console's "Manage", or click it
    twice because the panel took a moment, and the second click lands on a
    dismiss button that was not there when the first one did: the panel appears
    and vanishes, with the scrim's fade as a flash across the screen. Reported as
    "it pops up for a moment and then I can't see that panel" — nothing errors,
    nothing is logged, and the person is left clicking a button that appears to
    do nothing.

    So a scrim dismissal has to be a *deliberate* one, and there are two halves
    to that:

    A click within the entrance animation is not a decision about a sheet the
    person has not seen yet. The window is the animation's own length, which is
    the honest number: before it finishes, there is nothing on screen to have
    judged.

    And the press has to have *started* on the scrim. Drag a selection out of
    the sheet, or release a slider past its edge, and the click lands on the
    scrim having begun somewhere that meant the opposite.
  */
  const openedAt = useRef(0)
  const pressedScrim = useRef(false)

  useEffect(() => {
    if (open) {
      setDetent(initialDetent)
      openedAt.current = Date.now()
      pressedScrim.current = false
    }
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
    /*
      Two different components share this markup, and the difference is `scrim`.
      With a scrim it is a modal: it owns the screen until dismissed. Without one
      it is a peek that sits over a map the rep is still working with.

      That distinction has to be in the DOM, not just in the CSS. A full-viewport
      wrapper captures every pointer event whether or not it is painted, so the
      no-scrim variant was still swallowing pans, taps on the filter chips, and
      the map/list switch — invisibly, which is why it read as correct. And
      `aria-modal` claims the rest of the page is unavailable, which for the peek
      is a lie a screen reader acts on: it stops announcing everything behind it.

      So the peek turns off pointer capture on the wrapper and re-enables it on
      the panel, and drops `aria-modal` because it isn't one.
    */
    <div
      className={`fixed inset-0 z-40 ${scrim ? '' : 'pointer-events-none'}`}
      role="dialog"
      aria-modal={scrim ? true : undefined}
      aria-label={title}
    >
      {scrim && (
        <button
          aria-label="Close"
          onPointerDown={() => {
            pressedScrim.current = true
          }}
          onClick={(e) => {
            const startedHere = pressedScrim.current
            pressedScrim.current = false
            /*
              A keyboard activation reports no coordinates and never sends a
              pointerdown, so it is always deliberate — Tab to the close button
              and press Enter, and it closes whatever the timer says.
            */
            const byPointer = e.detail > 0
            if (byPointer && (!startedHere || Date.now() - openedAt.current < GRACE_MS)) return
            onClose()
          }}
          className="anim-fade absolute inset-0 bg-ink/35"
        />
      )}
      <div
        ref={sheetRef}
        className="anim-sheet pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col rounded-t-sheet bg-surface shadow-sheet"
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
