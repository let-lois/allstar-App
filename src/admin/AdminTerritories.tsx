import { useEffect, useMemo, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { FieldMap, fitZoom } from '../components/map/FieldMap'
import { useAppStore } from '../store/useAppStore'
import { UNASSIGNED_TERRITORY, inTerritory, useTerritories } from './useAdminData'
import { ApiError, apiAssignTerritory } from '../lib/http'
import { liveToken } from '../lib/session'
import { moneyFull } from '../lib/format'
import { INK, SINGLE } from './charts/tokens'

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
      title="Territories"
      description={`${rows.length} territories · ${totals.properties.toLocaleString()} properties · ${moneyFull(totals.open)} open`}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunk text-xs text-ink-mute">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Territory</th>
                <th className="px-3 py-2.5 text-left font-semibold">Assigned rep</th>
                <th className="px-3 py-2.5 text-right font-semibold">Properties</th>
                <th className="px-3 py-2.5 text-left font-semibold">Coverage</th>
                <th className="px-4 py-2.5 text-right font-semibold">Open value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  aria-selected={selected === t.id}
                  className={`cursor-pointer border-t border-slate-100 ${
                    selected === t.id ? 'bg-brand-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="px-4 py-3 font-medium">{label(t.id)}</td>
                  <td className="px-3 py-3">
                    <select
                      value={t.repId ?? ''}
                      disabled={mode !== 'live' || saving !== null}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => void assign(t.id, e.target.value)}
                      className="focusable min-h-[36px] rounded-lg border border-slate-200 bg-surface px-2 text-xs disabled:opacity-60"
                    >
                      <option value="">{t.mixed ? 'Mixed — pick one' : 'Unassigned'}</option>
                      {repOptions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="nums px-3 py-3 text-right">{t.properties}</td>
                  <td className="px-3 py-3">
                    {/* Coverage is a magnitude, so it's a bar — plus the number,
                        because a bar alone can't be read precisely. */}
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-24 overflow-hidden rounded-full"
                        style={{ backgroundColor: INK.grid }}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${t.coverage}%`, backgroundColor: SINGLE }}
                        />
                      </span>
                      <span className="nums text-xs font-semibold">{t.coverage}%</span>
                    </span>
                  </td>
                  <td className="nums px-4 py-3 text-right font-semibold text-emerald-700">
                    {moneyFull(t.openValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-slate-100 px-4 py-3 text-xs">
            {assignError ? (
              <p role="alert" className="font-medium text-red-700">
                {assignError}
              </p>
            ) : assigned ? (
              <p role="status" className="font-medium text-emerald-700">
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
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-surface">
          <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-bold">
              {selected ? label(selected) : 'All territories'}
            </h2>
            <span className="nums text-xs text-ink-mute">{shown.length} properties</span>
          </div>
          {shown.length === 0 && (
            <p className="px-4 py-6 text-sm text-ink-mute">
              No properties in this territory have coordinates yet, so there is
              nothing to place on a map.
            </p>
          )}
          <FieldMap
            className="h-[520px]"
            properties={shown}
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
            disableClustering={shown.length <= 25}
            selectedId={null}
            onSelect={() => {}}
            key={selected ?? 'all'}
            initialCenter={view?.center}
            initialZoom={view?.zoom}
          />
        </div>
      </div>
    </AdminPage>
  )
}
