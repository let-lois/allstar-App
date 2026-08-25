import { useState } from 'react'
import type { Photo, PhotoCategory } from '../../types'
import { usePhotoCategories } from '../../lib/useSettings'
import { compressImage, openCamera, openLibrary } from '../../lib/media'
import { photoState } from '../../lib/photos'
import { useAppStore } from '../../store/useAppStore'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../../lib/haptics'
import { IconCamera } from '../nav/icons'

/**
 * Camera-first attachment strip.
 *
 * The flow is: tap camera → OS camera opens → shoot → pick a category → done.
 * The category sheet appears *after* the shot, never before, so the rep is
 * never standing there answering a form question with the ladder in one hand.
 */
export function PhotoStrip({
  propertyId,
  visitId,
  photos,
}: {
  propertyId: string
  visitId?: string
  photos: Photo[]
}) {
  const categories = usePhotoCategories()
  const addPhoto = useAppStore((s) => s.addPhoto)
  const [pending, setPending] = useState<
    { dataUrl: string; width: number; height: number; bytes: number }[]
  >([])
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)

  const handleFiles = async (files: File[]) => {
    setBusy(true)
    try {
      // Compress on-device before anything touches storage or the queue.
      const compressed = await Promise.all(files.map((f) => compressImage(f)))
      setPending(compressed)
    } catch {
      setBusy(false)
    } finally {
      setBusy(false)
    }
  }

  const commit = async (category: PhotoCategory) => {
    haptic('confirm')
    const batch = pending
    setPending([])
    for (const img of batch) {
      await addPhoto(propertyId, img, category, visitId)
    }
  }

  return (
    <div className="space-y-2">
      <div className="snap-x-row -mx-1 px-1">
        <button
          onClick={() => openCamera((files) => void handleFiles(files))}
          disabled={busy}
          aria-label="Take photo"
          className="press focusable grid h-24 w-24 shrink-0 place-items-center rounded-card border-2 border-dashed border-ink/15 bg-surface-field text-ink-mute active:bg-surface-field disabled:opacity-50"
        >
          <span className="flex flex-col items-center gap-1">
            <IconCamera />
            <span className="text-[11px] font-semibold">
              {busy ? 'Processing…' : 'Camera'}
            </span>
          </span>
        </button>

        <button
          onClick={() => openLibrary((files) => void handleFiles(files))}
          disabled={busy}
          aria-label="Choose from library"
          className="press focusable grid h-24 w-24 shrink-0 place-items-center rounded-card border-2 border-dashed border-ink/15 bg-surface-field text-ink-mute active:bg-surface-field disabled:opacity-50"
        >
          <span className="flex flex-col items-center gap-1">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 16l5-4 4 3 3-2 6 5" />
            </svg>
            <span className="text-[11px] font-semibold">Library</span>
          </span>
        </button>

        {photos.map((p, i) => {
          const cat = categories.find((c) => c.key === p.category)
          return (
            <button
              key={p.id}
              onClick={() => setViewing(i)}
              className="press relative h-24 w-24 shrink-0 overflow-hidden rounded-card bg-line"
            >
              <img
                src={p.dataUrl}
                alt={`${cat?.label ?? 'Photo'} of property`}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4 text-left text-[11px] font-bold text-white">
                {cat?.label}
              </span>
              <PhotoDot photo={p} />
            </button>
          )
        })}
      </div>

      {photos.length > 0 && <PhotoTally photos={photos} />}

      {/* Categorize after the shot, in one tap. */}
      <BottomSheet
        open={pending.length > 0}
        onClose={() => setPending([])}
        title={pending.length > 1 ? `Categorize ${pending.length} photos` : 'Categorize photo'}
        detents={[0.62]}
      >
        <div className="space-y-3">
          <div className="snap-x-row">
            {pending.map((p, i) => (
              <img
                key={i}
                src={p.dataUrl}
                alt=""
                className="h-28 w-28 shrink-0 rounded-field object-cover"
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {categories.map((c) => (
              <button
                key={c.key}
                onClick={() => void commit(c.key)}
                className="press focusable flex min-h-[64px] items-center gap-2.5 rounded-card border-2 border-line px-4 font-semibold active:bg-surface-field"
              >
                <span className="text-xl" aria-hidden>
                  {c.glyph}
                </span>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </BottomSheet>

      {/* Swipe through photos full-screen. */}
      <PhotoViewer
        photos={photos}
        index={viewing}
        onClose={() => setViewing(null)}
        onIndex={setViewing}
      />
    </div>
  )
}

/**
 * The corner mark on a thumbnail.
 *
 * Only two states earn one. A photo already on the server needs no decoration —
 * that is the ordinary case, and marking it would make the strip a field of
 * dots. Neither does a photo on a deployment with nowhere to send it: nothing
 * is wrong, nothing is pending, and a warning colour would be a lie about a
 * setting the rep cannot change.
 */
function PhotoDot({ photo }: { photo: Photo }) {
  const state = photoState(photo)
  if (state === 'waiting') {
    return (
      <span
        className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-warn ring-2 ring-surface"
        title="Waiting to upload"
      />
    )
  }
  if (state === 'failed') {
    return (
      <span
        className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-bad ring-2 ring-surface"
        title={photo.lastError ?? 'Upload failed'}
      />
    )
  }
  return null
}

/**
 * One line saying where these photos are.
 *
 * It used to say "stored on this phone" in every case, which was true of the
 * bytes and misleading about everything else: a rep reading it after a day of
 * knocking cannot tell whether the office has the roof shots or whether losing
 * the phone loses them. The size is only quoted while something is still owed,
 * because that is the only moment the number is a fact the rep can act on.
 */
function PhotoTally({ photos }: { photos: Photo[] }) {
  const states = photos.map(photoState)
  const waiting = states.filter((s) => s === 'waiting').length
  const failed = states.filter((s) => s === 'failed').length
  const local = states.filter((s) => s === 'local').length
  const owedBytes = photos
    .filter((p) => photoState(p) !== 'uploaded')
    .reduce((sum, p) => sum + p.bytes, 0)

  const count = `${photos.length} photo${photos.length === 1 ? '' : 's'}`
  let detail: string
  if (failed > 0) detail = `${failed} did not upload — retry from More › Upload queue`
  else if (waiting > 0) detail = `${waiting} waiting to upload · ${Math.round(owedBytes / 1024)} KB`
  else if (local === photos.length) detail = `kept on this phone`
  else detail = 'uploaded'

  return (
    <p className={`text-xs ${failed > 0 ? 'text-bad' : 'text-ink-mute'}`}>
      {count} · {detail}
    </p>
  )
}

function PhotoViewer({
  photos,
  index,
  onClose,
  onIndex,
}: {
  photos: Photo[]
  index: number | null
  onClose: () => void
  onIndex: (i: number) => void
}) {
  const categories = usePhotoCategories()
  if (index == null || !photos[index]) return null
  const photo = photos[index]
  const cat = categories.find((c) => c.key === photo.category)

  return (
    <div className="anim-fade fixed inset-0 z-50 flex flex-col bg-black">
      <div className="pad-top flex items-center justify-between px-2 py-2 text-white">
        <button
          onClick={onClose}
          aria-label="Close"
          className="grid h-11 w-11 place-items-center rounded-full active:bg-white/10"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
        <span className="nums text-sm font-semibold">
          {index + 1} / {photos.length} · {cat?.label}
        </span>
        <span className="w-11" />
      </div>

      <div
        // Callback ref rather than an effect: the viewer mounts fresh each open,
        // so this jumps straight to the tapped photo without a visible scroll.
        ref={(el) => {
          if (el && !el.dataset.init) {
            el.dataset.init = '1'
            el.scrollLeft = index * el.clientWidth
          }
        }}
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto hide-scrollbar"
        onScroll={(e) => {
          const el = e.currentTarget
          const i = Math.round(el.scrollLeft / el.clientWidth)
          if (i !== index) onIndex(i)
        }}
      >
        {photos.map((p) => (
          <div key={p.id} className="flex w-full shrink-0 snap-center items-center justify-center p-3">
            <img src={p.dataUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ))}
      </div>
    </div>
  )
}
