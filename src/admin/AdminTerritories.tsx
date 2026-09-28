import { useEffect, useMemo, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { fitZoom } from '../components/map/FieldMap'
import { AllStarMap } from '../components/map/AllStarMap'
import { useAppStore } from '../store/useAppStore'
import { UNASSIGNED_TERRITORY, inTerritory, useTerritories } from './useAdminData'
import { DataList } from './DataList'
import { ApiError, apiAssignTerritory } from '../lib/http'
import { liveToken } from '../lib/session'
import { moneyFull } from '../lib/format'
import { pointInPolygon, polygonAreaSqMiles } from '../lib/geo'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'

/**
 * Territory management.
 *
 * Table on the left, map on the right, linked by selection — territory is a
 * spatial idea, and a coverage number without the shape it covers doesn't tell
 * a manager whether a rep is working a patch or cherry-picking across it.
 *
 * Reuses the field map component rather than a second renderer, so what the
 * office sees is what the rep sees.
 */
export function AdminTerritories() {
  const properties = useAppStore((s) => s.properties)
  const territories = useAppStore((s) => s.territories)
  const mode = useAppStore((s) => s.mode)
  const list = useMemo(() => Object.values(properties), [properties])
  const unsorted = useTerritories(list)

  /** A territory's name if we have one; otherwise something readable. */
  const label = (id: string) =>
    id === UNASSIGNED_TERRITORY ? 'Unassigned' : (territories[id]?.name ?? id)

  /* --- drawing a new territory ------------------------------------------- */
  const createTerritory = useAppStore((s) => s.createTerritory)
  const [draft, setDraft] = useState<{ points: { lat: number; lng: number }[] } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftRep, setDraftRep] = useState('')
  const [saving2, setSaving2] = useState(false)
  const [drawError, setDrawError] = useState<string | null>(null)
  const [drawDone, setDrawDone] = useState<string | null>(null)

  /*
    Counted on every tap, over every lead with coordinates. A manager dragging a
    patch out needs the number to move under their finger — that is the whole
    feedback loop of the feature, and it is why the point-in-polygon test is
    plain arithmetic rather than anything cleverer.
  */
  const inside = useMemo(() => {
    if (!draft || draft.points.length < 3) return []
    return list.filter(
      (p) =>
        Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, draft.points),
    )
  }, [draft, list])

  const draftArea = useMemo(
    () => (draft && draft.points.length >= 3 ? polygonAreaSqMiles(draft.points) : 0),
    [draft],
  )

  const saveDraft = async () => {
    if (!draft || draft.points.length < 3) return
    const name = draftName.trim()
    if (!name) {
      setDrawError('Give the area a name — the reps will see it.')
      return
    }
    setSaving2(true)
    setDrawError(null)
    try {
      const res = await createTerritory({
        name,
        repId: draftRep || null,
        boundary: draft.points,
      })
      setDrawDone(
        `Created ${name} with ${res.assigned.toLocaleString()} lead${res.assigned === 1 ? '' : 's'}.`,
      )
      /*
        Select what was just made. Without this the map left drawing mode with
        no selection, reframed itself on every lead in the company, and the
        patch that had just been drawn was nowhere on screen — which read as
        the map jumping somewhere else the moment the work was saved.
      */
      setSelected(res.id)
      setDraft(null)
      setDraftName('')
      setDraftRep('')
    } catch (err) {
      setDrawError(
        err instanceof ApiError ? err.message : 'Could not create the territory. Try again.',
      )
    } finally {
      setSaving2(false)
    }
  }

  /*
    Sorted by the name on screen, not by the internal id. Ids are hashes, so
    sorting on them puts the rows in an order with no relationship to what the
    operator is reading. Unassigned sits last wherever it falls alphabetically —
    it's a catch-all rather than a territory, and it belongs at the bottom of the
    list the same way it belongs at the bottom of the priorities.
  */
  const rows = useMemo(
    () =>
      [...unsorted].sort((a, b) => {
        if (a.id === UNASSIGNED_TERRITORY) return 1
        if (b.id === UNASSIGNED_TERRITORY) return -1
        return label(a.id).localeCompare(label(b.id))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unsorted, territories],
  )

  const [selected, setSelected] = useState<string | null>(rows[0]?.id ?? null)

  // The first render has no properties yet — they arrive from IndexedDB a beat
  // later — so the initial selection is null and would otherwise stay null.
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0].id)
  }, [rows, selected])

  /*
    Goes through `inTerritory` rather than comparing ids directly. Unassigned
    leads have no `territoryId` at all, so `territoryId === selected` never
    matched the unassigned bucket and the map showed nothing for it — which is
    every lead from an import where no territory name was given, i.e. the default.
  */
  const shown = useMemo(() => list.filter((p) => inTerritory(p, selected)), [list, selected])

  /*
    One roster, from the store: real on a live account, seeded in the demo.
    Offering to assign a territory to somebody who doesn't work here is worse
    than offering nothing.
  */
  const team = useAppStore((s) => s.team)
  const repOptions = useMemo(
    () => team.filter((m) => m.active && m.role !== 'super_admin'),
    [team],
  )

  /* --- assignment ---------------------------------------------------- */
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)
  const [saving, setSaving] = useState<string | null>(null)
  const [assignError, setAssignError] = useState<string | null>(null)
  const [assigned, setAssigned] = useState<string | null>(null)

  async function assign(territoryId: string, repId: string) {
    const token = liveToken()
    if (!token) {
      setAssignError('Assigning leads needs a live account. The demo has no real team.')
      return
    }
    setSaving(territoryId)
    setAssignError(null)
    setAssigned(null)
    try {
      const res = await apiAssignTerritory(token, {
        // The unassigned bucket is a sentinel on this side and a null on the
        // wire — the server has no row for "no territory".
        territoryId: territoryId === UNASSIGNED_TERRITORY ? null : territoryId,
        repId: repId || null,
      })
      // Re-read rather than patching state: this changes which properties a rep
      // can see, and guessing at the result is how a console drifts from the
      // database it is supposed to be showing.
      await refreshFromServer()
      setAssigned(
        repId
          ? `${res.assigned} lead${res.assigned === 1 ? '' : 's'} assigned.`
          : `${res.assigned} lead${res.assigned === 1 ? '' : 's'} unassigned.`,
      )
    } catch (err) {
      setAssignError(
        err instanceof ApiError ? err.message : 'Could not save that. Nothing was changed.',
      )
    } finally {
      setSaving(null)
    }
  }

  /* --- renaming and deleting ---------------------------------------- */
  /*
    Both live on the panel beside the map rather than in the table, and that is
    not only about column width. A delete needs the operator to be looking at
    the thing they are deleting — the panel is already showing the shape and the
    lead count for the selected territory, so the question "is this the one?" is
    answered on screen instead of from memory of which row was clicked.

    The unassigned bucket is excluded because it is not a row in the database:
    it is every lead with no territory, and there is nothing to rename or drop.
    Same for a territory id that only appears on leads — an import can name one
    that was never drawn — where renaming would be writing to a row that does
    not exist.
  */
  const renameTerritory = useAppStore((s) => s.renameTerritory)
  const deleteTerritory = useAppStore((s) => s.deleteTerritory)
  const editable = selected !== null && selected !== UNASSIGNED_TERRITORY && !!territories[selected]

  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manageError, setManageError] = useState<string | null>(null)
  const [managed, setManaged] = useState<string | null>(null)
  /*
    The delete confirmation is a separate note, and not because there are two
    kinds of good news.

    Everything else here is cleared when the selection moves, which is right —
    "Renamed to X" must not sit over a different territory. But a delete *is* a
    selection change: it drops the row, so the panel moves on, and a note
    cleared by that effect would vanish in the same frame it appeared. So this
    one is cleared by hand, at the start of the next thing the operator does.
  */
  const [removedNote, setRemovedNote] = useState<string | null>(null)

  // Leaving a half-typed rename open while the selection moves would apply it
  // to a different territory on the next Save.
  useEffect(() => {
    setRenaming(null)
    setConfirming(null)
    setManageError(null)
    setManaged(null)
  }, [selected])

  async function saveRename() {
    if (!renaming) return
    const name = renameTo.trim()
    if (!name) {
      setManageError('Give the area a name — the reps will see it.')
      return
    }
    setBusy(true)
    setManageError(null)
    setManaged(null)
    try {
      await renameTerritory(renaming, name)
      setRenaming(null)
      setManaged(`Renamed to ${name}.`)
      setRemovedNote(null)
    } catch (err) {
      setManageError(
        err instanceof ApiError ? err.message : 'Could not rename that. Nothing was changed.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (!confirming) return
    const name = label(confirming)
    setBusy(true)
    setManageError(null)
    setManaged(null)
    try {
      const res = await deleteTerritory(confirming)
      setConfirming(null)
      // Off the row that no longer exists, rather than leaving the panel
      // titled with a deleted name over an empty map. The effect a few lines
      // up picks the first remaining territory.
      setSelected(null)
      setRemovedNote(
        `Deleted ${name}. ${res.released.toLocaleString()} lead${
          res.released === 1 ? '' : 's'
        } went back to Unassigned; whoever was walking them still has them.`,
      )
    } catch (err) {
      setManageError(
        err instanceof ApiError ? err.message : 'Could not delete that. Nothing was changed.',
      )
    } finally {
      setBusy(false)
    }
  }

  // Frame the selected territory rather than inheriting the rep's street-level
  // zoom, where the whole patch collapses into cluster bubbles.
  const view = useMemo(() => {
    if (shown.length === 0) return undefined
    return {
      center: {
        lat: shown.reduce((a, p) => a + p.lat, 0) / shown.length,
        lng: shown.reduce((a, p) => a + p.lng, 0) / shown.length,
      },
      zoom: fitZoom(shown, 440, 500),
    }
  }, [shown])

  const totals = useMemo(
    () => ({
      properties: rows.reduce((a, r) => a + r.properties, 0),
      knocked: rows.reduce((a, r) => a + r.knocked, 0),
      open: rows.reduce((a, r) => a + r.openValue, 0),
    }),
    [rows],
  )

  return (
    <AdminPage
      tour="console-territories"
      title="Territories"
      description={`${rows.length} territories · ${totals.properties.toLocaleString()} properties · ${moneyFull(totals.open)} open`}
      actions={
        draft ? (
          <Button variant="secondary" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        ) : (
          <Button
            onClick={() => {
              setDraft({ points: [] })
              setDrawDone(null)
              setDrawError(null)
              setRemovedNote(null)
              /*
                The selection is deliberately kept.

                Clearing it used to be the first thing this did, and it is why
                drawing was reported as hard: `view` is framed on the selected
                territory, so dropping the selection reframed the map on every
                lead the company owns. A manager looking at one neighbourhood
                pressed New territory and was thrown out to the whole state,
                with the streets they meant to draw round now a few pixels
                wide. Keeping it means the shape is drawn on the map that was
                already on screen. Every lead is still *shown* while drawing —
                that is the `properties` prop below — which was the only thing
                clearing the selection was really for.
              */
            }}
          >
            New territory
          </Button>
        )
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <>
        <DataList
          rows={rows}
          keyOf={(t) => t.id}
          onRow={(t) => setSelected(t.id)}
          isSelected={(t) => selected === t.id}
          rowLabel={(t) => `Show ${label(t.id)} on the map`}
          empty="No territories yet — they appear once leads carry one."
          columns={[
            {
              header: 'Territory',
              phone: 'title',
              /*
                The bare label, with the weight on the cell. Wrapping it in a
                span made the span the smallest element containing the text,
                which is what Playwright's `:text-is` matches — so a gate that
                located a row by its first cell stopped finding any row. The
                markup a test locates by is part of the contract.
              */
              className: 'font-medium',
              cell: (t) => label(t.id),
            },
            {
              header: 'Assigned rep',
              cell: (t) => (
                <select
                  value={t.repId ?? ''}
                  disabled={mode !== 'live' || saving !== null}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void assign(t.id, e.target.value)}
                  /* 44px on a phone: this is the one control in the console a
                     manager reaches for one-handed, reassigning a patch because
                     somebody called in sick. */
                  className="focusable min-h-[44px] w-full rounded-lg border border-line bg-surface px-2 text-[13px] disabled:opacity-60 lg:min-h-[36px] lg:w-auto lg:text-xs"
                >
                  <option value="">{t.mixed ? 'Mixed — pick one' : 'Unassigned'}</option>
                  {repOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ),
            },
            { header: 'Properties', align: 'right', cell: (t) => t.properties },
            {
              header: 'Coverage',
              cell: (t) => (
                /* A magnitude, so a bar — plus the number, because a bar alone
                   cannot be read precisely. */
                <span className="flex items-center gap-2">
                  <span className="h-2 w-full max-w-[96px] overflow-hidden rounded-full bg-line-soft">
                    <span
                      className="block h-full rounded-full bg-brand-500"
                      style={{ width: `${t.coverage}%` }}
                    />
                  </span>
                  <span className="nums shrink-0 text-xs font-semibold">{t.coverage}%</span>
                </span>
              ),
            },
            /*
              Last, not second.

              Column order is not cosmetic here: a whole-row click selects the
              territory, and the rep `<select>` calls `stopPropagation` so its own
              clicks do not. With Open value in position two the select sat in the
              middle of the row — which is where a click on a table row lands —
              so selecting a territory on a desktop silently stopped working.
            */
            {
              header: 'Open value',
              phone: 'trailing',
              align: 'right',
              cell: (t) => (
                <span className="nums font-semibold text-ink">{moneyFull(t.openValue)}</span>
              ),
            },
          ]}
        />
        <div className="mt-3 card px-4 py-3 text-xs lg:mt-0 lg:rounded-none lg:border-0 lg:border-t lg:border-line-soft">

            {assignError ? (
              <p role="alert" className="font-medium text-bad">
                {assignError}
              </p>
            ) : assigned ? (
              <p role="status" className="font-medium text-good">
                {assigned} They’ll see them next time their phone syncs.
              </p>
            ) : (
              <p className="text-ink-mute">
                {mode === 'live'
                  ? 'Changing the rep moves every lead in that territory to them. Coverage is knocked properties over total, not route completion.'
                  : 'Demo data — assignment needs a live account. Coverage is knocked properties over total, not route completion.'}
              </p>
            )}
        </div>
        </>

        <div className="overflow-hidden card">
          <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-3">
            <h2 className="text-sm font-semibold">
              {draft ? 'Outline the area' : selected ? label(selected) : 'All territories'}
            </h2>
            <span className="nums text-xs text-ink-mute">
              {draft
                ? `${draft.points.length} point${draft.points.length === 1 ? '' : 's'}`
                : `${shown.length} properties`}
            </span>
          </div>

          {/*
            --- renaming and deleting the selected one -----------------------

            Under the heading that names it, so the name being changed and the
            name on screen are the same words. Hidden while drawing: the panel
            below is already the drawing controls, and offering to delete
            something while outlining something else is a misfire waiting to
            happen.
          */}
          {!draft && editable && (
            <div className="border-b border-line-soft px-4 py-3">
              {renaming ? (
                <div className="space-y-3">
                  <Field
                    label="Name"
                    value={renameTo}
                    autoFocus
                    onChange={(e) => setRenameTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void saveRename()}>
                      {busy ? 'Saving…' : 'Save name'}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : confirming ? (
                <div className="space-y-3">
                  {/*
                    Says what survives, not just what goes. "Delete?" on its own
                    invites the reading that the leads go with it, which is the
                    fear that stops somebody tidying up a map full of mistakes.
                  */}
                  <p className="text-[13px] leading-relaxed text-ink-soft">
                    Delete <span className="font-semibold text-ink">{label(confirming)}</span>? Its{' '}
                    {shown.length.toLocaleString()} lead{shown.length === 1 ? '' : 's'} go back to
                    Unassigned — nothing is erased, and whoever is walking them keeps them.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void confirmDelete()}>
                      {busy ? 'Deleting…' : 'Delete territory'}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setRenameTo(label(selected!))
                      setRenaming(selected)
                      setRemovedNote(null)
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setConfirming(selected)
                      setRemovedNote(null)
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}

              {manageError && (
                <p role="alert" className="mt-3 text-[13px] font-medium text-bad">
                  {manageError}
                </p>
              )}
              {managed && !manageError && (
                <p role="status" className="mt-3 text-[13px] font-medium text-good">
                  {managed}
                </p>
              )}
            </div>
          )}

          {removedNote && !draft && (
            <p role="status" className="border-b border-line-soft px-4 py-3 text-[13px] font-medium text-good">
              {removedNote}
            </p>
          )}

          {/*
            --- the drawing panel -------------------------------------------
            Above the map, not over it: on a phone the map is the thing being
            touched, and a floating panel would sit exactly where the next vertex
            needs to go.
          */}
          {draft && (
            <div className="border-b border-line-soft px-4 py-3">
              <p className="text-[13px] leading-relaxed text-ink-mute">
                Tap the map to drop a point. Three or more closes the shape — every
                lead inside it joins the territory.
              </p>

              {/*
                Fixed height, and the area reads "—" rather than disappearing
                before the third point.

                Not cosmetic: this panel sits *above* the map, so anything that
                changes its height moves the map under the finger that is drawing
                on it. The second tap of a shape was landing in a different place
                than the person aimed at, because placing the first one grew this
                block. Caught by a gate whose cached coordinates went stale for
                exactly that reason.
              */}
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
                  onClick={() =>
                    setDraft((d) => (d ? { points: d.points.slice(0, -1) } : d))
                  }
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
                  placeholder="e.g. Cypress Ridge & Marigold"
                />
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">
                    Assign to
                  </span>
                  <select
                    value={draftRep}
                    onChange={(e) => setDraftRep(e.target.value)}
                    className="field h-[52px]"
                  >
                    <option value="">Nobody yet</option>
                    {repOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Reserved, for the same reason: an error appearing must not push
                  the map down while somebody is drawing on it. */}
              <p
                role="alert"
                className={`mt-3 min-h-[18px] text-[13px] font-medium text-bad ${
                  drawError ? '' : 'invisible'
                }`}
              >
                {drawError ?? '\u00a0'}
              </p>

              <Button
                full
                className="mt-4"
                disabled={draft.points.length < 3 || saving2}
                onClick={() => void saveDraft()}
              >
                {saving2
                  ? 'Creating…'
                  : draft.points.length < 3
                    ? 'Drop at least three points'
                    : `Create with ${inside.length.toLocaleString()} lead${inside.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}

          {drawDone && !draft && (
            <p role="status" className="border-b border-line-soft px-4 py-3 text-[13px] font-medium text-good">
              {drawDone}
            </p>
          )}
          {shown.length === 0 && !draft && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              No properties in this territory have coordinates yet, so there is
              nothing to place on a map.
            </p>
          )}
          <AllStarMap
            className="h-[min(520px,60svh)] md:h-[520px]"
            /*
              Every lead while drawing, not just the selected territory's — the
              point of the exercise is to see what falls inside the shape, and
              filtering first would hide exactly the leads being claimed.
            */
            properties={draft ? list : shown}
            draw={
              draft
                ? {
                    points: draft.points,
                    onAddPoint: (point) =>
                      setDraft((d) => (d ? { points: [...d.points, point] } : d)),
                  }
                : undefined
            }
            // No follow-me here: an office user's own GPS is irrelevant to a
            // territory, and passing it would recenter the map off the patch.
            position={null}
            /*
              Cluster only when there's enough in the patch to overlap. Fifty
              houses eighteen metres apart, drawn at a zoom that fits the whole
              territory, collapse into unreadable blobs — the markers are wider
              than the gaps between the doors. A small territory still shows
              every pin, which is what makes a handful of leads legible.
            */
            /*
              Counted over what is on the map, which while drawing is every
              lead rather than the selected patch — the two diverged once the
              selection stopped being cleared, and a thousand pins with
              clustering switched off is a map nobody can draw on.
            */
            disableClustering={(draft ? list : shown).length <= 25}
            selectedId={null}
            onSelect={() => {}}
            /* `key` forces a refit when the selection changes. While drawing it
               is pinned, because remounting the map would throw away the pan and
               zoom the person is drawing against. */
            key={draft ? 'draw' : (selected ?? 'all')}
            initialCenter={view?.center}
            initialZoom={view?.zoom}
          />
        </div>
      </div>
    </AdminPage>
  )
}
