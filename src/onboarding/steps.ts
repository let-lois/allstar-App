import type { OnboardingStep } from '../types'
import type { OnboardingViewDTO } from '../lib/http'

/**
 * What every step screen is handed.
 *
 * The screens never talk to the server themselves. They read the view, and
 * they call `post` to complete a step or `goto` to walk back to an earlier one;
 * the shell owns the request, the busy state, the error, and — this is the
 * point — which step is showing, which is whatever the server said last.
 */
export interface StepProps {
  view: OnboardingViewDTO
  busy: boolean
  error: string | null
  post: (step: OnboardingStep, data?: Record<string, unknown>) => Promise<boolean>
  goto: (step: OnboardingStep) => void
}

export const STEP_TITLES: Record<OnboardingStep, string> = {
  profile: 'Complete your profile',
  setup: 'App setup',
  walkthrough: 'Learn the basics',
  badge: 'Your team member badge',
  checklist: 'Ready to sell',
}
