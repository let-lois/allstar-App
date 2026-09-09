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
import { LeadFields, useLeadDraft } from '../components/property/LeadForm'
import { Button } from '../components/ui/Button'
import { haptic } from '../lib/haptics'
import { distanceMiles, formatDistance } from '../lib/geo'
import { useIsWide } from '../lib/useMediaQuery'
import type { LeadStatus, Property } from '../types'
import { STATUS_COLOR, STATUS_LABEL } from '../data/outcomes'
import { VISITED_WINDOWS, matchesVisited, type VisitedWindow } from '../lib/leadFilter'

type Filter = 'all' | 'route' | 'unvisited' | 'noanswer' | 'open' | LeadStatus

/**
 * How much of the screen the Add-lead sheet covers.
 *
 * One number in one place, because it is two things at once: the sheet's first
 * detent, and how much of the map the picked pin has to stay clear of. Written
 * twice, those two would drift and the pin would start landing behind the sheet.
 */
const SHEET_FRACTION = 0.46

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'route', label: 'My route' },
  { key: 'all', label: 'All' },
  { key: 'unvisited', label: 'Not knocked' },
  /*
    The second pass.

    "Not knocked" and "nobody answered" are different jobs on different days:
    the first is virgin territory, the second is a street a rep has already
    walked and should come back to at a different hour. Until the map could
    tell them apart there was no way to ask for the second one at all.
  */
  { key: 'noanswer', label: 'No answer' },
  { key: 'open', label: 'Open leads' },
  /*
    Ahead of the sale stages on purpose. "Who asked me to come back" is the
    question a rep opens the map with when planning an afternoon; an appointment
    is already in their calendar.
  */
  { key: 'follow_up', label: STATUS_LABEL.follow_up },
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
    The house a rep has just tapped, and the form that opens over it.

    Two pieces of state rather than one because they answer different
    questions. `draftAt` is where the pin is — nothing else, and no record
    anywhere: tapping the map has to be free, or reps will stop doing it. It
    becomes a lead only when somebody fills the form in and presses Save, which
    is the whole of `adding`.
  */
  const [draftAt, setDraftAt] = useState<{ lat: number; lng: number } | null>(null)
  const [adding, setAdding] = useState(false)
  /*
    When it was last knocked, alongside the status rail rather than folded into
    it. "Not knocked" already lives in that rail as a one-off; these are the same
    question asked properly, and keeping them apart means the status chips stay a
    list of statuses.
  */
  const [visited, setVisited] = useState<VisitedWindow>('any')
  const timezone = useAppStore((s) => s.timezone)
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
    /*
      The visit window applies on top of whichever chip is selected, not instead
      of it: "my route, not knocked in a month" is a real request and the two
      rails compose. Through the shared predicate so the map agrees with both
      lists about what a month is. See leadFilter.ts.
    */
    const list =
      visited === 'any' ? scoped : scoped.filter((p) => matchesVisited(p, visited, timezone))
    switch (filter) {
      case 'all':
        return list
      case 'route':
        return list.filter((p) => routeIds.has(p.id))
      case 'unvisited':
        return list.filter((p) => !p.lastVisitAt)
      case 'noanswer':
        /*
          Still worth another knock. A door that answered and said no is not on
          this list — `lastOutcome` is the *last* thing that happened, so a lead
          that has since been sold or marked Do Not Contact has moved on and
          must not be handed back to a rep as unfinished business.
        */
        return list.filter(
          (p) => p.lastOutcome === 'no_answer' && !['won', 'lost', 'dnc'].includes(p.status),
        )
      case 'open':
        return list.filter((p) => !['won', 'lost', 'dnc'].includes(p.status))
      default:
        return list.filter((p) => p.status === filter)
    }
  }, [scoped, filter, routeIds, visited, timezone])

  const selected = selectedId ? properties[selectedId] : undefined

  const pickAt = (at: { lat: number; lng: number }) => {
    setDraftAt(at)
    setAdding(true)
    haptic('tap')
    /*
      Only if the sheet is about to cover it. The pin has to land under the
      rep's finger and stay there — that *is* the confirmation — so the map
      moves the minimum that keeps it visible and never recentres. See
      `MapHandle.reveal`.
    */
    mapHandle.current?.reveal(at, SHEET_FRACTION)
  }

  const cancelDraft = () => {
    setDraftAt(null)
    setAdding(false)
  }

  /*
    Saved. The temporary pin goes and the lead's own marker takes its place —
    which is only true if the lead is one the current filter shows, and "My
    route" shows a route this house is not on yet. So the filter widens rather
    than letting the pin vanish into a lead nobody can see, and the new lead is
    selected, which puts its own sheet up in place of the form.
  */
  const onSaved = (p: Property) => {
    setDraftAt(null)
    setAdding(false)
    const visible =
      (visited === 'any' || matchesVisited(p, visited, timezone)) &&
      (filter === 'all' || filter === 'open' || filter === 'unvisited' || filter === 'new')
    if (!visible) {
      setFilter('all')
      setVisited('any')
    }
    /*
      Close enough in that the new lead is its own dot rather than a number in a
      cluster bubble. Nearby doors merge into counts below zoom 17, so a lead
      saved at street zoom could otherwise vanish into one the instant it was
      created — the rep presses Save and their house is gone.
    */
    mapHandle.current?.flyTo(p.lat, p.lng, 18)
    setSelectedId(p.id)
  }

  /*
    One draft per pin, and it survives the pin moving.

    Keyed on nothing: re-mounting this on every tap would throw away whatever
    the rep had typed, and moving the pin is a correction to *this* lead, not a
    different one. The address they have already entered is still the address.
  */
  const leadDraft = useLeadDraft({ at: draftAt, onSaved })

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
      {/*
        The visit windows continue the same scroller rather than starting a
        second band. Over the map every extra row of chrome costs map, which on
        a 360px phone is the screen — and this rail already scrolls, so length
        is free where height is not. A divider says the two groups compose
        instead of replacing each other.
      */}
      <span className="mx-1 w-px shrink-0 self-stretch bg-line/60" />
      {VISITED_WINDOWS.filter((w) => w.key !== 'any' || visited !== 'any').map((w) => (
        <Chip
          key={w.key}
          size="sm"
          selected={visited === w.key}
          onClick={() => setVisited(w.key)}
          className={
            visited === w.key ? 'shadow-card' : 'bg-surface/95 shadow-card backdrop-blur'
          }
        >
          {w.key === 'any' ? 'Any visit' : w.label}
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
        {/*
          Two, not three. Street belongs on a map screen and it was briefly a
          third segment here, which broke the layout at 320px: this row also
          carries the lead search, and the extra width pushed the search field
          out of it entirely — `verify:mapsearch` measures that and caught it.
          The overflow was also the design telling me something. Map and List
          are two renderings of *this* screen; Street is a different route, and
          a view-toggle is the wrong place to navigate from. It moved to a
          button on the map itself.
        */}
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
    /*
      Not while a lead's sheet is up. In that state a tap on the map means
      "close this", which is what it has always meant and what a rep expects —
      handing it to the picker instead would answer a question nobody asked
      with a form. Once the sheet is down, a tap on open ground is the new lead.
    */
    pick: selected
      ? undefined
      : {
          at: draftAt,
          onPick: pickAt,
          exclusive: adding,
          label: adding ? 'Tap to move the new lead’s pin' : 'Tap a house to add it as a lead',
        },
    overlay: (
      <>
        {/*
          The way into the street view, bottom-left.

          Down here rather than in the segmented control at the top, which is
          the row that also carries the lead search — a third item there pushed
          the search off screen at 320px. The left edge at thumb height is free
          (the map's own controls stack on the right), so this costs no
          horizontal room at any width, which is what a 320px phone needs.
        */}
        <div className="pointer-events-none absolute inset-0">
          <button
            onClick={() => nav('/street')}
            className="focusable metal metal-map pointer-events-auto absolute left-3 flex min-h-[44px] items-center rounded-pill px-4 text-[12.5px] font-semibold text-ink-soft"
            style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
          >
            Street
          </button>
        </div>

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

        {/* Nearest-door shortcut, bottom-left, opposite the zoom controls. */}
        {!selected && nearest && (
          <button
            onClick={() => {
              const p = properties[nearest.id]
              mapHandle.current?.flyTo(p.lat, p.lng, 18)
              setSelectedId(nearest.id)
            }}
            className="metal metal-quiet press focusable absolute left-3 flex min-h-[48px] items-center gap-2 rounded-pill px-4 text-[14px] font-semibold !text-accent-strong"
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
        The Add-lead sheet.

        A sheet rather than the full screen at `/lead/new`, and the reason is
        the pin: a rep who has just tapped a house needs to keep seeing which
        house while they type, and a screen that covers the map takes away the
        thing they were confirming. No scrim, one detent under half the height,
        and the map stays live behind it — tapping it again moves the pin.

        Not on a tablet or a desktop, where the left pane is doing this job and
        there is room to show both properly.
      */}
      <BottomSheet
        open={adding && !isWide}
        onClose={cancelDraft}
        detents={[SHEET_FRACTION, 0.9]}
        scrim={false}
        title="Add lead"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" onClick={cancelDraft} className="shrink-0">
              Cancel
            </Button>
            {/*
              The one obvious thing to do next, and the widest target on the
              sheet. Disabled until there is an address *and* a pin, with the
              readout above saying which of the two is missing — a dead button
              that does not explain itself is what the old screen offered.
            */}
            <Button
              size="lg"
              full
              onClick={() => void leadDraft.save()}
              disabled={!leadDraft.canSave}
            >
              {leadDraft.saving ? 'Saving…' : 'Save lead'}
            </Button>
          </div>
        }
      >
        <div data-testid="add-lead-sheet" className="pb-2">
          <LeadFields draft={leadDraft} autoFocus={false} />
        </div>
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
