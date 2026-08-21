import { useMemo, useState } from 'react'
import { AdminPage, FilterBar } from './AdminLayout'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { useAppStore } from '../store/useAppStore'
import { ApiError, apiAssignProperties } from '../lib/http'
import { liveToken } from '../lib/session'
import { STATUS_COLOR, STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import type { LeadStatus, Property } from '../types'

/**
 * Every lead, from a desk.
 *
 * The console could show how many leads a territory held and draw them on a map,
 * but there was no way to answer "what happened at 1420 Cedar Bend" without
 * borrowing a rep's phone. This is the screen an office actually lives in: search
 * it, filter it, and move a handful of houses to a different person.
 *
 * Reassignment here is per-lead on purpose. Territory-level assignment covers
 * handing over a patch; what comes up daily is smaller — a rep is off sick, one
 * street belongs with the next patch over, a customer asked for someone else.
 */

const PAGE = 100

type SortKey = 'address' | 'status' | 'value' | 'recent'

export default function AdminLeads() {
  const properties = useAppStore((s) => s.properties)
  const territories = useAppStore((s) => s.territories)
  const team = useAppStore((s) => s.team)
  const mode = useAppStore((s) => s.mode)
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<LeadStatus | 'all'>('all')
  const [repFilter, setRepFilter] = useState<string>('all')
  const [sort, setSort] = useState<SortKey>('address')
  const [shown, setShown] = useState(PAGE)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reps = useMemo(() => team.filter((m) => m.active && m.role !== 'super_admin'), [team])
  const nameOf = (id?: string) => (id ? (team.find((m) => m.id === id)?.name ?? id) : null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = Object.values(properties)

    if (q) {
      list = list.filter(
        (p) =>
          p.address1.toLowerCase().includes(q) ||
          (p.city ?? '').toLowerCase().includes(q) ||
          (p.zip ?? '').includes(q) ||
          p.contacts.some((c) => c.name.toLowerCase().includes(q)),
      )
    }
    if (status !== 'all') list = list.filter((p) => p.status === status)
    if (repFilter === 'unassigned') list = list.filter((p) => !p.assignedRepId)
    else if (repFilter !== 'all') list = list.filter((p) => p.assignedRepId === repFilter)

    const sorted = [...list]
    if (sort === 'address') sorted.sort((a, b) => a.address1.localeCompare(b.address1))
    else if (sort === 'status') sorted.sort((a, b) => a.status.localeCompare(b.status))
    else if (sort === 'value')
      sorted.sort((a, b) => (b.opportunityValue ?? 0) - (a.opportunityValue ?? 0))
    else sorted.sort((a, b) => (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0))
    return sorted
  }, [properties, query, status, repFilter, sort])

  const page = rows.slice(0, shown)
  // Selection follows what's on screen: "select all" that silently picks up
  // three thousand filtered-out rows is how a bulk action goes wrong.
  const allOnPageSelected = page.length > 0 && page.every((p) => selected.has(p.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function assign() {
    const token = liveToken()
    if (!token) {
      setError('Assigning leads needs a live account. The demo has no real team.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiAssignProperties(token, {
        propertyIds: [...selected],
        repId: assignTo || null,
      })
      await refreshFromServer()
      setSelected(new Set())
      setNotice(
        assignTo
          ? `${res.assigned} lead${res.assigned === 1 ? '' : 's'} moved to ${nameOf(assignTo)}.`
          : `${res.assigned} lead${res.assigned === 1 ? '' : 's'} unassigned.`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminPage
      title="Leads"
      description={`${Object.keys(properties).length.toLocaleString()} in total · ${rows.length.toLocaleString()} matching`}
    >
      <FilterBar>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShown(PAGE)
          }}
          type="search"
          placeholder="Search address, city, ZIP or owner"
          className="focusable min-h-[40px] w-72 rounded-field border border-line px-3 text-sm"
        />
        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
        >
          <option value="all">Everyone</option>
          <option value="unassigned">Unassigned</option>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
        >
          <option value="address">By address</option>
          <option value="recent">Most recently visited</option>
          <option value="value">Highest value</option>
          <option value="status">By status</option>
        </select>
      </FilterBar>

      <FilterBar>
        <Chip size="sm" selected={status === 'all'} onClick={() => setStatus('all')}>
          All statuses
        </Chip>
        {(Object.keys(STATUS_LABEL) as LeadStatus[]).map((s) => (
          <Chip key={s} size="sm" selected={status === s} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </Chip>
        ))}
      </FilterBar>

      {notice && (
        <p role="status" className="mb-3 rounded-field bg-good-bg p-3 text-sm font-medium text-good">
          {notice} They’ll see it next time their phone syncs.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 rounded-field bg-bad-bg p-3 text-sm font-medium text-bad">
          {error}
        </p>
      )}

      {/* Only appears once something is selected — a permanently visible bulk
          bar is a permanently available way to move the wrong things. */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-field bg-brand-50 p-3 ring-1 ring-brand-200">
          <span className="text-sm font-semibold">
            {selected.size.toLocaleString()} selected
          </span>
          <select
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            className="focusable min-h-[38px] rounded-lg border border-ink/15 bg-surface px-2 text-sm"
          >
            <option value="">Unassign</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                Move to {r.name}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || mode !== 'live'} onClick={() => void assign()}>
            {busy ? 'Saving…' : 'Apply'}
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="focusable text-sm font-medium text-ink-mute underline"
          >
            Clear selection
          </button>
          {mode !== 'live' && (
            <span className="text-xs text-ink-mute">Demo data — nothing to reassign.</span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  aria-label="Select everything shown"
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (allOnPageSelected) page.forEach((p) => next.delete(p.id))
                      else page.forEach((p) => next.add(p.id))
                      return next
                    })
                  }
                />
              </th>
              <th className="px-3 py-2.5 text-left font-semibold">Address</th>
              <th className="px-3 py-2.5 text-left font-semibold">Owner</th>
              <th className="px-3 py-2.5 text-left font-semibold">Status</th>
              <th className="px-3 py-2.5 text-left font-semibold">Assigned</th>
              <th className="px-3 py-2.5 text-left font-semibold">Territory</th>
              <th className="px-3 py-2.5 text-right font-semibold">Value</th>
              <th className="px-3 py-2.5 text-left font-semibold">Last visit</th>
            </tr>
          </thead>
          <tbody>
            {page.map((p) => (
              <Row
                key={p.id}
                p={p}
                checked={selected.has(p.id)}
                onToggle={() => toggle(p.id)}
                repName={nameOf(p.assignedRepId)}
                territoryName={
                  p.territoryId
                    ? (territories[p.territoryId]?.name ?? p.territoryId)
                    : UNASSIGNED_LABEL
                }
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-8 text-center text-sm text-ink-mute">
            {Object.keys(properties).length === 0
              ? 'No leads yet. Import a list to get started.'
              : 'Nothing matches those filters.'}
          </p>
        )}
      </div>

      {shown < rows.length && (
        <Button
          variant="secondary"
          className="mt-3 self-start"
          onClick={() => setShown((n) => n + PAGE)}
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} remaining
        </Button>
      )}
    </AdminPage>
  )
}

const UNASSIGNED_LABEL = 'Unassigned'

function Row({
  p,
  checked,
  onToggle,
  repName,
  territoryName,
}: {
  p: Property
  checked: boolean
  onToggle: () => void
  repName: string | null
  territoryName: string
}) {
  const outcome = p.lastOutcome ? outcomeByCode(p.lastOutcome) : undefined
  return (
    <tr className={`border-t border-line-soft ${checked ? 'bg-brand-50' : 'hover:bg-surface-field'}`}>
      <td className="px-3 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${p.address1}`}
        />
      </td>
      <td className="px-3 py-2.5">
        <span className="font-medium">{p.address1}</span>
        <span className="block text-xs text-ink-mute">
          {[p.city, p.state, p.zip].filter(Boolean).join(', ')}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {p.contacts[0]?.name ?? <span className="text-ink-mute">—</span>}
        {p.contacts[0]?.phone && (
          <span className="nums block text-xs text-ink-mute">{p.contacts[0].phone}</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {/* Status carries a word as well as a colour — never colour alone. */}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: STATUS_COLOR[p.status] }}
          />
          {STATUS_LABEL[p.status]}
        </span>
        {outcome && <span className="block text-xs text-ink-mute">{outcome.label}</span>}
      </td>
      <td className="px-3 py-2.5">
        {repName ?? <span className="text-warn">Nobody</span>}
      </td>
      <td className="px-3 py-2.5 text-ink-mute">{territoryName}</td>
      <td className="nums px-3 py-2.5 text-right">
        {p.opportunityValue ? money(p.opportunityValue) : <span className="text-ink-mute">—</span>}
      </td>
      <td className="px-3 py-2.5 text-ink-mute">
        {p.lastVisitAt ? relative(p.lastVisitAt) : 'Never'}
      </td>
    </tr>
  )
}
