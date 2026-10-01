import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { IconCheck, IconChevron } from '../components/nav/icons'
import { markTourSeen } from '../lib/tourState'
import type { OnboardingViewDTO } from '../lib/http'
import { useAppStore } from '../store/useAppStore'

/**
 * Step 6 — you're ready.
 *
 * The one screen with two doors. "Start knocking" goes to the map for a rep
 * and to the overview for the office, and marks the tour as seen: somebody
 * who just spent a minute on the walkthrough should not have twenty-two
 * coach-marks land on them the moment they arrive. "Take the full tour" is
 * the other door, for whoever wants it — the tour opens over Today, where its
 * first step lives.
 *
 * `refreshMe` is what releases the gate in App: the server already says
 * complete, and re-reading the person is how the phone finds out.
 */
export function ReadyStep({ view }: { view: OnboardingViewDTO }) {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const refreshMe = useAppStore((s) => s.refreshMe)
  const requestTour = useAppStore((s) => s.requestTour)
  const [leaving, setLeaving] = useState(false)

  const first = view.profile.firstName ?? user?.name.split(' ')[0] ?? ''
  const home = user?.role === 'field_rep' ? '/map' : '/today'

  async function start() {
    setLeaving(true)
    await markTourSeen(user ? { id: user.id, role: user.role } : null)
    nav(home, { replace: true })
    await refreshMe()
  }

  async function tour() {
    setLeaving(true)
    requestTour()
    nav('/today', { replace: true })
    await refreshMe()
  }

  return (
    <div className="app-shell bg-surface-sunk text-ink" data-testid="onboarding" data-step="ready">
      <div className="scroll-pane flex flex-col justify-center px-6 py-10">
        <div className="mx-auto w-full max-w-sm text-center anim-rise">
          <span className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-good text-surface-sunk [&>svg]:h-10 [&>svg]:w-10" aria-hidden>
            <IconCheck />
          </span>
          <h1 className="mt-6 text-[27px] font-semibold leading-tight tracking-[-0.02em]">
            You’re ready to sell{first ? `, ${first}` : ''}.
          </h1>
          <p className="mt-3 text-[15.5px] leading-relaxed text-ink-mute">
            Your badge is confirmed and the app is set up. Everything you record saves on this phone first and uploads when you have signal.
          </p>
          {/* A chevron, not a typed arrow: the icon set draws this app's arrows. */}
          <Button size="lg" full className="mt-8" disabled={leaving} onClick={() => void start()} data-testid="start-knocking">
            <span>{leaving ? 'Opening…' : 'Start knocking'}</span>
            {!leaving && <IconChevron />}
          </Button>
          <Button variant="ghost" size="md" full className="mt-3" disabled={leaving} onClick={() => void tour()} data-testid="take-tour">
            Take the full tour first
          </Button>
        </div>
      </div>
    </div>
  )
}
