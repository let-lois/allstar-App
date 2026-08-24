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

interface Item {
  to: string
  label: string
  Icon: () => JSX.Element
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
        A hairline, not a shadow. The bar is a boundary between the content and
        the home indicator, and a drop shadow there reads as a floating panel —
        which is what made the old bar feel like a widget bolted to the bottom.
      */
      className="z-30 shrink-0 border-t border-line bg-surface/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Primary"
    >
      <ul className="flex px-1 pb-1 pt-1.5">
        {items.map(({ to, label, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              aria-label={
                to === '/more' && failedUploads > 0
                  ? `${label}, ${failedUploads} uploads failed`
                  : undefined
              }
              className={({ isActive }) =>
                [
                  'focusable relative flex min-h-[58px] flex-col items-center justify-center gap-1',
                  'rounded-pill text-[11px] transition-colors',
                  // The label follows the icon: teal and semibold when selected,
                  // quiet grey otherwise. Weight carries as much of this as
                  // colour does, which is what keeps it legible in sunlight.
                  isActive ? 'font-semibold text-accent' : 'font-medium text-ink-mute',
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
  const showConsole = role !== 'field_rep'
  return (
    <nav
      className="hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4 md:flex lg:w-56 lg:items-stretch lg:px-3"
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
          src="/icon-192.png"
          alt=""
          width={192}
          height={192}
          className="h-9 w-9 shrink-0 rounded-field lg:hidden"
        />
        <img
          src="/logo.png"
          alt="Allstar Home Solutions"
          width={720}
          height={184}
          className="hidden h-auto w-[164px] lg:block"
        />
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
