import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Avatar } from './Avatar'
import { TeamBadge, type TeamBadgeProps } from '../badge/TeamBadge'
import { badgePhotoFromCrop, type CropSource } from '../../lib/media'
import {
  BADGE_PHOTO_H,
  BADGE_PHOTO_RADIUS,
  BADGE_PHOTO_W,
  MAX_ZOOM,
  clampCrop,
  cropRect,
  fitFrame,
  rescaleCrop,
  zoomAround,
  type CropState,
  type Size,
} from '../../lib/photo-crop'

/**
 * Frame the badge photo by hand: drag, pinch or slide to zoom, see it on the
 * badge, then save.
 *
 * Two steps, because "is my face in the box" and "does this look right on my
 * badge" are different questions and the second can only be answered by the
 * badge. The preview is the real `TeamBadge`, not a picture of one.
 *
 * Nothing is written until Save. Cancel, the close button, Escape and a new
 * photo chosen halfway all leave the current photo exactly as it was.
 */
export function PhotoCropper({
  source,
  badge,
  onCancel,
  onReplace,
  onSave,
}: {
  source: CropSource
  /** The badge as it is now, so the preview shows this person's card. */
  badge: Omit<TeamBadgeProps, 'avatarUrl'>
  onCancel: () => void
  /** Pick a different photo; the cropper stays open for it. */
  onReplace: () => void
  onSave: (dataUrl: string) => Promise<void>
}) {
  const img: Size = { w: source.w, h: source.h }
  const stageRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<Size>({ w: 0, h: 0 })
  const [crop, setCrop] = useState<CropState>({ zoom: 1, x: 0, y: 0 })
  // The crop a gesture starts from, read without waiting for a render.
  const cropRef = useRef(crop)
  cropRef.current = crop
  const [step, setStep] = useState<'adjust' | 'preview'>('adjust')
  const [result, setResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A new photo starts centred and unzoomed.
  useEffect(() => {
    setCrop({ zoom: 1, x: 0, y: 0 })
    setStep('adjust')
    setResult(null)
    setError(null)
  }, [source])

  /* The frame is as large as the stage allows, at the badge's 4:5. */
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const next = fitFrame({ w: r.width - 32, h: r.height - 32 })
      setFrame((prev) => {
        if (prev.w === next.w && prev.h === next.h) return prev
        setCrop((c) => rescaleCrop(c, prev, next, img))
        return next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, source])

  /* --- gestures: one finger pans, two pinch, a wheel zooms ---------------- */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ crop: CropState; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null)

  const fromCentre = useCallback((clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) }
  }, [])

  const begin = () => {
    const pts = [...pointers.current.values()]
    if (pts.length === 0) {
      gesture.current = null
      return
    }
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0]
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    gesture.current = { crop: cropRef.current, dist, mid, at: fromCentre(mid.x, mid.y) }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (step !== 'adjust') return
    try {
      // Keeps a drag that leaves the stage. Not every pointer can be captured
      // (one already released, or one a script made), and none needs to be.
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* the gesture still works without capture */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    begin()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const pts = [...pointers.current.values()]
    if (pts.length > 1 && g.dist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      const zoomed = zoomAround(g.crop, g.crop.zoom * (dist / g.dist), g.at, img, frame)
      setCrop(clampCrop({ ...zoomed, x: zoomed.x + (mid.x - g.mid.x), y: zoomed.y + (mid.y - g.mid.y) }, img, frame))
    } else {
      setCrop(clampCrop({ ...g.crop, x: g.crop.x + (pts[0].x - g.mid.x), y: g.crop.y + (pts[0].y - g.mid.y) }, img, frame))
    }
  }
  const onPointerEnd = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    begin()
  }

  useEffect(() => {
    const el = stageRef.current
    if (!el || step !== 'adjust') return
    // Not React's onWheel: that listener is passive, and the page would scroll too.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const at = fromCentre(e.clientX, e.clientY)
      setCrop((c) => zoomAround(c, c.zoom * Math.exp(-e.deltaY * 0.0015), at, img, frame))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, step, source])

  /* Escape is Cancel; arrows nudge, for a keyboard or a switch control. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (step !== 'adjust' || (e.target as HTMLElement)?.tagName === 'INPUT') return
      const d = e.shiftKey ? 24 : 6
      const move = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key]
      if (move) {
        e.preventDefault()
        setCrop((c) => clampCrop({ ...c, x: c.x + move[0], y: c.y + move[1] }, img, frame))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, step, onCancel])

  const setZoom = (z: number) => setCrop((c) => zoomAround(c, z, { x: 0, y: 0 }, img, frame))

  function preview() {
    if (!frame.w) return
    try {
      const out = badgePhotoFromCrop(source.canvas, cropRect(crop, img, frame), { w: BADGE_PHOTO_W, h: BADGE_PHOTO_H })
      setResult(out.dataUrl)
      setError(null)
      setStep('preview')
    } catch {
      setError('That photo could not be framed. Try another one.')
    }
  }

  async function save() {
    if (!result || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(result)
    } catch {
      setError('The photo could not be saved on this phone. Try again.')
      setSaving(false)
    }
  }

  const c = clampCrop(crop, img, frame)
  const scale = frame.w ? (Math.max(frame.w / img.w, frame.h / img.h) * c.zoom) : 0

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-surface-sunk text-ink"
      role="dialog"
      aria-modal="true"
      aria-labelledby="crop-title"
      data-testid="photo-cropper"
      data-step={step}
    >
      <div className="pad-top flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <h2 id="crop-title" className="text-[17px] font-semibold tracking-[-0.01em]">
          {step === 'adjust' ? 'Frame your badge photo' : 'Check your badge'}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="focusable inline-flex min-h-tap items-center rounded-field px-3 text-[15px] font-semibold text-accent"
          data-testid="crop-cancel"
        >
          Cancel
        </button>
      </div>

      {step === 'adjust' ? (
        <>
          {/*
            The stage. The photo moves; the frame does not. Outside the frame
            is dimmed rather than hidden, so the rep can see what they are
            leaving out. The circle is the part that shows in round avatars
            on the team list and the leaderboard.
          */}
          <div
            ref={stageRef}
            className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-black"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            data-testid="crop-stage"
            aria-label="Drag to move your photo. Pinch, scroll or use the slider to zoom."
          >
            {scale > 0 && (
              <img
                src={source.url}
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: img.w * scale,
                  height: img.h * scale,
                  transform: `translate(calc(-50% + ${c.x}px), calc(-50% + ${c.y}px))`,
                }}
                data-testid="crop-image"
              />
            )}
            {frame.w > 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{
                  width: frame.w,
                  height: frame.h,
                  borderRadius: frame.w * BADGE_PHOTO_RADIUS,
                  boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.62), inset 0 0 0 2px rgb(255 255 255 / 0.9)',
                }}
                data-testid="crop-frame"
              >
                <span
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/55"
                  style={{ width: frame.w, height: frame.w }}
                />
              </div>
            )}
          </div>

          <div className="shrink-0 space-y-3 border-t border-line-soft px-4 pt-3"
            style={{ paddingBottom: 'calc(16px + var(--safe-bottom))' }}>
            <p className="text-center text-[13px] text-ink-mute">
              Drag to move · pinch or slide to zoom · the dashed circle is your round photo
            </p>
            <div className="mx-auto flex max-w-md items-center gap-3">
              <button
                type="button"
                onClick={() => setZoom(c.zoom / 1.2)}
                disabled={c.zoom <= 1}
                className="metal metal-dark press focusable grid h-11 w-11 shrink-0 place-items-center rounded-field text-[20px] font-semibold disabled:opacity-50"
                aria-label="Zoom out"
              >
                −
              </button>
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={c.zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-11 min-w-0 flex-1 accent-[rgb(var(--accent))]"
                aria-label="Zoom"
                data-testid="crop-zoom"
              />
              <button
                type="button"
                onClick={() => setZoom(c.zoom * 1.2)}
                disabled={c.zoom >= MAX_ZOOM}
                className="metal metal-dark press focusable grid h-11 w-11 shrink-0 place-items-center rounded-field text-[20px] font-semibold disabled:opacity-50"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
            {error && (
              <p role="alert" className="text-center text-[13.5px] font-medium text-bad">
                {error}
              </p>
            )}
            <div className="mx-auto flex max-w-md gap-3">
              <Button variant="secondary" className="flex-1" onClick={onReplace} data-testid="crop-replace">
                Choose another
              </Button>
              <Button className="flex-1" onClick={preview} disabled={!frame.w} data-testid="crop-preview">
                Preview
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="mx-auto max-w-[320px]">
              <TeamBadge {...badge} avatarUrl={result ?? undefined} />
              <div className="mt-4 flex items-center justify-center gap-3 text-[13px] text-ink-mute">
                <Avatar initials={badge.avatarInitials} name={badge.name} src={result ?? undefined} size="lg" />
                <span>How you appear on the team list</span>
              </div>
            </div>
          </div>
          <div className="shrink-0 space-y-3 border-t border-line-soft px-4 pt-3"
            style={{ paddingBottom: 'calc(16px + var(--safe-bottom))' }}>
            {error && (
              <p role="alert" className="text-center text-[13.5px] font-medium text-bad">
                {error}
              </p>
            )}
            <div className="mx-auto flex max-w-md gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep('adjust')} disabled={saving} data-testid="crop-back">
                Adjust
              </Button>
              <Button className="flex-1" onClick={() => void save()} disabled={saving} data-testid="crop-save">
                {saving ? 'Saving…' : 'Save to badge'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
