import { useEffect, useMemo, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { DataList } from './DataList'
import { FieldMap, fitZoom } from '../components/map/FieldMap'
import { Button } from '../components/ui/Button'
import { Field, TextArea } from '../components/ui/Input'
import { useAppStore } from '../store/useAppStore'
import { ApiError, NetworkError } from '../lib/http'
import { pointInPolygon, polygonAreaSqMiles } from '../lib/geo'
import { canManageLists } from '../lib/leadLists'
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

  // Lists arrive from IndexedDB a beat after the first render; pick one then.
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0].id)
    if (selected !== null && !leadLists[selected]) setSelected(rows[0]?.id ?? null)
  }, [rows, selected, leadLists])

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

  const startDraw = () => {
    setDraft({ points: [] })
    setDraftName('')
    setDraftDescription('')
    setDraftReps([])
    setDrawError(null)
    setNotice(null)
    setSelected(null)
  }

  const saveDraft = async () => {
    if (!draft || draft.points.length < 3) return
    const name = draftName.trim()
    if (!name) {
      setDrawError('Give the list a name — the reps will see it.')
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
      setRepFilter('')
      setShowArchived(false)
      setSelected(made.id)
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
      actions={
        draft ? (
          <Button variant="secondary" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        ) : manager ? (
          <Button onClick={startDraw}>New list</Button>
        ) : null
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
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
            onRow={(l) => setSelected(l.id)}
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
              aria-label={`Edit ${current.name}`}
              className="mt-4 card px-4 py-4"
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
        <div className="overflow-hidden card">
          <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-3">
            <h2 className="text-sm font-semibold">
              {draft ? 'Outline the list' : current ? current.name : 'Lists'}
            </h2>
            <span className="nums text-xs text-ink-mute">
              {draft
                ? `${draft.points.length} point${draft.points.length === 1 ? '' : 's'}`
                : `${shown.length} lead${shown.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {draft && (
            <div className="border-b border-line-soft px-4 py-3">
              <p className="text-[13px] leading-relaxed text-ink-mute">
                Tap the map to drop a point. Three or more closes the shape — every
                lead inside it goes on the list. Nothing changes who owns them.
              </p>

              {/* Fixed height: this panel sits above the map, and growing it moves
                  the map under the finger that is drawing on it. */}
              <div className="mt-3 flex h-8 items-baseline gap-4">
                <span>
                  <span className="nums text-[22px] font-semibold leading-none tracking-[-0.02em]">
                    {inside.length.toLocaleString()}
                  </span>
                  <span className="ml-1.5 text-[12.5px] text-ink-mute">
                    lead{inside.length === 1 ? '' : 's'} inside
                  </span>
                </span>
                <span className="nums text-[12.5px] text-ink-mute">
                  {draftArea > 0
                    ? `${draftArea < 10 ? draftArea.toFixed(1) : Math.round(draftArea)} sq mi`
                    : '—'}
                </span>
              </div>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={draft.points.length === 0}
                  onClick={() => setDraft((d) => (d ? { points: d.points.slice(0, -1) } : d))}
                >
                  Undo point
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={draft.points.length === 0}
                  onClick={() => setDraft({ points: [] })}
                >
                  Start over
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                <Field
                  label="Name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. Storm re-knock — Cypress Ridge"
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
              </div>

              <p
                role="alert"
                className={`mt-3 min-h-[18px] text-[13px] font-medium text-bad ${drawError ? '' : 'invisible'}`}
              >
                {drawError ?? ' '}
              </p>

              <Button
                full
                className="mt-4"
                disabled={draft.points.length < 3 || creating}
                onClick={() => void saveDraft()}
              >
                {creating
                  ? 'Creating…'
                  : draft.points.length < 3
                    ? 'Drop at least three points'
                    : `Create with ${inside.length.toLocaleString()} lead${inside.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}

          {!draft && current && shown.length === 0 && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              {current.leadIds.length === 0
                ? 'This list is empty. Reps can add houses from the field, or draw a new one round an area.'
                : 'None of the leads on this list have coordinates yet, so there is nothing to place on a map.'}
            </p>
          )}
          {!draft && !current && rows.length === 0 && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              Draw a list to see its leads here.
            </p>
          )}

          <FieldMap
            className="h-[520px]"
            properties={draft ? allProperties : shown}
            draw={
              draft
                ? {
                    points: draft.points,
                    onAddPoint: (point) =>
                      setDraft((d) => (d ? { points: [...d.points, point] } : d)),
                    label: 'Outline a list on the map',
                  }
                : current?.boundary && current.boundary.length >= 3
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
            key={draft ? 'draw' : (selected ?? 'all')}
            initialCenter={view?.center}
            initialZoom={view?.zoom}
          />
        </div>
      </div>
    </AdminPage>
  )
}
