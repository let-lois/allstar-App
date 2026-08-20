import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldMap, type MapHandle } from '../components/map/FieldMap'
import { RouteList } from '../components/map/RouteList'
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
  /*
    "My route" is the right default *when there is a route*. Without one it
    filters everything out, and a rep with leads assigned but no day planned
    opens the map to "0 properties" — the app telling them they have no work when
    the Leads tab, one tap away, says otherwise.
  */
  const hasRoute = (useAppStore((s) => s.route)?.stops.length ?? 0) > 0
  const [filter, setFilter] = useState<Filter>(hasRoute ? 'route' : 'open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /*
    Map or list. A choice for now, and the offline default later.

    The map is moving to the Google Maps JavaScript API, which cannot draw
    without a connection and whose terms forbid caching its tiles — so in a dead
    zone there will be no basemap and this list becomes what the screen shows.
    It is introduced as a toggle rather than wired to connectivity because the
    map this replaces still works offline today: switching automatically now
    would remove a working offline map and call it a feature. The automatic swap
    belongs in the same change that swaps the renderer.

    Useful on its own regardless. Some reps would rather read an ordered list
    than a map, and until now the app had no answer for them on a phone.
  */
  const [view, setView] = useState<'map' | 'list'>('map')
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

  const chips = (
    <div className="snap-x-row flex-1 pr-1">
      {FILTERS.filter((f) => f.key !== 'route' || hasRoute).map((f) => (
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
  )

  /*
    Count, sync state, and the view switch on one row. The switch sits here
    rather than in thumb reach on purpose: it is a preference someone sets and
    forgets, not an action they repeat, and the bottom corners belong to the
    controls a rep uses at every door.
  */
  const statusRow = (
    <div className="pointer-events-auto flex items-center gap-2 px-3">
      <span className="nums rounded-full bg-surface/95 px-3 py-1.5 text-[12.5px] font-semibold text-ink-soft shadow-raise ring-1 ring-ink/[0.06] backdrop-blur">
        {shown.length} properties
      </span>
      <SyncBadge onClick={() => nav('/more')} />
      <div
        role="group"
        aria-label="View"
        className="ml-auto flex overflow-hidden rounded-full bg-surface/95 shadow-raise ring-1 ring-ink/[0.06] backdrop-blur"
      >
        {(['map', 'list'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={`focusable min-h-tap px-3.5 text-[12.5px] font-semibold capitalize ${
              view === v ? 'bg-brand-600 text-white' : 'text-ink-soft'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="relative flex min-h-0 flex-1">
      {/*
        Tablet / desktop get a second pane instead of a taller map: the stop
        list beside the map, with the selected property expanding in place. On a
        phone the same information arrives as a bottom sheet over a full-bleed
        map, because there is no room for two panes and the map *is* the screen.
      */}
      {isWide && (
        <aside className="hidden w-[320px] shrink-0 flex-col border-r border-ink/10 bg-surface md:flex lg:w-[380px]">
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
              <div className="border-b border-ink/[0.06] px-4 py-3">
                <p className="eyebrow">{shown.length} properties</p>
              </div>
              <ul className="scroll-pane">
                {shown.slice(0, 200).map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        setSelectedId(p.id)
                        mapHandle.current?.flyTo(p.lat, p.lng)
                      }}
                      className="flex min-h-[66px] w-full items-center gap-3 border-b border-ink/[0.06] px-4 text-left active:bg-surface-field"
                    >
                      <span
                        className="h-9 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[p.status] }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">
                          {p.address1}
                        </span>
                        <span className="block truncate text-[13px] text-ink-mute">
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

      {view === 'map' ? (
        <FieldMap
          className="min-h-0 flex-1"
          properties={shown}
          position={position}
          route={filter === 'route' ? route : null}
          selectedId={selectedId}
          onSelect={setSelectedId}
          handleRef={mapHandle}
          initialCenter={
            route?.stops.length ? properties[route.stops[0].propertyId] : undefined
          }
          overlay={
            <>
              {/* Floating filter rail — scrolls horizontally, never wraps. */}
              <div className="pad-top pointer-events-none absolute inset-x-0 top-0">
                <div className="pointer-events-auto flex items-center gap-2 px-3 pb-2 pt-2">
                  {chips}
                </div>
                {statusRow}
              </div>

              {/* Nearest-door shortcut, bottom-left, opposite the zoom controls. */}
              {!selected && nearest && (
                <button
                  onClick={() => {
                    const p = properties[nearest.id]
                    mapHandle.current?.flyTo(p.lat, p.lng, 18)
                    setSelectedId(nearest.id)
                  }}
                  className="press focusable absolute left-3 flex min-h-[48px] items-center gap-2 rounded-field bg-surface px-4 text-[14px] font-semibold text-brand-600 shadow-float ring-1 ring-ink/[0.06]"
                  style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
                >
                  Nearest door
                  <span className="nums font-medium text-ink-mute">
                    {(nearest.d * 5280).toFixed(0)} ft
                  </span>
                </button>
              )}
            </>
          }
        />
      ) : (
        /*
          A real screen rather than a degraded map, so it gets a solid header
          instead of controls floating over imagery that isn't there.
        */
        <div className="flex min-h-0 flex-1 flex-col bg-surface">
          <div className="pad-top shrink-0 border-b border-ink/[0.06] bg-surface">
            <div className="flex items-center gap-2 px-3 pb-2 pt-2">{chips}</div>
            <div className="pb-2">{statusRow}</div>
          </div>
          <RouteList
            className="pad-nav min-h-0 flex-1"
            properties={shown}
            route={filter === 'route' ? route : null}
            position={position}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      )}

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
