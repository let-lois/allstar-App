import { useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../lib/errors'
import { AdminPage } from './AdminLayout'
import { fitZoom, type MapHandle } from '../components/map/FieldMap'
import { FreehandLayer } from '../components/map/FreehandLayer'
import { buildOutline, type OutlineResult } from '@allstar/core/freehand'
import { AllStarMap } from '../components/map/AllStarMap'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { UNASSIGNED_TERRITORY, inTerritory, useTerritories } from './useAdminData'
import { DataList } from './DataList'
import { type GeneratedLeads, apiAssignTerritory } from '../lib/http'
import { liveToken } from '../lib/session'
import { moneyFull } from '../lib/format'
import { pointInPolygon, polygonAreaSqMiles } from '../lib/geo'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { IconClose } from '../components/nav/icons'

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
/** Said under the name field when Create is pressed without one. */
const NAME_REQUIRED = 'Give the area a name — the reps will see it.'

export function AdminTerritories() {
  const properties = useAppStore((s) => s.properties)
  const territories = useAppStore((s) => s.territories)
  const mode = useAppStore((s) => s.mode)
  const nav = useNavigate()
  const list = useMemo(() => Object.values(properties), [properties])
  const territoryIds = useMemo(() => Object.keys(territories), [territories])
  const unsorted = useTerritories(list, territoryIds)

  /** A territory's name if we have one; otherwise something readable. */
  const label = (id: string) =>
    id === UNASSIGNED_TERRITORY ? 'Unassigned' : (territories[id]?.name ?? id)

  /* --- drawing a new territory ------------------------------------------- */
  const createTerritory = useAppStore((s) => s.createTerritory)
  const [draft, setDraft] = useState<{ points: { lat: number; lng: number }[] } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftReps, setDraftReps] = useState<string[]>([])
  /*
    How the outline is drawn: by tapping its corners (how this screen always
    worked, and still the default) or by dragging a finger round it. Either way
    the result is the same list of points in `draft`, so the count, the name, the
    reps and the create call below do not know which was used.
  */
  const [drawStyle, setDrawStyle] = useState<'tap' | 'freehand'>('tap')
  /** What the last freehand stroke said, shown beneath the map where it cannot move it. */
  const [freehandNote, setFreehandNote] = useState<string | null>(null)
  const mapHandle = useRef<MapHandle | null>(null)
  function chooseStyle(style: 'tap' | 'freehand') {
    setDrawStyle(style)
    setFreehandNote(null)
    // Switching starts the shape again: a freehand line and a handful of tapped
    // corners are not the same drawing, and mixing them gives a shape nobody drew.
    draftStash.current = null
    setDraft((d) => (d ? { points: [] } : d))
    if (style === 'freehand') mapHandle.current?.prepareDraw()
  }
  function onFreehand(result: OutlineResult) {
    if (result.ok) {
      setDraft({ points: result.outline })
      setFreehandNote(result.trimmed ? 'The end of the line crossed the start, so the extra bit was trimmed off.' : null)
    } else {
      setFreehandNote(result.message)
    }
  }
  /*
    On by default: the whole point of drawing round a block is the houses on
    it. A deployment with no address data says so in the result and the
    territory is created regardless, so the default costs nothing when it
    cannot deliver.
  */
  const [draftGenerate, setDraftGenerate] = useState(true)
  const [saving2, setSaving2] = useState(false)
  // A second tap before the button re-renders disabled must not make a second
  // territory; state is too late for that, a ref is not.
  const creating = useRef(false)
  /*
    What creating is doing, said honestly while it runs. The save itself is
    quick; looking up every house inside is what takes the time, and a big
    patch can take most of a minute. Staged by elapsed time — the server does
    not report progress — so the words only ever claim what is certainly true.
  */
  const [createStage, setCreateStage] = useState(0)
  useEffect(() => {
    if (!saving2) {
      setCreateStage(0)
      return
    }
    const a = window.setTimeout(() => setCreateStage(1), 3000)
    const b = window.setTimeout(() => setCreateStage(2), 15000)
    return () => {
      window.clearTimeout(a)
      window.clearTimeout(b)
    }
  }, [saving2])
  const [drawError, setDrawError] = useState<string | null>(null)
  const [drawDone, setDrawDone] = useState<string | null>(null)
  const [drawWarn, setDrawWarn] = useState(false)
  // The numbers from the last creation, shown as numbers: found, new, kept.
  const [drawResult, setDrawResult] = useState<GeneratedLeads | null>(null)
  const [drawHead, setDrawHead] = useState<{ name: string; detail: string } | null>(null)
  /*
    What was drawn when the Create section was folded away. Collapsing is not
    cancelling: a manager who closes it to look something up in the list gets
    their shape back when they open it again. Start over is the way to discard.
  */
  const draftStash = useRef<{ lat: number; lng: number }[] | null>(null)

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

  /*
    Leads inside the new outline that are filed under another territory now.
    Creating a patch takes them (that is how a downtown patch is carved out of a
    city-wide one), so the panel says how many before anyone presses Create: a
    reassignment somebody can see coming is a deliberate one.
  */
  const carving = useMemo(() => inside.filter((p) => !!p.territoryId && !!territories[p.territoryId]), [inside, territories])
  const carvedFrom = useMemo(() => [...new Set(carving.map((p) => territories[p.territoryId!]!.name))], [carving, territories])

  const saveDraft = async () => {
    if (!draft || draft.points.length < 3) return
    const name = draftName.trim()
    if (!name) {
      setDrawError(NAME_REQUIRED)
      return
    }
    if (creating.current) return
    creating.current = true
    setSaving2(true)
    setDrawError(null)
    try {
      const res = await createTerritory({
        name,
        repId: draftReps[0] ?? null,
        repIds: draftReps,
        boundary: draft.points,
        generate: draftGenerate && mode === 'live',
      })
      // What the drawing did, and whether it needs attention: a territory saved
      // with no new houses says why, in the warning colour, not as a success.
      const g = res.generated
      const claimed = res.assigned ? ` ${res.assigned.toLocaleString()} existing lead${res.assigned === 1 ? '' : 's'} inside joined it.` : ''
      setDrawDone(`Created ${name}.${claimed}` + (g ? ` ${describeGenerated(g)}` : ''))
      setDrawHead({ name, detail: `${claimed.trim()}${g ? ` ${describeGenerated(g)}` : ''}`.trim() })
      setDrawWarn(!!g && ('error' in g || g.coverageStatus === 'LIMITED' || g.coverageStatus === 'NONE' || (g.created === 0 && (g.coverage === 'none' || !!g.withoutAddress || !!g.lookupFailed))))
      setDrawResult(g && !('error' in g) ? g : null)
      draftStash.current = null
      /*
        Not selected: the result is said at the top, and the new territory is
        in the list, one tap from its map. Opening a map nobody tapped is what
        this page no longer does.
      */
      setSelected(null)
      setDraft(null)
      setDraftName('')
      setDraftReps([])
    } catch (err) {
      setDrawError(
        describeError(err, 'Could not create the territory. Try again.'),
      )
    } finally {
      creating.current = false
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

  /*
    Nothing selected until somebody taps a territory. The page used to pick the
    first one and open its map under the list, so every visit to Territories
    carried a map nobody had asked for; now the list is the page, and a map
    appears only for the territory being looked at or edited.
  */
  const [selected, setSelected] = useState<string | null>(null)
  const detail = useRef<HTMLDivElement>(null)
  const open = (id: string) => {
    setSelected(id)
    // On a phone the panel is below the list; bring it to the eye.
    window.setTimeout(() => detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

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

  /*
    A territory holds any number of reps. `add` puts one on the patch beside
    whoever is already there; `remove` takes one off. The unassigned bucket is
    houses, not a patch, so there `add` still means "hand all of these over".
  */
  async function assign(territoryId: string, repId: string, action: 'add' | 'remove' = 'add') {
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
        action,
      })
      // Re-read rather than patching state: this changes which properties a rep
      // can see, and guessing at the result is how a console drifts from the
      // database it is supposed to be showing.
      await refreshFromServer()
      const who = repOptions.find((r) => r.id === repId)?.name ?? 'the rep'
      setAssigned(
        action === 'remove'
          ? `${who} taken off ${label(territoryId)}. Houses they were working stay theirs.`
          : !repId
            ? `${res.assigned} lead${res.assigned === 1 ? '' : 's'} unassigned.`
            : territoryId === UNASSIGNED_TERRITORY
              ? `${res.assigned} lead${res.assigned === 1 ? '' : 's'} assigned.`
              : res.assigned > 0
                ? `${who} added to ${label(territoryId)} and handed ${res.assigned} unclaimed lead${res.assigned === 1 ? '' : 's'}.`
                : `${who} added to ${label(territoryId)} — ${res.repIds?.length ?? 0} rep${(res.repIds?.length ?? 0) === 1 ? '' : 's'} share it now.`,
      )
    } catch (err) {
      setAssignError(
        describeError(err, 'Could not save that. Nothing was changed.'),
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
    Editing a territory's outline.

    Two ways, like drawing one: drag the corners of the line that is there, or
    throw it away and redraw it freehand. A freehand outline has too many corners
    to drag usefully, so one with more than `DRAG_CORNERS_MAX` opens on redraw.
    Nothing is written until Save; Cancel puts the old line back untouched.
  */
  const reshapeTerritory = useAppStore((s) => s.reshapeTerritory)
  const [outlineEdit, setOutlineEdit] = useState<{ id: string; points: { lat: number; lng: number }[]; style: 'corners' | 'freehand' } | null>(null)
  const [outlineError, setOutlineError] = useState<string | null>(null)
  const [outlineSaving, setOutlineSaving] = useState(false)
  const detailHandle = useRef<MapHandle | null>(null)
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
        describeError(err, 'Could not rename that. Nothing was changed.'),
      )
    } finally {
      setBusy(false)
    }
  }

  const generateTerritoryLeads = useAppStore((s) => s.generateTerritoryLeads)
  async function findAddresses() {
    if (!selected || selected === UNASSIGNED_TERRITORY) return
    setBusy(true)
    setManageError(null)
    setManaged(null)
    try {
      const res = await generateTerritoryLeads(selected)
      setManaged(describeGenerated(res))
      setRemovedNote(null)
    } catch (err) {
      setManageError(
        describeError(err, 'Could not look up the houses. Nothing was changed.'),
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
        describeError(err, 'Could not delete that. Nothing was changed.'),
      )
    } finally {
      setBusy(false)
    }
  }

  // Choosing another territory ends an edit of this one; the line would
  // otherwise stay on a map now showing somebody else's patch.
  useEffect(() => {
    setOutlineEdit((e) => (e && e.id !== selected ? null : e))
  }, [selected])

  const DRAG_CORNERS_MAX = 60
  function startOutlineEdit(id: string) {
    const boundary = territories[id]?.boundary ?? []
    setOutlineError(null)
    setManaged(null)
    setManageError(null)
    const corners = boundary.length >= 3 && boundary.length <= DRAG_CORNERS_MAX
    setOutlineEdit({ id, points: corners ? boundary : [], style: corners ? 'corners' : 'freehand' })
    if (!corners) detailHandle.current?.prepareDraw()
  }
  function outlineStyle(style: 'corners' | 'freehand') {
    setOutlineError(null)
    setOutlineEdit((e) => {
      if (!e) return e
      const boundary = territories[e.id]?.boundary ?? []
      // Corners start from the saved line; freehand starts from nothing.
      if (style === 'corners') return { ...e, style, points: boundary.length <= DRAG_CORNERS_MAX ? boundary : [] }
      return { ...e, style, points: [] }
    })
    if (style === 'freehand') detailHandle.current?.prepareDraw()
  }
  function onOutlineFreehand(result: OutlineResult) {
    if (result.ok) {
      setOutlineEdit((e) => (e ? { ...e, points: result.outline } : e))
      setOutlineError(null)
    } else {
      setOutlineError(result.message)
    }
  }
  /*
    What saving would do, counted live over the leads on this device: leads in
    no territory that the new line takes in, and this territory's own leads that
    the new line leaves outside (they stay in it — see `reshapeTerritory`).
  */
  const outlineEffect = useMemo(() => {
    if (!outlineEdit || outlineEdit.points.length < 3) return null
    const pts = outlineEdit.points
    let joining = 0
    let outside = 0
    for (const p of list) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
      const isIn = pointInPolygon(p, pts)
      if (!p.territoryId && isIn) joining++
      else if (p.territoryId === outlineEdit.id && !isIn) outside++
    }
    return { joining, outside }
  }, [outlineEdit, list])
  async function saveOutline() {
    if (!outlineEdit || outlineSaving) return
    // Corners dragged across each other make a shape that crosses itself; the
    // same check a freehand stroke gets, so a bad line is said, not stored.
    const checked = buildOutline(outlineEdit.points, { trimOvershoot: outlineEdit.style === 'freehand' })
    if (!checked.ok) {
      setOutlineError(checked.message)
      return
    }
    setOutlineSaving(true)
    setOutlineError(null)
    try {
      const name = label(outlineEdit.id)
      const res = await reshapeTerritory(outlineEdit.id, checked.outline)
      const joined = res.joined ? ` ${res.joined.toLocaleString()} lead${res.joined === 1 ? '' : 's'} in no territory joined it.` : ''
      const out = res.outside
        ? ` ${res.outside.toLocaleString()} of its leads are now outside the line and stay in ${name}; move them from Leads if they belong elsewhere.`
        : ''
      setManaged(`Saved the new outline for ${name}.${joined}${out}`)
      setOutlineEdit(null)
    } catch (err) {
      // The drawing stays on the map: a failed save must not cost the line.
      setOutlineError(describeError(err, 'Could not save the outline. Try again.'))
    } finally {
      setOutlineSaving(false)
    }
  }

  /*
    Every saved territory, drawn under the leads so several can be seen at once.
    The one selected is emphasised; the one whose outline is being edited is left
    out, because its new line is the shape being drawn.
  */
  const outlines = useMemo(
    () =>
      Object.values(territories)
        .filter((t) => (t.boundary?.length ?? 0) >= 3 && t.id !== outlineEdit?.id)
        .map((t) => ({ id: t.id, points: t.boundary!, emphasis: t.id === selected && !draft })),
    [territories, selected, outlineEdit?.id, draft],
  )

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

  /*
    Open or fold the Create section. Opening starts a drawing (or brings back
    the one that was folded away); folding keeps it for next time.
  */
  const toggleCreate = () => {
    if (draft) {
      draftStash.current = draft.points.length ? draft.points : null
      setDraft(null)
      setDrawError(null)
      return
    }
    setDraft({ points: draftStash.current ?? [] })
    setDrawDone(null)
    setDrawResult(null)
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
  }

  return (
    <AdminPage
      tour="console-territories"
      title="Territories"
      description={`${rows.length} territories · ${totals.properties.toLocaleString()} leads · ${moneyFull(totals.open)} open`}
    >
      {/*
        --- Create new territory ----------------------------------------------
        At the top, folded until it is wanted. Open, it is everything creating
        takes, in the order it is done: outline the area on the map, name it,
        pick the reps, choose whether to find the houses, create. Folded, the
        list of territories is the first thing on the page.
      */}
      <section className="mb-4 overflow-hidden card" data-testid="territory-create">
        <button
          type="button"
          onClick={toggleCreate}
          aria-expanded={!!draft}
          aria-controls="territory-create-panel"
          data-testid="territory-create-toggle"
          className="focusable flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-tint text-accent" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">Create new territory</span>
            <span className="block text-[12.5px] text-ink-mute">
              {draft ? 'Outline the area on the map, then name it' : 'Draw an area, name it and assign reps'}
            </span>
          </span>
          <svg
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden
            className={`shrink-0 text-ink-mute transition-transform ${draft ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {/* The result of the last creation, under the header it came from. */}
        {drawDone && !draft && (
          <div
            role="status"
            data-testid="territory-created"
            className={`border-t border-line-soft px-4 py-3 text-[13px] leading-snug ${drawWarn ? 'text-warn' : 'text-good'}`}
          >
            {/* The whole sentence stays for a screen reader and for search; the
                parts below are the same words, laid out. */}
            <span className="sr-only">{drawDone}</span>
            <p className="font-medium" aria-hidden>Created {drawHead?.name}.</p>
            {drawResult && (
              <dl className="mt-2 grid grid-cols-3 gap-2 text-ink" data-testid="territory-created-counts">
                {[
                  ['Addresses found', drawResult.found ?? 0, 'found'],
                  ['New leads', drawResult.created ?? 0, 'created'],
                  ['Already leads', drawResult.existed ?? 0, 'existed'],
                ].map(([k, v, id]) => (
                  <div key={id as string} className="rounded-field bg-surface-field px-2.5 py-2">
                    <dt className="text-[11.5px] text-ink-mute">{k}</dt>
                    <dd className="nums text-[18px] font-semibold" data-testid={`territory-count-${id}`}>
                      {(v as number).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {drawHead?.detail && <p className="mt-2 text-ink-soft" aria-hidden>{drawHead.detail}</p>}
          </div>
        )}

        {draft && (
          <div id="territory-create-panel" className="border-t border-line-soft">
            {/* Drawing tools, above the map. Fixed height: anything that grows
                here moves the map under the finger that is drawing on it. */}
            <div className="px-4 py-3">
              <div className="mb-2 flex overflow-hidden rounded-field border border-line" role="group" aria-label="How to draw">
                {(['tap', 'freehand'] as const).map((style) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => chooseStyle(style)}
                    aria-pressed={drawStyle === style}
                    data-testid={`territory-style-${style}`}
                    className={`focusable min-h-[40px] flex-1 px-3 text-sm font-semibold ${
                      drawStyle === style ? 'bg-brand-500 text-ink-inverse' : 'bg-surface text-ink-soft'
                    }`}
                  >
                    {style === 'tap' ? 'Tap corners' : 'Draw freehand'}
                  </button>
                ))}
              </div>
              <p className="text-[13px] leading-snug text-ink-mute">
                {drawStyle === 'tap'
                  ? 'Tap the map to drop points. Three or more make the shape.'
                  : 'Drag your finger to outline a territory. It closes itself when you let go.'}
              </p>
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
                {drawStyle === 'tap' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="whitespace-nowrap"
                    disabled={draft.points.length === 0}
                    onClick={() => setDraft((d) => (d ? { points: d.points.slice(0, -1) } : d))}
                  >
                    Undo point
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="whitespace-nowrap"
                  disabled={draft.points.length === 0}
                  onClick={() => {
                    draftStash.current = null
                    setFreehandNote(null)
                    setDraft({ points: [] })
                  }}
                >
                  Start over
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto whitespace-nowrap"
                  data-testid="territory-draw-cancel"
                  // Cancel discards the drawing; folding the section keeps it.
                  onClick={() => {
                    draftStash.current = null
                    setDraft(null)
                    setDraftName('')
                    setDrawError(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="mt-2 text-[12.5px] text-ink-mute">
                {drawStyle === 'tap'
                  ? 'Tap the map to add a corner. Pan and zoom freely between taps; drag a corner to move it.'
                  : 'Pan and zoom to frame the area first; the map holds still while you draw. Start over to draw it again.'}
              </p>
            </div>

            <AllStarMap
              className="h-[min(440px,55svh)] md:h-[480px]"
              // Every lead while drawing: the point is to see what falls inside.
              properties={list}
              handleRef={mapHandle}
              // The drawing surface, only while there is nothing drawn: once there is
              // an outline the map is free to pan and zoom to check it.
              surface={
                drawStyle === 'freehand' && draft.points.length === 0 ? (
                  <FreehandLayer toLatLng={(x, y) => mapHandle.current?.toLatLng(x, y) ?? null} onOutline={onFreehand} />
                ) : undefined
              }
              draw={
                drawStyle === 'freehand'
                  ? {
                      points: draft.points,
                      // A tap on a finished freehand outline must not append a corner to it.
                      onAddPoint: () => {},
                      // No corner handles: a hand-drawn line has dozens, none worth dragging.
                      showVertices: false,
                      label: 'Territory outline',
                    }
                  : {
                      points: draft.points,
                      onAddPoint: (point) => setDraft((d) => (d ? { points: [...d.points, point] } : d)),
                      onMovePoint: (i, point) =>
                        setDraft((d) => (d ? { points: d.points.map((p, n) => (n === i ? point : p)) } : d)),
                    }
              }
              // The territories already drawn, so a new one can be placed against its neighbours.
              outlines={outlines}
              position={null}
              disableClustering={list.length <= 25}
              selectedId={null}
              onSelect={() => {}}
              key="draw"
              initialCenter={view?.center}
              initialZoom={view?.zoom}
            />

            {/* Below the map, so nothing here moves the map while drawing. */}
            <div className="space-y-4 px-4 py-4">
              {drawStyle === 'freehand' && freehandNote && (
                <p
                  role={draft.points.length === 0 ? 'alert' : 'status'}
                  className={`text-[13px] leading-snug ${draft.points.length === 0 ? 'font-medium text-bad' : 'text-ink-mute'}`}
                  data-testid="territory-freehand-note"
                >
                  {freehandNote}
                </p>
              )}
              <Field
                label="Territory name (required)"
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value)
                  if (drawError && e.target.value.trim()) setDrawError(null)
                }}
                required
                aria-required="true"
                placeholder="e.g. Cypress Ridge & Marigold"
                error={drawError === NAME_REQUIRED ? drawError : undefined}
                data-testid="territory-name"
              />
              <fieldset>
                <legend className="mb-1.5 block text-[13px] font-medium text-ink-soft">Assign to reps</legend>
                {/*
                  Any number of people. One rep also gets the unclaimed houses
                  inside; two or more share the patch and claim doors as they
                  knock them.
                */}
                <div className="max-h-[220px] overflow-y-auto rounded-field border border-line bg-surface">
                  {repOptions.length === 0 && (
                    <p className="px-3 py-3 text-[13px] text-ink-mute">Nobody on the team yet.</p>
                  )}
                  {repOptions.map((r) => {
                    const on = draftReps.includes(r.id)
                    return (
                      <label
                        key={r.id}
                        className="flex min-h-[44px] cursor-pointer items-center gap-3 border-b border-line-soft px-3 last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setDraftReps((cur) => (on ? cur.filter((id) => id !== r.id) : [...cur, r.id]))
                          }
                          className="h-5 w-5 accent-brand-500"
                        />
                        <span className="text-[14px]">{r.name}</span>
                      </label>
                    )
                  })}
                </div>
                <p className="mt-1.5 text-[12.5px] leading-snug text-ink-mute">
                  {draftReps.length === 0
                    ? 'Optional. Nobody yet — the leads inside keep whoever has them.'
                    : draftReps.length === 1
                      ? 'One rep: they also get every lead inside that nobody is working.'
                      : `${draftReps.length} reps share it: all of them see every lead inside.`}
                </p>
              </fieldset>
              {mode === 'live' && (
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={draftGenerate}
                    onChange={(e) => setDraftGenerate(e.target.checked)}
                    className="mt-1 h-5 w-5 accent-brand-500"
                    data-testid="territory-generate"
                  />
                  <span className="text-[13px] leading-snug">
                    <span className="font-medium">Find the houses inside and add them as leads</span>
                    <span className="block text-ink-mute">
                      From open address data. Houses that are already leads are left as they are — never duplicated.
                    </span>
                  </span>
                </label>
              )}

              <div>
                {drawError && drawError !== NAME_REQUIRED && (
                  <p role="alert" className="mb-3 rounded-field bg-bad-bg px-3 py-2 text-[13px] font-medium text-bad">
                    {drawError}
                  </p>
                )}
                <Button full disabled={draft.points.length < 3 || saving2} onClick={() => void saveDraft()} data-testid="territory-create-submit">
                  {saving2 ? 'Creating…' : draft.points.length < 3 ? 'Drop at least three points' : 'Create territory'}
                </Button>
                {saving2 ? (
                  <p role="status" aria-live="polite" className="mt-2 text-[13px] leading-snug text-ink-soft" data-testid="territory-progress">
                    {!(draftGenerate && mode === 'live')
                      ? 'Saving the territory…'
                      : createStage === 0
                        ? 'Saving the territory…'
                        : createStage === 1
                          ? 'Finding the homes inside and adding them as leads…'
                          : 'Still working — a large territory can take up to a minute. You can keep this screen open.'}
                  </p>
                ) : (
                  draft.points.length >= 3 && (
                    <p className="mt-2 text-[12.5px] leading-snug text-ink-mute" data-testid="territory-generate-note">
                      {inside.length.toLocaleString()} existing lead{inside.length === 1 ? '' : 's'} inside will join it
                      {mode === 'live' && draftGenerate ? '; the houses inside are looked up when you create it.' : '.'}
                      {carving.length > 0 && (
                        <span className="mt-1 block font-medium text-warn" data-testid="territory-carve-note">
                          {carving.length.toLocaleString()} of them {carving.length === 1 ? 'is' : 'are'} in {carvedFrom.join(', ')} now and will move to this territory.
                        </span>
                      )}
                    </p>
                  )
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* What a delete did, above the list it changed — the panel it came
          from has closed with the territory. */}
      {removedNote && (
        <p role="status" className="mb-3 card px-4 py-3 text-[13px] font-medium text-good" data-testid="territory-removed">
          {removedNote}
        </p>
      )}
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-mute">Territories</h2>
      <div className={`grid gap-4 ${!draft && selected ? 'xl:grid-cols-[minmax(0,1fr)_460px]' : ''}`}>
        <>
        <DataList
          rows={rows}
          keyOf={(t) => t.id}
          onRow={(t) => open(t.id)}
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
              header: 'Reps',
              // Not in the phone card: the card is one button, and controls
              // inside a button are neither valid nor reachable by a screen
              // reader, and the card's meta cell truncates. On a phone the
              // same controls sit in the panel for the selected territory.
              phone: 'off',
              cell: (t) =>
                t.id === UNASSIGNED_TERRITORY ? (
                  /*
                    The unassigned bucket is houses with no patch, so it keeps
                    the one-shot control: pick a person and every lead in it is
                    theirs. That is the post-import move, and it is a hand-over
                    rather than a membership.
                  */
                  <select
                    value=""
                    disabled={mode !== 'live' || saving !== null}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => void assign(t.id, e.target.value)}
                    aria-label="Hand every unassigned lead to"
                    className="focusable min-h-[44px] w-full rounded-lg border border-line bg-surface px-2 text-[13px] disabled:opacity-60 lg:min-h-[36px] lg:w-auto lg:text-xs"
                  >
                    <option value="">{t.mixed ? 'Mixed — hand all to…' : 'Hand all to…'}</option>
                    {repOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  /*
                    Selects the territory, as a click on its row does, but
                    without the row's scroll down to the map: on a desktop
                    narrower than the two-column layout that scroll threw the
                    page to the map every time somebody added or removed a
                    rep, which read as the rep picker jumping away.
                  */
                  <div
                    data-testid="territory-rep-cell"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelected(t.id)
                    }}
                  >
                    <RepChips
                      repIds={territories[t.id]?.repIds ?? (territories[t.id]?.repId ? [territories[t.id]!.repId!] : [])}
                      options={repOptions}
                      disabled={mode !== 'live' || saving !== null}
                      onAdd={(repId) => void assign(t.id, repId, 'add')}
                      onRemove={(repId) => void assign(t.id, repId, 'remove')}
                    />
                  </div>
                ),
            },
            { header: 'Leads', align: 'right', cell: (t) => t.properties },
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
              territory, and the unassigned bucket's `<select>` calls
              `stopPropagation` so its own clicks do not. With Open value in
              position two the select sat in the middle of the row — which is
              where a click on a table row lands — so selecting a territory on a
              desktop silently stopped working. The rep chips let their clicks
              through for the same reason (see RepChips).
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
                  ? 'A territory can have several reps, and each of them sees every lead in it. Adding or removing a rep never takes a lead off the rep working it. Coverage is leads knocked over total, not route completion.'
                  : 'Demo data — assignment needs a live account. Coverage is leads knocked over total, not route completion.'}
              </p>
            )}
        </div>
        </>

        {/*
          The selected territory — its map, its reps, rename, find addresses,
          delete. Out of the way while one is being drawn above, so the page
          never carries two maps.
        */}
        {!draft && selected && (
        <div className="overflow-hidden card scroll-mt-4" ref={detail} data-testid="territory-detail">
          <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-3">
            <h2 className="text-sm font-semibold">
              {label(selected)}
            </h2>
            <span className="flex items-baseline gap-3">
              {/*
                The same leads as a list. The Leads page filtered to this
                territory, where they can be searched, sorted, reassigned and
                moved in bulk; the map here and that list read the same rows.
              */}
              {(
                <a
                  href={`/admin/leads?territory=${selected === UNASSIGNED_TERRITORY ? 'none' : encodeURIComponent(selected)}`}
                  onClick={(e) => {
                    e.preventDefault()
                    nav(`/admin/leads?territory=${selected === UNASSIGNED_TERRITORY ? 'none' : encodeURIComponent(selected)}`)
                  }}
                  data-testid="territory-view-list"
                  className="focusable -my-3 inline-flex min-h-tap items-center px-2 text-xs font-semibold text-accent"
                >
                  View as list
                </a>
              )}
              <span className="nums text-xs text-ink-mute">
                {`${shown.length} lead${shown.length === 1 ? '' : 's'}`}
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close this territory"
                data-testid="territory-detail-close"
                className="focusable -my-3 -mr-2 grid h-11 w-11 place-items-center rounded-full text-ink-mute active:bg-surface-field"
              >
                <IconClose />
              </button>
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
          {editable && (
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
                <>
                  {/*
                    On a phone the table is cards, and a card is one button, so
                    the rep controls live here for whichever territory is
                    picked. The desktop table keeps them in its Reps column.
                  */}
                  {selected && (
                    <div className="mb-3 lg:hidden" data-testid="territory-reps-panel">
                      <p className="mb-1.5 text-[13px] font-medium text-ink-soft">
                        {selected === UNASSIGNED_TERRITORY ? 'Hand every unassigned lead to' : 'Reps on this territory'}
                      </p>
                      {selected === UNASSIGNED_TERRITORY ? (
                        <select
                          value=""
                          disabled={mode !== 'live' || saving !== null}
                          onChange={(e) => void assign(selected, e.target.value)}
                          aria-label="Hand every unassigned lead to"
                          className="focusable min-h-[44px] w-full rounded-lg border border-line bg-surface px-2 text-[13px] disabled:opacity-60"
                        >
                          <option value="">Hand all to…</option>
                          {repOptions.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <RepChips
                          repIds={territories[selected]?.repIds ?? (territories[selected]?.repId ? [territories[selected]!.repId!] : [])}
                          options={repOptions}
                          disabled={mode !== 'live' || saving !== null}
                          onAdd={(repId) => void assign(selected, repId, 'add')}
                          onRemove={(repId) => void assign(selected, repId, 'remove')}
                        />
                      )}
                    </div>
                  )}
                <div className="flex flex-wrap gap-2">
                  {/*
                    The houses inside, for a territory drawn before the look-up
                    existed, or one whose street has grown. Same rule as the
                    checkbox when drawing: what is already a lead stays one.
                  */}
                  {mode === 'live' && !!territories[selected!]?.boundary && (
                    <Button size="sm" disabled={busy} onClick={() => void findAddresses()}>
                      {busy ? 'Looking…' : 'Find addresses'}
                    </Button>
                  )}
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
                  {(territories[selected!]?.boundary?.length ?? 0) >= 3 && !outlineEdit && (
                    <Button size="sm" variant="secondary" onClick={() => startOutlineEdit(selected!)} data-testid="territory-edit-outline">
                      Edit outline
                    </Button>
                  )}
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
                {outlineEdit && outlineEdit.id === selected && (
                  <div className="mt-3 rounded-field bg-surface-sunk px-3 py-2.5" data-testid="territory-outline-panel">
                    <div className="mb-2 flex overflow-hidden rounded-field border border-line" role="group" aria-label="How to edit the outline">
                      {(['corners', 'freehand'] as const).map((style) => (
                        <button
                          key={style}
                          type="button"
                          onClick={() => outlineStyle(style)}
                          aria-pressed={outlineEdit.style === style}
                          data-testid={`territory-outline-${style}`}
                          disabled={style === 'corners' && (territories[outlineEdit.id]?.boundary?.length ?? 0) > DRAG_CORNERS_MAX}
                          className={`focusable min-h-[40px] flex-1 px-3 text-sm font-semibold disabled:opacity-50 ${
                            outlineEdit.style === style ? 'bg-brand-500 text-ink-inverse' : 'bg-surface text-ink-soft'
                          }`}
                        >
                          {style === 'corners' ? 'Drag corners' : 'Redraw freehand'}
                        </button>
                      ))}
                    </div>
                    {/* Room for the longest count, reserved: it changes while a corner
                        is being dragged, and a line that wrapped mid-drag moved the
                        map — and the corner — under the finger. */}
                    <p className="min-h-[54px] text-[13px] leading-snug text-ink-soft md:min-h-[36px]" data-testid="territory-outline-effect">
                      {outlineEffect
                        ? `${outlineEffect.joining.toLocaleString()} lead${outlineEffect.joining === 1 ? '' : 's'} in no territory will join. ` +
                          (outlineEffect.outside
                            ? `${outlineEffect.outside.toLocaleString()} of its leads would sit outside the new line and stay in it.`
                            : 'All of its leads stay inside.')
                        : outlineEdit.style === 'freehand'
                          ? 'Drag your finger round the area on the map below.'
                          : 'Drag a corner on the map to move it.'}
                    </p>
                    {outlineError && (
                      <p role="alert" className="mt-1 text-[13px] font-medium text-bad" data-testid="territory-outline-error">
                        {outlineError}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" disabled={outlineEdit.points.length < 3 || outlineSaving} onClick={() => void saveOutline()} data-testid="territory-outline-save">
                        {outlineSaving ? 'Saving…' : 'Save outline'}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={outlineSaving} onClick={() => outlineStyle('freehand')} data-testid="territory-outline-redraw">
                        Redraw
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={outlineSaving}
                        onClick={() => {
                          setOutlineEdit(null)
                          setOutlineError(null)
                        }}
                        data-testid="territory-outline-cancel"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                </>
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


          {shown.length === 0 && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              No leads in this territory have coordinates yet, so there is
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
            // While its outline is being edited, every lead: the point is to see
            // which ones the new line takes in and which it leaves out.
            properties={outlineEdit ? list : shown}
            outlines={outlines}
            handleRef={detailHandle}
            surface={
              outlineEdit && outlineEdit.style === 'freehand' && outlineEdit.points.length === 0 ? (
                <FreehandLayer toLatLng={(x, y) => detailHandle.current?.toLatLng(x, y) ?? null} onOutline={onOutlineFreehand} />
              ) : undefined
            }
            draw={
              outlineEdit && outlineEdit.points.length > 0
                ? outlineEdit.style === 'corners'
                  ? {
                      points: outlineEdit.points,
                      // Moving corners only: a tap appending a corner to a closed
                      // line puts a spike wherever the last corner happens to be.
                      onAddPoint: () => {},
                      onMovePoint: (i, point) =>
                        setOutlineEdit((e) => (e ? { ...e, points: e.points.map((p, n) => (n === i ? point : p)) } : e)),
                      label: 'Territory outline',
                    }
                  : { points: outlineEdit.points, onAddPoint: () => {}, showVertices: false, label: 'Territory outline' }
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
            disableClustering={(outlineEdit ? list : shown).length <= 25}
            selectedId={null}
            onSelect={() => {}}
            /* `key` forces a refit when the selection changes. While drawing it
               is pinned, because remounting the map would throw away the pan and
               zoom the person is drawing against. */
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


/**
 * The reps on a patch, as chips, with a way to add one and a way to take one
 * off. Each × is a 44px target on a phone: this is the control a manager
 * reaches for one-handed when somebody calls in sick.
 */
function RepChips({
  repIds,
  options,
  disabled,
  onAdd,
  onRemove,
}: {
  repIds: string[]
  options: { id: string; name: string }[]
  disabled: boolean
  onAdd: (repId: string) => void
  onRemove: (repId: string) => void
}) {
  const nameOf = (id: string) => options.find((r) => r.id === id)?.name ?? 'Former team member'
  const free = options.filter((r) => !repIds.includes(r.id))
  return (
    // Nothing here stops the click: the row's cell wraps this and selects the
    // territory (without scrolling to its map), so using a territory's rep
    // controls still shows which patch is being edited.
    <div className="flex flex-wrap items-center gap-1.5">
      {repIds.length === 0 && <span className="text-[13px] text-ink-mute">Nobody yet</span>}
      {repIds.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunk pl-2.5 text-[13px] font-medium"
        >
          {nameOf(id)}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Take ${nameOf(id)} off this territory`}
            onClick={() => onRemove(id)}
            className="focusable grid h-11 w-11 place-items-center rounded-r-full text-ink-mute disabled:opacity-60 lg:h-8 lg:w-7"
          >
            <span className="scale-75">
              <IconClose />
            </span>
          </button>
        </span>
      ))}
      {free.length > 0 && (
        <select
          value=""
          disabled={disabled}
          onChange={(e) => e.target.value && onAdd(e.target.value)}
          aria-label="Add a rep to this territory"
          className="focusable min-h-[44px] rounded-lg border border-dashed border-line bg-surface px-2 text-[13px] text-ink-soft disabled:opacity-60 lg:min-h-[36px] lg:text-xs"
        >
          <option value="">+ Add rep</option>
          {free.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/**
 * The look-up's result as sentences, or its refusal as the server put it.
 *
 * Says what happened and, when nothing was made, why: no address data for the
 * area, houses whose addresses need the Geocodio key, or a look-up that failed
 * and can be retried. An empty territory never reads as a silent success.
 */
export function describeGenerated(g: { error: string; code?: string } | GeneratedLeads): string {
  if ('error' in g) {
    // In words a manager can act on; the server's own text names config files.
    if (g.code === 'addresses_not_configured') return 'Finding houses is not set up for this company yet. The territory is saved; ask your administrator to turn on address look-up, then press Find addresses.'
    return g.error
  }
  const n = (x: number | undefined) => (x ?? 0).toLocaleString()
  const plural = (x: number | undefined, one: string, many = `${one}s`) => ((x ?? 0) === 1 ? one : many)
  const out: string[] = []

  if (g.coverage === 'none' && g.coverageStatus !== 'LIMITED') {
    return 'There is no address data for this area yet, so no houses were found. The territory is saved; press Find addresses again once the area has data.'
  }

  const counts = [`${n(g.found)} ${plural(g.found, 'address', 'addresses')} found`, `${n(g.created)} ${plural(g.created, 'lead')} created`]
  if (g.existed) counts.push(`${n(g.existed)} already ${plural(g.existed, 'a lead', 'leads')}`)
  if (g.erased) counts.push(`${n(g.erased)} erased before and left that way`)
  if (g.skipped) counts.push(`${n(g.skipped)} past the limit — press Find addresses again for the rest`)
  out.push(counts.join(', ') + '.')

  // Where they came from, when more than one source was used.
  const src = g.bySource
  if (src && (src.census_tiger || src.geocodio)) {
    const parts = [src.overture ? `${n(src.overture)} published address points` : '', src.census_tiger ? `${n(src.census_tiger)} estimated from Census street ranges (confirm the number at the door)` : '', src.geocodio ? `${n(src.geocodio)} from Geocodio` : ''].filter(Boolean)
    out.push(`Sources: ${parts.join(', ')}.`)
  }
  if (g.coverageStatus && g.pointCoverage != null && g.homeRooftops) {
    out.push(`${g.pointCoverage}% of the ${n(g.homeRooftops)} homes here have an official address.`)
  }
  if (g.nonResidential) out.push(`${n(g.nonResidential)} on commercial or public buildings ${plural(g.nonResidential, 'was', 'were')} left out.`)

  const leftover = g.unranged ?? g.withoutAddress ?? 0
  if (g.rangeData === false && g.withoutAddress) {
    out.push(`${n(g.withoutAddress)} ${plural(g.withoutAddress, 'home has', 'homes have')} no published address and the Census street ranges for this area are not loaded yet.`)
  } else if (g.geocoder === 'off' && leftover) {
    out.push(`${n(leftover)} ${plural(leftover, 'home is', 'homes are')} too far from a numbered street to estimate.`)
  } else {
    if (g.lookupFailed) out.push(`Looking up ${n(g.lookupFailed)} ${plural(g.lookupFailed, 'house')} failed — press Find addresses to try again; nothing is duplicated.`)
    if (g.lookupSkipped) out.push(`${n(g.lookupSkipped)} more ${plural(g.lookupSkipped, 'house is', 'houses are')} waiting — press Find addresses again to look them up.`)
    if (g.unresolved) out.push(`${n(g.unresolved)} ${plural(g.unresolved, 'rooftop has', 'rooftops have')} no street address on record.`)
  }

  if (!g.found && !g.withoutAddress && g.coverage === 'addresses') out.push('There are no houses inside this shape.')
  return out.join(' ')
}
