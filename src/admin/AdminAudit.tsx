import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { apiAudit, type AuditRowDTO } from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'
import { relative } from '../lib/format'
import { STATUS } from './charts/tokens'

/**
 * The activity log.
 *
 * Written for the conversation that starts "I never did that". Until this
 * existed, an admin could reset a rep's password, hand their territory to
 * someone else, or delete them outright, and none of it left a trace.
 *
 * Read-only, deliberately and visibly. There is no filter that hides an entry
 * and no control that removes one, because a log the accused can edit is not
 * evidence — and the person most likely to want a row gone is the person the row
 * is about.
 */

/** Grouped by what a reader is actually looking for, not by table. */
const GROUPS = [
  { key: 'all', label: 'Everything', actions: [] as string[] },
  {
    key: 'access',
    label: 'Access',
    actions: ['user.password_set', 'user.reset_link', 'user.role_changed'],
  },
  {
    key: 'people',
    label: 'People',
    actions: ['user.invited', 'user.deactivated', 'user.reactivated', 'user.deleted'],
  },
  { key: 'leads', label: 'Leads', actions: ['territory.assigned', 'leads.imported'] },
]

/** Severity is about what a reader should stop on, not about failure. */
const WEIGHT: Record<string, 'high' | 'medium' | 'low'> = {
  'user.deleted': 'high',
  'user.role_changed': 'high',
  'user.password_set': 'medium',
  'user.deactivated': 'medium',
  'user.reset_link': 'medium',
  'user.invited': 'low',
  'user.reactivated': 'low',
  'territory.assigned': 'low',
  'leads.imported': 'low',
}

export default function AdminAudit() {
  const mode = useAppStore((s) => s.mode)
  const [entries, setEntries] = useState<AuditRowDTO[]>([])
  const [group, setGroup] = useState('all')
  const [loading, setLoading] = useState(true)
  const [done, setDone] = useState(false)

  const load = useCallback(
    async (before?: number) => {
      const token = liveToken()
      if (!token) {
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const { entries: next } = await apiAudit(token, { limit: 100, before })
        setEntries((prev) => (before ? [...prev, ...next] : next))
        if (next.length < 100) setDone(true)
      } catch {
        setDone(true)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (mode === 'live') void load()
    else setLoading(false)
  }, [mode, load])

  const shown = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group)
    if (!g || g.actions.length === 0) return entries
    return entries.filter((e) => g.actions.includes(e.action))
  }, [entries, group])

  if (mode !== 'live') {
    return (
      <AdminPage title="Activity log" description="Who changed what, and when.">
        <p className="rounded-field bg-warn-bg p-4 text-sm leading-relaxed text-warn ring-1 ring-warn/25">
          The demo keeps no log — nothing you do here touches a real account. Sign in
          with real credentials to see one.
        </p>
      </AdminPage>
    )
  }

  return (
    <AdminPage
      title="Activity log"
      description="Who changed what, and when. Read-only — nothing here can be edited or removed."
    >
      <FilterBar>
        {GROUPS.map((g) => (
          <Chip key={g.key} size="sm" selected={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </Chip>
        ))}
      </FilterBar>

      <div className="overflow-hidden rounded-card border border-ink/10 bg-surface">
        {shown.length === 0 && !loading ? (
          <p className="p-8 text-center text-sm text-ink-mute">
            {entries.length === 0
              ? 'Nothing recorded yet. Invites, password resets, role changes, deletions and lead assignments all appear here.'
              : 'Nothing of that kind recorded yet.'}
          </p>
        ) : (
          <ul>
            {shown.map((e) => (
              <li
                key={e.id}
                className="flex items-start gap-3 border-b border-ink/[0.06] px-5 py-3 last:border-0"
              >
                <span
                  aria-hidden
                  className="mt-2 h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      WEIGHT[e.action] === 'high'
                        ? STATUS.critical
                        : WEIGHT[e.action] === 'medium'
                          ? STATUS.warning
                          : STATUS.good,
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{describe(e)}</span>
                  <span className="mt-0.5 block text-xs text-ink-mute">
                    {new Date(e.at).toLocaleString()} · {relative(e.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!done && entries.length > 0 && (
        <Button
          variant="secondary"
          className="mt-3 self-start"
          disabled={loading}
          onClick={() => void load(entries[entries.length - 1]?.at)}
        >
          {loading ? 'Loading…' : 'Load older'}
        </Button>
      )}

      <p className="mt-3 text-xs text-ink-mute">
        Names are recorded as they read at the time, so an entry still says who deleted
        an account after that account is gone.
      </p>
    </AdminPage>
  )
}

/**
 * One readable sentence per entry.
 *
 * Phrased as what happened rather than as an event name: a manager reading this
 * during a dispute should not have to translate `user.role_changed` into
 * English.
 */
function describe(e: AuditRowDTO): React.ReactNode {
  const who = <b className="font-semibold">{e.actorName}</b>
  const target = <b className="font-semibold">{e.targetLabel ?? 'someone'}</b>
  const d = (e.detail ?? {}) as Record<string, unknown>

  switch (e.action) {
    case 'user.invited':
      return <>{who} invited {target} as a {roleWord(String(d.role ?? ''))}</>
    case 'user.password_set':
      return d.self ? (
        <>{who} changed their own password</>
      ) : (
        <>{who} set a new password for {target}</>
      )
    case 'user.reset_link':
      return <>{who} created a password reset link for {target}</>
    case 'user.role_changed':
      return (
        <>
          {who} changed {target} from {roleWord(String(d.from ?? ''))} to{' '}
          {roleWord(String(d.to ?? ''))}
        </>
      )
    case 'user.deactivated':
      return <>{who} removed {target} from the team</>
    case 'user.reactivated':
      return <>{who} restored access for {target}</>
    case 'user.deleted':
      return (
        <>
          {who} permanently deleted {target}
          {d.email ? ` (${d.email})` : ''}
        </>
      )
    case 'territory.assigned':
      return (
        <>
          {who} {d.repId ? 'assigned' : 'unassigned'} {String(d.leads ?? 0)} lead
          {d.leads === 1 ? '' : 's'} in {target}
        </>
      )
    case 'leads.imported':
      return (
        <>
          {who} imported leads into {target} — {String(d.created ?? 0)} new,{' '}
          {String(d.updated ?? 0)} updated
        </>
      )
    default:
      return (
        <>
          {who} — {e.action}
        </>
      )
  }
}

const roleWord = (r: string) =>
  ({
    field_rep: 'Field Rep',
    manager: 'Manager',
    client_admin: 'Client Admin',
    super_admin: 'Super Admin',
  })[r] ?? r
