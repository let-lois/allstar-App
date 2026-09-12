import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { IconCamera, IconCheck, IconDevice, IconLocate } from '../components/nav/icons'
import { getPosition, locationPermission } from '../lib/geo'
import { installState, onInstallChange, promptInstall, type InstallState } from '../lib/install'
import type { StepProps } from './steps'

/**
 * Step 2 — app setup: location, install, camera.
 *
 * Three cards, and what each one does is decided by what the browser will let
 * it do rather than by what would look tidy:
 *
 *   **Location** is a real permission. It is read first without prompting
 *   (`permissions.query`), so a rep who already said yes sees "on" and is never
 *   asked again — asking for a permission you already hold is how a browser
 *   learns to distrust a site. Denied says what is lost and how to undo it in
 *   the phone's settings; there is no button, because there is no prompt to
 *   raise. Not-yet-asked gets the one button that raises it.
 *
 *   **Install** is what "download the app" means for a PWA. Chromium offers a
 *   prompt; iOS offers only the share sheet, so iOS gets the instructions.
 *
 *   **Camera and photos** has no permission to grant ahead of time in a
 *   browser — it is asked the first time a photo is taken. The card says
 *   exactly that. A toggle here would be a toggle that does nothing.
 *
 * None of the three blocks Continue. They are recommended, and the checklist
 * says which are on.
 */

type LocState = 'checking' | 'granted' | 'denied' | 'prompt' | 'unsupported'

export function SetupStep({ view, busy, error, post }: StepProps) {
  const [loc, setLoc] = useState<LocState>('checking')
  const [asking, setAsking] = useState(false)
  const [install, setInstall] = useState<InstallState>(installState())
  const [installOutcome, setInstallOutcome] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!('geolocation' in navigator)) {
      setLoc('unsupported')
    } else {
      void locationPermission().then((p) => {
        if (!alive) return
        setLoc(p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt')
      })
    }
    const off = onInstallChange(() => setInstall(installState()))
    return () => {
      alive = false
      off()
    }
  }, [])

  async function askLocation() {
    setAsking(true)
    const pos = await getPosition(10_000, 0)
    const after = await locationPermission()
    setLoc(pos ? 'granted' : after === 'granted' ? 'granted' : 'denied')
    setAsking(false)
  }

  async function askInstall() {
    const outcome = await promptInstall()
    setInstallOutcome(outcome === 'accepted' ? 'Installed. Open Allstar from your home screen next time.' : outcome === 'dismissed' ? 'No problem — you can install it later from More.' : null)
    setInstall(installState())
  }

  const locationStatus = loc === 'granted' ? 'granted' : loc === 'denied' ? 'denied' : loc === 'unsupported' ? 'unsupported' : 'skipped'

  return (
    <div className="anim-rise">
      <p className="text-[15px] leading-relaxed text-ink-mute">
        Two things make the app work like an app, and one that is asked for later. None of them stop you continuing.
      </p>

      {/* --- location ---------------------------------------------------- */}
      <section className="card mt-5 p-4" data-testid="setup-location" data-state={loc}>
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 shrink-0 ${loc === 'granted' ? 'text-good' : 'text-accent'}`} aria-hidden>
            {loc === 'granted' ? <IconCheck /> : <IconLocate />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Location</p>
            {loc === 'checking' && <p className="mt-0.5 text-[13.5px] text-ink-mute">Checking…</p>}
            {loc === 'granted' && (
              <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                On. The map finds the nearest door for you and remembers where you stood when you knocked.
              </p>
            )}
            {loc === 'prompt' && (
              <>
                <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                  Lets the map find the nearest door and record where you knocked. Your phone will ask once.
                </p>
                <Button size="sm" className="mt-3" onClick={() => void askLocation()} disabled={asking} data-testid="setup-location-ask">
                  {asking ? 'Asking…' : 'Turn on location'}
                </Button>
              </>
            )}
            {loc === 'denied' && (
              <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                Off. Without it the map cannot find the nearest door for you and visits are not pinned to where you stood. To turn it on later, allow location for this app in your phone’s settings.
              </p>
            )}
            {loc === 'unsupported' && (
              <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">This device does not offer location to the app.</p>
            )}
          </div>
        </div>
      </section>

      {/* --- install ------------------------------------------------------ */}
      <section className="card mt-3 p-4" data-testid="setup-install" data-state={install}>
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 shrink-0 ${install === 'installed' ? 'text-good' : 'text-accent'}`} aria-hidden>
            {install === 'installed' ? <IconCheck /> : <IconDevice />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Add to your home screen</p>
            {install === 'installed' && (
              <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">Done. You are running Allstar from your home screen.</p>
            )}
            {install === 'promptable' && (
              <>
                <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                  Opens full-screen from its own icon and keeps working with no signal.
                </p>
                <Button size="sm" className="mt-3" onClick={() => void askInstall()} data-testid="setup-install-ask">
                  Install Allstar
                </Button>
              </>
            )}
            {install === 'ios' && (
              <div className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                <p>Opens full-screen from its own icon and keeps working with no signal. On iPhone:</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>Tap the Share button at the bottom of Safari.</li>
                  <li>Scroll and tap <strong>Add to Home Screen</strong>.</li>
                  <li>Tap <strong>Add</strong>.</li>
                </ol>
              </div>
            )}
            {install === 'manual' && (
              <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
                Opens full-screen from its own icon and keeps working with no signal. Use your browser’s <strong>Add to Home Screen</strong> or <strong>Install</strong> option — usually in its menu.
              </p>
            )}
            {installOutcome && <p className="mt-2 text-[13px] text-ink-soft">{installOutcome}</p>}
          </div>
        </div>
      </section>

      {/* --- camera --------------------------------------------------------- */}
      <section className="card mt-3 p-4" data-testid="setup-camera">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-accent" aria-hidden>
            <IconCamera />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Camera and photos</p>
            <p className="mt-0.5 text-[13.5px] leading-snug text-ink-mute">
              Nothing to turn on now. Your phone asks the first time you take a photo of a house, and remembers.
            </p>
          </div>
        </div>
      </section>

      {error && (
        <p role="alert" className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
          {error}
        </p>
      )}

      <Button
        size="lg"
        full
        className="mt-6"
        disabled={busy || loc === 'checking'}
        onClick={() => void post('setup', { locationStatus })}
        data-testid="setup-continue"
      >
        {busy ? 'Saving…' : loc === 'denied' || loc === 'prompt' ? 'Continue anyway' : 'Continue'}
      </Button>
      {view.setup.completedAt && (
        <p className="mt-2 text-center text-[12.5px] text-ink-mute">You have done this step before; continuing records what is on now.</p>
      )}
    </div>
  )
}
