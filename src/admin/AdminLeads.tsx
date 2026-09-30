import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AdminPage, FilterBar } from './AdminLayout'
import { IconFilter } from '../components/nav/icons'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { useAppStore } from '../store/useAppStore'
import { ApiError, NetworkError, apiAssignProperties, apiEraseLeads, apiExportLeadsCsv, apiMoveToTerritory, apiSetLeadStatus } from '../lib/http'
import { UNASSIGNED_TERRITORY, inTerritory } from './useAdminData'
import { Field } from '../components/ui/Input'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { liveToken } from '../lib/session'
import { FileSaveUnsupported, saveFile } from '../lib/download'
import { PIPELINE_STAGES, STATUS_COLOR, STATUS_LABEL, outcomeByCode } from '../data/outcomes'
import { money, relative } from '../lib/format'
import type { LeadStatus } from '../types'
import { DataList } from './DataList'
import { AllStarMap } from '../components/map/AllStarMap'
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

/**
 * How many leads go up in one delete request.
 *
 * The server erases one lead at a time — seven database round trips each, no
 * transaction across the batch — and the browser abandons any request after
 * twenty seconds. Locally that is seven milliseconds a lead and the ceiling
 * never comes near; against a real database in one region, with a console open
 * in another, the same work is a network round trip per statement and a large
 * selection can outrun the browser.
 *
 * Twenty-five keeps a batch comfortably inside the limit at any plausible
 * latency, and means a failure costs one batch rather than the whole selection.
 * The server's own ceiling of 500 stays where it is, as a backstop for a caller
 * that is not this one.
 */
const ERASE_BATCH = 25

/**
 * What to tell an administrator when a batch does not come back.
 *
 * The distinction in the middle is the one that matters and the one this screen
 * used to throw away: `NetworkError` already knows whether the server answered
 * and the browser refused its reply, or whether nothing was reached at all. The
 * first is a deployment misconfiguration and retrying will never fix it; the
 * second is worth trying again. The sign-in screen has told these apart since
 * the day the flag was added. This one said "Could not reach the server" to
 * both.
 */
function describeEraseFailure(err: unknown): { text: string; definite: boolean } {
  /*
    `definite` is whether we know what happened to the leads in the batch that
    broke. A server that answers has decided: a refusal means it did nothing.
    A request that never came back has decided nothing we can see — the leads in
    it may all be gone, none, or some, because the server destroys them one at a
    time and commits each before the next.
  */
  if (err instanceof ApiError) {
    if (err.status === 403) return { text: 'You do not have permission to delete leads.', definite: true }
    return { text: err.message, definite: true }
  }
  if (err instanceof NetworkError && err.blocked) {
    return {
      text: 'Reached the server, but the browser refused its reply. This address is probably missing from the API’s ALLOWED_ORIGINS — retrying will not fix it.',
      definite: false,
    }
  }
  if (err instanceof NetworkError) {
    return {
      text: navigator.onLine
        ? 'Lost the connection to the server part way through.'
        : 'This device is offline. Deleting leads needs a connection.',
      definite: false,
    }
  }
  return { text: 'Something went wrong part way through.', definite: false }
}

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
  // 'all', 'none' (in no territory) or a territory id. Seeded from ?territory=
  // so the Territories page can open its own leads here as a list.
  const [territoryFilter, setTerritoryFilter] = useState<string>(() => params.get('territory') ?? 'all')
  const [visited, setVisited] = useState<VisitedWindow>('any')
  // Phone only: whether the folded filters are open. Opened from a territory,
  // they start open, so the territory the manager came for is in view.
  const [filtersShown, setFiltersShown] = useState(() => params.has('territory'))
  const activeFilterCount =
    Number(status !== 'all') + Number(repFilter !== 'all') + Number(territoryFilter !== 'all') + Number(visited !== 'any')
  const resetFilters = () => {
    setStatus('all')
    setRepFilter('all')
    setTerritoryFilter('all')
    setVisited('any')
  }
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
  const [territoryTo, setTerritoryTo] = useState('')
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
  // How far through the batches we are, so a long delete says so rather than
  // looking hung. Null when nothing is running.
  const [eraseProgress, setEraseProgress] = useState<{ done: number; total: number } | null>(null)
  /*
    A selection into a list.

    The office's half of "Select area, create list, hand to a rep" in one bar.
    The console's Lists page can draw a shape and do the same, but a manager who
    has already lassoed twenty-five houses here should not have to draw them
    again over there — the selection is the selection, whichever screen made it.
    Existing lists are offered too, so a second street can join Monday's list
    instead of becoming a second list.
  */
  const [listOpen, setListOpen] = useState(false)
  const [listTarget, setListTarget] = useState('')
  const [listName, setListName] = useState('')
  const [listReps, setListReps] = useState<string[]>([])
  const leadLists = useAppStore((s) => s.leadLists)
  const createList = useAppStore((s) => s.createList)
  const updateListMembers = useAppStore((s) => s.updateListMembers)
  const lists = useMemo(
    () => Object.values(leadLists).filter((l) => !l.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [leadLists],
  )

  const reps = useMemo(() => team.filter((m) => m.active && m.role !== 'super_admin'), [team])
  const territoryList = useMemo(
    () => Object.values(territories).sort((a, b) => a.name.localeCompare(b.name)),
    [territories],
  )
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
    // 'none' is the Territories page's Unassigned row, by the same test, so the counts agree.
    if (territoryFilter === 'none') list = list.filter((p) => inTerritory(p, UNASSIGNED_TERRITORY))
    else if (territoryFilter !== 'all') list = list.filter((p) => p.territoryId === territoryFilter)
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
  }, [properties, query, status, repFilter, territoryFilter, visited, sort, timezone])

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

  async function applyTerritory() {
    const token = liveToken()
    if (!token || !territoryTo) {
      setError('Moving leads needs a live account. The demo has no server.')
      return
    }
    const territoryId = territoryTo === '__none' ? null : territoryTo
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiMoveToTerritory(token, { propertyIds: [...selected], territoryId })
      await refreshFromServer()
      setSelected(new Set())
      setTerritoryTo('')
      const n = `${res.moved} lead${res.moved === 1 ? '' : 's'}`
      setNotice(territoryId ? `${n} moved to ${territories[territoryId]?.name ?? 'that territory'}.` : `${n} taken out of every territory.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  /*
    Leads out as a file, filtered the way the screen is.

    The rep and status filters travel to the server, which writes the file from
    the database rather than from what this browser holds — the notes a rep
    typed this afternoon are on the server and not in this table. The search box
    and the visited window do not travel: they are ways of finding a row on
    screen, and a file "of the leads matching 'cedar'" is not a thing anyone
    asked for. Demo mode has no server and so nothing to export.
  */
  const [exporting, setExporting] = useState(false)
  async function exportCsv() {
    const token = liveToken()
    if (!token) {
      setError('Exporting needs a live account. The demo has no server to export from.')
      return
    }
    setExporting(true)
    setError(null)
    try {
      const { blob, filename } = await apiExportLeadsCsv(token, {
        rep: repFilter === 'all' ? null : repFilter,
        status: status === 'all' ? null : status,
      })
      await saveFile(blob, filename)
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof FileSaveUnsupported
          ? err.message
          : 'The export could not be produced. Try again.',
      )
    } finally {
      setExporting(false)
    }
  }

  async function addToList() {
    const ids = [...selected]
    const n = ids.length
    const noun = `${n.toLocaleString()} lead${n === 1 ? '' : 's'}`
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (listTarget) {
        const target = leadLists[listTarget]
        await updateListMembers(listTarget, { add: ids })
        setNotice(`Added ${noun} to ${target?.name ?? 'the list'}.`)
      } else {
        /*
          Through the store, which takes a list with reps to the server and a
          list without them onto the phone first — the same two roads the Lists
          page uses, so a list made here is indistinguishable from one drawn
          there. The count is read back from what was made, not from the
          selection: the server drops ids it does not know.
        */
        const made = await createList({ name: listName, propertyIds: ids, repIds: listReps })
        const handed = made.repIds.map((id) => nameOf(id) ?? id)
        setNotice(
          `Created ${made.name} with ${made.leadIds.length.toLocaleString()} lead${made.leadIds.length === 1 ? '' : 's'}.` +
            (handed.length ? ` Handed to ${handed.join(', ')}.` : ''),
        )
      }
      setSelected(new Set())
      setListOpen(false)
      setListTarget('')
      setListName('')
      setListReps([])
    } catch (err) {
      setError(
        err instanceof NetworkError
          ? 'Handing a list to a rep needs a connection. Try again when you are back online.'
          : err instanceof ApiError || (err instanceof Error && err.message)
            ? err.message
            : 'Could not save that. Nothing was changed.',
      )
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
    setEraseProgress({ done: 0, total: ids.length })

    let deleted = 0
    let alreadyGone = 0
    let notFound = 0
    let failed = 0
    let settled = 0
    const gone: string[] = []
    let broke: { text: string; definite: boolean; inFlight: number } | null = null

    try {
      for (let i = 0; i < ids.length; i += ERASE_BATCH) {
        const batch = ids.slice(i, i + ERASE_BATCH)
        try {
          const res = await apiEraseLeads(token, { propertyIds: batch, reason: eraseReason.trim() })
          deleted += res.deleted
          alreadyGone += res.alreadyGone
          notFound += res.notFound.length
          failed += res.failed.length
          gone.push(...batch.filter((id) => !res.failed.includes(id) && !res.notFound.includes(id)))
          settled += batch.length
          setEraseProgress({ done: settled, total: ids.length })
        } catch (err) {
          broke = { ...describeEraseFailure(err), inFlight: batch.length }
          break
        }
      }

      /*
        Everything confirmed gone leaves this device, even when a later batch
        broke. Those rows are destroyed on the server; keeping them on screen
        would be the same lie in the other direction.
      */
      if (gone.length) await forgetProperties(gone)
      void refreshFromServer()

      if (broke) {
        /*
          What this replaces said "Nothing was deleted", which the client is in
          no position to know. The server destroys one lead at a time and
          commits each before starting the next, so a request that never came
          back may have done all of its work, some of it, or none. What *is*
          knowable is how many batches were confirmed before the break and how
          many leads were in the one that was not — so that is what it says.
        */
        // Each clause is its own sentence, so the reason keeps its full stop
        // only once and what follows reads as prose rather than a list.
        const said = [broke.text.replace(/\.\s*$/, '')]
        if (deleted) said.push(`${deleted.toLocaleString()} lead${deleted === 1 ? '' : 's'} had already been deleted before that`)
        if (broke.inFlight) {
          said.push(
            broke.definite
              ? `The remaining ${(ids.length - settled).toLocaleString()} were not deleted`
              : `${broke.inFlight.toLocaleString()} more may or may not have been — refresh to see what is left`,
          )
        }
        setEraseError(`${said.join('. ')}.`)
        setSelected(new Set(ids.filter((id) => !gone.includes(id))))
        return
      }

      setConfirmErase(false)
      setEraseReason('')
      setSelected(new Set())
      const parts = [`${deleted.toLocaleString()} lead${deleted === 1 ? '' : 's'} deleted`]
      if (alreadyGone) parts.push(`${alreadyGone} ${alreadyGone === 1 ? 'was' : 'were'} already gone`)
      if (notFound) parts.push(`${notFound} no longer exist${notFound === 1 ? 's' : ''} on this team`)
      if (failed) parts.push(`${failed} could not be deleted — refresh and try again`)
      if (failed) setError(`${parts.join('. ')}.`)
      else setNotice(`${parts.join('. ')}.`)
    } finally {
      setErasing(false)
      setEraseProgress(null)
    }
  }

  const eraseCount = selected.size
  const eraseNoun = `${eraseCount.toLocaleString()} lead${eraseCount === 1 ? '' : 's'}`

  return (
    <AdminPage
      tour="console-leads"
      title="Leads"
      description={`${Object.keys(properties).length.toLocaleString()} in total · ${rows.length.toLocaleString()} matching`}
      actions={
        <Button
          size="sm"
          variant="secondary"
          disabled={exporting || mode !== 'live'}
          onClick={() => void exportCsv()}
          data-testid="export-csv"
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      }
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
          className="focusable min-h-[40px] w-full rounded-field border border-line px-3 text-sm md:w-72"
        />
        {/*
          On a phone the filters fold behind one button. Four dropdowns and
          eleven status chips stood between a manager and the first lead; the
          search and the list/map switch stay in view, and the rest opens with
          a count of what is on and a way to clear it.
        */}
        <button
          type="button"
          onClick={() => setFiltersShown((v) => !v)}
          aria-expanded={filtersShown}
          data-testid="console-leads-filters"
          className="focusable flex min-h-[44px] items-center gap-1.5 rounded-field border border-line bg-surface px-3 text-sm font-semibold text-ink-soft md:hidden"
        >
          <IconFilter />
          Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={resetFilters}
            className="focusable min-h-[44px] px-2 text-sm font-semibold text-accent md:hidden"
          >
            Reset
          </button>
        )}
        <div className={filtersShown ? 'contents' : 'hidden md:contents'}>
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
          value={territoryFilter}
          onChange={(e) => setTerritoryFilter(e.target.value)}
          className="focusable min-h-[40px] rounded-field border border-line bg-surface px-2 text-sm"
          aria-label="Territory"
          data-testid="leads-territory-filter"
        >
          <option value="all">Every territory</option>
          <option value="none">No territory</option>
          {territoryList.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
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
        </div>
      </FilterBar>

      <div className={filtersShown ? 'contents' : 'hidden md:contents'}>
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
      </div>

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
            Which patch the selection is filed in. Only the territory moves; the
            rep working each lead keeps it, and the reassign control beside this
            one is where that changes.
          */}
          <select
            value={territoryTo}
            onChange={(e) => setTerritoryTo(e.target.value)}
            className="focusable min-h-[38px] rounded-lg border border-ink/15 bg-surface px-2 text-sm"
            aria-label="Move to territory"
            data-testid="bulk-territory"
          >
            <option value="">Move to territory…</option>
            {territoryList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="__none">No territory</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || mode !== 'live' || !territoryTo}
            onClick={() => void applyTerritory()}
            data-testid="bulk-territory-apply"
          >
            {busy ? 'Saving…' : 'Move'}
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
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setListOpen((o) => !o)}
            aria-expanded={listOpen}
            data-testid="bulk-list"
          >
            Add to list
          </Button>
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

      {selected.size > 0 && listOpen && (
        <div
          className="mb-3 space-y-3 rounded-field bg-surface-sunk p-3"
          data-testid="bulk-list-panel"
        >
          <p className="text-sm font-semibold">
            Put {selected.size.toLocaleString()} lead{selected.size === 1 ? '' : 's'} on a list
          </p>
          <select
            value={listTarget}
            onChange={(e) => setListTarget(e.target.value)}
            className="focusable min-h-[38px] rounded-lg border border-ink/15 bg-surface px-2 text-sm"
            aria-label="Which list"
          >
            <option value="">New list…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.leadIds.length.toLocaleString()})
              </option>
            ))}
          </select>
          {!listTarget && (
            <>
              <Field
                label="List name"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                placeholder="e.g. Oak Street Area"
                disabled={busy}
              />
              {/*
                Hand it out here rather than on the Lists page afterwards: the
                brief for this bar is select, create, assign, with nothing in
                between. Same control the Lists page draws, so a manager learns
                it once.
              */}
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Hand to</legend>
                {reps.length === 0 ? (
                  <p className="text-[13px] text-ink-mute">Nobody on the team yet — you can hand it out later.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {reps.map((r) => {
                      const on = listReps.includes(r.id)
                      return (
                        <label
                          key={r.id}
                          className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] lg:min-h-[36px] ${
                            on ? 'border-brand-500 bg-brand-500/10 text-ink' : 'border-line text-ink-soft'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-brand-500"
                            checked={on}
                            disabled={busy}
                            onChange={() =>
                              setListReps((ids) => (on ? ids.filter((x) => x !== r.id) : [...ids, r.id]))
                            }
                          />
                          {r.name}
                        </label>
                      )
                    })}
                  </div>
                )}
              </fieldset>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={busy || (!listTarget && !listName.trim())}
              onClick={() => void addToList()}
              data-testid="bulk-list-apply"
            >
              {busy
                ? 'Saving…'
                : listTarget
                  ? `Add ${selected.size.toLocaleString()} to list`
                  : `Create list with ${selected.size.toLocaleString()}`}
            </Button>
            <button
              onClick={() => setListOpen(false)}
              className="focusable text-sm font-medium text-ink-mute underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {view === 'map' && (
        <section className="mb-3">
          {/*
            Drawing a shape round some pins, which is how an office selects a
            block without ticking forty rows.

            The gesture and the geometry are both reused rather than rebuilt:
            the map already turns taps into coordinates and draws the shape for
            territory drawing — both renderers do, through the same `draw`
            contract — and `pointInPolygon` is the same function the server uses
            to decide which leads a territory claims, kept in step by
            `verify:geo-parity`. What is new here is only where the answer goes:
            into the selection the checkboxes already feed.
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
          <AllStarMap
            className="h-[min(520px,60svh)] rounded-card md:h-[520px]"
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
            // The map deselects by passing null; there is nothing to toggle
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
          // The box stays 18 px; the label around it is the 44 pt target a
          // thumb needs, pulled back by its own margin so nothing moves.
          <label className="-m-[13px] grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggle(p.id)}
              aria-label={`Select ${p.address1}`}
              className="h-[18px] w-[18px] accent-brand-600"
            />
          </label>
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
            /*
              The address opens the lead — the same profile a rep opens, with
              its notes, visits and every rep's photos. This list had no way
              into a single lead at all, so a manager checking the roof shots
              a rep filed had to go and find the house on the field side.
              A link rather than a clickable row: the row already holds the
              selection checkbox, and a checkbox inside a button is two
              controls answering one tap.
            */
            cell: (p) => (
              <>
                <Link
                  to={`/property/${p.id}`}
                  className="focusable inline-flex min-h-tap items-center font-medium text-accent underline-offset-2 hover:underline"
                  data-testid="admin-lead-open"
                >
                  {p.address1}
                </Link>
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
          busyLabel={
            eraseProgress && eraseProgress.total > ERASE_BATCH
              ? `Deleting… ${eraseProgress.done.toLocaleString()} of ${eraseProgress.total.toLocaleString()}`
              : 'Deleting leads…'
          }
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

