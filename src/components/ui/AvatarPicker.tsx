import { useEffect, useRef, useState } from 'react'
import { Avatar } from './Avatar'
import { PhotoCropper } from './PhotoCropper'
import { cropSourceFromFile, type CropSource } from '../../lib/media'
import { useAppStore } from '../../store/useAppStore'
import { haptic } from '../../lib/haptics'
import { ROLE_LABEL } from '../../lib/roles'

/**
 * The signed-in person's profile photo, and the control that sets it.
 *
 * The avatar *is* the button. A separate "change photo" link beside it would be
 * a second tap target for the thing the first one already looks like, and on a
 * phone the face is the biggest, most obviously tappable object on the screen.
 *
 * Everything happens on the device: pick, frame, preview, save. The upload is
 * a consequence, not a step — a rep in a stairwell sets their photo and it is
 * simply set, the same contract every other write in this app makes.
 *
 * Framing is the rep's: the photo opens in `PhotoCropper` at the badge's 4:5
 * shape, and nothing changes until they press Save. It used to be cut to a
 * centred square on the spot, with no say in where.
 */
export function AvatarPicker() {
  const user = useAppStore((s) => s.user)
  const setMyAvatar = useAppStore((s) => s.setMyAvatar)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<CropSource | null>(null)

  // The working copy is an object URL; let it go when it is replaced or closed.
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url) }, [source])

  if (!user) return null

  async function onPick(file: File | undefined) {
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      setSource(await cropSourceFromFile(file))
    } catch {
      /*
        Named, not swallowed. A photo that silently fails to appear reads as the
        app being broken, and the most common cause here is a file that is not
        an image at all — a PDF or a HEIC the browser cannot decode.
      */
      setError('That file could not be read as an image. Try another photo.')
    } finally {
      setBusy(false)
      // Clear the input so picking the same file twice still fires a change.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.name
  const company = user.company ?? { name: user.clientName, timezone: undefined }

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        aria-label={user.avatarUrl ? 'Change your profile photo' : 'Add a profile photo'}
        className="focusable relative shrink-0 rounded-full disabled:opacity-60"
      >
        <Avatar
          initials={user.avatarInitials}
          name={user.name}
          src={user.avatarUrl}
          size="lg"
        />
        {/*
          A camera badge on the corner, always visible.

          Without it the avatar is just a picture, and nothing on this screen
          says a photo can be set at all — the affordance has to be on the
          object, because there is no other place left to put it.
        */}
        <span
          aria-hidden
          /*
            Flush to the corner, not hanging off it.

            The obvious placement is a couple of pixels outside the circle, and
            the viewport audit rejects it: a control's moving parts have to stay
            inside the control, because the one time that rule was broken the
            offline switch's knob spent a release 22px outside its own track.
            Two pixels of overhang is not that bug — but a rule with an
            exception for "small enough" cannot catch the next one.
          */
          className="absolute bottom-0 right-0 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white ring-2 ring-surface-sunk"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 8h3l1.5-2h7L17 8h3v11H4V8z"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="2.2" />
          </svg>
        </span>
      </button>

      <input
        ref={fileRef}
        type="file"
        /*
          `capture` is deliberately absent. On a phone this input offers camera
          *and* library; adding capture="user" would force the selfie camera and
          take the library away, and most people already have the photo they
          want to use.
        */
        accept="image/*"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />

      {error && (
        <p role="alert" className="mt-2 text-[12.5px] font-medium text-bad">
          {error}
        </p>
      )}

      {source && (
        <PhotoCropper
          source={source}
          badge={{
            badge: user.badge ?? null,
            name,
            title: user.jobTitle || ROLE_LABEL[user.role],
            company,
            avatarInitials: user.avatarInitials,
          }}
          onCancel={() => setSource(null)}
          onReplace={() => fileRef.current?.click()}
          onSave={async (dataUrl) => {
            await setMyAvatar(dataUrl)
            haptic('tap')
            setSource(null)
          }}
        />
      )}
    </>
  )
}

/** The "Remove photo" action, shown only when there is one to remove. */
export function AvatarRemove() {
  const user = useAppStore((s) => s.user)
  const setMyAvatar = useAppStore((s) => s.setMyAvatar)
  if (!user?.avatarUrl) return null
  return (
    <button
      type="button"
      onClick={() => void setMyAvatar(null)}
      className="focusable mt-1 inline-flex min-h-tap items-center rounded-lg px-2 text-[12.5px] font-semibold text-accent"
    >
      Remove photo
    </button>
  )
}
