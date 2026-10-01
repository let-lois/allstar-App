import { useEffect, useMemo, useRef, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { DataList } from './DataList'
import { fitZoom } from '../components/map/FieldMap'
import { AllStarMap } from '../components/map/AllStarMap'
import { Button } from '../components/ui/Button'
import { Field, TextArea } from '../components/ui/Input'
import { useAppStore } from '../store/useAppStore'
import { ApiError, NetworkError, apiExportLeadsCsv } from '../lib/http'
import { liveToken } from '../lib/session'
import { FileSaveUnsupported, saveFile } from '../lib/download'
import { pointInPolygon, polygonAreaSqMiles } from '../lib/geo'
import { canManageLists, tallyStatuses } from '../lib/leadLists'
import { STATUS_COLOR, STATUS_LABEL } from '../data/outcomes'
import type { LeadList } from '../types'

/**
 * Lead lists, from the office.
 *
 * A territory is the ground a rep owns: one patch, one rep, and every lead
 * inside it is theirs. A list is a working set — a block of houses grouped for
 * a push, a storm, a re-knock — and it can be handed to one rep or several
 * without moving anything. The two coexist on purpose, and the copy on this
 * screen keeps them apart, because "assign" on a territory and "assign" on a
 * list do different things to the leads a rep's phone receives.
 *
 * Same shape as the territories screen — table on the left, map on the right,
 * linked by selection — and the same drawing gesture, so a manager who has
 * outlined a territory already knows how to outline a list.
 */

type Draft = { points: { lat: number; lng: number }[] }

/** What the server or the store said went wrong, in words a manager can act on. */
function explain(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return 'That needs a connection. Try again when you are back online.'
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/** Said under the name field when Create is pressed without one. */
const LIST_NAME_REQUIRED = 'Give the list a name — the reps will see it.'

export function AdminLists() {
  const user = useAppStore((s) => s.user)
  const mode = useAppStore((s) => s.mode)
  const properties = useAppStore((s) => s.properties)
  const leadLists = useAppStore((s) => s.leadLists)
  const team = useAppStore((s) => s.team)
  const createList = useAppStore((s) => s.createList)
  const updateList = useAppStore((s) => s.updateList)
  const setListReps = useAppStore((s) => s.setListReps)
  const deleteList = useAppStore((s) => s.deleteList)

  const allProperties = useMemo(() => Object.values(properties), [properties])

  /*
    Anyone on the team a list can be handed to. Same roster the territory
    screen offers, so a name that can own a patch can also work a list.
  */
  const repOptions = useMemo(
    () => team.filter((m) => m.active && m.role !== 'super_admin'),
    [team],
  )
  const repName = (id: string) => team.find((m) => m.id === id)?.name ?? 'Former teammate'

  /* --- the table ----------------------------------------------------------- */
  const [repFilter, setRepFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const rows = useMemo(() => {
    const all = Object.values(leadLists)
    return all
      .filter((l) => showArchived || !l.archived)
      .filter((l) => {
        if (!repFilter) return true
        if (repFilter === '__none__') return l.repIds.length === 0
        return l.repIds.includes(repFilter)
      })
      .sort((a, b) => {
        // Live lists first, then by the name on screen.
        if (a.archived !== b.archived) return a.archived ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [leadLists, repFilter, showArchived])

  const [selected, setSelected] = useState<string | null>(null)
  const current: LeadList | null = selected ? (leadLists[selected] ?? null) : null

  /*
    Nothing selected until somebody taps a list — the page used to open the
    first one's map under the list on every visit. A list that disappears
    (archived away, deleted elsewhere) closes its panel.
  */
  useEffect(() => {
    if (selected !== null && !leadLists[selected]) setSelected(null)
  }, [selected, leadLists])
  const detail = useRef<HTMLElement>(null)
  const open = (id: string) => {
    setSelected(id)
    // On a phone the panel is below the list; bring it to the eye.
    window.setTimeout(() => detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  const shown = useMemo(() => {
    if (!current) return []
    const ids = new Set(current.leadIds)
    return allProperties.filter((p) => ids.has(p.id))
  }, [current, allProperties])

  /*
    Frame the selected list, or — when nothing is selected, which is every
    first visit and the whole of the drawing flow — every lead in the account.

    Not `properties[0]`, which is what the map falls back to on its own. That
    is the alphabetically first address, because the server orders by address1,
    and "1 Outside Ave" sorts before "10 Inside St": a manager about to draw
    round a block was opened onto whichever lone lead happened to sort first,
    which can be miles from everything else. Worse, the map seeds that view
    once at mount, so *which* answer you got depended on whether the store had
    filled yet — the same screen opened on two different places depending on
    how loaded the machine was. Fitting everything is both the right default
    for drawing and a deterministic one.
  */
  const framed = shown.length > 0 ? shown : allProperties.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  const view = useMemo(() => {
    if (framed.length === 0) return undefined
    return {
      center: {
        lat: framed.reduce((a, p) => a + p.lat, 0) / framed.length,
        lng: framed.reduce((a, p) => a + p.lng, 0) / framed.length,
      },
      zoom: fitZoom(framed, 440, 500),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framed.length, shown.length, current?.id])

  /* --- drawing a new list -------------------------------------------------- */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [draftReps, setDraftReps] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [drawError, setDrawError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Counted on every tap, the same arithmetic the territory screen uses, so
  // the number under the manager's finger is the number the list will hold.
  const inside = useMemo(() => {
    if (!draft || draft.points.length < 3) return []
    return allProperties.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, draft.points),
    )
  }, [draft, allProperties])

  const draftArea = useMemo(
    () => (draft && draft.points.length >= 3 ? polygonAreaSqMiles(draft.points) : 0),
    [draft],
  )

  const toggleDraftRep = (id: string) =>
    setDraftReps((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))

  /*
    Open or fold the Create section. Folding keeps the shape, the name and the
    reps for when it is opened again; Start over discards the shape.
  */
  const draftStash = useRef<{ lat: number; lng: number }[] | null>(null)
  const toggleCreate = () => {
    if (draft) {
      draftStash.current = draft.points.length ? draft.points : null
      setDraft(null)
      setDrawError(null)
      return
    }
    setDraft({ points: draftStash.current ?? [] })
    setDrawError(null)
    setNotice(null)
    setSelected(null)
  }

  const saveDraft = async () => {
    if (!draft || draft.points.length < 3) return
    const name = draftName.trim()
    if (!name) {
      setDrawError(LIST_NAME_REQUIRED)
      return
    }
    setCreating(true)
    setDrawError(null)
    try {
      const made = await createList({
        name,
        description: draftDescription.trim() || undefined,
        repIds: draftReps,
        boundary: draft.points,
      })
      const n = made.leadIds.length
      const who =
        made.repIds.length === 0
          ? 'Nobody has it yet.'
          : `Handed to ${made.repIds.map(repName).join(', ')}.`
      setNotice(`Created ${name} with ${n.toLocaleString()} lead${n === 1 ? '' : 's'}. ${who}`)
      setDraft(null)
      draftStash.current = null
      setDraftName('')
      setDraftDescription('')
      setDraftReps([])
      setRepFilter('')
      setShowArchived(false)
      // Said at the top and in the list; its map opens when it is tapped.
      setSelected(null)
    } catch (err) {
      setDrawError(explain(err, 'Could not create the list. Nothing was changed.'))
    } finally {
      setCreating(false)
    }
  }

  /* --- editing the selected list ------------------------------------------- */
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState(false)
  async function exportCsv() {
    const token = liveToken()
    if (!current || !token) return
    setExporting(true)
    setNotice(null)
    try {
      const { blob, filename } = await apiExportLeadsCsv(token, { list: current.id, listName: current.name })
      await saveFile(blob, filename)
      setNotice(`Exported ${current.name}.`)
    } catch (err) {
      setNotice(err instanceof FileSaveUnsupported ? err.message : explain(err, 'The export could not be produced.'))
    } finally {
      setExporting(false)
    }
  }

  // Re-seed the form whenever a different list is picked or it changes under us.
  useEffect(() => {
    setEditName(current?.name ?? '')
    setEditDescription(current?.description ?? '')
    setEditError(null)
    setConfirmDelete(false)
  }, [current?.id, current?.name, current?.description])

  const dirty =
    !!current &&
    (editName.trim() !== current.name || editDescription.trim() !== (current.description ?? ''))

  const act = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setEditError(null)
    setNotice(null)
    try {
      await work()
    } catch (err) {
      setEditError(explain(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  const saveEdits = () =>
    current &&
    act(async () => {
      await updateList(current.id, { name: editName, description: editDescription })
      setNotice('Saved.')
    }, 'Could not save that. Nothing was changed.')

  const toggleRep = (repId: string) =>
    current &&
    act(async () => {
      const next = current.repIds.includes(repId)
        ? current.repIds.filter((r) => r !== repId)
        : [...current.repIds, repId]
      await setListReps(current.id, next)
      setNotice(
        current.repIds.includes(repId)
          ? `${repName(repId)} no longer has ${current.name}.`
          : `${repName(repId)} has ${current.name} now. They’ll see its leads next time their phone syncs.`,
      )
    }, 'Could not change who has this list. Nothing was changed.')

  const toggleArchived = () =>
    current &&
    act(async () => {
      await updateList(current.id, { archived: !current.archived })
      setNotice(current.archived ? `${current.name} is back.` : `${current.name} archived. Reps no longer see it.`)
    }, 'Could not archive that. Nothing was changed.')

  const remove = () =>
    current &&
    act(async () => {
      const name = current.name
      await deleteList(current.id)
      setSelected(null)
      setNotice(`${name} deleted. The leads themselves are untouched.`)
    }, 'Could not delete that. Archive it instead if you are offline.')

  // Same line the server draws; a rep who somehow lands here gets read-only.
  const manager = canManageLists(user)

  const liveCount = useMemo(() => Object.values(leadLists).filter((l) => !l.archived).length, [leadLists])

  return (
    <AdminPage
      title="Lists"
      description={`${liveCount} list${liveCount === 1 ? '' : 's'} · a list is a working set of leads handed to one rep or several — a territory is the ground one rep owns`}
    >
      {/*
        --- Create new list --------------------------------------------------
        At the top, folded until wanted, the same as Territories: open, it is
        the drawing tools, the map, then the details and Create. Folded, the
        lists are the first thing on the page.
      */}
      {manager && (
      <section className="mb-4 overflow-hidden card" data-testid="list-create">
        <button
          type="button"
          onClick={toggleCreate}
          aria-expanded={!!draft}
          aria-controls="list-create-panel"
          data-testid="list-create-toggle"
          className="focusable flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-tint text-accent" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">Create new list</span>
            <span className="block text-[12.5px] text-ink-mute">
              {draft ? 'Outline the houses on the map, then name it' : 'Draw round a block of leads and hand it to reps'}
            </span>
          </span>
          <svg
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden
            className={`shrink-0 text-ink-mute transition-transform ${draft ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {draft && (
          <div id="list-create-panel" className="border-t border-line-soft">
            <div className="px-4 py-3">
              <p className="text-[13px] leading-snug text-ink-mute">
                Tap the map to drop points. Every lead inside goes on the list; nothing changes who owns them.
              </p>
              {/* Fixed height: anything that grows here moves the map under the finger drawing on it. */}
              <div className="mt-2 flex h-7 items-baseline gap-3 whitespace-nowrap">
                <span className="nums text-[20px] font-semibold leading-none tracking-[-0.02em]">
                  {inside.length.toLocaleString()}
                </span>
                <span className="text-[12.5px] text-ink-mute">lead{inside.length === 1 ? '' : 's'} inside</span>
                <span className="nums ml-auto text-[12.5px] text-ink-mute">
                  {draftArea > 0 ? `${draftArea < 10 ? draftArea.toFixed(1) : Math.round(draftArea)} sq mi` : '—'}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="whitespace-nowrap"
                  disabled={draft.points.length === 0}
                  onClick={() => setDraft((d) => (d ? { points: d.points.slice(0, -1) } : d))}
                >
                  Undo point
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="whitespace-nowrap"
                  disabled={draft.points.length === 0}
                  onClick={() => {
                    draftStash.current = null
                    setDraft({ points: [] })
                  }}
                >
                  Start over
                </Button>
              </div>
            </div>

            <AllStarMap
              className="h-[min(440px,55svh)] md:h-[480px]"
              properties={allProperties}
              draw={{
                points: draft.points,
                onAddPoint: (point) => setDraft((d) => (d ? { points: [...d.points, point] } : d)),
                label: 'Outline a list on the map',
              }}
              position={null}
              disableClustering={allProperties.length <= 25}
              selectedId={null}
              onSelect={() => {}}
              key="draw"
              initialCenter={view?.center}
              initialZoom={view?.zoom}
            />

            <div className="space-y-4 px-4 py-4">
              <Field
                label="Name (required)"
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value)
                  if (drawError && e.target.value.trim()) setDrawError(null)
                }}
                required
                aria-required="true"
                placeholder="e.g. Storm re-knock — Cypress Ridge"
                error={drawError === LIST_NAME_REQUIRED ? drawError : undefined}
                data-testid="list-name"
              />
              <TextArea
                label="Description"
                rows={2}
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="Optional — what this push is for"
              />
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Hand to</legend>
                {repOptions.length === 0 ? (
                  <p className="text-[13px] text-ink-mute">Nobody on the team yet — you can hand it out later.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {repOptions.map((r) => {
                      const on = draftReps.includes(r.id)
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
                            onChange={() => toggleDraftRep(r.id)}
                          />
                          {r.name}
                        </label>
                      )
                    })}
                  </div>
                )}
              </fieldset>

              {/* A list only groups leads that already exist, so a new area
                  reads 0 here. Say where the houses come from instead. */}
              {draft.points.length >= 3 && inside.length === 0 && (
                <p className="text-[13px] leading-snug text-ink-soft" data-testid="list-empty-hint">
                  No leads inside this shape yet. A list only groups existing leads — to turn the houses here into leads, draw it under <span className="font-semibold">Territories</span>.
                </p>
              )}

              <div>
                {drawError && drawError !== LIST_NAME_REQUIRED && (
                  <p role="alert" className="mb-3 rounded-field bg-bad-bg px-3 py-2 text-[13px] font-medium text-bad">
                    {drawError}
                  </p>
                )}
                <Button full disabled={draft.points.length < 3 || creating} onClick={() => void saveDraft()} data-testid="list-create-submit">
                  {creating
                    ? 'Creating…'
                    : draft.points.length < 3
                      ? 'Drop at least three points'
                      : `Create with ${inside.length.toLocaleString()} lead${inside.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
      )}

      <div className={`grid gap-4 ${!draft && current ? 'xl:grid-cols-[minmax(0,1fr)_460px]' : ''}`}>
        <div>
          {/* --- filters: a row that wraps, never scrolls -------------------- */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px] text-ink-soft">
              <span className="font-medium">Rep</span>
              <select
                aria-label="Filter by rep"
                value={repFilter}
                onChange={(e) => setRepFilter(e.target.value)}
                className="focusable min-h-[44px] rounded-lg border border-line bg-surface px-2 text-[13px] lg:min-h-[36px]"
              >
                <option value="">All reps</option>
                <option value="__none__">Nobody yet</option>
                {repOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink-soft lg:min-h-[36px]">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 accent-brand-500"
              />
              Show archived
            </label>
          </div>

          <DataList
            rows={rows}
            keyOf={(l) => l.id}
            onRow={(l) => open(l.id)}
            isSelected={(l) => selected === l.id}
            rowLabel={(l) => `Show ${l.name} on the map`}
            empty={
              repFilter || showArchived
                ? 'No lists match that filter.'
                : manager
                  ? 'No lists yet. Draw one round a block of houses and hand it to a rep — or several.'
                  : 'No lists yet.'
            }
            columns={[
              {
                header: 'List',
                phone: 'title',
                className: 'font-medium',
                cell: (l) => l.name,
              },
              {
                header: 'Status',
                phone: 'trailing',
                cell: (l) =>
                  l.archived ? (
                    <span className="rounded-md bg-line-soft px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
                      Archived
                    </span>
                  ) : l.pending ? (
                    <span className="text-[12px] text-ink-mute">Syncing…</span>
                  ) : (
                    <span className="text-[12px] text-good">Live</span>
                  ),
              },
              { header: 'Leads', align: 'right', cell: (l) => l.leadIds.length.toLocaleString() },
              {
                header: 'Reps',
                cell: (l) =>
                  l.repIds.length === 0 ? (
                    <span className="text-ink-mute">Nobody yet</span>
                  ) : (
                    l.repIds.map(repName).join(', ')
                  ),
              },
              {
                header: 'Updated',
                phone: 'off',
                cell: (l) => new Date(l.updatedAt).toLocaleDateString(),
              },
            ]}
          />

          <div className="mt-3 card px-4 py-3 text-xs lg:mt-0 lg:rounded-none lg:border-0 lg:border-t lg:border-line-soft">
            {editError ? (
              <p role="alert" className="font-medium text-bad">
                {editError}
              </p>
            ) : notice ? (
              <p role="status" className="font-medium text-good">
                {notice}
              </p>
            ) : (
              <p className="text-ink-mute">
                {mode === 'live'
                  ? 'Handing a list to a rep puts its leads on their phone without changing who owns them. Archiving takes it off every phone; the leads stay.'
                  : 'Demo data — changes stay on this device. Handing a list to a rep puts its leads on their phone without changing who owns them.'}
              </p>
            )}
          </div>

          {/* --- the selected list ------------------------------------------ */}
          {current && !draft && (
            <section
              ref={detail}
              aria-label={`Edit ${current.name}`}
              className="mt-4 scroll-mt-4 card px-4 py-4"
              data-list-editor
            >
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Name"
                  value={editName}
                  disabled={!manager || busy}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <TextArea
                  label="Description"
                  rows={2}
                  value={editDescription}
                  disabled={!manager || busy}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="What this push is for"
                />
              </div>

              <fieldset className="mt-4">
                <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Who has it</legend>
                {repOptions.length === 0 ? (
                  <p className="text-[13px] text-ink-mute">Nobody on the team to hand it to yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {repOptions.map((r) => {
                      const on = current.repIds.includes(r.id)
                      return (
                        <label
                          key={r.id}
                          className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] lg:min-h-[36px] ${
                            on ? 'border-brand-500 bg-brand-500/10 text-ink' : 'border-line text-ink-soft'
                          } ${!manager || busy ? 'cursor-default opacity-60' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-brand-500"
                            checked={on}
                            disabled={!manager || busy}
                            onChange={() => void toggleRep(r.id)}
                          />
                          {r.name}
                        </label>
                      )
                    })}
                  </div>
                )}
              </fieldset>

              {manager && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" disabled={!dirty || busy} onClick={() => void saveEdits()}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </Button>
                  {/* This list's houses as a file, written by the server from the database. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || exporting || mode !== 'live' || current.leadIds.length === 0}
                    onClick={() => void exportCsv()}
                    data-testid="export-list-csv"
                  >
                    {exporting ? 'Exporting…' : 'Export CSV'}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggleArchived()}>
                    {current.archived ? 'Restore' : 'Archive'}
                  </Button>
                  {confirmDelete ? (
                    <>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
                        Yes, delete {current.name}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                        Keep it
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* --- the map ------------------------------------------------------- */}
        {/*
          The selected list — its leads, its map. Only when one is tapped, so
          the page is not carrying a map nobody asked for.
        */}
        {!draft && current && (
        <div className="overflow-hidden card" data-testid="list-detail">
          <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-3">
            <h2 className="text-sm font-semibold">
              {current.name}
            </h2>
            <span className="flex items-baseline gap-3">
              <span className="nums text-xs text-ink-mute">{`${shown.length} lead${shown.length === 1 ? '' : 's'}`}</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close this list"
                data-testid="list-detail-close"
                className="focusable -my-3 -mr-2 grid h-11 w-11 place-items-center rounded-full text-ink-mute active:bg-surface-field"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          </div>
          {/* The same progress line the rep sees on their phone, for the same list. */}
          {shown.length > 0 && (
            <p className="nums border-b border-line-soft px-4 py-2 text-[12.5px] text-ink-soft" data-testid="list-progress">
              {[`${shown.length} total`, ...tallyStatuses(shown).map((t) => `${t.count} ${STATUS_LABEL[t.status].toLowerCase()}`)].join(' · ')}
            </p>
          )}

          {shown.length === 0 && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              {current.leadIds.length === 0
                ? 'This list is empty. Reps can add houses from the field, or draw a new one round an area.'
                : 'None of the leads on this list have coordinates yet, so there is nothing to place on a map.'}
            </p>
          )}
          {/*
            The leads themselves, which this screen did not show.

            Selecting a list gave a name, a status tally and a map — and no way
            to read the actual houses on it. Reported from the console: "I don't
            think I can view a list of leads on the list without exporting it,
            it just shows a map." That was exactly right. Export CSV was the
            only route to the rows, which is a strange thing to need in order to
            answer "who is on this list".

            Above the map rather than below it, because it is the answer to the
            question the screen is open for; the map is the context. Capped and
            scrolled on its own so a four-hundred-lead list does not push the
            map off the bottom of the page.

            Same `DataList` the Leads console uses, so a row reads the same in
            both places and a phone gets cards instead of a broken table.
          */}
          {shown.length > 0 && (
            <div className="max-h-[320px] overflow-y-auto border-b border-line-soft">
              <DataList
                rows={shown}
                keyOf={(p) => p.id}
                empty="Nothing on this list yet."
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
                    header: 'Status',
                    phone: 'trailing',
                    cell: (p) => (
                      /* A word as well as a colour — never colour alone. */
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: STATUS_COLOR[p.status] }}
                        />
                        {STATUS_LABEL[p.status]}
                      </span>
                    ),
                  },
                  {
                    header: 'Owner',
                    phone: 'meta',
                    cell: (p) =>
                      p.contacts[0]?.name ?? <span className="text-ink-mute">—</span>,
                  },
                  {
                    header: 'Assigned',
                    phone: 'meta',
                    cell: (p) =>
                      p.assignedRepId ? (
                        repName(p.assignedRepId)
                      ) : (
                        /* Unassigned is the state worth seeing: a lead nobody
                           owns reaches no rep's phone at all. */
                        <span className="text-warn">Nobody</span>
                      ),
                  },
                ]}
              />
            </div>
          )}

          <AllStarMap
            className="h-[min(520px,60svh)] md:h-[520px]"
            properties={shown}
            draw={
              current.boundary && current.boundary.length >= 3
                  ? {
                      // Read-only: the saved shape, shown; a tap does nothing.
                      points: current.boundary,
                      onAddPoint: () => {},
                      label: `Boundary of ${current.name}`,
                    }
                  : undefined
            }
            position={null}
            disableClustering={shown.length <= 25}
            selectedId={null}
            onSelect={() => {}}
            key={selected ?? 'all'}
            initialCenter={view?.center}
            initialZoom={view?.zoom}
          />
        </div>
        )}
      </div>
    </AdminPage>
  )
}
