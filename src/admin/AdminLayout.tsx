import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { useMediaQuery } from '../lib/useMediaQuery'
import { Button } from '../components/ui/Button'
import type { Role } from '../types'

/**
 * The office console.
 *
 * This is the one part of the product that is deliberately **desktop-first**.
 * Everywhere else, mobile is the design and desktop is the enhancement; here
 * the work itself — comparing reps across a month, reassigning territories,
 * auditing configuration — is dense, wide, and done sitting down.
 *
 * Rather than cram that onto a phone badly, a phone gets an honest handoff to
 * the mobile screens that actually answer the on-the-go questions.
 */

interface Item {
  to: string
  label: string
  roles: Role[]
}

const NAV: Item[] = [
  { to: '/admin', label: 'Dashboard', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/reports', label: 'Reports', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/team', label: 'Team', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/territories', label: 'Territories', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/import', label: 'Import leads', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/audit', label: 'Activity log', roles: ['client_admin', 'super_admin'] },
  { to: '/admin/settings', label: 'Settings', roles: ['client_admin', 'super_admin'] },
  { to: '/admin/clients', label: 'Clients', roles: ['super_admin'] },
]

export const ADMIN_ROLES: Role[] = ['manager', 'client_admin', 'super_admin']

export function AdminLayout() {
  const user = useAppStore((s) => s.user)
  const nav = useNavigate()
  // 1024px: below this there isn't room for a table that's worth reading.
  const wideEnough = useMediaQuery('(min-width: 1024px)')

  if (!user) return null

  if (!ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-lg font-bold">Not available for your role</p>
          <p className="mt-1 text-sm text-ink-mute">
            The console is for managers and administrators.
          </p>
          <Button className="mt-4" onClick={() => nav('/today')}>
            Back to Today
          </Button>
        </div>
      </div>
    )
  }

  if (!wideEnough) {
    return (
      <div className="scroll-pane grid place-items-center p-8 text-center">
        <div className="max-w-sm">
          <span className="text-3xl" aria-hidden>
            🖥
          </span>
          <h1 className="mt-3 text-xl font-bold">Open the console on a larger screen</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-mute">
            User management, territories and reporting are built for a desktop — wide
            tables and month-long comparisons. Squeezing them onto a phone would make
            both worse.
          </p>
          <p className="mt-4 text-sm font-medium">On this phone you can still:</p>
          <div className="mt-2 space-y-2">
            <Button variant="secondary" full onClick={() => nav('/today')}>
              See today’s company overview
            </Button>
            <Button variant="secondary" full onClick={() => nav('/team')}>
              Check what the team is doing
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const items = NAV.filter((i) => i.roles.includes(user.role))

  return (
    <div className="flex min-h-0 flex-1 bg-surface-sunk">
      <nav className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-surface px-3 py-4">
        <div className="mb-5 px-2">
          <p className="text-sm font-bold">{user.clientName}</p>
          <p className="text-xs text-ink-mute">Console</p>
        </div>

        {items.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            end={i.to === '/admin'}
            className={({ isActive }) =>
              [
                'mb-0.5 flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium',
                isActive ? 'bg-brand-50 text-brand-600' : 'text-ink-mute hover:bg-slate-50',
              ].join(' ')
            }
          >
            {i.label}
          </NavLink>
        ))}

        <div className="mt-auto border-t border-slate-100 pt-3">
          <button
            onClick={() => nav('/today')}
            className="focusable flex min-h-[40px] w-full items-center rounded-lg px-3 text-sm font-medium text-ink-mute hover:bg-slate-50"
          >
            ← Field app
          </button>
          <p className="mt-2 px-3 text-xs text-ink-mute">
            {user.name}
            <br />
            <span className="capitalize">{user.role.replace('_', ' ')}</span>
          </p>
        </div>
      </nav>

      <main className="scroll-pane">
        <Outlet />
      </main>
    </div>
  )
}

/** Shared page frame so every console screen lines up. */
export function AdminPage({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-[1200px] p-6 xl:p-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black leading-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-mute">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** Filters live in one row above the cards, never inside a chart card. */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>
}
