/**
 * Where the badge photo is cut from, as plain numbers.
 *
 * The badge shows the person in a 4:5 portrait (`TeamBadge`, `badge-image`),
 * so that is the shape a rep frames. The picker used to cut a centred square
 * and the badge then trimmed that square to 4:5 again — two crops nobody
 * chose, the second of which took the ears off.
 *
 * The model is the one every photo cropper uses, kept small enough to test:
 * the frame stays still, the photo moves under it. `zoom` 1 is the smallest
 * the photo may be and still fill the frame; `x` and `y` are how far the
 * photo's centre sits from the frame's centre, in frame pixels. The photo
 * may never leave a gap inside the frame, so every change is clamped.
 */

/** The badge's photo slot: 36.7 wide × 45.875 tall in card units. */
export const BADGE_PHOTO_ASPECT = 4 / 5
/** What is stored: 256 × 320, the old 256px edge at the badge's shape. */
export const BADGE_PHOTO_W = 256
export const BADGE_PHOTO_H = 320
/** Corner radius of the slot as a share of its width (2.6 / 36.7). */
export const BADGE_PHOTO_RADIUS = 2.6 / 36.7
export const MAX_ZOOM = 4

export interface Size {
  w: number
  h: number
}
export interface CropState {
  zoom: number
  x: number
  y: number
}

/** The scale, in frame px per photo px, at which the photo just fills the frame. */
export function coverScale(img: Size, frame: Size): number {
  return Math.max(frame.w / img.w, frame.h / img.h)
}

/** Keep the zoom in range and the photo covering the frame. */
export function clampCrop(s: CropState, img: Size, frame: Size): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(s.zoom) ? s.zoom : 1))
  const scale = coverScale(img, frame) * zoom
  const maxX = Math.max(0, (img.w * scale - frame.w) / 2)
  const maxY = Math.max(0, (img.h * scale - frame.h) / 2)
  const clip = (v: number, m: number) => (Number.isFinite(v) ? Math.min(m, Math.max(-m, v)) : 0)
  return { zoom, x: clip(s.x, maxX), y: clip(s.y, maxY) }
}

/**
 * Zoom to `zoom`, keeping the photo point under `at` (frame px from the
 * frame's centre) where it is — the point between two fingers, or the
 * middle for the slider.
 */
export function zoomAround(s: CropState, zoom: number, at: { x: number; y: number }, img: Size, frame: Size): CropState {
  const next = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const k = next / s.zoom
  return clampCrop({ zoom: next, x: at.x - (at.x - s.x) * k, y: at.y - (at.y - s.y) * k }, img, frame)
}

/** The rectangle of the photo, in photo px, that the frame shows. */
export function cropRect(s: CropState, img: Size, frame: Size): { sx: number; sy: number; sw: number; sh: number } {
  const c = clampCrop(s, img, frame)
  const scale = coverScale(img, frame) * c.zoom
  const sw = frame.w / scale
  const sh = frame.h / scale
  return { sx: img.w / 2 - c.x / scale - sw / 2, sy: img.h / 2 - c.y / scale - sh / 2, sw, sh }
}

/** The frame, as big as fits in `box` at the badge's shape. */
export function fitFrame(box: Size, aspect = BADGE_PHOTO_ASPECT): Size {
  const w = Math.min(box.w, box.h * aspect)
  return { w: Math.round(w), h: Math.round(w / aspect) }
}

/**
 * Keep the same framing when the frame changes size (a phone rotating):
 * offsets are frame pixels, so they scale with it.
 */
export function rescaleCrop(s: CropState, from: Size, to: Size, img: Size): CropState {
  if (!from.w) return clampCrop(s, img, to)
  const k = to.w / from.w
  return clampCrop({ zoom: s.zoom, x: s.x * k, y: s.y * k }, img, to)
}
