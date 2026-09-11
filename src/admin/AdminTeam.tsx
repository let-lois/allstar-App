import { useCallback, useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { BottomSheet } from '../components/ui/BottomSheet'
import { useAppStore } from '../store/useAppStore'
import { useTeamStats } from '../store/teamStats'
import { useRepRangeRows, RANGES, type RangeKey } from './useAdminData'
import { money, relative } from '../lib/format'
import { STATUS } from './charts/tokens'
import { AddMemberDialog } from './AddMemberDialog'
import { DataList } from './DataList'
import { ManageUser } from './ManageUser'
import { ROLE_LABEL } from '../lib/roles'
import type { Role } from '../types'

/**
 * User management.
 *
 * The table is the product here: one row per person, every column a number a
 * manager actually acts on, and the row itself the handle for changing
 * assignment or access. Deliberately dense — this is the screen where density
 * is the feature, not a compromise.
 */

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
    One roster, held in the store: real on a live account, seeded in the demo.
    This screen used to fetch it itself and Territories fetched it again, so the
    two could disagree and neither cached anything.
  */
  const team = useAppStore((s) => s.team)
  const loadTeam = useAppStore((s) => s.loadTeam)
  const loadRoster = useCallback(() => void loadTeam(), [loadTeam])

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

    return team.map((u) => ({
      id: u.id,
      name: u.name,
      initials: u.initials,
      role: u.role,
      email: u.email,
      phone: u.phone,
      territory: territoryOf(u.id),
      active: u.active,
      pending: u.pending,
    }))
  }, [properties, territories, team])

  const admins = useMemo(
    () =>
      members.filter(
        (m) => (m.role === 'client_admin' || m.role === 'super_admin') && m.active && !m.pending,
      ),
    [members],
  )

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
      tour="console-team"
      title="Team"
      description={`${members.length} ${members.length === 1 ? 'person' : 'people'} · ${
        members.filter((m) => m.role === 'field_rep').length
      } in the field`}
      actions={
        <Button size="sm" onClick={() => setInviting(true)}>
          Add team member
        </Button>
      }
    >
      {/*
        There is no email recovery, so a company with one administrator has one
        password standing between it and losing its own account. Stated where
        the fix is one click away rather than buried in documentation.
      */}
      {mode === 'live' && admins.length === 1 && (
        <div className="mb-4 rounded-field bg-warn-bg p-4 text-sm text-warn ring-1 ring-warn/25">
          <p className="font-semibold">You’re the only administrator.</p>
          <p className="mt-1 leading-relaxed">
            There’s no password recovery by email yet, so if you lose this password
            nobody can let you back in — not even us. Invite a second Client Admin and
            the two of you can reset each other.
          </p>
          <Button size="sm" className="mt-3" onClick={() => setInviting(true)}>
            Invite a second admin
          </Button>
        </div>
      )}

      <FilterBar>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          placeholder="Search name or email"
          className="focusable min-h-[40px] w-64 rounded-field border border-line px-3 text-sm"
        />
        {(['all', 'field_rep', 'manager', 'client_admin'] as const).map((r) => (
          <Chip key={r} size="sm" selected={roleFilter === r} onClick={() => setRoleFilter(r)}>
            {r === 'all' ? 'All roles' : ROLE_LABEL[r]}
          </Chip>
        ))}
        <span className="mx-2 h-6 w-px bg-line" />
        {RANGES.map((r) => (
          <Chip key={r.key} size="sm" selected={range === r.key} onClick={() => setRange(r.key)}>
            {r.label}
          </Chip>
        ))}
      </FilterBar>

      {/*
        Nine columns of table, or a card per person — see `DataList`. The three
        numbers a manager actually opens this screen for on a phone (today's
        stops, doors, contact rate) are the card's meta grid; e-mail is the
        subtitle; the status dot rides beside the name.
      */}
      <DataList
        rows={filtered}
        keyOf={(m) => m.id}
        onRow={(m) => setEditing(m)}
        rowLabel={(m) => `Manage ${m.name}`}
        empty={
          members.length === 0
            ? 'Nobody on the team yet. Add your first rep to get started.'
            : 'No one matches those filters.'
        }
        columns={[
          {
            header: 'Name',
            phone: 'title',
            cell: (m) => (
              <span className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-tint text-[11px] font-semibold text-accent">
                  {m.initials}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{m.name}</span>
                  {m.email && (
                    <span className="block truncate text-xs text-ink-mute">{m.email}</span>
                  )}
                </span>
              </span>
            ),
          },
          {
            header: 'Status',
            phone: 'trailing',
            cell: (m) => (
              /* An icon and a word, never colour alone. */
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-ink-soft">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
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
            ),
          },
          { header: 'Role', cell: (m) => <span className="text-ink-mute">{ROLE_LABEL[m.role]}</span> },
          {
            header: 'Territory',
            cell: (m) => <span className="text-ink-mute">{m.territory ?? '—'}</span>,
          },
          {
            header: 'Today',
            align: 'right',
            cell: (m) => {
              const t = todayById.get(m.id)
              return m.role === 'field_rep' && t ? `${t.done}/${t.total}` : '—'
            },
          },
          {
            header: 'Doors',
            align: 'right',
            cell: (m) => {
              const r = rangeById.get(m.id)
              return m.role === 'field_rep' && r ? r.knocks.toLocaleString() : '—'
            },
          },
          {
            header: 'Contact rate',
            align: 'right',
            className: 'font-semibold',
            cell: (m) => {
              const r = rangeById.get(m.id)
              return m.role === 'field_rep' && r ? `${r.contactRate}%` : '—'
            },
          },
          {
            header: 'Won',
            align: 'right',
            cell: (m) => {
              const r = rangeById.get(m.id)
              return m.role === 'field_rep' && r ? r.sold : '—'
            },
          },
          {
            header: 'Actions',
            phone: 'off',
            align: 'right',
            cell: (m) => (
              <button
                onClick={() => setEditing(m)}
                className="focusable min-h-[32px] rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-tint"
              >
                Manage
              </button>
            ),
          },
        ]}
      />

      <p className="mt-3 text-xs text-ink-mute">
        {mode === 'live'
          ? 'Manage a person to reset their password, remove them, or delete the account. Role changes are still read-only.'
          : 'Demo roster. Managing people needs a live account.'}
      </p>

      {inviting && (
        <AddMemberDialog onClose={() => setInviting(false)} onInvited={loadRoster} />
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
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-tint font-bold text-accent">
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
        <dl className="grid grid-cols-2 gap-3 rounded-field bg-surface-sunk p-3 text-sm">
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
        <p className="rounded-field bg-warn-bg px-3 py-2.5 text-xs leading-relaxed text-warn">
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
