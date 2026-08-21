import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldMap, type MapHandle } from '../components/map/FieldMap'
import { RouteList } from '../components/map/RouteList'
import { GoogleFieldMap } from '../components/map/GoogleFieldMap'
import { MapSearch } from '../components/map/MapSearch'
import { gmapsConfigured, type GmapsError } from '../lib/gmaps'
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

  /*
    Why the Google map could not be shown, if it could not.

    Connectivity is not checked separately, on purpose. Offline, no signal, a
    rejected key and a blocked script all surface here as a *named* load failure,
    and every one of them has the same correct response: show the route as a list
    and say why. Adding an `online` check on top would be a second source of
    truth for the same question, and the two would disagree on a flaky connection
    — which is precisely the condition this screen exists for.
  */
  const [mapError, setMapError] = useState<GmapsError | null>(null)
  const googleMap = gmapsConfigured()
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
    /*
      `min-w-0` is load-bearing. This is a horizontal scroller inside a flex row,
      and a flex item without it takes its min-content width as a floor — here
      the sum of every chip, about 527px. Over the map that was invisible,
      because the overlay is `absolute inset-x-0` and pinned to the viewport. In
      the list view the same row sits in normal flow, so the floor stretched the
      whole column to 551px inside a 390px screen and pushed the map/list switch
      off the right edge with no way to scroll to it.
    */
    <div className="snap-x-row min-w-0 flex-1 pr-1">
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
      {/*
        Search takes the space the property-count pill used to hold. The count
        moved into its placeholder rather than getting a row of its own: on a
        360px phone the map *is* the screen, and a third band of chrome over it
        costs more than the pill was worth.
      */}
      <MapSearch
        properties={shown}
        position={position}
        count={shown.length}
        onPickLead={(id) => {
          const p = properties[id]
          if (!p) return
          mapHandle.current?.flyTo(p.lat, p.lng, 18)
          setSelectedId(id)
          // A found lead is worth seeing on the map, so the list view steps
          // aside for it rather than leaving the rep to switch back manually.
          setView('map')
        }}
        onPickPlace={(at) => {
          mapHandle.current?.flyTo(at.lat, at.lng, 17)
          setSelectedId(null)
          setView('map')
        }}
      />
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

  /*
    Google online, the self-rendered map offline, and the list only when a rep
    asks for it.

    This used to send a failed Google load straight to the list — which meant
    that in production, where Google *is* configured, the MapTiler tiles a rep
    downloads through "Offline maps" were never drawn at all. The territory
    download had become unreachable: the one moment it exists for was the one
    moment the screen stopped using it.

    So the order is now imagery first. Google draws while it can; when it cannot,
    `FieldMap` takes over with whatever tiles are already on the device and its
    own drawn basemap underneath them. The list remains a choice rather than a
    consolation.
  */
  const showList = view === 'list'
  const useGoogle = googleMap && !mapError

  /*
    One prop bundle for both renderers. They are not variants of one map — they
    are two maps behind one contract — and keeping the call sites identical is
    what stops them drifting into different behaviour on the screen a rep spends
    their day in.
  */
  const mapProps = {
    className: 'min-h-0 flex-1',
    properties: shown,
    position,
    route: filter === 'route' ? route : null,
    selectedId,
    onSelect: setSelectedId,
    handleRef: mapHandle,
    initialCenter: route?.stops.length ? properties[route.stops[0].propertyId] : undefined,
    overlay: (
      <>
        {/* Floating filter rail — scrolls horizontally, never wraps. */}
        <div className="pad-top pointer-events-none absolute inset-x-0 top-0">
          <div className="pointer-events-auto flex items-center gap-2 px-3 pb-2 pt-2">{chips}</div>
          {statusRow}

          {/*
            Said over the map rather than instead of it. A rep who has fallen back
            to saved imagery needs to know two things — which map they are looking
            at, and that their work is still being recorded — and neither is worth
            taking the map away for.
          */}
          {mapError && (
            <div
              role="status"
              className="pointer-events-auto mx-3 mt-2 rounded-field bg-warn-bg px-3 py-2 text-[12.5px] text-warn shadow-raise"
            >
              {/*
                Connectivity gets a rep's sentence; everything else keeps the
                provider's own words. A rejected key is the most likely thing to
                break on a new deployment and the least guessable, so collapsing
                it into "map unavailable" would throw away the one message that
                tells whoever deployed it what to go and fix.
              */}
              {mapError.reason === 'unreachable' ? (
                <>
                  <span className="font-semibold">No signal for live map imagery.</span> Showing
                  your saved map. Visits are still being saved on this phone.
                </>
              ) : (
                <>
                  <span className="font-semibold">Live map unavailable.</span> {mapError.message}{' '}
                  Showing your saved map.
                </>
              )}
            </div>
          )}
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
    ),
  }

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

      {!showList ? (
        useGoogle ? (
          <GoogleFieldMap {...mapProps} onUnavailable={setMapError} />
        ) : (
          <FieldMap {...mapProps} />
        )
      ) : (
        /*
          A real screen rather than a degraded map, so it gets a solid header
          instead of controls floating over imagery that isn't there.
        */
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-surface">
          <div className="pad-top w-full min-w-0 shrink-0 border-b border-ink/[0.06] bg-surface">
            <div className="flex items-center gap-2 px-3 pb-2 pt-2">{chips}</div>
            <div className="pb-2">{statusRow}</div>
          </div>

          {/*
            Only when the map failed, and only saying what happened. A rep who
            cannot see a map already knows it; what they do not know is whether
            their work is still being saved, which is why the reason is named and
            the reassurance is explicit.
          */}
          {mapError && (
            <div role="status" className="shrink-0 bg-warn-bg px-4 py-2.5 text-[13px] text-warn">
              <span className="font-semibold">Map unavailable.</span>{' '}
              {mapError.reason === 'unreachable'
                ? 'No connection for map imagery. Your route and every visit you log are saved on this phone.'
                : mapError.message}
            </div>
          )}

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
