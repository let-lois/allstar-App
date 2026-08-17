import { useMemo, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { FieldMap, fitZoom } from '../components/map/FieldMap'
import { useAppStore } from '../store/useAppStore'
import { useTerritories } from './useAdminData'
import { FIELD_REPS } from '../data/seed'
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
  const list = useMemo(() => Object.values(properties), [properties])
  const rows = useTerritories(list)
  const [selected, setSelected] = useState<string | null>(rows[0]?.id ?? null)

  const shown = useMemo(
    () => (selected ? list.filter((p) => p.territoryId === selected) : list),
    [list, selected],
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
                  <td className="px-4 py-3 font-medium">{t.id}</td>
                  <td className="px-3 py-3">
                    <select
                      defaultValue={t.repId ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      className="focusable min-h-[36px] rounded-lg border border-slate-200 bg-surface px-2 text-xs"
                    >
                      <option value="">Unassigned</option>
                      {FIELD_REPS.map((r) => (
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
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-ink-mute">
            Reassignment is read-only until the backend lands. Coverage is knocked
            properties over total, not route completion.
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-surface">
          <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-bold">{selected ?? 'All territories'}</h2>
            <span className="nums text-xs text-ink-mute">{shown.length} properties</span>
          </div>
          <FieldMap
            className="h-[520px]"
            properties={shown}
            // No follow-me here: an office user's own GPS is irrelevant to a
            // territory, and passing it would recenter the map off the patch.
            position={null}
            disableClustering
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
