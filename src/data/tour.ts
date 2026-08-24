/**
 * The first-run tour.
 *
 * Six steps, and the number is the design. A tutorial is a toll gate between
 * someone and the thing they downloaded the app to do, and every extra panel
 * raises the odds they hit Skip and learn none of it. So this covers what a rep
 * cannot work out on their own or cannot afford to get wrong, and nothing else:
 *
 *   - what the day is, and how much of it is left
 *   - which door is next, and that the app chose it
 *   - the one button that starts a knock
 *   - that the app keeps working with no signal — the thing nobody believes
 *     until they are told, and the thing that loses a day's work if they
 *     assume the opposite
 *   - where the doors are
 *   - that the day is scored
 *
 * Deliberately not here: settings, filters, territory drawing, the console,
 * import. Those are discoverable, and none of them is load-bearing on day one.
 *
 * Kept as data rather than JSX so `verify:tour` can read it without a browser —
 * the step list is a product decision, and it belongs somewhere a test can
 * assert it rather than buried in a render.
 */

export interface TourStep {
  /** Matches a `data-tour` attribute on a real element. */
  target: string
  title: string
  body: string
  /**
   * Where the card sits relative to the spotlight when there is room. The
   * component overrides this when there is not.
   */
  prefer?: 'above' | 'below'
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: 'progress',
    title: 'Your day at a glance',
    body: 'Doors knocked out of doors planned, and how many are left. This is the number that moves as you work.',
    prefer: 'below',
  },
  {
    target: 'next-stop',
    title: 'The app picks the next door',
    body: 'Your route is ordered by distance, so the closest unknocked door is always on top. Navigate opens it in your maps app.',
    prefer: 'below',
  },
  {
    target: 'start-visit',
    title: 'One tap starts the knock',
    body: 'Tap Start visit on the doorstep. You record what happened right after — interested, not home, sold — in two taps.',
    prefer: 'above',
  },
  {
    target: 'sync',
    title: 'No signal is not a problem',
    body: 'Everything you record is saved on this phone first and uploads itself when you get bars back. Keep knocking in a dead zone; nothing is lost.',
    prefer: 'below',
  },
  {
    target: 'nav-map',
    title: 'Every door on a map',
    body: 'See where you are, where the doors are, and what happened at each one. Tap a pin to open it.',
    prefer: 'above',
  },
  {
    target: 'nav-more',
    title: 'The day is scored',
    body: 'Points for doors, conversations, appointments and sales. Standings live under More — along with everything else.',
    prefer: 'above',
  },
]

/** Bumped only when the steps change enough that people should see it again. */
export const TOUR_VERSION = 1
export const TOUR_KEY = `allstar.tour.v${TOUR_VERSION}`
