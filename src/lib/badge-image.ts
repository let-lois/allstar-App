import { qrModules } from './qr'
import { saveFile } from './download'
import type { BadgeInfo } from '../types'

/**
 * The badge as a file: a CR80 card, drawn rather than screenshotted.
 *
 * A team member badge is a physical object first — the plastic card every
 * ID printer and every lanyard sleeve is sized for is CR80, 3.375 × 2.125
 * inches (85.6 × 54 mm), and a rep who downloads their badge is going to
 * have it printed on one, or hold the phone up in its place. So the export
 * is that card, portrait, at 300 dots per inch: 638 × 1013 pixels, corner
 * radius an eighth of an inch, and the same layout the screen shows.
 *
 * ## Why it is drawn and not captured
 *
 * The on-screen card is responsive: it fills whatever width the phone has,
 * and a capture of it is whatever size the phone was. Stretching that to
 * card proportions distorts the one thing on it that must not distort — the
 * QR code, which stops scanning the moment its cells are no longer square —
 * and puts a text-rendering of the photo where a rep's face should be.
 * Drawing it here, from the same facts the component draws from, means the
 * file has the card's proportions whatever the screen had, every circle is a
 * circle, and the code is laid down cell by cell on whole pixels.
 *
 * ## The code's size is the point
 *
 * Between three-quarters of an inch and one inch across, including the quiet
 * zone the standard requires. Smaller and a phone camera at arm's length
 * fails to lock on; larger and it crowds the dates it sits beside. The cell
 * size is chosen so the whole code lands in that range whatever version the
 * URL needed, and it is an integer so no cell is ever anti-aliased across a
 * pixel boundary — a grey edge is a cell the scanner has to guess about.
 */

export const CR80 = {
  /** Portrait, in inches. */
  widthIn: 2.125,
  heightIn: 3.375,
  dpi: 300,
  cornerIn: 0.125,
} as const

export const BADGE_PX = {
  width: Math.round(CR80.widthIn * CR80.dpi), // 638
  height: Math.round(CR80.heightIn * CR80.dpi), // 1013
} as const

/** Inches to pixels at the card's resolution. */
const px = (inches: number) => Math.round(inches * CR80.dpi)

/** The QR code, quiet zone included, must land in this band. */
export const QR_MIN_IN = 0.75
export const QR_MAX_IN = 1.0
const QR_QUIET_MODULES = 4

/**
 * How many pixels each cell gets so the code, with its quiet zone, is as
 * large as it can be under an inch. Exported so a gate can prove the band.
 */
export function qrCellPx(moduleCount: number): number {
  const cells = moduleCount + QR_QUIET_MODULES * 2
  return Math.max(1, Math.floor(px(QR_MAX_IN) / cells))
}

export interface BadgeImageSpec {
  badge: BadgeInfo | null
  name: string
  title: string
  company: { name: string; timezone?: string; logoUrl?: string; badgeQrUrl?: string }
  avatarUrl?: string
  avatarInitials: string
  /** What the code encodes; the same rule as the component (`TeamBadge`). */
  target?: string
  /** For the status pill; the component's label table. */
  statusLabel: string
}

const BLUE = '#1f6bd1'
const INK = '#0b1220'
const MUTE = '#5a697d'
const PAPER = '#ffffff'
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Loads an image for drawing, or gives up quietly.
 *
 * A photo is a data URL from the picker on this phone, and a logo is
 * whatever the admin uploaded, which may be served from elsewhere. Asking
 * for CORS is what lets a cross-origin image be drawn without tainting the
 * canvas; a server that refuses gets the same treatment as a broken link,
 * and the card is drawn without that picture rather than not at all.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    if (!src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Fit `text` into `maxWidth` by shrinking the font, never below `minPx`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: string, startPx: number, minPx: number, maxWidth: number) {
  let size = startPx
  for (;;) {
    ctx.font = `${weight} ${size}px ${FONT}`
    if (ctx.measureText(text).width <= maxWidth || size <= minPx) return size
    size -= 2
  }
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = w / scale
  const sh = h / scale
  const sx = (img.naturalWidth - sw) / 2
  const sy = (img.naturalHeight - sh) / 2
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

function drawContain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, cx: number, cy: number, maxW: number, maxH: number) {
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
  const w = img.naturalWidth * scale
  const h = img.naturalHeight * scale
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h)
}

const fmtDate = (ms: number | undefined, tz: string | undefined) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: tz }) : '—'

/**
 * Draw the card. Returns the canvas so the caller can turn it into whatever
 * it needs — a file, a preview, a test — and never hands out a tainted one:
 * if a picture could not be drawn safely it is left off.
 */
export async function drawBadge(spec: BadgeImageSpec): Promise<HTMLCanvasElement> {
  const W = BADGE_PX.width
  const H = BADGE_PX.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')

  const [photo, logo] = await Promise.all([
    spec.avatarUrl ? loadImage(spec.avatarUrl) : Promise.resolve(null),
    spec.company.logoUrl ? loadImage(spec.company.logoUrl) : Promise.resolve(null),
  ])

  // --- the card itself, with the corner radius a printer cuts ---------------
  ctx.save()
  roundedRect(ctx, 0, 0, W, H, px(CR80.cornerIn))
  ctx.clip()
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, W, H)

  // --- header: the band, the slot and TEAM MEMBER ---------------------------
  const bandH = px(0.62)
  ctx.fillStyle = BLUE
  ctx.fillRect(0, 0, W, bandH)
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  roundedRect(ctx, W / 2 - px(0.28), px(0.1), px(0.56), px(0.075), px(0.0375))
  ctx.fill()
  ctx.fillStyle = PAPER
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `900 ${px(0.19)}px ${FONT}`
  ctx.fillText('TEAM MEMBER', W / 2, px(0.4))

  // --- the company -----------------------------------------------------------
  const companyCy = px(0.86)
  if (logo) {
    drawContain(ctx, logo, W / 2, companyCy, px(1.5), px(0.34))
  } else {
    ctx.fillStyle = INK
    const size = fitText(ctx, (spec.company.name || 'Your company').toUpperCase(), '900', px(0.15), px(0.09), W - px(0.4))
    ctx.font = `900 ${size}px ${FONT}`
    ctx.fillText((spec.company.name || 'Your company').toUpperCase(), W / 2, companyCy)
  }

  // --- the person: a 4:5 portrait, or the placeholder with a true circle ----
  const photoW = px(0.9)
  const photoH = Math.round(photoW * 1.25)
  const photoX = Math.round((W - photoW) / 2)
  const photoY = px(1.1)
  const photoR = px(0.06)
  ctx.save()
  roundedRect(ctx, photoX, photoY, photoW, photoH, photoR)
  ctx.clip()
  if (photo) {
    drawCover(ctx, photo, photoX, photoY, photoW, photoH)
  } else {
    ctx.fillStyle = '#e9edf3'
    ctx.fillRect(photoX, photoY, photoW, photoH)
    const r = px(0.16)
    ctx.beginPath()
    ctx.arc(W / 2, photoY + photoH / 2 - px(0.08), r, 0, Math.PI * 2)
    ctx.fillStyle = PAPER
    ctx.fill()
    ctx.fillStyle = MUTE
    ctx.font = `600 ${px(0.13)}px ${FONT}`
    ctx.fillText(spec.avatarInitials, W / 2, photoY + photoH / 2 - px(0.08))
    ctx.font = `500 ${px(0.075)}px ${FONT}`
    ctx.fillText('Your photo goes here', W / 2, photoY + photoH / 2 + px(0.17))
  }
  ctx.restore()

  // --- name and title ----------------------------------------------------------
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const nameText = (spec.name || 'Your name').toUpperCase()
  const nameSize = fitText(ctx, nameText, '900', px(0.17), px(0.1), W - px(0.4))
  ctx.fillStyle = BLUE
  ctx.font = `900 ${nameSize}px ${FONT}`
  ctx.fillText(nameText, px(0.2), px(2.5))
  ctx.fillStyle = INK
  const titleSize = fitText(ctx, spec.title.toUpperCase(), '700', px(0.085), px(0.06), W - px(0.4))
  ctx.font = `700 ${titleSize}px ${FONT}`
  ctx.fillText(spec.title.toUpperCase(), px(0.2), px(2.64))

  // --- the rule, then id, dates and status on the left ---------------------------
  ctx.fillStyle = 'rgba(11,18,32,0.12)'
  ctx.fillRect(px(0.2), px(2.72), W - px(0.4), 2)
  const rows: [string, string][] = [
    ['ID:', spec.badge ? `#${spec.badge.id}` : 'No badge yet'],
    ['ISSUED:', fmtDate(spec.badge?.issuedAt, spec.company.timezone)],
    ['EXPIRES:', fmtDate(spec.badge?.expiresAt, spec.company.timezone)],
  ]
  let y = px(2.87)
  for (const [k, v] of rows) {
    ctx.fillStyle = BLUE
    ctx.font = `900 ${px(0.075)}px ${FONT}`
    ctx.fillText(k, px(0.2), y)
    ctx.fillStyle = INK
    ctx.font = `700 ${px(0.075)}px ${FONT}`
    ctx.fillText(v, px(0.2) + px(0.42), y)
    y += px(0.115)
  }
  const status = spec.badge?.status ?? 'none'
  const pill =
    status === 'active'
      ? { bg: '#dcfce7', ink: '#137536' }
      : status === 'expired'
        ? { bg: '#fee2e2', ink: '#b91c1c' }
        : { bg: '#fef3c7', ink: '#92400e' }
  ctx.font = `600 ${px(0.065)}px ${FONT}`
  const pillW = ctx.measureText(spec.statusLabel).width + px(0.12)
  const pillH = px(0.11)
  const pillY = y - px(0.02)
  ctx.fillStyle = pill.bg
  roundedRect(ctx, px(0.2), pillY, pillW, pillH, pillH / 2)
  ctx.fill()
  ctx.fillStyle = pill.ink
  ctx.textBaseline = 'middle'
  ctx.fillText(spec.statusLabel, px(0.26), pillY + pillH / 2)

  // --- the code, on the right, on whole pixels ----------------------------------
  if (spec.target) {
    const modules = qrModules(spec.target)
    const cell = qrCellPx(modules.length)
    const size = cell * (modules.length + QR_QUIET_MODULES * 2)
    const qx = W - px(0.15) - size
    const qy = H - px(0.15) - size
    ctx.fillStyle = PAPER
    ctx.fillRect(qx, qy, size, size)
    ctx.fillStyle = INK
    const origin = QR_QUIET_MODULES * cell
    modules.forEach((row, r) => {
      row.forEach((dark, c) => {
        if (dark) ctx.fillRect(qx + origin + c * cell, qy + origin + r * cell, cell, cell)
      })
    })
  }

  ctx.restore()
  return canvas
}

/** The card as a PNG. */
export async function badgePng(spec: BadgeImageSpec): Promise<Blob> {
  const canvas = await drawBadge(spec)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not encode the badge')
  return blob
}

/**
 * Hand the file to the person: the share sheet in the phone app (where Save
 * Image lives), a download in a browser. The same road every file in the app
 * takes now — see `saveFile` — so a device that cannot share a file is told so
 * rather than handed a button that does nothing.
 */
export async function deliverBadge(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  return saveFile(new Blob([blob], { type: 'image/png' }), filename)
}
