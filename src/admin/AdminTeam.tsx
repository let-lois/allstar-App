import { useMemo, useState } from 'react'
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
}

export function AdminTeam() {
  const [range, setRange] = useState<RangeKey>('14d')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  const [editing, setEditing] = useState<Member | null>(null)

  const properties = useAppStore((s) => s.properties)
  const today = useTeamStats()
  const rangeRows = useRepRangeRows(range)

  /**
   * The roster is assembled from the reps who own territory plus the office
   * users. A real backend would return this directly; the shape is what
   * matters for the UI.
   */
  const members = useMemo<Member[]>(() => {
    const repRows: Member[] = FIELD_REPS.map((r) => {
      const owned = Object.values(properties).filter((p) => p.assignedRepId === r.id)
      const territories = [...new Set(owned.map((p) => p.territoryId).filter(Boolean))]
      return {
        id: r.id,
        name: r.name,
        initials: r.initials,
        role: 'field_rep',
        phone: r.phone,
        email: `${r.name.split(' ')[0].toLowerCase()}@summitexteriors.com`,
        territory: territories.join(', ') || undefined,
        active: true,
      }
    })
    const office: Member[] = DEMO_USERS.filter((u) => u.role !== 'field_rep').map((u) => ({
      id: u.id,
      name: u.name,
      initials: u.avatarInitials,
      role: u.role,
      email: u.email,
      active: true,
    }))
    return [...repRows, ...office]
  }, [properties])

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
      description={`${members.length} people · ${FIELD_REPS.length} in the field`}
      actions={<Button size="sm">Invite user</Button>}
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
                          backgroundColor: m.active ? STATUS.good : STATUS.warning,
                        }}
                      />
                      {m.active ? 'Active' : 'Invited'}
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
          <p className="p-8 text-center text-sm text-ink-mute">No one matches those filters.</p>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-mute">
        Role changes, territory reassignment and deactivation are recorded against the
        acting admin once the backend lands.
      </p>

      <BottomSheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name}
        detents={[0.7]}
      >
        {editing && <MemberDetail member={editing} />}
      </BottomSheet>
    </AdminPage>
  )
}

function MemberDetail({ member }: { member: Member }) {
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

      <div className="space-y-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
            Role
          </span>
          <select
            defaultValue={member.role}
            className="focusable mt-1 min-h-[40px] w-full rounded-xl border border-slate-200 px-3 text-sm"
          >
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
            Territory
          </span>
          <input
            defaultValue={member.territory ?? ''}
            placeholder="e.g. t_0, t_1"
            className="focusable mt-1 min-h-[40px] w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>
      </div>

      <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
        Editing is read-only until the backend lands — there's nowhere to persist a role
        change yet, and a control that silently discards input is worse than one that
        says so.
      </p>
    </div>
  )
}
