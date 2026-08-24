import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TOUR_STEPS, type TourStep } from '../../data/tour'
import { haptic } from '../../lib/haptics'

/**
 * The first-run tour: a spotlight on a real control, and a card explaining it.
 *
 * Pointing at the actual interface rather than at screenshots of it, because a
 * tutorial made of pictures teaches someone what the app *looked like* when the
 * pictures were taken. These holes are cut around live elements, measured at the
 * moment they are shown, so the tour cannot drift out of date without the
 * element it points at disappearing — which is a failure the component handles
 * by skipping the step rather than by spotlighting empty space.
 *
 * The overlay swallows taps. A tour where the underlying buttons still work
 * sounds friendlier and is not: the first thing anyone does is press the
 * highlighted control, the screen changes underneath, and the tour is left
 * pointing at whatever now occupies those coordinates.
 */

const PAD = 8
const CARD_GAP = 14

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function rectOf(target: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function Tour({ onClose }: { onClose: (completed: boolean) => void }) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  /*
    Only the steps whose targets are actually on screen.
    
    The next-stop card is absent on a day with no route, and the sync chip is
    absent before the first sync. Rather than show a card pointing at nothing,
    the step is dropped and the counter renumbers — "2 of 5" is honest, "2 of 6"
    with one panel spotlighting the void is not.
  */
  const [steps, setSteps] = useState<TourStep[]>([])
  useLayoutEffect(() => {
    setSteps(TOUR_STEPS.filter((s) => rectOf(s.target) !== null))
  }, [])

  const step = steps[index]

  const measure = useCallback(() => {
    if (!step) return
    setRect(rectOf(step.target))
  }, [step])

  useLayoutEffect(() => {
    if (!step) return
    // Bring the target into view before measuring, or the spotlight lands on a
    // rect that is half off the bottom of a phone.
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    measure()
    const t = window.setTimeout(measure, 320)
    return () => window.clearTimeout(t)
  }, [step, measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure])

  const last = index >= steps.length - 1
  const next = useCallback(() => {
    haptic('tap')
    if (last) onClose(true)
    else setIndex((i) => i + 1)
  }, [last, onClose])
  const back = useCallback(() => {
    haptic('tap')
    setIndex((i) => Math.max(0, i - 1))
  }, [])

  /* Keys, because the console runs this on a desktop with a keyboard. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false)
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, onClose])

  // Move focus to the card on every step so a screen reader reads the new copy.
  useEffect(() => {
    cardRef.current?.focus()
  }, [index])

  if (!step || steps.length === 0) return null

  /*
    Above or below the hole, whichever fits.
    
    `prefer` is a wish, not an instruction: the nav sits at the bottom of the
    screen, so a card "below" it would be off-screen entirely, and the last two
    steps would be invisible on exactly the phones this app is built for.
  */
  const vh = window.innerHeight
  const holeTop = rect ? rect.top - PAD : vh / 2
  const holeBottom = rect ? rect.top + rect.height + PAD : vh / 2
  const roomBelow = vh - holeBottom
  const below = rect ? (step.prefer === 'above' ? roomBelow > 260 : roomBelow > 200) : true

  return (
    <div
      /*
        This element is what swallows taps, and it does it by existing: a filled
        fixed box over the whole viewport receives every pointer event that would
        otherwise reach the app.

        There was a second, explicit blocker div in here for a while. It did
        nothing — the root already blocked — and it made the mechanism look like
        it lived somewhere it did not, which is worse than no comment. Do not add
        `pointer-events-none` here to "let the page scroll": the tap goes
        straight through to the nav, the screen changes underneath, and the tour
        is left spotlighting whatever now occupies those coordinates.
      */
      className="fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
      aria-label={`Tutorial, step ${index + 1} of ${steps.length}`}
    >
      {/*
        The dimmer is one element with an enormous spread shadow rather than four
        rectangles around the hole or an SVG mask. It follows the border radius,
        animates as one box, and there is no seam where two panels meet.
      */}
      {rect ? (
        <div
          className="tour-hole pointer-events-none absolute rounded-[18px]"
          style={{
            top: holeTop,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/70" />
      )}

      {/*
        Two elements, and the split is load-bearing.

        The outer one positions: `left-1/2` plus a -50% translate. The inner one
        animates. They cannot be the same element, because `anim-rise` animates
        `transform` with fill-mode `both` — so the keyframes' `translateY` wins
        over the centring `translateX` for good, and the card sits half off the
        right edge of the phone with its Next button unreachable. Which is
        exactly what the first version of this did.
      */}
      <div
        className="absolute left-1/2 w-[min(340px,calc(100vw-32px))] -translate-x-1/2"
        style={below ? { top: holeBottom + CARD_GAP } : { bottom: vh - holeTop + CARD_GAP }}
      >
        <div
          ref={cardRef}
          tabIndex={-1}
          data-tour-card
          className="anim-rise rounded-card border border-line bg-surface p-4 shadow-float focus:outline-none"
        >
        <p className="nums text-[12px] font-semibold text-accent">
          {index + 1} of {steps.length}
        </p>
        <h2 className="mt-1 text-[17px] font-semibold leading-snug tracking-[-0.01em]">
          {step.title}
        </h2>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">{step.body}</p>

        <div className="mt-4 flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onClose(false)}
            data-tour-skip
            className="focusable min-h-tap rounded-field px-1 text-[13.5px] font-semibold text-ink-mute"
          >
            Skip
          </button>
          <span className="flex-1" />
          {index > 0 && (
            <button
              type="button"
              onClick={back}
              data-tour-back
              className="metal metal-quiet press focusable min-h-tap rounded-field px-4 text-[14px] font-semibold"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={next}
            data-tour-next
            className="metal metal-brand press focusable min-h-tap rounded-field px-5 text-[14px] font-semibold"
          >
            {last ? 'Got it' : 'Next'}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}
