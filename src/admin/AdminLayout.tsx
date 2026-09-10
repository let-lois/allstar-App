import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { IconBack } from '../components/nav/icons'
import type { Role } from '../types'

/**
 * The office console.
 *
 * **Mobile first, like the rest of the product.** This used to be the one
 * deliberate exception: below 1024px it refused to render and handed off to the
 * field screens instead, on the reasoning that comparing reps across a month is
 * dense work done sitting down.
 *
 * That reasoning described the *desk* half of the job and missed the other half.
 * An owner approves a lead import from a truck. A manager reassigns a territory
 * when a rep calls in sick, at seven in the morning, from a kitchen. Those are
 * not desk tasks that happen to be possible on a phone — they are the tasks that
 * are urgent, and urgency is exactly when nobody is at a desk. A console that
 * refuses to open is not neutral in that moment; it sends someone to find a
 * laptop.
 *
 * So the mobile layout is the design and the wide one is the enhancement:
 *
 *   - Nine sections is too many for a bar of five, so on a phone they are a
 *     scrolling row of chips under the header. Every section is one tap, and the
 *     row remembers nothing — where you are is where the chip is.
 *   - Tables become lists. A table is a comparison instrument and a phone cannot
 *     hold one; the same rows as cards answer "what is this one" instead, which
 *     is the question a phone is usually being asked.
 *   - The side rail comes back at `md`, and the tables with it at `lg`.
 *
 * The role gate is unchanged and is the part that matters: a field rep cannot
 * reach this by nav or by typing the URL.
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
  { to: '/admin/leads', label: 'Leads', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/territories', label: 'Territories', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/lists', label: 'Lists', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/import', label: 'Import leads', roles: ['manager', 'client_admin', 'super_admin'] },
  { to: '/admin/audit', label: 'Activity log', roles: ['client_admin', 'super_admin'] },
  { to: '/admin/settings', label: 'Settings', roles: ['client_admin', 'super_admin'] },
  { to: '/admin/clients', label: 'Clients', roles: ['super_admin'] },
]

export const ADMIN_ROLES: Role[] = ['manager', 'client_admin', 'super_admin']

export function AdminLayout() {
  const user = useAppStore((s) => s.user)
  const nav = useNavigate()
  const location = useLocation()

  if (!user) return null

  if (!ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-lg font-semibold">Not available for your role</p>
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

  const items = NAV.filter((i) => i.roles.includes(user.role))

  /*
    The door is locked by the same table that hides the link.

    These were two separate facts for a long time, and they disagreed: NAV said
    Clients was super-admin only, the sidebar dutifully hid it, and the screen
    itself checked nothing — so typing the URL rendered the whole thing. Its own
    docstring said "Super Admin only" the entire time. A manager could reach the
    activity log and the settings editor the same way.

    Deriving both from one list is what stops that recurring: a route added to
    NAV is navigable by exactly the roles it names, and a screen cannot forget
    to guard itself because it is not the screen doing the guarding.

    Longest match first, so /admin/settings resolves to its own entry rather
    than to /admin, and /admin/team/:id inherits Team's roles.
  */
  const entry = [...NAV]
    .sort((a, b) => b.to.length - a.to.length)
    .find((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`))
  const permitted = !entry || entry.roles.includes(user.role)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-sunk md:flex-row">
      {/*
        --- the phone shell -------------------------------------------------
        A header that says where you are and gets you out, over a scrolling row
        of sections. Nine destinations will not fit a tab bar, and a hamburger
        drawer would hide the whole console behind one more tap on the device
        where taps are most expensive — so the sections are simply visible.
      */}
      <header className="pad-top z-20 shrink-0 border-b border-line bg-surface md:hidden">
        <div className="flex min-h-[54px] items-center gap-2 px-2">
          <button
            onClick={() => nav('/today')}
            aria-label="Back to the field app"
            className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink active:bg-surface-field"
          >
            <IconBack />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">
              {user.clientName}
            </p>
            <p className="truncate text-[12.5px] leading-tight text-ink-mute">Console</p>
          </div>
        </div>
        <div className="snap-x-row px-2 pb-2" data-tour="console-tabs">
          {items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.to === '/admin'}
              className={({ isActive }) =>
                [
                  'focusable flex min-h-[40px] shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-[13px] font-medium',
                  isActive
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-accent/40 bg-surface text-ink-mute active:bg-surface-field',
                ].join(' ')
              }
            >
              {i.label}
            </NavLink>
          ))}
        </div>
      </header>

      <nav className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
        <div className="mb-5 px-2">
          <p className="text-sm font-semibold">{user.clientName}</p>
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
                isActive ? 'bg-surface-tint text-accent' : 'text-ink-mute hover:bg-surface-field',
              ].join(' ')
            }
          >
            {i.label}
          </NavLink>
        ))}

        <div className="mt-auto border-t border-line-soft pt-3">
          <button
            onClick={() => nav('/today')}
            className="focusable flex min-h-[40px] w-full items-center rounded-lg px-3 text-sm font-medium text-ink-mute hover:bg-surface-field"
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

      {/* min-w-0: without it the pane's widest table sets a floor on the flex
          item and pushes the whole console sideways on a phone. */}
      <main className="scroll-pane min-w-0 flex-1">
        {permitted ? (
          <Outlet />
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div className="max-w-sm">
              <p className="text-lg font-semibold">Not available for your role</p>
              <p className="mt-1 text-sm text-ink-mute">
                Ask an administrator if you need access to this section.
              </p>
              <Button className="mt-4" onClick={() => nav('/admin')}>
                Back to the console
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

/** Shared page frame so every console screen lines up. */
export function AdminPage({
  title,
  description,
  actions,
  tour,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  /** A `data-tour` anchor, so the walkthrough can point at a console screen. */
  tour?: string
  children: React.ReactNode
}) {
  return (
    <div
      data-tour={tour}
      className="mx-auto max-w-[1200px] px-4 py-4 md:p-6 xl:p-8"
      /* The field app's bottom bar is absent in here, but a phone still has a
         home indicator to clear at the end of a scroll. */
      style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom, 0px))' }}
    >
      {/*
        The heading is 20px on a phone and 24 on a desktop, and never `font-black`
        — a page title set heavier than everything under it is how a console
        starts reading as a report.
      */}
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3 md:mb-5">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] md:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-[13px] leading-snug text-ink-mute md:text-sm">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** Filters live in one row above the cards, never inside a chart card. */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>
}
