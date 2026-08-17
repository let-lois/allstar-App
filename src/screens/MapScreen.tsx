import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldMap, type MapHandle } from '../components/map/FieldMap'
import { BottomSheet } from '../components/ui/BottomSheet'
import { PropertyPeek } from '../components/property/PropertyPeek'
import { Chip } from '../components/ui/Chip'
import { SyncBadge } from '../components/sync/SyncBadge'
import { useAppStore, useScopedProperties } from '../store/useAppStore'
import { distanceMiles, formatDistance } from '../lib/geo'
import { useIsWide } from '../lib/useMediaQuery'
import type { LeadStatus } from '../types'
import { STATUS_COLOR, STATUS_LABEL } from '../data/outcomes'

type Filter = 'all' | 'route' | 'unvisited' | 'open' | LeadStatus

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'route', label: 'My route' },
  { key: 'all', label: 'All' },
  { key: 'unvisited', label: 'Not knocked' },
  { key: 'open', label: 'Open leads' },
  { key: 'appointment', label: STATUS_LABEL.appointment },
  { key: 'quoted', label: STATUS_LABEL.quoted },
  { key: 'working', label: STATUS_LABEL.working },
]

/**
 * Full-bleed map.
 *
 * The map owns the whole viewport — no header bar eating 15% of a phone screen.
 * Filters float on top, the property sheet rises from the bottom, and every
 * control sits in the lower two-thirds where a thumb can reach it.
 */
export function MapScreen() {
  const nav = useNavigate()
  const { properties, route, position } = useAppStore()
  const scoped = useScopedProperties()
  const [filter, setFilter] = useState<Filter>('route')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const mapHandle = useRef<MapHandle | null>(null)
  const isWide = useIsWide()

  const routeIds = useMemo(
    () => new Set(route?.stops.map((s) => s.propertyId) ?? []),
    [route],
  )

  const shown = useMemo(() => {
    const list = scoped
    switch (filter) {
      case 'all':
        return list
      case 'route':
        return list.filter((p) => routeIds.has(p.id))
      case 'unvisited':
        return list.filter((p) => !p.lastVisitAt)
      case 'open':
        return list.filter((p) => !['won', 'lost', 'dnc'].includes(p.status))
      default:
        return list.filter((p) => p.status === filter)
    }
  }, [scoped, filter, routeIds])

  const selected = selectedId ? properties[selectedId] : undefined

  // Nearest open door — the answer to "where do I go now" when the rep is
  // freelancing rather than following the route.
  const nearest = useMemo(() => {
    if (!position) return undefined
    let best: { id: string; d: number } | undefined
    for (const p of shown) {
      if (['won', 'dnc'].includes(p.status)) continue
      const d = distanceMiles(position, p)
      if (!best || d < best.d) best = { id: p.id, d }
    }
    return best
  }, [shown, position])

  return (
    <div className="relative flex min-h-0 flex-1">
      {/*
        Tablet / desktop get a second pane instead of a taller map: the stop
        list beside the map, with the selected property expanding in place. On a
        phone the same information arrives as a bottom sheet over a full-bleed
        map, because there is no room for two panes and the map *is* the screen.
      */}
      {isWide && (
        <aside className="hidden w-[320px] shrink-0 flex-col border-r border-slate-200 bg-surface md:flex lg:w-[380px]">
          {selected ? (
            <div className="scroll-pane p-4">
              <button
                onClick={() => setSelectedId(null)}
                className="focusable mb-2 min-h-tap rounded-lg px-2 text-sm font-semibold text-brand-600"
              >
                ← All properties
              </button>
              <PropertyPeek
                property={selected}
                position={position}
                onOpenFull={() => nav(`/property/${selected.id}`)}
              />
            </div>
          ) : (
            <>
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="nums text-xs font-semibold text-ink-mute">
                  {shown.length} properties
                </p>
              </div>
              <ul className="scroll-pane">
                {shown.slice(0, 200).map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        setSelectedId(p.id)
                        mapHandle.current?.flyTo(p.lat, p.lng)
                      }}
                      className="flex min-h-[64px] w-full items-center gap-2.5 border-b border-slate-100 px-3 text-left active:bg-slate-50"
                    >
                      <span
                        className="h-8 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[p.status] }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {p.address1}
                        </span>
                        <span className="block truncate text-xs text-ink-mute">
                          {p.contacts[0]?.name ?? 'No contact'}
                          {position && ` · ${formatDistance(distanceMiles(position, p))}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}

      <FieldMap
        className="min-h-0 flex-1"
        properties={shown}
        position={position}
        route={filter === 'route' ? route : null}
        selectedId={selectedId}
        onSelect={setSelectedId}
        handleRef={mapHandle}
        initialCenter={
          route?.stops.length
            ? properties[route.stops[0].propertyId]
            : undefined
        }
        overlay={
          <>
            {/* Floating filter rail — scrolls horizontally, never wraps. */}
            <div className="pad-top pointer-events-none absolute inset-x-0 top-0">
              <div className="pointer-events-auto flex items-center gap-2 px-3 pb-2 pt-2">
                <div className="snap-x-row flex-1 pr-1">
                  {FILTERS.map((f) => (
                    <Chip
                      key={f.key}
                      size="sm"
                      selected={filter === f.key}
                      onClick={() => setFilter(f.key)}
                      className={
                        filter === f.key ? 'shadow-float' : 'bg-surface/95 shadow-raise backdrop-blur'
                      }
                    >
                      {f.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="pointer-events-auto flex items-center gap-2 px-3">
                <span className="nums rounded-full bg-surface/95 px-2.5 py-1 text-xs font-semibold shadow-raise backdrop-blur">
                  {shown.length} properties
                </span>
                <SyncBadge onClick={() => nav('/more')} />
              </div>
            </div>

            {/* Nearest-door shortcut, bottom-left, opposite the zoom controls. */}
            {!selected && nearest && (
              <button
                onClick={() => {
                  const p = properties[nearest.id]
                  mapHandle.current?.flyTo(p.lat, p.lng, 18)
                  setSelectedId(nearest.id)
                }}
                className="press focusable absolute left-3 flex min-h-[48px] items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-white shadow-float"
                style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
              >
                Nearest door
                <span className="nums opacity-70">
                  {(nearest.d * 5280).toFixed(0)} ft
                </span>
              </button>
            )}
          </>
        }
      />

      {/* Scrim off: the rep should still be able to pan the map behind the sheet. */}
      <BottomSheet
        open={!!selected && !isWide}
        onClose={() => setSelectedId(null)}
        detents={[0.46, 0.86]}
        scrim={false}
      >
        {selected && (
          <PropertyPeek
            property={selected}
            position={position}
            onOpenFull={() => nav(`/property/${selected.id}`)}
          />
        )}
      </BottomSheet>
    </div>
  )
}
