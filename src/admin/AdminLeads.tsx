import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminPage, FilterBar } from './AdminLayout'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { useAppStore } from '../store/useAppStore'
import { ApiError, apiAssignProperties, apiEraseLeads, apiSetLeadStatus } from '../lib/http'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { liveToken } from '../lib/session'
import { PIPELINE_STAGES, STATUS_COLOR, STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import type { LeadStatus } from '../types'
import { DataList } from './DataList'
import { FieldMap } from '../components/map/FieldMap'
import { pointInPolygon } from '../lib/geo'
import { VISITED_WINDOWS, matchesVisited, type VisitedWindow } from '../lib/leadFilter'

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
  const signedIn = useAppStore((s) => s.user)
  const forgetProperties = useAppStore((s) => s.forgetProperties)
  const canErase = signedIn?.role === 'client_admin' || signedIn?.role === 'super_admin'
  // The company's calendar, so "today" here is the day the reporting counts on.
  const timezone = useAppStore((s) => s.timezone)
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)

  // Seeded from the URL so another screen can send somebody here pointed at one
  // house — the sync-conflict panel does. It seeds rather than controls: the
  // search box stays the manager's the moment they type in it.
  const [params] = useSearchParams()
  const [query, setQuery] = useState(() => params.get('q') ?? '')
  const [status, setStatus] = useState<LeadStatus | 'all'>('all')
  const [repFilter, setRepFilter] = useState<string>('all')
  const [visited, setVisited] = useState<VisitedWindow>('any')
  const [sort, setSort] = useState<SortKey>('address')
  const [shown, setShown] = useState(PAGE)
  const [view, setView] = useState<'list' | 'map'>('list')
  /*
    The shape being drawn, or null when not drawing.

    Held here rather than inside the map for the same reason territory drawing
    holds it in its own screen: the undo, the commit and the running count all
    belong to whoever is selecting, and the map's job is only to turn a tap into
    a coordinate and show what has been drawn so far.
  */
  const [lasso, setLasso] = useState<{ lat: number; lng: number }[] | null>(null)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [statusTo, setStatusTo] = useState<LeadStatus | ''>('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Erasure: the one bulk action with no undo, so it has its own confirmation
  // step, its own busy flag (a slow erase must not grey out the other
  // controls' meaning), and a reason — required by the server, and rightly.
  const [confirmErase, setConfirmErase] = useState(false)
  const [eraseReason, setEraseReason] = useState('')
  const [erasing, setErasing] = useState(false)
  const [eraseError, setEraseError] = useState<string | null>(null)

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
    /*
      Through the shared predicate rather than inline arithmetic, so this screen,
      the rep's list and the map cannot disagree about what "the last 7 days"
      means — and so all three cut the day on the company's calendar instead of
      this browser's. See leadFilter.ts.
    */
    if (visited !== 'any') list = list.filter((p) => matchesVisited(p, visited, timezone))

    const sorted = [...list]
    if (sort === 'address') sorted.sort((a, b) => a.address1.localeCompare(b.address1))
    else if (sort === 'status') sorted.sort((a, b) => a.status.localeCompare(b.status))
    else if (sort === 'value')
      sorted.sort((a, b) => (b.opportunityValue ?? 0) - (a.opportunityValue ?? 0))
    else sorted.sort((a, b) => (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0))
    return sorted
  }, [properties, query, status, repFilter, visited, sort, timezone])

  const page = rows.slice(0, shown)

  /*
    Which leads the drawn shape currently covers.

    Over `rows` — the filtered set — not every lead in the company. If somebody
    has narrowed to Follow-up and then draws round a block, they mean the
    follow-ups on that block; selecting the closed sales underneath them as well
    would be a bulk action nobody asked for. It also means the shape composes
    with the filters instead of fighting them.

    Recomputed on every tap, which is the feedback loop of the whole gesture —
    the count has to move under the finger, which is why the test is plain
    arithmetic rather than anything cleverer.
  */
  const inside = useMemo(() => {
    if (!lasso || lasso.length < 3) return []
    return rows.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, lasso),
    )
  }, [lasso, rows])

  /*
    Added to the selection rather than replacing it.

    Replacing would silently discard ticks somebody had already made — including
    ones scrolled off screen — and the count in the bulk bar is the only place
    that would have said so. A union is visible in that count and undone by
    "Clear selection", so the recoverable choice is the default.
  */
  function commitLasso() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const p of inside) next.add(p.id)
      return next
    })
    setLasso(null)
  }
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

  /*
    Setting a status on a selection.

    The one place in the product where a status is typed rather than earned, and
    it is here rather than on a phone on purpose — see `api/src/lead-edit.ts`.
    Do Not Contact is never overwritten by it, which the server enforces and
    reports back, so the notice below can say how many were held rather than
    leaving an operator to work out why the count is short.
  */
  async function applyStatus() {
    const token = liveToken()
    if (!token) {
      setError('Changing a status needs a live account. The demo has nothing to save to.')
      return
    }
    if (!statusTo) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiSetLeadStatus(token, { propertyIds: [...selected], status: statusTo })
      await refreshFromServer()
      setSelected(new Set())
      const held = res.protectedDnc
        ? ` ${res.protectedDnc} left on Do Not Contact.`
        : ''
      setNotice(
        `${res.updated} lead${res.updated === 1 ? '' : 's'} set to ${STATUS_LABEL[statusTo]}.${held}`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  /*
    Erasing a selection.

    Two taps by design: the bar's button only opens the dialog, and the dialog's
    button does the work. The dialog asks for a reason because the server does,
    and the server does because the only question anyone asks afterwards is
    "why is this gone". The answer that comes back is exact — destroyed,
    already gone, not ours, failed — and the notice says all four rather than
    "done", because a batch that half-succeeded and reports success is the
    failure this whole feature is shaped to avoid.

    The rows leave the screen and the map on the tap, through the same purge a
    bootstrap runs for an erased id, and the refresh afterwards reconciles with
    the server. Nothing waits for the round trip to disappear.
  */
  async function eraseSelected() {
    const token = liveToken()
    if (!token) {
      setEraseError('Deleting leads needs a live account. The demo has nothing to delete.')
      return
    }
    if (erasing) return
    const ids = [...selected]
    setErasing(true)
    setEraseError(null)
    setError(null)
    setNotice(null)
    try {
      const res = await apiEraseLeads(token, { propertyIds: ids, reason: eraseReason.trim() })
      const gone = ids.filter((id) => !res.failed.includes(id) && !res.notFound.includes(id))
      await forgetProperties(gone)
      setConfirmErase(false)
      setEraseReason('')
      setSelected(new Set())
      const parts = [`${res.deleted} lead${res.deleted === 1 ? '' : 's'} deleted`]
      if (res.alreadyGone) parts.push(`${res.alreadyGone} ${res.alreadyGone === 1 ? 'was' : 'were'} already gone`)
      if (res.notFound.length) parts.push(`${res.notFound.length} no longer exist${res.notFound.length === 1 ? 's' : ''} on this team`)
      if (res.failed.length) parts.push(`${res.failed.length} could not be deleted — refresh and try again`)
      if (res.failed.length) setError(`${parts.join('. ')}.`)
      else setNotice(`${parts.join('. ')}.`)
      void refreshFromServer()
    } catch (err) {
      setEraseError(
        err instanceof ApiError
          ? err.status === 403
            ? 'You do not have permission to delete leads.'
            : err.message
          : 'Could not reach the server. Nothing was deleted — check your connection and try again.',
      )
    } finally {
      setErasing(false)
    }
  }

  const eraseCount = selected.size
  const eraseNoun = `${eraseCount.toLocaleString()} lead${eraseCount === 1 ? '' : 's'}`

  return (
    <AdminPage
      tour="console-leads"
      title="Leads"
      description={`${Object.keys(properties).length.toLocaleString()} in total · ${rows.length.toLocaleString()} matching`}
    >
      <FilterBar>
        {/*
          A segmented control rather than two buttons, matching the map screen:
          two buttons leave "which one am I looking at" to colour alone, and this
          pair has to answer it at a glance.
        */}
        <div className="flex overflow-hidden rounded-field border border-line" role="group" aria-label="View">
          {(['list', 'map'] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v)
                // Leaving the map mid-shape would leave the draft hanging with
                // nothing on screen able to finish or discard it.
                if (v === 'list') setLasso(null)
              }}
              aria-pressed={view === v}
              className={`focusable min-h-[40px] px-3 text-sm font-semibold capitalize ${
                view === v ? 'bg-brand-500 text-ink-inverse' : 'bg-surface text-ink-soft'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
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
          value={visited}
          onChange={(e) => setVisited(e.target.value as VisitedWindow)}
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
          aria-label="Last visited"
        >
          {VISITED_WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>
              {w.key === 'any' ? 'Visited: any time' : w.label}
            </option>
          ))}
        </select>
        {/*
          Labelled, like every other control in this bar. Four dropdowns sitting
          in a row are four identical "combo box" announcements to a screen
          reader — and a bare `select` selector in a gate becomes ambiguous the
          moment a fifth is added, which is how two gates broke on unrelated
          work in this session.
        */}
        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
          aria-label="Assigned to"
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
          aria-label="Sort by"
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
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-field bg-surface-tint p-3 ring-1 ring-brand-500">
          <span className="text-sm font-semibold" data-testid="bulk-count">
            {selected.size.toLocaleString()} selected
          </span>
          {/*
            Labelled, now that there are two dropdowns in this bar. Unlabelled
            it was identifiable only by position — fine for one control, and
            immediately wrong for two: a screen reader announces "combo box"
            twice with no way to tell reassignment from a status change.
          */}
          <select
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            className="focusable min-h-[38px] rounded-lg border border-ink/15 bg-surface px-2 text-sm"
            aria-label="Reassign to"
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

          {/*
            A second control rather than a shared "Apply", because the two do
            unrelated things to the same rows and a single button next to two
            dropdowns has to guess which one was meant. `dnc` is offered, since
            a scrubbed list coming back is a real reason to set it in bulk; the
            server refuses to overwrite one either way.
          */}
          <select
            value={statusTo}
            onChange={(e) => setStatusTo(e.target.value as LeadStatus | '')}
            className="focusable min-h-[38px] rounded-lg border border-ink/15 bg-surface px-2 text-sm"
            aria-label="Set status"
          >
            <option value="">Set status…</option>
            {[...PIPELINE_STAGES, 'lost' as LeadStatus, 'dnc' as LeadStatus].map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || mode !== 'live' || !statusTo}
            onClick={() => void applyStatus()}
          >
            {busy ? 'Saving…' : 'Set'}
          </Button>
          {/*
            Offered only to who the server would allow. A manager sees the two
            controls above and not this one, rather than a button that answers
            "not permitted" — see canErase in api/src/erase.ts for why the line
            sits where it does. It opens a dialog; it never deletes.
          */}
          {canErase && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy || erasing || mode !== 'live'}
              onClick={() => {
                setEraseError(null)
                setConfirmErase(true)
              }}
              data-testid="bulk-delete"
            >
              Delete selected
            </Button>
          )}
          <button
            onClick={() => setSelected(new Set())}
            className="focusable text-sm font-medium text-ink-mute underline"
            data-testid="bulk-clear"
          >
            Clear selection
          </button>
          {mode !== 'live' && (
            <span className="text-xs text-ink-mute">Demo data — nothing to reassign.</span>
          )}
        </div>
      )}

      {view === 'map' && (
        <section className="mb-3">
          {/*
            Drawing a shape round some pins, which is how an office selects a
            block without ticking forty rows.

            The gesture and the geometry are both reused rather than rebuilt:
            `FieldMap` already turns taps into coordinates and draws the shape
            for territory drawing, and `pointInPolygon` is the same function the
            server uses to decide which leads a territory claims — kept in step
            by `verify:geo-parity`. What is new here is only where the answer
            goes: into the selection the checkboxes already feed.
          */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {!lasso ? (
              <Button size="sm" variant="secondary" onClick={() => setLasso([])}>
                Select an area
              </Button>
            ) : (
              <>
                <span className="text-sm font-semibold">
                  {lasso.length < 3
                    ? `Tap the map to outline an area — ${3 - lasso.length} more point${
                        3 - lasso.length === 1 ? '' : 's'
                      }`
                    : `${inside.length.toLocaleString()} lead${
                        inside.length === 1 ? '' : 's'
                      } inside`}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={lasso.length === 0}
                  onClick={() => setLasso((pts) => (pts ? pts.slice(0, -1) : pts))}
                >
                  Undo point
                </Button>
                <Button
                  size="sm"
                  disabled={inside.length === 0}
                  onClick={commitLasso}
                >
                  Add {inside.length.toLocaleString()} to selection
                </Button>
                <button
                  onClick={() => setLasso(null)}
                  className="focusable text-sm font-medium text-ink-mute underline"
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          {/*
            The filtered set, so what is on the map is what the list would show.
            An operator who has narrowed to one rep's follow-ups and then opens
            the map to draw round them should not be handed the whole company.
          */}
          <FieldMap
            className="h-[520px] rounded-card"
            properties={rows}
            draw={
              lasso
                ? {
                    points: lasso,
                    onAddPoint: (point) => setLasso((pts) => [...(pts ?? []), point]),
                    label: 'Outline an area to select leads',
                  }
                : undefined
            }
            // An office user's own GPS says nothing about a customer's street,
            // and passing it would recentre the map away from the work.
            position={null}
            selectedId={null}
            // FieldMap deselects by passing null; there is nothing to toggle
            // then, and the selection is cleared from the bulk bar instead.
            onSelect={(id) => id && toggle(id)}
          />
          <p className="mt-1 text-xs text-ink-mute">
            {lasso
              ? 'Tap the map to add points. The shape closes itself.'
              : 'Tap a pin to select it, or draw round several at once.'}
          </p>
        </section>
      )}

      {/*
        Cards on a phone, the table on a desktop — see `DataList`. This one keeps
        its select-all: reassigning a street's worth of leads is exactly the job
        somebody does from a phone after a rep quits.
      */}
      {view === 'list' && (
      <DataList
        rows={page}
        keyOf={(p) => p.id}
        leading={(p) => (
          <input
            type="checkbox"
            checked={selected.has(p.id)}
            onChange={() => toggle(p.id)}
            aria-label={`Select ${p.address1}`}
            className="h-[18px] w-[18px] accent-brand-600"
          />
        )}
        leadingHeader={
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
        }
        empty={
          Object.keys(properties).length === 0
            ? 'No leads yet. Import a list to get started.'
            : 'Nothing matches those filters.'
        }
        columns={[
          {
            header: 'Address',
            phone: 'title',
            cell: (p) => (
              <>
                <span className="font-medium">{p.address1}</span>
                <span className="block text-xs text-ink-mute">
                  {[p.city, p.state, p.zip].filter(Boolean).join(', ')}
                </span>
              </>
            ),
          },
          {
            header: 'Value',
            phone: 'trailing',
            align: 'right',
            cell: (p) =>
              p.opportunityValue ? (
                <span className="nums font-semibold">{money(p.opportunityValue)}</span>
              ) : (
                <span className="text-ink-mute">—</span>
              ),
          },
          {
            header: 'Status',
            cell: (p) => {
              const outcome = p.lastOutcome ? outcomeByCode(p.lastOutcome) : undefined
              return (
                <>
                  {/* A word as well as a colour — never colour alone. */}
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: STATUS_COLOR[p.status] }}
                    />
                    {STATUS_LABEL[p.status]}
                  </span>
                  {outcome && (
                    <span className="block truncate text-xs text-ink-mute">{outcome.label}</span>
                  )}
                </>
              )
            },
          },
          {
            header: 'Owner',
            cell: (p) => (
              <>
                {p.contacts[0]?.name ?? <span className="text-ink-mute">—</span>}
                {p.contacts[0]?.phone && (
                  <span className="nums block text-xs text-ink-mute">{p.contacts[0].phone}</span>
                )}
              </>
            ),
          },
          {
            header: 'Assigned',
            cell: (p) => nameOf(p.assignedRepId) ?? <span className="text-warn">Nobody</span>,
          },
          {
            header: 'Territory',
            cell: (p) => (
              <span className="text-ink-mute">
                {p.territoryId
                  ? (territories[p.territoryId]?.name ?? p.territoryId)
                  : UNASSIGNED_LABEL}
              </span>
            ),
          },
          {
            header: 'Last visit',
            cell: (p) => (
              <span className="text-ink-mute">
                {p.lastVisitAt ? relative(p.lastVisitAt) : 'Never'}
              </span>
            ),
          },
        ]}
      />
      )}

      {view === 'list' && shown < rows.length && (
        <Button
          variant="secondary"
          className="mt-3 self-start"
          onClick={() => setShown((n) => n + PAGE)}
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} remaining
        </Button>
      )}

      {confirmErase && (
        <ConfirmDialog
          title={`Delete ${eraseNoun}?`}
          confirmLabel={`Delete ${eraseNoun}`}
          busyLabel="Deleting leads…"
          busy={erasing}
          destructive
          confirmDisabled={eraseReason.trim().length < 3}
          onConfirm={() => void eraseSelected()}
          onCancel={() => {
            if (erasing) return
            setConfirmErase(false)
            setEraseError(null)
          }}
          testId="bulk-delete-dialog"
        >
          <p>
            You are about to permanently delete {eraseNoun}. This removes {eraseCount === 1 ? 'it' : 'them'} from the map, from
            every rep’s phone, from assignments and lists, and takes every note, visit and photo along. It cannot be undone, and the
            {eraseCount === 1 ? ' address' : ' addresses'} cannot be re-imported afterwards.
          </p>
          <label className="mt-4 block">
            <span className="text-[13px] font-semibold text-ink">Why?</span>
            <input
              value={eraseReason}
              onChange={(e) => setEraseReason(e.target.value)}
              placeholder="e.g. Scrubbed list came back, homeowners asked to be removed"
              disabled={erasing}
              data-testid="bulk-delete-reason"
              className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-[15px]"
            />
            <span className="mt-1 block text-[12.5px] text-ink-mute">Recorded in the audit log beside each lead. Required — a blank reason makes every deletion look like an accident.</span>
          </label>
          {eraseError && (
            <p role="alert" className="mt-3 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad" data-testid="bulk-delete-error">
              {eraseError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </AdminPage>
  )
}

const UNASSIGNED_LABEL = 'Unassigned'
