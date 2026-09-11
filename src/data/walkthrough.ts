/**
 * Learn the basics: five cards, about ten seconds each.
 *
 * This is not the tour. The tour (data/tour.ts) is twenty-two coach-marks over
 * the live interface and takes minutes; it is offered at the end of onboarding
 * and from More for anyone who wants it. This is the sixty-second version a
 * new rep reads on a first morning: what the app is for, in the order the day
 * happens. Kept as data so `verify:onboarding` can read it without a browser
 * and so the copy is a product decision somewhere a test can assert it.
 *
 * Icons are named, not imported, for the same reason the outcome glyphs are:
 * a data module must not pull in JSX.
 */

export type WalkthroughIcon = 'map' | 'door' | 'check' | 'leads' | 'trophy'

export interface WalkthroughCard {
  key: string
  icon: WalkthroughIcon
  title: string
  body: string
}

export const WALKTHROUGH: readonly WalkthroughCard[] = [
  {
    key: 'map',
    icon: 'map',
    title: 'Map & territory',
    body: 'Every door you own is a pin. Colour is status, and the map works with no signal once you have been somewhere.',
  },
  {
    key: 'knock',
    icon: 'door',
    title: 'Knock a door',
    body: 'Today lines up the nearest door. One tap starts the visit on the doorstep; the timer runs while you talk.',
  },
  {
    key: 'log',
    icon: 'check',
    title: 'Log the result',
    body: 'Two taps to record what happened — no answer, interested, sold. It saves on the phone first and uploads when you have bars.',
  },
  {
    key: 'leads',
    icon: 'leads',
    title: 'Manage leads',
    body: 'Search any house, add a note or a photo, book the follow-up. Swipe a lead to call the owner or start a visit.',
  },
  {
    key: 'performance',
    icon: 'trophy',
    title: 'Track performance',
    body: 'Doors, conversations, appointments and sales — yours and the team’s, scored daily. The board is where the day gets kept.',
  },
]
