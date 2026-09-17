import { AdminPage } from './AdminLayout'
import { StatTile } from './charts/StatTile'
import { BackupStatus } from './BackupStatus'
import { useAppStore } from '../store/useAppStore'
import { relative } from '../lib/format'

/**
 * Platform view — Super Admin only.
 *
 * Enforced by AdminLayout, from the same NAV table that hides the link — not
 * here. A second check on the screen would be a second source of truth, and two
 * sources of truth disagreeing is exactly how this went wrong.
 *
 * That line was a comment and nothing else for a while. The console's nav hides
 * this entry from everyone below super admin, which hides the door without
 * locking it: `AdminLayout` admits managers and client admins, so typing the
 * URL rendered the whole screen. Nothing real leaked, because the numbers below
 * are a hardcoded illustration — but a company's own admin seeing what looks
 * like other customers' seat counts and revenue is wrong on its face, and it
 * would have become an actual leak on the day this is wired to an API.
 *
 * Deliberately thin, and honest about why: with a single-tenant local dataset
 * there is no second client's data to aggregate. The shape is real (accounts,
 * seats, activity health, revenue) so it slots onto a multi-tenant API without
 * redesign, but the numbers beyond Summit Exteriors are illustrative and the
 * screen says so rather than implying the platform already has three customers.
 */

const WEEK = 7 * 24 * 60 * 60 * 1000

export function AdminClients() {
  const team = useAppStore((s) => s.team)
  const user = useAppStore((s) => s.user)

  const onTeam = team.filter((m) => !m.pending)
  const active = onTeam.filter((m) => m.active)
  const since = Date.now() - WEEK
  const recent = active.filter((m) => typeof m.lastSeenAt === 'number' && m.lastSeenAt >= since)
  const lastSeen = onTeam
    .map((m) => m.lastSeenAt)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => b - a)[0]

  return (
    <AdminPage title="Account" description="What this deployment holds">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Accounts" value="1" />
        <StatTile label="On the team" value={String(onTeam.length)} />
        <StatTile
          label="Active"
          value={String(active.length)}
          sub={onTeam.length ? `of ${onTeam.length} on the team` : undefined}
        />
        <StatTile
          label="Seen this week"
          value={String(recent.length)}
          sub={active.length ? `${Math.round((recent.length / active.length) * 100)}% of active` : undefined}
        />
      </div>

      <section className="mt-4 card p-5" data-testid="account-row">
        <h2 className="text-sm font-bold">{user?.clientName ?? 'This account'}</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-mute">
          {onTeam.length === 1 ? '1 person on the team' : `${onTeam.length} people on the team`}
          {active.length !== onTeam.length ? `, ${active.length} active` : ''}
          {lastSeen ? ` · last activity ${relative(lastSeen)}` : ' · no activity recorded yet'}
        </p>
      </section>

      {/*
        The one thing on this screen that was always real. It sits here rather
        than in a company's own settings because the dump is the whole
        database, and this is the only role with a platform-wide view.
      */}
      <BackupStatus />

      <p className="mt-4 rounded-field bg-surface-sunk px-4 py-3 text-xs leading-relaxed text-ink-mute">
        One account, because that is what this deployment holds and there is no endpoint that
        would list others. Seats, revenue and per-customer health belong to a multi-tenant API
        that does not exist yet; when it does, the numbers above become a row per account.
      </p>
    </AdminPage>
  )
}
