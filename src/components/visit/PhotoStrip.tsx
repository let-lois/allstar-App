import { Glyph } from '../ui/Glyph'
import { useEffect, useState } from 'react'
import type { Photo, PhotoCategory } from '../../types'
import { usePhotoCategories } from '../../lib/useSettings'
import { compressImage, openCamera, openLibrary } from '../../lib/media'
import { ensureBytes, photoState } from '../../lib/photos'
import { StorageFull } from '../../lib/db'
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
  const updatePhotoCategory = useAppStore((s) => s.updatePhotoCategory)
  const [pending, setPending] = useState<
    { dataUrl: string; width: number; height: number; bytes: number }[]
  >([])
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /*
    Refiling an existing photo. The same sheet as the one after the shot, over
    the same grid, with the photo's current category and type already in it —
    so "what is this?" is answered once, in one place, whichever way the rep
    arrived at the question.
  */
  const [editing, setEditing] = useState<Photo | null>(null)
  /*
    "Other" is the one category that asks a question, and the question is
    answered in a text field that only exists while Other is the choice.
    Tapping any named category files the photo at once, as it always has;
    tapping Other opens the field and waits for a word. Leaving Other for a
    named category throws the word away — a type describing a category the
    photo does not have would be read by the office as a fact.
  */
  const [asking, setAsking] = useState(false)
  const [otherType, setOtherType] = useState('')
  const closeSheet = () => {
    setPending([])
    setEditing(null)
    setAsking(false)
    setOtherType('')
  }

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

  /* A tap on a category: file it now, or — for Other — ask what it is first. */
  const choose = (category: PhotoCategory) => {
    if (category === 'other') {
      setAsking(true)
      return
    }
    setAsking(false)
    setOtherType('')
    void commit(category)
  }

  const commit = async (category: PhotoCategory, type?: string) => {
    haptic('confirm')
    if (editing) {
      const target = editing
      closeSheet()
      setFailed(null)
      try {
        await updatePhotoCategory(target.id, category, type)
      } catch {
        setFailed('The photo could not be refiled. Try again.')
        haptic('warn')
      }
      return
    }
    const batch = pending
    closeSheet()
    setFailed(null)
    for (const img of batch) {
      try {
        await addPhoto(propertyId, img, category, visitId, type)
      } catch (err) {
        /*
          A photo the rep believes they took and does not have is the worst
          outcome this screen can produce — worse than a visible failure,
          because they walk away from the house.

          Until now this threw into a click handler and vanished: the sheet
          closed, the strip stayed empty, and nothing said why. A full phone is
          not hypothetical now that local copies are kept for good.
        */
        setFailed(
          err instanceof StorageFull
            ? 'This phone is out of storage, so the photo was not saved. Free some space and take it again.'
            : 'The photo could not be saved. Try taking it again.',
        )
        haptic('warn')
        break
      }
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
              <PhotoImage
                photo={p}
                alt={`${cat?.label ?? 'Photo'} of property`}
                className="h-full w-full object-cover"
              />
              <span
                className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4 text-left text-[11px] font-bold text-white"
                data-testid="photo-label"
              >
                {photoLabel(cat?.label, p)}
              </span>
              <PhotoDot photo={p} />
            </button>
          )
        })}
      </div>

      {failed && (
        <p
          role="alert"
          className="rounded-field border border-bad/50 bg-bad-bg px-3 py-2 text-[13px] font-medium text-bad"
        >
          {failed}
        </p>
      )}

      {photos.length > 0 && <PhotoTally photos={photos} />}

      {/* Categorize after the shot, in one tap. */}
      <BottomSheet
        open={pending.length > 0 || editing !== null}
        onClose={closeSheet}
        title={editing ? 'Change category' : pending.length > 1 ? `Categorize ${pending.length} photos` : 'Categorize photo'}
        /*
          Tall enough for the whole grid, and raisable.

          Reported from the field: "cut off and has to be manually lifted and
          then cuts off again." Both halves have a cause.

          **Cut off.** Seven categories in two columns is four rows — 286px of
          buttons, over a 112px strip of thumbnails, under a 72px handle and
          title, above the home indicator. That is about 530px of content in
          62% of a phone, which on anything smaller than a Pro Max clips the
          last row. `Before` and `After` were simply below the edge.

          **Lifted, then cut off again.** With one detent there was nothing to
          lift to: `onPointerUp` clamps to `detents.length - 1`, so the drag
          resisted and sprang straight back. The rep's instinct was right and
          the sheet had no answer to it.

          So the first detent now fits the grid outright, and the second exists
          so the gesture does something. The pane scrolls either way — a
          company that renames its way to ten categories still reaches them —
          but nobody should have to scroll to find the button they came for.
        */
        detents={[0.78, 0.94]}
      >
        <div className="space-y-3" data-testid="categorize-sheet" data-mode={editing ? 'edit' : 'new'}>
          <div className="snap-x-row">
            {editing ? (
              <PhotoImage photo={editing} alt="" className="h-28 w-28 shrink-0 rounded-field object-cover" />
            ) : (
              pending.map((p, i) => (
                <img
                  key={i}
                  src={p.dataUrl}
                  alt=""
                  className="h-28 w-28 shrink-0 rounded-field object-cover"
                />
              ))
            )}
          </div>
          {/*
            The question, above the grid rather than below it, because on a
            phone the keyboard takes the bottom half of the sheet: a field
            under the buttons is a field the rep cannot see while typing.
          */}
          {asking && (
            <form
              className="rounded-card border-2 border-accent bg-surface-tint p-3"
              data-testid="photo-type-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (otherType.trim()) void commit('other', otherType)
              }}
            >
              <label className="block">
                <span className="text-[13px] font-semibold text-ink">Type</span>
                <input
                  value={otherType}
                  onChange={(e) => setOtherType(e.target.value)}
                  autoFocus
                  maxLength={60}
                  enterKeyHint="done"
                  autoCapitalize="sentences"
                  className="field-sunk mt-1.5 h-12 w-full rounded-field px-3.5 text-base text-ink placeholder:text-ink-faint"
                  placeholder="What is it? e.g. skylight, gutter, permit"
                  data-testid="photo-type"
                />
              </label>
              <button
                type="submit"
                disabled={!otherType.trim()}
                className="metal metal-brand press focusable mt-2.5 grid h-12 w-full place-items-center rounded-field text-[15px] font-semibold disabled:opacity-50"
                data-testid="photo-type-save"
              >
                {editing ? 'Save' : 'Save photo'}
              </button>
            </form>
          )}
          <div className="grid grid-cols-2 gap-2.5">
            {categories.map((c) => {
              const selected = asking ? c.key === 'other' : editing?.category === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => choose(c.key)}
                  aria-pressed={selected}
                  className={`press focusable flex min-h-[64px] items-center gap-2.5 rounded-card border-2 px-4 font-semibold active:bg-surface-field ${
                    selected ? 'border-accent bg-surface-tint' : 'border-accent/40'
                  }`}
                  data-testid={`photo-category-${c.key}`}
                >
                  <span className="text-xl" aria-hidden>
                    {c.icon ? <Glyph name={c.icon} /> : c.letter}
                  </span>
                  {c.label}
                </button>
              )
            })}
          </div>
        </div>
      </BottomSheet>

      {/* Swipe through photos full-screen. */}
      <PhotoViewer
        photos={photos}
        index={viewing}
        onClose={() => setViewing(null)}
        onIndex={setViewing}
        onRefile={(photo) => {
          // The sheet opens with the photo's own answer already in it.
          setViewing(null)
          setEditing(photo)
          setAsking(photo.category === 'other')
          setOtherType(photo.type ?? '')
        }}
      />
    </div>
  )
}

/**
 * A photo, whether or not its bytes are on this device.
 *
 * They are not, for anything this phone did not shoot: the office opening a
 * property has the row and nothing to draw. So the bytes are fetched on first
 * sight and written back to the row, which means the second look is free and
 * works with no signal.
 *
 * Per photo rather than per property, because a strip is mostly off-screen: a
 * rep with fifteen shots on a lead sees three, and pulling the other twelve over
 * cellular to fill a scroll container nobody scrolled is exactly the kind of
 * thing that makes a field app feel broken.
 */
function PhotoImage({
  photo,
  alt,
  className,
}: {
  photo: Photo
  alt: string
  className: string
}) {
  const [src, setSrc] = useState<string | undefined>(photo.dataUrl)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (photo.dataUrl) {
      setSrc(photo.dataUrl)
      return
    }
    let alive = true
    setSrc(undefined)
    setGone(false)
    void ensureBytes(photo.id).then((bytes) => {
      if (!alive) return
      if (bytes) setSrc(bytes)
      else setGone(true)
    })
    return () => {
      alive = false
    }
  }, [photo.id, photo.dataUrl])

  if (src) {
    return <img src={src} alt={alt} loading="lazy" decoding="async" className={className} />
  }

  /*
    Two different absences, drawn differently on purpose. A photo still coming
    down is a placeholder that will fill; one the server cannot produce is a
    dash, because a spinner that never stops is worse than an answer.
  */
  return (
    <span
      role="img"
      aria-label={gone ? 'Photo unavailable' : 'Photo loading'}
      className={`${className} grid place-items-center bg-surface-field text-ink-faint`}
    >
      {gone ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 12h14" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="h-4 w-4 animate-pulse rounded-full bg-ink/20" />
      )}
    </span>
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
  onRefile,
}: {
  photos: Photo[]
  index: number | null
  onClose: () => void
  onIndex: (i: number) => void
  /** Open the category sheet for this photo — the one place a filing is changed. */
  onRefile: (photo: Photo) => void
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
        <span className="nums min-w-0 truncate px-2 text-sm font-semibold" data-testid="viewer-label">
          {index + 1} / {photos.length} · {photoLabel(cat?.label, photo)}
        </span>
        <button
          onClick={() => onRefile(photo)}
          className="focusable grid h-11 shrink-0 place-items-center rounded-full px-3 text-[13px] font-semibold active:bg-white/10"
          data-testid="photo-refile"
        >
          Change
        </button>
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
            <PhotoImage photo={p} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * What a thumbnail or the viewer calls a photo: the category's label, and for
 * "other" the rep's own word after it — "Other · skylight" — because "Other"
 * alone is the one label that tells the office nothing.
 */
function photoLabel(label: string | undefined, photo: Photo): string {
  const base = label ?? 'Photo'
  return photo.category === 'other' && photo.type ? `${base} · ${photo.type}` : base
}
