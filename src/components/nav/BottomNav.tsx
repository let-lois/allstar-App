import { NavLink, useLocation } from 'react-router-dom'
import type { Role } from '../../types'
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

  // Visit Mode and the capture flows are full-attention screens — the nav would
  // only offer a way to lose work halfway through.
  if (/^\/(visit|capture)/.test(pathname)) return null

  return (
    <nav
      className="z-30 shrink-0 border-t border-slate-200 bg-surface/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Primary"
    >
      <ul className="flex">
        {items.map(({ to, label, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              className={({ isActive }) =>
                [
                  'flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
                  isActive ? 'text-brand-500' : 'text-ink-mute',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <span className={isActive ? 'scale-105' : ''}>
                    <Icon />
                  </span>
                  <span>{label}</span>
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
      className="hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-surface py-4 md:flex lg:w-56 lg:items-stretch lg:px-3"
      aria-label="Primary"
    >
      <div className="mb-4 flex items-center gap-2 px-1 lg:px-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink text-sm font-bold text-white">
          A
        </span>
        <span className="hidden text-sm font-bold lg:block">Allstar</span>
      </div>
      {items.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex min-h-tap items-center gap-3 rounded-xl px-3 text-sm font-medium lg:justify-start',
              'justify-center',
              isActive ? 'bg-brand-50 text-brand-600' : 'text-ink-mute hover:bg-slate-50',
            ].join(' ')
          }
        >
          <Icon />
          <span className="hidden lg:block">{label}</span>
        </NavLink>
      ))}

      {/* The office console is a separate, desktop-first surface — it gets its
          own entry rather than sitting in the field navigation. */}
      {showConsole && (
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            [
              'mt-auto flex min-h-tap items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium lg:justify-start',
              isActive ? 'bg-brand-50 text-brand-600' : 'text-ink-mute hover:bg-slate-50',
            ].join(' ')
          }
        >
          <IconPipeline />
          <span className="hidden lg:block">Console</span>
        </NavLink>
      )}
    </nav>
  )
}
