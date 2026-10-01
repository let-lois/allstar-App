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
 * lives inside the `TopBar`, and when the header carried `backdrop-blur` —
 * `backdrop-filter` makes an element the containing block for every
 * `position: fixed` descendant — a sheet rendered in place was clipped to the
 * header's own 54px box: a scrim over nothing, a panel with no room, and two
 * buttons the person could not reach. The blur is gone; the portal stays,
 * because any future filter or transform on the header would bring it back.
 */
export function SignOutButton({ row = false }: { row?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const signOut = useAppStore((s) => s.signOut)
  const user = useAppStore((s) => s.user)
  const sync = useSync()
  const photos = usePhotoSync()

  const owed = sync.pending + sync.failed
  const owedPhotos = photos.waiting + photos.failed

  return (
    <>
      {/*
        A button, not a bare glyph.

        It used to be a loose icon in the header, which is the same affordance as
        a decoration — nothing about it said it could be pressed, and the one
        control on this screen that ends the session is a poor place to make
        somebody guess. It now wears the app's own machined face, so it reads as
        a thing you press for the same reason every other button here does.

        Gunmetal rather than the brand teal. The reference for this was a bright
        blue call-to-action, and that is exactly what logging out must not be:
        the loudest control on a screen whose job is to send a rep to the next
        door. It is unmistakable, and it is not shouting.

        No word beside it any more. "LOGOUT" set in uppercase with letterspacing
        was the widest thing in the header and the loudest — a secondary action
        competing with the rep's own name for the top of every screen — and the
        arrow-through-a-door is one of the few glyphs in software that needs no
        gloss. The accessible name and the tooltip carry it for the people and
        the situations where a picture is not enough; the target is square and
        still a full 44px.
      */}
      {row ? (
        /*
          The More screen's last row: a full-width target with its name in
          words, in the destructive colour, and the same confirmation below.
        */
        <div className="card overflow-hidden">
          <button
            onClick={() => setOpen(true)}
            data-testid="sign-out"
            className="focusable flex min-h-tap w-full items-center gap-3 px-4 py-3 text-left text-[15px] font-semibold text-bad active:bg-surface-field"
          >
            <IconSignOut />
            Sign out
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          aria-label="Sign out"
          title="Sign out"
          data-testid="sign-out"
          className="press focusable metal metal-quiet grid min-h-tap w-11 shrink-0 place-items-center rounded-field text-ink-soft"
        >
          <IconSignOut />
        </button>
      )}

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
