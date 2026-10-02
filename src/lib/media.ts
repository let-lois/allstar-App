/**
 * Photo capture helpers.
 *
 * A 12MP phone photo is ~4MB. Uploading that over one bar of LTE, forty times a
 * day, is the fastest way to make the app feel broken — so everything is
 * downscaled and re-encoded on-device before it ever touches the sync queue.
 */

const MAX_EDGE = 1600
const QUALITY = 0.72

/*
 * Avatars are a different problem from property photos.
 *
 * They are shown at 32-48px in lists, they ride the sync queue like everything
 * else, and — unlike a roof shot — every teammate's copy is downloaded by every
 * other device. A 1600px portrait would be ~180KB of somebody else's face on a
 * rep's data plan, forty times over.
 *
 * 256px wide is four times the largest place one is drawn in a list, which is
 * the headroom a 3x screen needs and no more. It is stored at the badge's 4:5
 * (256 × 320, see `lib/photo-crop.ts`), framed by the rep in `PhotoCropper`;
 * round avatars show its centre.
 */
const AVATAR_QUALITY = 0.82

export interface CompressedImage {
  dataUrl: string
  width: number
  height: number
  bytes: number
}

export async function compressImage(file: Blob): Promise<CompressedImage> {
  const bitmap = await loadBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height)
  if ('close' in bitmap) (bitmap as ImageBitmap).close()

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
  // base64 is ~4/3 of the byte length, minus the header.
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
  return { dataUrl, width, height, bytes }
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // Honors EXIF orientation — otherwise every iPhone roof shot lands sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      /* fall through */
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read image'))
    }
    img.src = url
  })
}

/**
 * Opens the OS camera directly via the file input's `capture` hint. This beats
 * getUserMedia for field use: it's the camera the rep already knows, it handles
 * focus/flash/HDR, and it works when the page isn't allowed a live video stream.
 */
export function openCamera(onFiles: (files: File[]) => void, multiple = true) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.capture = 'environment'
  input.multiple = multiple
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  document.body.appendChild(input)
  input.addEventListener(
    'change',
    () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      if (files.length) onFiles(files)
    },
    { once: true },
  )
  input.click()
}

/** Same, minus the `capture` hint — lets the rep pick from the camera roll. */
export function openLibrary(onFiles: (files: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  document.body.appendChild(input)
  input.addEventListener(
    'change',
    () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      if (files.length) onFiles(files)
    },
    { once: true },
  )
  input.click()
}


/* --- the badge photo, framed by hand ------------------------------------- */

/** Longest edge of the copy the cropper works from. */
const CROP_SOURCE_EDGE = 2048

export interface CropSource {
  /** What the cropper draws from: the photo, upright, at most 2048px long. */
  canvas: HTMLCanvasElement
  /** An object URL of the same pixels, for the <img> the rep drags. Revoke it. */
  url: string
  w: number
  h: number
}

/**
 * Open a photo for framing.
 *
 * A 48MP iPhone photo is ~190MB decoded, which is more than iOS lets one
 * canvas hold. It is decoded once, upright (EXIF honoured, as for every other
 * photo here), drawn into a canvas no longer than 2048px, and the full-size
 * decode is let go. 2048px is eight times the stored photo's width, so no
 * amount of zoom the cropper allows runs out of detail.
 */
export async function cropSourceFromFile(file: Blob): Promise<CropSource> {
  const bitmap = await loadBitmap(file)
  const bw = bitmap.width
  const bh = bitmap.height
  if (!bw || !bh) throw new Error('Could not read image')
  const k = Math.min(1, CROP_SOURCE_EDGE / Math.max(bw, bh))
  const w = Math.max(1, Math.round(bw * k))
  const h = Math.max(1, Math.round(bh * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h)
  if ('close' in bitmap) (bitmap as ImageBitmap).close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
  if (!blob) throw new Error('Could not read image')
  return { canvas, url: URL.createObjectURL(blob), w, h }
}

/**
 * The framed photo as the badge stores it: 256 × 320 JPEG.
 *
 * The server takes an avatar of at most 64,000 characters of data URL. A busy
 * photo at the usual quality can come close at this size, so the quality steps
 * down until it fits rather than the save failing on the server later, after
 * the rep has walked away believing it worked.
 */
export function badgePhotoFromCrop(
  source: CanvasImageSource,
  rect: { sx: number; sy: number; sw: number; sh: number },
  out: { w: number; h: number },
): CompressedImage {
  const canvas = document.createElement('canvas')
  canvas.width = out.w
  canvas.height = out.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingQuality = 'high'
  // White under the photo, so a transparent PNG is not a black JPEG.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.w, out.h)
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, out.w, out.h)
  let dataUrl = ''
  for (const q of [AVATAR_QUALITY, 0.74, 0.66, 0.58, 0.5]) {
    dataUrl = canvas.toDataURL('image/jpeg', q)
    if (dataUrl.length <= 60_000) break
  }
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
  return { dataUrl, width: out.w, height: out.h, bytes }
}
