import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { BottomSheet } from '../components/ui/BottomSheet'
import { useAppStore } from '../store/useAppStore'
import { useTeamStats } from '../store/teamStats'
import { useRepRangeRows, RANGES, type RangeKey } from './useAdminData'
import { FIELD_REPS, DEMO_USERS } from '../data/seed'
import { money, relative } from '../lib/format'
import { STATUS } from './charts/tokens'
import { InviteDialog } from './InviteDialog'
import { ManageUser } from './ManageUser'
import { apiUsers, type TeamUserDTO } from '../lib/http'
import { liveToken } from '../lib/session'
import type { Role } from '../types'

/**
 * User management.
 *
 * The table is the product here: one row per person, every column a number a
 * manager actually acts on, and the row itself the handle for changing
 * assignment or access. Deliberately dense — this is the screen where density
 * is the feature, not a compromise.
 */

const ROLE_LABEL: Record<Role, string> = {
  field_rep: 'Field Rep',
  manager: 'Manager',
  client_admin: 'Client Admin',
  super_admin: 'Super Admin',
}

interface Member {
  id: string
  name: string
  initials: string
  role: Role
  email?: string
  phone?: string
  territory?: string
  active: boolean
  /** Invited but hasn't set a password yet — distinct from deactivated. */
  pending?: boolean
}

const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function AdminTeam() {
  const [range, setRange] = useState<RangeKey>('14d')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  const [editing, setEditing] = useState<Member | null>(null)
  const [inviting, setInviting] = useState(false)

  const properties = useAppStore((s) => s.properties)
  const territories = useAppStore((s) => s.territories)
  const mode = useAppStore((s) => s.mode)
  const signedInUser = useAppStore((s) => s.user)
  const today = useTeamStats()
  const rangeRows = useRepRangeRows(range)

  /*
    On a live account the roster is the real one. The seeded version below is
    kept for the demo, where there is no server to ask and the pitch depends on
    a full team being visible.
  */
  const [live, setLive] = useState<TeamUserDTO[] | null>(null)
  const loadRoster = useCallback(() => {
    if (mode !== 'live') return
    const token = liveToken()
    if (!token) return
    void apiUsers(token)
      .then(({ users }) => setLive(users))
      .catch(() => setLive([]))
  }, [mode])
  useEffect(loadRoster, [loadRoster])

  /**
   * The roster.
   *
   * Live: whoever actually has an account, straight from the server, including
   * people who were invited and haven't accepted yet — "hasn't set a password"
   * and "was switched off" look identical in a list that only has an active
   * flag, and an admin chasing a rep who never got their link needs to tell
   * those apart.
   *
   * Demo: assembled from the seed, because the pitch needs a full team and there
   * is no server to ask.
   */
  const members = useMemo<Member[]>(() => {
    const territoryOf = (userId: string) => {
      const owned = Object.values(properties).filter((p) => p.assignedRepId === userId)
      const ids = [...new Set(owned.map((p) => p.territoryId).filter(Boolean))] as string[]
      const named = ids.map((id) => territories[id]?.name ?? id)
      if (named.length === 0) return owned.length ? `${owned.length} unassigned leads` : undefined
      return named.join(', ')
    }

    if (mode === 'live') {
      return (live ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        initials: initialsOf(u.name),
        role: u.role,
        email: u.email,
        phone: u.phone,
        territory: territoryOf(u.id),
        // The raw flag, not `active && !pending`. Collapsing them loses the
        // difference between "switched off" and "never accepted their invite",
        // and the manage panel then offers to restore access to somebody whose
        // access was never taken away.
        active: u.active,
        pending: u.pending,
      }))
    }

    const repRows: Member[] = FIELD_REPS.map((r) => ({
      id: r.id,
      name: r.name,
      initials: r.initials,
      role: 'field_rep' as const,
      phone: r.phone,
      email: `${r.name.split(' ')[0].toLowerCase()}@summitexteriors.com`,
      territory: territoryOf(r.id),
      active: true,
    }))
    const office: Member[] = DEMO_USERS.filter((u) => u.role !== 'field_rep').map((u) => ({
      id: u.id,
      name: u.name,
      initials: u.avatarInitials,
      role: u.role,
      email: u.email,
      active: true,
    }))
    return [...repRows, ...office]
  }, [properties, territories, mode, live])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return members.filter(
      (m) =>
        (roleFilter === 'all' || m.role === roleFilter) &&
        (!q || m.name.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q)),
    )
  }, [members, query, roleFilter])

  const rangeById = new Map(rangeRows.map((r) => [r.id, r]))
  const todayById = new Map(today.map((r) => [r.id, r]))

  return (
    <AdminPage
      title="Team"
      description={`${members.length} ${members.length === 1 ? 'person' : 'people'} · ${
        members.filter((m) => m.role === 'field_rep').length
      } in the field`}
      actions={
        <Button size="sm" onClick={() => setInviting(true)}>
          Invite user
        </Button>
      }
    >
      <FilterBar>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          placeholder="Search name or email"
          className="focusable min-h-[40px] w-64 rounded-xl border border-slate-200 px-3 text-sm"
        />
        {(['all', 'field_rep', 'manager', 'client_admin'] as const).map((r) => (
          <Chip key={r} size="sm" selected={roleFilter === r} onClick={() => setRoleFilter(r)}>
            {r === 'all' ? 'All roles' : ROLE_LABEL[r]}
          </Chip>
        ))}
        <span className="mx-2 h-6 w-px bg-slate-200" />
        {RANGES.map((r) => (
          <Chip key={r.key} size="sm" selected={range === r.key} onClick={() => setRange(r.key)}>
            {r.label}
          </Chip>
        ))}
      </FilterBar>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              <th className="px-5 py-2.5 text-left font-semibold">Name</th>
              <th className="px-3 py-2.5 text-left font-semibold">Role</th>
              <th className="px-3 py-2.5 text-left font-semibold">Territory</th>
              <th className="px-3 py-2.5 text-right font-semibold">Today</th>
              <th className="px-3 py-2.5 text-right font-semibold">Doors</th>
              <th className="px-3 py-2.5 text-right font-semibold">Contact rate</th>
              <th className="px-3 py-2.5 text-right font-semibold">Won</th>
              <th className="px-3 py-2.5 text-left font-semibold">Status</th>
              <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const r = rangeById.get(m.id)
              const t = todayById.get(m.id)
              const isRep = m.role === 'field_rep'
              return (
                <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-600">
                        {m.initials}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium">{m.name}</span>
                        <span className="block truncate text-xs text-ink-mute">{m.email}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-ink-mute">{ROLE_LABEL[m.role]}</td>
                  <td className="px-3 py-3 text-ink-mute">{m.territory ?? '—'}</td>
                  <td className="nums px-3 py-3 text-right">
                    {isRep && t ? `${t.done}/${t.total}` : '—'}
                  </td>
                  <td className="nums px-3 py-3 text-right">
                    {isRep && r ? r.knocks.toLocaleString() : '—'}
                  </td>
                  <td className="nums px-3 py-3 text-right font-semibold">
                    {isRep && r ? `${r.contactRate}%` : '—'}
                  </td>
                  <td className="nums px-3 py-3 text-right">{isRep && r ? r.sold : '—'}</td>
                  <td className="px-3 py-3">
                    {/* Status carries an icon and a word — never color alone. */}
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: m.pending
                            ? STATUS.warning
                            : m.active
                              ? STATUS.good
                              : STATUS.serious,
                        }}
                      />
                      {m.pending ? 'Invite pending' : m.active ? 'Active' : 'Deactivated'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setEditing(m)}
                      className="focusable min-h-[32px] rounded-lg px-2 text-xs font-semibold text-brand-600 hover:bg-brand-50"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-8 text-center text-sm text-ink-mute">
            {members.length === 0
              ? 'Nobody on the team yet. Invite your first rep to get started.'
              : 'No one matches those filters.'}
          </p>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-mute">
        {mode === 'live'
          ? 'Manage a person to reset their password, remove them, or delete the account. Role changes are still read-only.'
          : 'Demo roster. Managing people needs a live account.'}
      </p>

      {inviting && (
        <InviteDialog onClose={() => setInviting(false)} onInvited={loadRoster} />
      )}

      <BottomSheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name}
        detents={[0.7]}
      >
        {editing && (
          <MemberDetail
            member={editing}
            mode={mode}
            signedInId={signedInUser?.id}
            onChanged={() => {
              loadRoster()
              setEditing(null)
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </BottomSheet>
    </AdminPage>
  )
}

function MemberDetail({
  member,
  mode,
  signedInId,
  onChanged,
  onClose,
}: {
  member: Member
  mode: 'demo' | 'live'
  signedInId?: string
  onChanged: () => void
  onClose: () => void
}) {
  const today = useTeamStats().find((r) => r.id === member.id)
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 font-bold text-brand-600">
          {member.initials}
        </span>
        <div>
          <p className="font-bold">{member.name}</p>
          <p className="text-xs text-ink-mute">
            {ROLE_LABEL[member.role]}
            {member.email && ` · ${member.email}`}
          </p>
        </div>
      </div>

      {today && (
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-surface-sunk p-3 text-sm">
          <div>
            <dt className="text-xs text-ink-mute">Route today</dt>
            <dd className="nums font-semibold">
              {today.done}/{today.total} stops
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Conversations</dt>
            <dd className="nums font-semibold">{today.conversations}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Pipeline today</dt>
            <dd className="nums font-semibold">{money(today.pipelineToday)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Last activity</dt>
            <dd className="font-semibold">{relative(today.lastActivityAt)}</dd>
          </div>
        </dl>
      )}

      {mode === 'live' ? (
        <ManageUser
          user={{
            id: member.id,
            name: member.name,
            email: member.email,
            role: member.role,
            active: member.active,
            pending: member.pending,
          }}
          isSelf={member.id === signedInId}
          onChanged={onChanged}
          onClose={onClose}
        />
      ) : (
        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
          This is the demo roster — nobody here has a real account, so there's nothing to
          reset or remove. Sign in with real credentials to manage people.
        </p>
      )}

      <p className="text-xs text-ink-mute">
        Role changes are still read-only. A control that silently discards input is worse
        than one that says so.
      </p>
    </div>
  )
}
