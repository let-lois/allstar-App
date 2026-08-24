import type { Role } from '../types'

/**
 * The first-run tour.
 *
 * It walks the app rather than one screen of it: each step names the route it
 * lives on, and the tour navigates there before it spotlights anything. That is
 * the only honest way to explain a five-tab product — a tour that stays on the
 * home screen and describes the other four is a list of promises.
 *
 * Two lists, because two jobs. A rep's day is doors: the route, the knock, the
 * outcome, the fact that none of it needs signal. The office's day is other
 * people's doors: who is out, what came back, and the console that assigns the
 * work. The overlap — map, leads, pipeline, standings — is shared rather than
 * written twice, so a change to how the map is explained reaches everyone.
 *
 * Kept as data rather than JSX so `verify:tour` can read it without a browser.
 * The step list is a product decision and belongs somewhere a test can assert
 * it, not buried in a render.
 */

export interface TourStep {
  /** Matches a `data-tour` attribute on a real element. */
  target: string
  title: string
  body: string
  /** Navigated to before the step is shown. Omitted means "wherever we are". */
  route?: string
  /**
   * Where the card sits relative to the spotlight when there is room. The
   * component overrides this when there is not.
   */
  prefer?: 'above' | 'below'
}

/* --- the parts both jobs share ------------------------------------------- */

const MAP: TourStep[] = [
  {
    route: '/map',
    target: 'map-canvas',
    title: 'Every door on one map',
    body: 'Pins are colour-coded by status, and they cluster when you zoom out. Tap one to open the property without leaving the map.',
    prefer: 'below',
  },
  {
    route: '/map',
    target: 'map-filters',
    title: 'Filter what you are looking at',
    body: 'Today’s route, everything, only the doors nobody has knocked, or only the leads still open. The map redraws as you tap.',
    prefer: 'below',
  },
  {
    route: '/map',
    target: 'map-search',
    title: 'Find an address',
    body: 'Searches your own leads first, then the wider world. A result you already own opens the lead rather than dropping a pin.',
    prefer: 'below',
  },
  {
    route: '/map',
    target: 'map-locate',
    title: 'Snap back to yourself',
    body: 'Recentres on your position. Useful after you have panned across a neighbourhood looking for the next street.',
    prefer: 'above',
  },
]

const LEADS: TourStep[] = [
  {
    route: '/leads',
    target: 'leads-search',
    title: 'Search every lead',
    body: 'Address or owner name. This is the fastest way back to a specific house when someone calls you about it.',
    prefer: 'below',
  },
  {
    route: '/leads',
    target: 'leads-sort',
    title: 'Sort by what matters now',
    body: 'Nearest for working a street, best score for cherry-picking, value for the biggest jobs, recent for what you touched today.',
    prefer: 'below',
  },
  {
    route: '/leads',
    target: 'leads-row',
    title: 'What a lead row tells you',
    body: 'Distance, owner, status and the score bar — the whole picture without opening anything. Swipe a row to call or start a visit.',
    prefer: 'below',
  },
]

const PIPELINE: TourStep[] = [
  {
    route: '/pipeline',
    target: 'pipeline-stages',
    title: 'The funnel, by stage',
    body: 'New through Won, with the count and the money in each. Tap a stage to see the leads sitting in it.',
    prefer: 'below',
  },
]

const STANDINGS: TourStep[] = [
  {
    route: '/standings',
    target: 'standings-board',
    title: 'The day is scored',
    body: 'Points for doors, conversations, appointments and sales. Tap anyone to see their day.',
    prefer: 'above',
  },
]

const MORE_SHARED: TourStep[] = [
  {
    route: '/more',
    target: 'more-avatar',
    title: 'Your profile photo',
    body: 'Tap your initials to add a photo. It shows next to your name on the board and anywhere your team sees you.',
    prefer: 'below',
  },
  {
    route: '/more',
    target: 'more-sync',
    title: 'What is saved, and what is waiting',
    body: 'Everything cached on this phone, and anything still queued to upload. If a number here is stuck, this is where you will see it.',
    prefer: 'below',
  },
]

/* --- the rep's day -------------------------------------------------------- */

export const REP_STEPS: TourStep[] = [
  {
    route: '/today',
    target: 'progress',
    title: 'Your day at a glance',
    body: 'Doors knocked out of doors planned, and how many are left. This is the number that moves as you work.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'conversations',
    title: 'Conversations, not just knocks',
    body: 'How many doors actually opened, and what the resulting pipeline is worth. Knocks are effort; this is progress.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'next-stop',
    title: 'The app picks the next door',
    body: 'Your route is ordered by distance, so the closest unknocked door is always on top.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'navigate',
    title: 'Walking directions',
    body: 'Hands the address to your maps app. Come back and the door is still waiting where you left it.',
    prefer: 'above',
  },
  {
    route: '/today',
    target: 'start-visit',
    title: 'One tap starts the knock',
    body: 'Tap this on the doorstep. A timer runs, and when you are done you record what happened — interested, not home, sold — in two taps.',
    prefer: 'above',
  },
  {
    route: '/today',
    target: 'sync',
    title: 'No signal is not a problem',
    body: 'Everything you record is saved on this phone first and uploads itself when you get bars back. Keep knocking in a dead zone; nothing is lost.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'appointments',
    title: 'Appointments today',
    body: 'What you have booked, and when. Set one from any visit and it lands here.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'followups',
    title: 'Follow-ups you owe',
    body: 'Callbacks and second visits, oldest first. Overdue ones say so, because the whole job is coming back when you said you would.',
    prefer: 'below',
  },
  ...MAP,
  ...LEADS,
  {
    route: '/route',
    target: 'route-list',
    title: 'The whole route',
    body: 'Every stop in order, with what happened at each. Skip one and it moves to the end rather than disappearing.',
    prefer: 'below',
  },
  ...PIPELINE,
  ...STANDINGS,
  {
    route: '/today',
    target: 'quick-actions',
    title: 'Add anything, from anywhere',
    body: 'A lead, an appointment, a follow-up. This button is on every screen so a name shouted through a door does not have to be remembered.',
    prefer: 'above',
  },
  ...MORE_SHARED,
  {
    route: '/more',
    target: 'more-offline-maps',
    title: 'Take the map with you',
    body: 'Download the streets you are working before you leave signal. The map still draws underground, in a basement, or out where there is nothing.',
    prefer: 'above',
  },
]

/* --- the office's day ----------------------------------------------------- */

export const OFFICE_STEPS: TourStep[] = [
  {
    route: '/today',
    target: 'overview-kpis',
    title: 'The company, today',
    body: 'Doors, conversations, appointments and revenue across everyone who is out. This is the number you check first.',
    prefer: 'below',
  },
  {
    route: '/today',
    target: 'overview-team',
    title: 'Who is out, and how they are doing',
    body: 'Each rep with their route progress and today’s outcomes. Tap one to open their day.',
    prefer: 'below',
  },
  {
    route: '/team',
    target: 'team-list',
    title: 'The team screen',
    body: 'The same people in more detail — stops done, conversations, and the doors they have just knocked. It updates as their phones sync.',
    prefer: 'below',
  },
  ...MAP,
  ...LEADS,
  ...PIPELINE,
  ...STANDINGS,
  ...MORE_SHARED,
  {
    route: '/more',
    target: 'nav-more',
    title: 'And the console',
    body: 'Assigning work, importing leads, drawing territories, adding people and pulling reports all live in the console — under More, or on the left on a bigger screen.',
    prefer: 'above',
  },
  {
    route: '/admin',
    target: 'console-tabs',
    title: 'Everything the office needs',
    body: 'Dashboard, reports, team, leads, territories, import, settings. Each one is a full screen; this is the map of them.',
    prefer: 'below',
  },
  {
    route: '/admin',
    target: 'console-kpis',
    title: 'Performance over time',
    body: 'The last 7, 14 or 30 days, compared against the period before it — so a bad week reads as a bad week rather than as a number.',
    prefer: 'below',
  },
  {
    route: '/admin/team',
    target: 'console-team',
    title: 'People',
    body: 'Add a rep, send an invite, deactivate someone who has left. An invited person sets their own password; nobody types one for them.',
    prefer: 'below',
  },
  {
    route: '/admin/leads',
    target: 'console-leads',
    title: 'Assigning the work',
    body: 'Every lead in the company, filterable, and assignable to a rep in bulk. This is where a rep’s route comes from.',
    prefer: 'below',
  },
  {
    route: '/admin/territories',
    target: 'console-territories',
    title: 'Territories',
    body: 'Draw an outline on the map and every lead inside it becomes one patch, assigned to one rep. Beats sorting by postcode.',
    prefer: 'below',
  },
  {
    route: '/admin/import',
    target: 'console-import',
    title: 'Bringing leads in',
    body: 'Drop a CSV from any list provider. It reads the headings, shows you what it matched, and geocodes the addresses as it goes.',
    prefer: 'below',
  },
]

export function stepsFor(role: Role): TourStep[] {
  return role === 'field_rep' ? REP_STEPS : OFFICE_STEPS
}

/** Bumped only when the steps change enough that people should see it again. */
export const TOUR_VERSION = 2
export const TOUR_KEY = `allstar.tour.v${TOUR_VERSION}`
