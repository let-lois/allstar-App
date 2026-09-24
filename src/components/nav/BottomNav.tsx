import { NavLink, useLocation } from 'react-router-dom'
import type { Role } from '../../types'
import { NavBadge } from './NavBadge'
import { useSync } from '../sync/SyncBadge'
import {
  IconLeads,
  IconMap,
  IconMore,
  IconPipeline,
  IconToday,
} from './icons'
import { Wordmark } from '../ui/Wordmark'
import { isNativeShell } from '../../lib/webview'
// Imported, not `/icon-192.png`: see the note in ui/Wordmark.tsx.
import appIconUrl from '../../assets/icon-192.png'

interface Item {
  to: string
  label: string
  Icon: () => React.JSX.Element
}

/**
 * Bottom navigation.
 *
 * Five destinations, always in thumb range. Field reps get the field set; the
 * office roles get a set that matches what they actually do on a phone (check
 * on the team) rather than a shrunken copy of their desktop console.
 */
const REP_ITEMS: Item[] = [
  { to: '/today', label: 'Today', Icon: IconToday },
  { to: '/map', label: 'Map', Icon: IconMap },
  { to: '/leads', label: 'Leads', Icon: IconLeads },
  { to: '/pipeline', label: 'Pipeline', Icon: IconPipeline },
  { to: '/more', label: 'More', Icon: IconMore },
]

const OFFICE_ITEMS: Item[] = [
  { to: '/today', label: 'Overview', Icon: IconToday },
  { to: '/team', label: 'Team', Icon: IconLeads },
  { to: '/map', label: 'Map', Icon: IconMap },
  { to: '/pipeline', label: 'Pipeline', Icon: IconPipeline },
  { to: '/more', label: 'More', Icon: IconMore },
]

export function navItemsForRole(role: Role): Item[] {
  return role === 'field_rep' ? REP_ITEMS : OFFICE_ITEMS
}

export function BottomNav({ role }: { role: Role }) {
  const items = navItemsForRole(role)
  const { pathname } = useLocation()
  /*
    The only counter with anything real behind it.
    Uploads that failed are the one thing a rep must notice and can act on — they
    live behind More, so that is where the pip goes. Inventing counts for the
    other destinations would make the badge decoration and teach reps to ignore
    it, which is worse than not having one.
  */
  const failedUploads = useSync().failed

  // Visit Mode and the capture flows are full-attention screens — the nav would
  // only offer a way to lose work halfway through.
  if (/^\/(visit|capture)/.test(pathname)) return null

  return (
    <nav
      /*
        A lit capsule floating on the ground, not a bar welded to the bottom
        edge — see `.nav-dock`. It is still a flex child rather than fixed, so it
        occupies its own space and nothing underneath needs to know it moved.

        The safe-area inset is a *margin* here rather than padding: the dock has
        a visible bottom edge now, and padding would stretch the capsule down
        behind the home indicator instead of standing clear of it.
      */
      className="nav-dock z-30 mx-3 shrink-0 md:hidden"
      style={{ marginBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}
      aria-label="Primary"
    >
      <ul className="flex px-2 pb-2 pt-2.5">
        {items.map(({ to, label, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              /* The tour points at these by route, so it survives a relabel. */
              data-tour={`nav-${to.replace('/', '') || 'today'}`}
              aria-label={
                to === '/more' && failedUploads > 0
                  ? `${label}, ${failedUploads} uploads failed`
                  : undefined
              }
              className={({ isActive }) =>
                [
                  'focusable relative flex min-h-[68px] flex-col items-center justify-center gap-1.5',
                  'rounded-pill text-[11px] transition-colors',
                  // The label follows the icon: teal and semibold when selected,
                  // quiet otherwise. Weight carries as much of this as colour
                  // does, which is what keeps it legible in sunlight.
                  //
                  // Resting labels sit on `ink-soft` rather than `ink-mute`: the
                  // dock is darker than the bar it replaced, and mute on that
                  // fill is a step too quiet to scan at arm's length.
                  isActive ? 'font-semibold text-accent' : 'font-medium text-ink-soft',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <NavBadge
                    to={to}
                    active={isActive}
                    count={to === '/more' ? failedUploads : undefined}
                  >
                    <Icon />
                  </NavBadge>
                  <span className="leading-none">{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * Tablet / desktop rail. Same destinations, but persistent and paired with the
 * wider layouts — office roles live here, reps never see it on a phone.
 */
export function SideRail({ role }: { role: Role }) {
  const items = navItemsForRole(role)
  /*
    Office roles only, and only where the console exists.

    The role half has always been right. The second half was missing, and it is
    the same bug `More` was fixed for — fixed there and nowhere else, because
    that is where somebody reported it from.

    Metro swaps `src/adminRoutes.tsx` for a stub in the native bundle (see
    `apps/mobile/metro.config.js`), so inside the shell `/admin` is not a route:
    `App`'s catch-all quietly sends it to `/today`. This rail is `hidden md:flex`,
    which kept the dead link off a phone and left it on every wider screen the
    shell can run on — an Android tablet, or a device in a large display mode. A
    manager taps Console and lands on the rep's own Today screen with nothing
    saying why, which is worse than a control that is simply not there.

    Hidden rather than disabled, for the reason `More` gives: a greyed-out row
    invites the same tap and answers nothing. `More` carries the sentence about
    where the console actually is, and it is on the same screen in the same
    shell, so it is not repeated here.
  */
  const showConsole = role !== 'field_rep' && !isNativeShell()
  return (
    <nav
      className="nav-rail hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4 md:flex lg:w-56 lg:items-stretch lg:px-3"
      aria-label="Primary"
    >
      {/*
        The rail collapses to 76px on tablets, where a wordmark would be
        unreadable — so the icon carries the brand at that width and the full
        mark appears only once there is room for it.
      */}
      {/* px matches the nav links below so the mark and the icons share a left edge. */}
      <div className="mb-5 flex items-center px-1 lg:px-3">
        <img
          src={appIconUrl}
          alt=""
          width={192}
          height={192}
          className="h-9 w-9 shrink-0 rounded-field lg:hidden"
        />
        {/* On its own tile: the rail is near-black and the mark's type is black. */}
        <Wordmark width={148} className="hidden lg:inline-flex" />
      </div>
      {items.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex min-h-[52px] items-center gap-3 rounded-field px-2 text-sm font-semibold lg:justify-start',
              'justify-center',
              // At rail width the pill alone is too quiet, so the whole row
              // tints — same two colours, more surface.
              isActive
                ? 'bg-surface-tint text-accent'
                : 'text-ink-mute hover:bg-surface-field',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              <NavBadge to={to} active={isActive} size={38}>
                <Icon />
              </NavBadge>
              <span className="hidden lg:block">{label}</span>
            </>
          )}
        </NavLink>
      ))}

      {/* The office console is a separate, desktop-first surface — it gets its
          own entry rather than sitting in the field navigation. */}
      {showConsole && (
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            [
              'mt-auto flex min-h-[52px] items-center justify-center gap-3 rounded-field px-2 text-sm font-semibold lg:justify-start',
              isActive
                ? 'bg-surface-tint text-accent'
                : 'text-ink-mute hover:bg-surface-field',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              <NavBadge to="/admin" active={isActive} size={38}>
                <IconPipeline />
              </NavBadge>
              <span className="hidden lg:block">Console</span>
            </>
          )}
        </NavLink>
      )}
    </nav>
  )
}
