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
import type { Property } from '../types'
import { STATUS_COLOR, isOpenStatus } from '../data/outcomes'
import {
  DEFAULT_MAP_FILTER,
  UNFILTERED_MAP,
  activeFilterCount,
  matchesMapFilter,
  widenToShow,
  type MapFilter,
} from '../lib/leadFilter'
import { FilterSheet } from '../components/map/FilterSheet'

/**
 * How much of the screen the Add-lead sheet covers.
 *
 * One number in one place, because it is two things at once: the sheet's first
 * detent, and how much of the map the picked pin has to stay clear of. Written
 * twice, those two would drift and the pin would start landing behind the sheet.
 */
const SHEET_FRACTION = 0.46

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
  /*
    One value, four questions.

    This was two single-select rails holding fourteen chips between them, of
    which three fitted on a 320px screen — and they could contradict each other:
    "Not knocked" and "Today" sat a divider apart and asked for a door that had
    never been knocked and was knocked this morning. The shape is in
    leadFilter.ts, beside the visit windows it composes with, so the predicate
    has one implementation and a gate that needs no browser.
  */
  const [filter, setFilter] = useState<MapFilter>({
    ...DEFAULT_MAP_FILTER,
    scope: hasRoute ? 'route' : 'all',
  })
  const [filtersOpen, setFiltersOpen] = useState(false)
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

  const shown = useMemo(
    /*
      One predicate, shared with the no-DOM gate and with the widening that runs
      after a lead is saved. The switch this replaces had five branches and a
      default, and the save path carried a hand-written list of which of those
      branches already showed a new lead — a second model of the same question,
      which had already drifted into testing a branch that no chip could reach.
    */
    () => scoped.filter((p) => matchesMapFilter(p, filter, { onRoute: routeIds.has(p.id), timezone })),
    [scoped, filter, routeIds, timezone],
  )

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
    /*
      The real predicate, not a list of filter keys.

      This used to ask `filter === 'all' || filter === 'open' || ...` — a second,
      hand-maintained model of what the map shows, which had already drifted:
      one of its four keys named a chip that did not exist. Asking the filter
      itself cannot drift, and it is the same function that drew the map.

      Widened as little as it takes. Resetting to "everything" was the first
      draft and it is wrong: "everything" includes any status, which would put
      every Do Not Contact lead in the territory on a rep's map as a side effect
      of their adding one house. See `widenToShow`.
    */
    if (!matchesMapFilter(p, filter, { onRoute: routeIds.has(p.id), timezone })) {
      setFilter(widenToShow(p))
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
      // `isOpenStatus`, not the hand-written pair this used to carry: it
      // skipped `won` and `dnc` but not `lost`, so the button whose whole job is
      // to offer a rep somewhere worth going would send them to a door that had
      // already turned them down — and one "Open leads" will not even draw.
      if (!isOpenStatus(p.status)) continue
      const d = distanceMiles(position, p)
      if (!best || d < best.d) best = { id: p.id, d }
    }
    return best
  }, [shown, position])

  const activeCount = activeFilterCount(filter)

  /*
    The band that used to be fourteen chips.

    Four things now, and the first is pinned. `shrink-0` on the button and
    `min-w-0` on the scroller beside it mean that however narrow the screen, the
    way into every filter is on it — which was the actual failure of the rail,
    not its length: eleven of its fourteen chips were behind a horizontal swipe
    that gave no sign of how much was hidden, and five of the nine statuses had
    no chip at all.

    The two that stayed out are the two questions a rep answers on arriving:
    which set am I looking at, and is it today's route. Everything else is one
    tap further in, which is the trade — and it buys New, Contacted, Won, Lost
    and Do Not Contact becoming askable on the map for the first time.

    No third chip for "Open leads", though it was here in a first draft: the
    sheet's status section already carries that name, and two controls with one
    accessible name are ambiguous to a screen reader and to anything that
    addresses a control by what it is called. The gate measures that now.
  */
  const chips = (
    <div className="flex min-w-0 flex-1 items-center gap-2 pr-1">
      <button
        type="button"
        data-tour="map-filters"
        data-testid="map-filters"
        aria-expanded={filtersOpen}
        /*
          A stable accessible name with the count inside it, so a gate can find
          the control without depending on how the number is rendered, and a
          screen-reader user hears how much is on before they open it.
        */
        aria-label={activeCount ? `Filters, ${activeCount} active` : 'Filters'}
        onClick={() => setFiltersOpen(true)}
        /*
          `metal-map`, not `metal-quiet`: the quiet face is translucent, and a
          translucent control over map imagery is the dark-on-dark bug this
          codebase has already recorded once.
        */
        className="focusable press metal metal-map flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-pill px-3.5 text-[12.5px] font-semibold text-ink-soft"
      >
        Filters
        {activeCount > 0 && (
          <span className="nums rounded-full bg-ink/10 px-1.5 py-0.5 text-[11px] font-bold text-accent-strong">
            {activeCount}
          </span>
        )}
      </button>

      {/*
        `min-w-0` is still load-bearing here. This is a horizontal scroller
        inside a flex row, and a flex item without it takes its min-content
        width as a floor — which once stretched this column to 551px inside a
        390px screen and pushed the map/list switch off the right edge.
      */}
      <div className="snap-x-row min-w-0 flex-1">
        <Chip
          size="sm"
          selected={activeCount === 0 && filter.scope === 'all' && filter.status.kind === 'any'}
          onClick={() => setFilter(UNFILTERED_MAP)}
          className="bg-surface/95 shadow-card backdrop-blur"
        >
          All
        </Chip>
        {hasRoute && (
          <Chip
            size="sm"
            selected={filter.scope === 'route'}
            onClick={() =>
              setFilter((f) => ({ ...f, scope: f.scope === 'route' ? 'all' : 'route' }))
            }
            className="bg-surface/95 shadow-card backdrop-blur"
          >
            My route
          </Chip>
        )}
      </div>
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
    /*
      The scope is also the render mode: the route line and its ordered stop
      numbers only mean anything while the map is showing that route. This was
      the least obvious thing the old rail did — 'My route' was a filter *and*
      the switch that drew the polyline — and it is the one piece of it that had
      to survive the restructure intact.
    */
    route: filter.scope === 'route' ? route : null,
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
    /*
      Nor while the filter sheet is up. That sheet is the one on this screen
      with a scrim, precisely because a tap on the map means "add a lead here" —
      a rep reaching past it to watch their filter take effect would come back
      to a draft pin they never asked for.
    */
    pick: selected || filtersOpen
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
          {/*
            Nothing matched, and why.

            The old rail could be tapped into a state that was empty by
            construction — "Not knocked" plus "Today" — and it said nothing at
            all: an empty map and a search box reading "Search 0 leads". That
            particular contradiction is now unsayable, but a filter can still
            legitimately find nothing, and an empty map is indistinguishable
            from a broken one. Only shown when a filter is actually on, so a rep
            whose territory really is empty is not told it is their fault.
          */}
          {shown.length === 0 && activeCount > 0 && (
            <div
              role="status"
              data-testid="no-matches"
              className="pointer-events-auto mx-3 mt-2 flex items-center gap-2 rounded-field bg-surface px-3 py-2 text-[12.5px] text-ink-soft shadow-card"
            >
              <span className="flex-1">No leads match these filters.</span>
              <button
                onClick={() =>
                  setFilter((f) => ({
                    ...f,
                    status: { kind: 'open' },
                    visited: 'any',
                    noAnswerOnly: false,
                  }))
                }
                className="focusable min-h-[36px] shrink-0 rounded-lg px-2 font-semibold text-accent"
              >
                Clear filters
              </button>
            </div>
          )}

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
            route={filter.scope === 'route' ? route : null}
            position={position}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      )}

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filter={filter}
        onChange={setFilter}
        matching={shown.length}
      />

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
