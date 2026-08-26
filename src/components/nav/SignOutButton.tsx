import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BottomSheet } from '../ui/BottomSheet'
import { Button } from '../ui/Button'
import { IconSignOut } from './icons'
import { useAppStore } from '../../store/useAppStore'
import { usePhotoSync, useSync } from '../sync/SyncBadge'

/**
 * Signing out, from the header.
 *
 * It used to live at the bottom of More, below everything else, which is where
 * a destructive action belongs when nobody has asked for it to be closer. It is
 * closer now — one tap from the screen a rep starts their day on, next to a
 * chip they tap to check sync.
 *
 * So it asks first, and that is not decoration. Signing out clears this
 * device's visits, notes and photos, and the photos it clears include ones
 * still waiting to upload — a rep who mis-taps this on the way to the sync chip
 * loses a morning of roof shots with no way to get them back. The queued writes
 * survive, the images do not.
 *
 * The confirmation says what is unsent when anything is, because "are you sure"
 * on its own is a question nobody can answer. A number is.
 *
 * The sheet is portalled to the body, and that is not tidiness. This button
 * lives inside the `TopBar`, and the header carries `backdrop-blur` —
 * `backdrop-filter` makes an element the containing block for every
 * `position: fixed` descendant, so a sheet rendered in place was clipped to the
 * header's own 54px box: a scrim over nothing, a panel with no room, and two
 * buttons the person could not reach. It looked like a broken sheet and was
 * really a CSS containment rule two components away.
 */
export function SignOutButton() {
  const [open, setOpen] = useState(false)
  const signOut = useAppStore((s) => s.signOut)
  const user = useAppStore((s) => s.user)
  const sync = useSync()
  const photos = usePhotoSync()

  const owed = sync.pending + sync.failed
  const owedPhotos = photos.waiting + photos.failed

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Sign out"
        className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-mute active:bg-surface-field"
      >
        <IconSignOut />
      </button>

      {createPortal(
        <BottomSheet open={open} onClose={() => setOpen(false)} title="Sign out?" detents={[0.52]}>
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {user ? `You are signed in as ${user.name}. ` : ''}
              Signing out clears this phone&rsquo;s visits, notes and photos.
            </p>

            {/*
              Only when there is something to lose. A warning that appears every
              time is one nobody reads by the time it matters.
            */}
            {owed + owedPhotos > 0 && (
              <p
                role="alert"
                className="rounded-field border border-warn/50 bg-warn-bg px-3 py-2.5 text-[13px] font-medium leading-relaxed text-warn"
              >
                {owedPhotos > 0 && (
                  <>
                    {owedPhotos} photo{owedPhotos === 1 ? '' : 's'} on this phone{' '}
                    {owedPhotos === 1 ? 'has' : 'have'} not uploaded yet and will be lost.{' '}
                  </>
                )}
                {owed > 0 && (
                  <>
                    {owed} other change{owed === 1 ? '' : 's'} {owed === 1 ? 'is' : 'are'} still
                    queued — {owed === 1 ? 'it' : 'they'} will go up next time you sign in.{' '}
                  </>
                )}
                Connect to signal and wait for Synced first if you can.
              </p>
            )}

            <div className="flex flex-col gap-2.5">
              <Button variant="secondary" full size="lg" onClick={() => setOpen(false)}>
                Stay signed in
              </Button>
              <Button
                variant="secondary"
                full
                size="lg"
                className="!text-bad"
                onClick={() => {
                  setOpen(false)
                  void signOut()
                }}
              >
                Sign out
              </Button>
            </div>
            </div>
        </BottomSheet>,
        document.body,
      )}
    </>
  )
}
