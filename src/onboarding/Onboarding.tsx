import { useCallback, useEffect, useState } from 'react'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Button } from '../components/ui/Button'
import { OfflineBanner } from '../components/sync/SyncBadge'
import { InAppBrowserNotice } from '../components/system/InAppBrowserNotice'
import { ApiError, NetworkError, apiOnboarding, apiOnboardingStep, type OnboardingViewDTO } from '../lib/http'
import { liveToken } from '../lib/session'
import { haptic } from '../lib/haptics'
import { useAppStore } from '../store/useAppStore'
import type { OnboardingStep } from '../types'
import { STEP_TITLES } from './steps'
import { ProfileStep } from './ProfileStep'
import { SetupStep } from './SetupStep'
import { WalkthroughStep } from './WalkthroughStep'
import { BadgeStep } from './BadgeStep'
import { ChecklistStep } from './ChecklistStep'
import { ReadyStep } from './ReadyStep'

/**
 * Onboarding, the shell.
 *
 * Takes the whole viewport, the way Visit Mode does, because there is nothing
 * else to do until it is finished — no nav, no map, no tour. It is rendered by
 * App when the signed-in person's `onboarding.status` is anything but
 * complete, and it stops being rendered the moment the server says otherwise.
 *
 * **The server holds the place.** This component asks `/api/me/onboarding`
 * where the person is and shows that step. Completing a step is one request
 * whose answer is the next view — there is no local notion of progress to
 * drift, and a phone that closed the app on step three reopens on step three
 * because the server, not the phone, remembers. Going *back* to an earlier
 * step is the one thing kept locally (`active`), because it is a view choice
 * and not progress; it is dropped the moment the server answers again.
 */

const STEPS: readonly OnboardingStep[] = ['profile', 'setup', 'walkthrough', 'badge', 'checklist']

export function Onboarding() {
  const user = useAppStore((s) => s.user)
  const [view, setView] = useState<OnboardingViewDTO | null>(null)
  const [active, setActive] = useState<OnboardingStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = liveToken()
    if (!token) return
    setLoadError(null)
    try {
      setView(await apiOnboarding(token))
      setActive(null)
    } catch (err) {
      setLoadError(messageFor(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const post = useCallback(async (step: OnboardingStep, data?: Record<string, unknown>) => {
    const token = liveToken()
    if (!token || busy) return false
    setBusy(true)
    setError(null)
    try {
      const next = await apiOnboardingStep(token, step, data)
      setView(next)
      setActive(null)
      haptic('confirm')
      return true
    } catch (err) {
      setError(messageFor(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [busy])

  const goto = useCallback((step: OnboardingStep) => {
    setError(null)
    setActive(step)
  }, [])

  if (!user) return null

  if (!view) {
    return (
      <div className="app-shell bg-surface-sunk text-ink" data-testid="onboarding">
        <div className="pad-top shrink-0">
          <InAppBrowserNotice />
          <OfflineBanner />
        </div>
        <div className="scroll-pane grid place-items-center px-6">
          {loadError ? (
            <div className="max-w-sm text-center">
              <p className="text-[15px] text-ink-mute">{loadError}</p>
              <Button className="mt-4" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-[15px] text-ink-mute">Getting things ready…</p>
          )}
        </div>
      </div>
    )
  }

  if (view.status === 'complete') {
    return <ReadyStep view={view} />
  }

  const step = active ?? view.step
  const index = STEPS.indexOf(step)
  const props = { view, busy, error, post, goto }

  return (
    <div className="app-shell bg-surface-sunk text-ink" data-testid="onboarding" data-step={step}>
      <div className="pad-top shrink-0">
        <InAppBrowserNotice />
        <OfflineBanner />
      </div>
      {/*
        One header for every step, so the person always knows how far along
        they are. Company first: this is *their* company welcoming them, and
        the app's own name is on the icon they just tapped.
      */}
      <header className="shrink-0 px-5 pb-3 pt-2">
        <div className="mx-auto w-full max-w-md">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-[13px] font-medium text-ink-mute">{user.clientName}</p>
            <p className="shrink-0 text-[13px] font-medium text-ink-mute" data-testid="onboarding-progress">
              Step {index + 1} of {STEPS.length}
            </p>
          </div>
          <ProgressBar
            value={index + 1}
            max={STEPS.length}
            className="mt-2"
            animate={false}
            label={`Step ${index + 1} of ${STEPS.length}`}
          />
          <h1 className="mt-4 text-[23px] font-semibold leading-tight tracking-[-0.02em]">
            {STEP_TITLES[step]}
          </h1>
        </div>
      </header>
      <div className="scroll-pane px-5 pb-8">
        <div className="mx-auto w-full max-w-md">
          {step === 'profile' && <ProfileStep {...props} />}
          {step === 'setup' && <SetupStep {...props} />}
          {step === 'walkthrough' && <WalkthroughStep {...props} />}
          {step === 'badge' && <BadgeStep {...props} />}
          {step === 'checklist' && <ChecklistStep {...props} />}
        </div>
      </div>
    </div>
  )
}

function messageFor(err: unknown): string {
  if (err instanceof NetworkError) {
    return navigator.onLine
      ? 'Could not reach the server. Try again in a moment.'
      : 'You are offline. Setting up needs a connection — your typing is kept.'
  }
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Try again.'
}
