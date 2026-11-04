import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FREEHAND_SAMPLE_PX,
  OUTLINE_MESSAGES,
  buildOutline,
  prepareTrace,
  type OutlineResult,
} from '@allstar/core/freehand'
import { DRAW_FILL, DRAW_FILL_OPACITY, DRAW_STROKE, DRAW_STROKE_WIDTH } from './map-contract'

/**
 * A surface that turns one finger dragged across the map into a territory outline.
 *
 * Sits over the map, under its zoom buttons (the renderers' `surface` slot), and
 * takes every touch that lands on it. That is the whole mechanism for the three
 * things a freehand gesture needs:
 *
 *   **The map does not move.** A drag on the map is a pan. Here the drag never
 *   reaches the map at all, so the view the person framed is the view the outline
 *   is drawn in — nothing has to be disabled on either renderer, and nothing has
 *   to be restored afterwards: unmount this and the map is exactly as it was.
 *
 *   **No pin is selected by accident.** The same: the touch never reaches a marker.
 *
 *   **The line is real time and cheap.** What is drawn while the finger moves is
 *   one SVG path in this layer's own pixels, rebuilt at most once a frame. No
 *   projection runs per sample and no map overlay is rebuilt, which is what keeps it
 *   responsive on a phone that struggles to pan the map itself. Coordinates are
 *   worked out once, for the simplified corners, when the finger lifts.
 *
 * ## Gestures it refuses
 *
 * A second finger abandons the stroke: two fingers are a pinch, which this layer
 * does not do, and a half-pinch must not become a half-outline. Nothing more is
 * recorded until every finger is up. A stroke the system cancels (a call, an edge
 * swipe) is dropped. A trace too short to be an outline, and an outline that cannot
 * be a territory, come back through `onOutline` as a failed result carrying the
 * words to show — this component says nothing itself except the instruction.
 */

export const FREEHAND_HINT = 'Drag your finger to outline a territory.'

/** Samples kept per stroke. A very long stroke is thinned further rather than growing without end. */
const MAX_RAW_POINTS = 2500

interface Sample {
  /** Within this layer, for drawing. */
  x: number
  y: number
  /** Within the page, for asking the map what is there. */
  cx: number
  cy: number
}

function pathOf(points: readonly Sample[], close: boolean): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + (close ? ' Z' : '')
}

export function FreehandLayer({
  toLatLng,
  onOutline,
  onStart,
  className = '',
}: {
  /** The map's own answer for a point on the page — `MapHandle.toLatLng`. */
  toLatLng: (clientX: number, clientY: number) => { lat: number; lng: number } | null
  /** Called when the finger lifts, with an outline ready to use or the reason there is none. */
  onOutline: (result: OutlineResult) => void
  onStart?: () => void
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trace = useRef<Sample[]>([])
  const activeId = useRef<number | null>(null)
  const down = useRef(new Set<number>())
  const blocked = useRef(false)
  const frame = useRef(0)
  const [shape, setShape] = useState<{ line: string; fill: string; closing: string } | null>(null)

  // Always the latest, so a stroke started under one render finishes under the next.
  const cb = useRef({ toLatLng, onOutline, onStart })
  cb.current = { toLatLng, onOutline, onStart }

  const clear = useCallback(() => {
    trace.current = []
    activeId.current = null
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
    setShape(null)
  }, [])

  // A layer unmounted mid-stroke must not leave a frame callback behind.
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const paint = useCallback(() => {
    frame.current = 0
    const pts = trace.current
    if (pts.length < 2) {
      setShape(null)
      return
    }
    const last = pts[pts.length - 1]
    const first = pts[0]
    setShape({
      line: pathOf(pts, false),
      fill: pathOf(pts, true),
      closing: `M${last.x.toFixed(1)} ${last.y.toFixed(1)} L${first.x.toFixed(1)} ${first.y.toFixed(1)}`,
    })
  }, [])

  const sample = (clientX: number, clientY: number): Sample | null => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return null
    return { x: clientX - box.left, y: clientY - box.top, cx: clientX, cy: clientY }
  }

  const finish = () => {
    const raw = trace.current
    clear()
    const prepared = prepareTrace(raw)
    if (!prepared.ok) {
      cb.current.onOutline(prepared)
      return
    }
    const coords = []
    for (const p of prepared.points) {
      const at = cb.current.toLatLng(p.cx, p.cy)
      if (!at) {
        // The map could not place a corner (not laid out yet, or rotated): say so
        // rather than inventing coordinates.
        cb.current.onOutline({ ok: false, reason: 'invalid', message: OUTLINE_MESSAGES.invalid })
        return
      }
      coords.push(at)
    }
    cb.current.onOutline(buildOutline(coords))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    down.current.add(e.pointerId)
    // A second finger is a pinch, not a second outline: drop what there is and
    // ignore the gesture until every finger has lifted.
    if (down.current.size > 1) {
      blocked.current = true
      clear()
      return
    }
    if (blocked.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const first = sample(e.clientX, e.clientY)
    if (!first) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    activeId.current = e.pointerId
    trace.current = [first]
    cb.current.onStart?.()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerId !== activeId.current || blocked.current) return
    // Coalesced events carry the samples the browser batched between frames, so a
    // fast stroke is a curve and not a polygon with long straight sides.
    const batch = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? []
    const events = batch.length ? batch : [e.nativeEvent as PointerEvent]
    for (const ev of events) {
      const at = sample(ev.clientX, ev.clientY)
      const last = trace.current[trace.current.length - 1]
      if (!at || !last) continue
      if (Math.hypot(at.x - last.x, at.y - last.y) < FREEHAND_SAMPLE_PX) continue
      if (trace.current.length >= MAX_RAW_POINTS) {
        // Keep the line going without growing: the newest sample replaces the last.
        trace.current[trace.current.length - 1] = at
      } else {
        trace.current.push(at)
      }
    }
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }

  const release = (e: React.PointerEvent, completed: boolean) => {
    down.current.delete(e.pointerId)
    if (down.current.size === 0) blocked.current = false
    if (e.pointerId !== activeId.current) return
    if (!completed || blocked.current) {
      clear()
      return
    }
    const end = sample(e.clientX, e.clientY)
    const last = trace.current[trace.current.length - 1]
    if (end && last && (end.x !== last.x || end.y !== last.y)) trace.current.push(end)
    finish()
  }

  return (
    <div
      ref={rootRef}
      data-testid="freehand-layer"
      role="group"
      aria-label={FREEHAND_HINT}
      className={`absolute inset-0 cursor-crosshair touch-none select-none ${className}`}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => release(e, true)}
      onPointerCancel={(e) => release(e, false)}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {shape && (
          <g data-testid="freehand-trace">
            <path d={shape.fill} fill={DRAW_FILL} fillOpacity={DRAW_FILL_OPACITY} stroke="none" />
            <path
              d={shape.closing}
              fill="none"
              stroke={DRAW_STROKE}
              strokeWidth={DRAW_STROKE_WIDTH}
              strokeDasharray="6 5"
              strokeLinecap="round"
              opacity={0.7}
            />
            <path
              d={shape.line}
              fill="none"
              stroke={DRAW_STROKE}
              strokeWidth={DRAW_STROKE_WIDTH + 0.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        )}
      </svg>
      {!shape && (
        <p
          className="pointer-events-none absolute left-1/2 top-3 max-w-[calc(100%-24px)] -translate-x-1/2 rounded-pill bg-surface px-3.5 py-1.5 text-center text-[13px] font-semibold text-ink shadow-nav ring-1 ring-line"
          data-testid="freehand-hint"
        >
          {FREEHAND_HINT}
        </p>
      )}
    </div>
  )
}
