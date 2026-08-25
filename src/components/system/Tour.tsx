import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { stepsFor, type TourStep } from '../../data/tour'
import { haptic } from '../../lib/haptics'
import { useAppStore } from '../../store/useAppStore'

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
/** Breathing room the card keeps from the edges of the screen. */
const MARGIN = 12

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
  const nav = useNavigate()
  const location = useLocation()
  const role = useAppStore((s) => s.user?.role)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  /*
    The list is chosen by job, not filtered by what happens to be rendered.

    An earlier version filtered the whole list at mount against the DOM, which
    on a multi-screen tour means measuring nineteen elements that are not on
    this route yet and concluding the tour is four steps long. That is exactly
    what it did. Steps that turn out to have no anchor are skipped when reached,
    below, where the answer is knowable.
  */
  const steps = role ? stepsFor(role) : []
  const step: TourStep | undefined = steps[index]

  const measure = useCallback(() => {
    if (!step) return
    setRect(rectOf(step.target))
  }, [step])

  /* Navigate first. The anchor cannot exist until its screen does. */
  useEffect(() => {
    if (!step?.route) return
    if (location.pathname !== step.route) nav(step.route)
  }, [step, location.pathname, nav])

  /*
    Then wait for the anchor rather than assuming it.

    A route change swaps the whole pane, lazy chunks land when they land, and a
    list renders after its data. Polling until the element exists — with a
    ceiling, after which the step is skipped — is what keeps the spotlight off
    empty space without pretending to know how long any of that takes.
  */
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!step) return
    /* The console is the code-split part of the app; everything else is in the
       main bundle and already present. */
    const lazyRoute = step.route?.startsWith('/admin') ?? false
    setMissing(false)
    let alive = true
    let tries = 0
    const tick = () => {
      if (!alive) return
      /*
        Measured, not merely found.

        An anchor can exist and still have nothing to spotlight: the offline-maps
        wrapper renders whether or not tile imagery is configured, and when it is
        not, the component inside returns null and the wrapper collapses to zero
        height. Polling for existence alone found that element, stopped waiting,
        and left the tour parked on a step it could never draw — on the last
        step, which meant it never finished at all.
      */
      const el = rectOf(step.target)
        ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
        : null
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        measure()
        window.setTimeout(() => alive && measure(), 320)
        return
      }
      /*
        How long to wait before giving up on an anchor, and it is two numbers
        because the two cases are not alike.

        A step on a screen that is already mounted either has its anchor or
        never will, so waiting is just a stall — 1.2s.

        A step on a *lazily loaded* screen is a different question entirely. The
        console is code-split, so reaching it means fetching a chunk over
        whatever connection the person has; on a phone on cellular that is
        routinely over a second before React even begins to render. The old
        single ceiling of 1.2s was measured against a local dev server, which is
        the one network no user is on, and the console steps were being skipped
        in the field for no reason other than a slow download.
      */
      if (++tries > (lazyRoute ? 60 : 12)) {
        setMissing(true)
        return
      }
      window.setTimeout(tick, 100)
    }
    tick()
    return () => {
      alive = false
    }
  }, [step, measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure])

  /*
    A step whose anchor never turned up is stepped over, in whichever direction
    the person was already going. Reps with no route have no next stop; a
    super-admin has console screens a manager does not. Rather than predict all
    of that, the tour walks past what is not there.
  */
  // Held in a ref so the skip-forward effect does not re-run every time a
  // parent re-renders and hands down a new closure.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const dir = useRef(1)
  useEffect(() => {
    if (!missing) return
    /*
      Computed here rather than inside a `setIndex` updater.

      The first version closed the tour from within the updater, which is a side
      effect in a function React is free to call more than once and, in practice,
      simply did not run: when the *last* step had no anchor — offline maps, on a
      build with no tile imagery — the tour sat on it forever instead of
      finishing. An updater returns a value; it does not do things.
    */
    const n = index + dir.current
    if (n < 0) setIndex(0)
    else if (n >= steps.length) onCloseRef.current(true)
    else setIndex(n)
  }, [missing, index, steps.length])

  const last = index >= steps.length - 1
  const next = useCallback(() => {
    haptic('tap')
    dir.current = 1
    if (last) onClose(true)
    else setIndex((i) => i + 1)
  }, [last, onClose])
  const back = useCallback(() => {
    haptic('tap')
    dir.current = -1
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

  /*
    The card's own height, measured rather than assumed. Step bodies are two to
    four lines depending on the phone, and a guessed height is what turns a
    clamp into a card that is nearly on screen.
  */
  const [cardH, setCardH] = useState(200)
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const read = () => setCardH(el.getBoundingClientRect().height)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [index, step])

  if (!step || steps.length === 0) return null

  /*
    Above or below the hole, and then clamped into the viewport.

    `prefer` is a wish, not an instruction, and the clamp is not a nicety
    either. Some anchors are the whole screen — the map is a full-bleed canvas —
    and a full-screen hole has no above and no below: the card was placed 866px
    down an 844px phone, entirely off the bottom, and Next could not be reached.
    The tour stopped dead on step 9 of 22.

    So the position is a preference and the clamp is the rule. Measuring the
    card first is what makes the clamp possible, which is why it runs after
    layout rather than being computed from the step.
  */
  const vh = window.innerHeight
  const holeTop = rect ? rect.top - PAD : vh / 2
  const holeBottom = rect ? rect.top + rect.height + PAD : vh / 2
  const roomBelow = vh - holeBottom
  const preferBelow = rect
    ? step.prefer === 'above'
      ? roomBelow > cardH + CARD_GAP + MARGIN
      : roomBelow > cardH + CARD_GAP + MARGIN
    : true
  const wanted = preferBelow ? holeBottom + CARD_GAP : holeTop - CARD_GAP - cardH
  const top = Math.min(Math.max(MARGIN, wanted), Math.max(MARGIN, vh - cardH - MARGIN))

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
        style={{ top }}
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
