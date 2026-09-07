import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldMap, type MapHandle } from '../components/map/FieldMap'
import { RouteList } from '../components/map/RouteList'
import { GoogleFieldMap } from '../components/map/GoogleFieldMap'
import { MapSearch } from '../components/map/MapSearch'
import { gmapsConfigured, type GmapsError } from '../lib/gmaps'
import { BottomSheet } from '../components/ui/BottomSheet'
import { PropertyPeek } from '../components/property/PropertyPeek'
import { DropPinSheet } from '../components/property/DropPinSheet'
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
    Pinning mode.

    `pinning` is armed by the rep and disarms itself on the first tap, which is
    the entire safety design: this map is panned and tapped all day, and a mode
    that stayed on would turn a mis-tap into a lead. One tap, one pin, back to
    normal — and the button says which state it is in, because a map that
    silently behaves differently is worse than one that cannot pin at all.

    `dropped` is the coordinate waiting to be confirmed. Held here rather than in
    the sheet so cancelling throws it away and nothing is written.
  */
  const [pinning, setPinning] = useState(false)
  const [dropped, setDropped] = useState<{ lat: number; lng: number } | null>(null)

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
    <div className="snap-x-row min-w-0 flex-1 pr-1" data-tour="map-filters">
      {FILTERS.filter((f) => f.key !== 'route' || hasRoute).map((f) => (
        <Chip
          key={f.key}
          size="sm"
          selected={filter === f.key}
          onClick={() => setFilter(f.key)}
          className={
            filter === f.key ? 'shadow-card' : 'bg-surface/95 shadow-card backdrop-blur'
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
    <div className="pointer-events-auto flex items-center gap-2 px-3" data-tour="map-search">
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
      <SyncBadge plated onClick={() => nav('/more')} />
      <div
        role="group"
        aria-label="View"
        /*
          A segmented control, not two buttons. The selected half is a teal pill
          inside a white track with a hairline — the same two-state vocabulary as
          the nav bar, so the one control that floats over the map does not
          introduce a third way of showing "selected".
        */
        className="metal metal-quiet ml-auto flex overflow-hidden rounded-full p-0.5"
      >
        {(['map', 'list'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            /*
              44px, not 40. The pill sits inside a 2px track, so the inner button
              is what a thumb actually lands on — sizing the *track* to the tap
              floor left the target 4px short, which `verify:routelist` measures
              directly and caught.
            */
            className={`focusable min-h-[44px] rounded-full px-3.5 text-[12.5px] font-semibold capitalize transition-colors ${
              view === v ? 'metal metal-brand' : 'text-ink-mute'
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
    onMapPick: pinning
      ? (at: { lat: number; lng: number }) => {
          setPinning(false)
          setSelectedId(null)
          setDropped(at)
          mapHandle.current?.flyTo(at.lat, at.lng, 19)
        }
      : undefined,
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
              className="pointer-events-auto mx-3 mt-2 rounded-field bg-warn-bg px-3 py-2 text-[12.5px] text-warn shadow-card"
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

        {/*
          Said over the map while the mode is armed, and only then. The rep has
          one tap to spend and needs to know it, and the same block is how they
          get out of the mode without spending it.
        */}
        {pinning && (
          <div
            role="status"
            className="pointer-events-auto mx-3 mt-2 flex items-center gap-3 rounded-field bg-surface-tint px-3 py-2 text-[12.5px] text-accent-strong shadow-card"
          >
            <span className="flex-1">
              <span className="font-semibold">Tap the house.</span> Zoom in first — the pin
              lands exactly where you tap.
            </span>
            <button
              onClick={() => setPinning(false)}
              className="focusable min-h-tap shrink-0 rounded-lg px-2 font-semibold underline"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Nearest-door shortcut, bottom-left, opposite the zoom controls. */}
        {!selected && !dropped && (
          <div
            className="pointer-events-auto absolute left-3 flex flex-col items-start gap-2"
            style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
          >
            {nearest && (
              <button
                onClick={() => {
                  const p = properties[nearest.id]
                  mapHandle.current?.flyTo(p.lat, p.lng, 18)
                  setSelectedId(nearest.id)
                }}
                className="metal metal-quiet press focusable flex min-h-[48px] items-center gap-2 rounded-pill px-4 text-[14px] font-semibold !text-accent-strong"
              >
                Nearest door
                <span className="nums font-medium text-ink-mute">
                  {(nearest.d * 5280).toFixed(0)} ft
                </span>
              </button>
            )}
            {/*
              Bottom-left with the other thumb controls, not in the header: this
              is something a rep does standing at a kerb, one-handed, and the top
              of a phone is the one place that hand cannot reach.
            */}
            <button
              onClick={() => {
                setPinning((v) => !v)
                setSelectedId(null)
              }}
              aria-pressed={pinning}
              className={`press focusable flex min-h-[48px] items-center gap-2 rounded-pill px-4 text-[14px] font-semibold ${
                pinning ? 'metal metal-brand' : 'metal metal-quiet !text-accent-strong'
              }`}
            >
              {pinning ? 'Tap a house…' : 'Drop a pin'}
            </button>
          </div>
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
        <aside className="hidden w-[320px] shrink-0 flex-col border-r border-line bg-surface md:flex lg:w-[380px]">
          {selected ? (
            <div className="scroll-pane p-4">
              <button
                onClick={() => setSelectedId(null)}
                className="focusable mb-2 min-h-tap rounded-lg px-2 text-sm font-semibold text-accent"
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
              <div className="border-b border-line-soft px-4 py-3">
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
                      className="flex min-h-[66px] w-full items-center gap-3 border-b border-line-soft px-4 text-left active:bg-surface-field"
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
          <div className="pad-top w-full min-w-0 shrink-0 border-b border-line-soft bg-surface">
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

      {/*
        The new pin's own sheet, and a separate one from the property peek on
        purpose: this is a confirmation with an unsaved coordinate behind it, and
        sharing a surface with the "look at this existing lead" sheet is how a
        dismiss ends up saving something or a save ends up dismissed.

        Keyed on the coordinate so a second pin gets a clean sheet rather than
        the previous house's address still sitting in the field.
      */}
      <BottomSheet
        open={!!dropped}
        onClose={() => setDropped(null)}
        detents={[0.56, 0.86]}
        scrim={false}
      >
        {dropped && (
          <DropPinSheet
            key={`${dropped.lat},${dropped.lng}`}
            at={dropped}
            onCancel={() => setDropped(null)}
            onSaved={(id) => {
              setDropped(null)
              nav(`/property/${id}`)
            }}
          />
        )}
      </BottomSheet>

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
