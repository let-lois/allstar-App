/**
 * Photo capture helpers.
 *
 * A 12MP phone photo is ~4MB. Uploading that over one bar of LTE, forty times a
 * day, is the fastest way to make the app feel broken — so everything is
 * downscaled and re-encoded on-device before it ever touches the sync queue.
 */

const MAX_EDGE = 1600
const QUALITY = 0.72

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
