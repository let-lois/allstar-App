import { useCallback, useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { IconFilter } from '../components/nav/icons'
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
import { ROLE_LABEL, grantableRoles } from '../lib/roles'
import type { Role, TeamMember } from '../types'
import { BADGE_LABEL, INVITATION_LABEL, ONBOARDING_LABEL } from './statusLabels'

/**
 * User management.
 *
 * Two views of one roster. *People* is the onboarding brief's list — who has
 * been invited, who has accepted, who has finished setting up, whose badge is
 * live — every column a status the server derives, never a checkmark the
 * console decides for itself. *Performance* is the older table: doors,
 * contact rate, won, over a range. They share the search, the role filter and
 * the row (Manage), because they are the same twenty people.
 *
 * Deliberately dense — this is the screen where density is the feature.
 */

type View = 'people' | 'performance'
type Attention = 'all' | 'invited' | 'setting_up' | 'badge' | 'inactive'

const shortDate = (ms?: number) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/** Which attention filter a person falls under. */
function needs(m: TeamMember): Attention[] {
  const out: Attention[] = []
  if (m.pending || m.invitation === 'expired' || m.invitation === 'revoked') out.push('invited')
  if (!m.pending && m.active && m.onboarding && m.onboarding !== 'complete') out.push('setting_up')
  if (!m.pending && m.active && m.badge && m.badge !== 'active') out.push('badge')
  // Pending invitees are inactive until they accept — that is the invite filter's business, not this one's.
  if (!m.active && !m.pending) out.push('inactive')
  return out
}

export function AdminTeam() {
  const [view, setView] = useState<View>('people')
  const [range, setRange] = useState<RangeKey>('14d')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  // Team / office is a label on each person (users.team_id), not a hierarchy:
  // filtering by it is all the Team page needs. '' means every office.
  const [officeFilter, setOfficeFilter] = useState<string>('')
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'pending' | 'deactivated'>('all')
  const [attention, setAttention] = useState<Attention>('all')
  const [filtersShown, setFiltersShown] = useState(false)
  const activeFilterCount = Number(roleFilter !== 'all') + Number(officeFilter !== '') + Number(activeFilter !== 'all') + (view === 'people' ? Number(attention !== 'all') : Number(range !== '14d'))
  const [editingId, setEditingId] = useState<string | null>(null)
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
  // Looked up, not held: after a change the sheet must show the refreshed row.
  const editing = editingId ? team.find((m) => m.id === editingId) ?? null : null
  const loadRoster = useCallback(() => void loadTeam(), [loadTeam])

  const territoryOf = useCallback(
    (userId: string) => {
      const owned = Object.values(properties).filter((p) => p.assignedRepId === userId)
      const ids = [...new Set(owned.map((p) => p.territoryId).filter(Boolean))] as string[]
      const named = ids.map((id) => territories[id]?.name ?? id)
      if (named.length === 0) return owned.length ? `${owned.length} unassigned leads` : undefined
      return named.join(', ')
    },
    [properties, territories],
  )

  const admins = useMemo(
    () => team.filter((m) => (m.role === 'client_admin' || m.role === 'super_admin') && m.active && !m.pending),
    [team],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return team.filter(
      (m) =>
        (roleFilter === 'all' || m.role === roleFilter) &&
        (officeFilter === '' || (officeFilter === '__none' ? !m.teamName : m.teamName === officeFilter)) &&
        (activeFilter === 'all' ||
          (activeFilter === 'pending' ? !!m.pending : activeFilter === 'active' ? m.active && !m.pending : !m.active && !m.pending)) &&
        (attention === 'all' || needs(m).includes(attention)) &&
        (!q || m.name.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q) || (m.teamName ?? '').toLowerCase().includes(q)),
    )
  }, [team, query, roleFilter, attention, officeFilter, activeFilter])
  const offices = useMemo(() => [...new Set(team.map((m) => m.teamName).filter((n): n is string => !!n))].sort(), [team])

  const counts = useMemo(() => {
    const c: Record<Attention, number> = { all: team.length, invited: 0, setting_up: 0, badge: 0, inactive: 0 }
    for (const m of team) for (const k of needs(m)) c[k] += 1
    return c
  }, [team])

  const rangeById = new Map(rangeRows.map((r) => [r.id, r]))
  const todayById = new Map(today.map((r) => [r.id, r]))

  /* Never colour alone: a dot, and the word beside it. */
  const dot = (tone: 'good' | 'warn' | 'bad' | 'mute') => (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: tone === 'good' ? STATUS.good : tone === 'warn' ? STATUS.warning : tone === 'bad' ? STATUS.serious : 'var(--ink-faint)' }}
    />
  )
  const status = (tone: 'good' | 'warn' | 'bad' | 'mute', label: string, testid: string) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-ink-soft" data-testid={testid} data-value={label}>
      {dot(tone)}
      {label}
    </span>
  )

  const peopleColumns = [
    {
      header: 'Name',
      phone: 'title' as const,
      cell: (m: TeamMember) => (
        <span className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-tint text-[11px] font-semibold text-accent">{m.initials}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{m.name}</span>
            {m.email && <span className="block truncate text-xs text-ink-mute">{m.email}</span>}
          </span>
        </span>
      ),
    },
    { header: 'Role', cell: (m: TeamMember) => <span className="text-ink-mute">{ROLE_LABEL[m.role]}{m.jobTitle ? ` · ${m.jobTitle}` : ''}</span> },
    { header: 'Team / office', cell: (m: TeamMember) => <span className="text-ink-mute">{m.teamName ?? '—'}</span> },
    {
      header: 'Invitation',
      phone: 'meta' as const,
      cell: (m: TeamMember) => {
        const v = m.invitation ?? (m.pending ? 'pending' : 'not_sent')
        return status(v === 'accepted' ? 'good' : v === 'pending' || v === 'opened' ? 'warn' : v === 'not_sent' ? 'mute' : 'bad', INVITATION_LABEL[v], 'col-invitation')
      },
    },
    {
      header: 'Account',
      phone: 'trailing' as const,
      cell: (m: TeamMember) =>
        status(m.pending ? 'warn' : m.active ? 'good' : 'bad', m.pending ? 'Invite pending' : m.active ? 'Active' : 'Deactivated', 'col-account'),
    },
    {
      header: 'Onboarding',
      phone: 'meta' as const,
      cell: (m: TeamMember) => {
        const v = m.onboarding
        if (!v) return <span className="text-ink-mute">—</span>
        return status(v === 'complete' ? 'good' : v === 'not_started' ? 'mute' : 'warn', ONBOARDING_LABEL[v], 'col-onboarding')
      },
    },
    {
      header: 'Badge',
      phone: 'meta' as const,
      cell: (m: TeamMember) => {
        const v = m.badge
        if (!v) return <span className="text-ink-mute">—</span>
        return status(v === 'active' ? 'good' : v === 'none' ? 'mute' : v === 'expired' ? 'bad' : 'warn', BADGE_LABEL[v], 'col-badge')
      },
    },
    { header: 'Last active', cell: (m: TeamMember) => <span className="text-ink-mute">{m.lastSeenAt ? relative(m.lastSeenAt) : 'Never'}</span> },
    { header: 'Date added', cell: (m: TeamMember) => <span className="text-ink-mute">{shortDate(m.createdAt)}</span> },
  ]

  const performanceColumns = [
    peopleColumns[0]!,
    {
      header: 'Status',
      phone: 'trailing' as const,
      cell: (m: TeamMember) =>
        status(m.pending ? 'warn' : m.active ? 'good' : 'bad', m.pending ? 'Invite pending' : m.active ? 'Active' : 'Deactivated', 'col-account'),
    },
    { header: 'Role', cell: (m: TeamMember) => <span className="text-ink-mute">{ROLE_LABEL[m.role]}</span> },
    { header: 'Territory', cell: (m: TeamMember) => <span className="text-ink-mute">{territoryOf(m.id) ?? '—'}</span> },
    {
      header: 'Today',
      align: 'right' as const,
      cell: (m: TeamMember) => {
        const t = todayById.get(m.id)
        return t && t.total > 0 ? `${t.done}/${t.total}` : m.role === 'field_rep' && t ? `${t.done}/${t.total}` : '—'
      },
    },
    {
      header: 'Doors',
      align: 'right' as const,
      cell: (m: TeamMember) => {
        const r = rangeById.get(m.id)
        return r ? r.knocks.toLocaleString() : '—'
      },
    },
    {
      header: 'Contact rate',
      align: 'right' as const,
      className: 'font-semibold',
      cell: (m: TeamMember) => {
        const r = rangeById.get(m.id)
        return r ? `${r.contactRate}%` : '—'
      },
    },
    {
      header: 'Won',
      align: 'right' as const,
      cell: (m: TeamMember) => {
        const r = rangeById.get(m.id)
        return r ? r.sold : '—'
      },
    },
  ]

  const manageColumn = {
    header: 'Actions',
    phone: 'off' as const,
    align: 'right' as const,
    cell: (m: TeamMember) => (
      <button onClick={() => setEditingId(m.id)} className="focusable min-h-[32px] rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-tint">
        Manage
      </button>
    ),
  }

  return (
    <AdminPage
      tour="console-team"
      title="Team"
      description={`${team.length} ${team.length === 1 ? 'person' : 'people'} · ${team.filter((m) => m.role === 'field_rep').length} in the field`}
      actions={
        /*
          Only for people the server will let add somebody. A manager sees
          the roster but cannot create access to it (`canInvite` on the
          Worker), and the old button taught them that with a "Not permitted"
          after they had filled in five fields.
        */
        grantableRoles(signedInUser).length > 0 ? (
          <Button size="sm" onClick={() => setInviting(true)} data-testid="team-add-member">
            Add team member
          </Button>
        ) : undefined
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
            There’s no password recovery by email yet, so if you lose this password nobody can let you back in — not even us. Invite a
            second Client Admin and the two of you can reset each other.
          </p>
          <Button size="sm" className="mt-3" onClick={() => setInviting(true)}>
            Invite a second admin
          </Button>
        </div>
      )}

      <FilterBar>
        <div className="flex gap-1" data-testid="roster-view">
          {(
            [
              ['people', 'People'],
              ['performance', 'Performance'],
            ] as const
          ).map(([key, label]) => (
            <Chip key={key} size="sm" selected={view === key} onClick={() => setView(key)}>
              {label}
            </Chip>
          ))}
        </div>
        <span className="mx-2 hidden h-6 w-px bg-line md:block" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          aria-label="Search the team"
          placeholder="Search name, email or team"
          className="focusable min-h-[44px] min-w-0 flex-1 rounded-field border border-line px-3 text-sm md:min-h-[40px] md:w-64 md:flex-none"
        />
        {/* On a phone the chips below fold behind one button, as on Leads:
            three rows of them pushed the first person off the screen. */}
        <button
          type="button"
          onClick={() => setFiltersShown((v) => !v)}
          aria-expanded={filtersShown}
          data-testid="console-team-filters"
          className="focusable flex min-h-[44px] items-center gap-1.5 rounded-field border border-line bg-surface px-3 text-sm font-semibold text-ink-soft md:hidden"
        >
          <IconFilter />
          Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
        </button>
        <div className={filtersShown ? 'contents' : 'hidden md:contents'}>
        {(['all', 'field_rep', 'manager', 'client_admin'] as const).map((r) => (
          <Chip key={r} size="sm" selected={roleFilter === r} onClick={() => setRoleFilter(r)}>
            {r === 'all' ? 'All roles' : ROLE_LABEL[r]}
          </Chip>
        ))}
        <select
          value={officeFilter}
          onChange={(e) => setOfficeFilter(e.target.value)}
          aria-label="Team / office"
          data-testid="team-office-filter"
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
        >
          <option value="">Every team / office</option>
          {offices.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          <option value="__none">No team / office</option>
        </select>
        <select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}
          aria-label="Account status"
          data-testid="team-active-filter"
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
        >
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="pending">Invite pending</option>
          <option value="deactivated">Removed from team</option>
        </select>
        <span className="mx-2 h-6 w-px bg-line" />
        {view === 'people' ? (
          (
            [
              ['all', 'Everyone'],
              ['invited', 'Invite open'],
              ['setting_up', 'Still setting up'],
              ['badge', 'Badge not active'],
              ['inactive', 'Removed from team'],
            ] as const
          ).map(([key, label]) => (
            <Chip key={key} size="sm" selected={attention === key} onClick={() => setAttention(key)}>
              {label}
              {key !== 'all' && counts[key] > 0 ? ` · ${counts[key]}` : ''}
            </Chip>
          ))
        ) : (
          RANGES.map((r) => (
            <Chip key={r.key} size="sm" selected={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </Chip>
          ))
        )}
        </div>
      </FilterBar>

      {/*
        Nine columns of table, or a card per person — see `DataList`. On a phone
        the People card carries the four statuses as its meta grid; the
        Performance card the three numbers a manager opens this screen for.
      */}
      <div data-testid={`roster-${view}`}>
        <DataList
          rows={filtered}
          keyOf={(m) => m.id}
          onRow={(m) => setEditingId(m.id)}
          rowLabel={(m) => `Manage ${m.name}`}
          empty={team.length === 0 ? 'Nobody on the team yet. Add your first rep to get started.' : 'No one matches those filters.'}
          columns={[...(view === 'people' ? peopleColumns : performanceColumns), manageColumn]}
        />
      </div>

      <p className="mt-3 text-xs text-ink-mute">
        {mode === 'live'
          ? 'Every status here is the server’s: invitations from the newest link, onboarding and badge from what the person has actually done. Manage a person to re-send an invite, change their role, team or title, reset their setup, renew a badge, or remove them.'
          : 'Demo roster. Managing people needs a live account.'}
      </p>

      {inviting && <AddMemberDialog onClose={() => setInviting(false)} onInvited={loadRoster} />}

      <BottomSheet open={!!editing} onClose={() => setEditingId(null)} title={editing?.name} detents={[0.9]}>
        {editing && (
          <MemberDetail
            member={editing}
            mode={mode}
            signedInId={signedInUser?.id}
            onChanged={() => {
              loadRoster()
              setEditingId(null)
            }}
            onRefresh={loadRoster}
            onClose={() => setEditingId(null)}
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
  onRefresh,
  onClose,
}: {
  member: TeamMember
  mode: 'demo' | 'live'
  signedInId?: string
  onChanged: () => void
  onRefresh: () => void
  onClose: () => void
}) {
  const today = useTeamStats().find((r) => r.id === member.id)
  return (
    <div className="space-y-4 pt-1" data-testid="member-detail">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-tint font-bold text-accent">{member.initials}</span>
        <div className="min-w-0">
          <p className="font-bold">{member.name}</p>
          <p className="truncate text-xs text-ink-mute">
            {ROLE_LABEL[member.role]}
            {member.jobTitle && ` · ${member.jobTitle}`}
            {member.teamName && ` · ${member.teamName}`}
            {member.email && ` · ${member.email}`}
          </p>
        </div>
      </div>

      {/* The statuses the roster shows, stated for this one person. */}
      {member.onboarding && (
        <dl className="grid grid-cols-2 gap-3 rounded-field bg-surface-sunk p-3 text-sm" data-testid="member-statuses">
          <div>
            <dt className="text-xs text-ink-mute">Invitation</dt>
            <dd className="font-semibold">{INVITATION_LABEL[member.invitation ?? 'not_sent']}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Onboarding</dt>
            <dd className="font-semibold">
              {ONBOARDING_LABEL[member.onboarding]}
              {member.onboarding !== 'complete' && member.onboardingStep ? ` — at ${member.onboardingStep}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Badge</dt>
            <dd className="font-semibold">{BADGE_LABEL[member.badge ?? 'none']}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-mute">Last active</dt>
            <dd className="font-semibold">{member.lastSeenAt ? relative(member.lastSeenAt) : 'Never'}</dd>
          </div>
        </dl>
      )}

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
        <ManageUser user={member} isSelf={member.id === signedInId} onChanged={onChanged} onRefresh={onRefresh} onClose={onClose} />
      ) : (
        <p className="rounded-field bg-warn-bg px-3 py-2.5 text-xs leading-relaxed text-warn">
          This is the demo roster — nobody here has a real account, so there's nothing to reset or remove. Sign in with real credentials
          to manage people.
        </p>
      )}
    </div>
  )
}
