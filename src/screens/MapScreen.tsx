import { IconFilter } from '../components/nav/icons'
import { IconBack } from '../components/nav/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
  /*
    Arrived from a list. `/map?list=<id>` is what "Open on map" on a list
    sends, and the map opens already narrowed to that list — every house on
    it, whatever its status, because the list is somebody's deliberate choice
    of doors and second-guessing it by status would hide the ones they asked
    for. The chip in the rail is the way back out.
  */
  const [params] = useSearchParams()
  const leadLists = useAppStore((s) => s.leadLists)
  const [filter, setFilter] = useState<MapFilter>(() => {
    const fromList = params.get('list')
    if (fromList && leadLists[fromList]) return { ...UNFILTERED_MAP, list: fromList }
    return { ...DEFAULT_MAP_FILTER, scope: hasRoute ? 'route' : 'all' }
  })
  const openList = filter.list ? leadLists[filter.list] : undefined
  const listIds = useMemo(() => new Set(openList?.leadIds ?? []), [openList])
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
  /** Whether the first pull from the server is still running. See the empty strip. */
  const refreshing = useAppStore((s) => s.refreshing)
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
    () =>
      scoped.filter((p) =>
        matchesMapFilter(p, filter, { onRoute: routeIds.has(p.id), onList: listIds.has(p.id), timezone }),
      ),
    [scoped, filter, routeIds, listIds, timezone],
  )

  /*
    A list opened from its page is framed, once.

    Once per list rather than on every change to what is shown: the rep will
    pan and zoom, a house will be added, a status will change — none of those
    is a reason to snap the view back. Only a different list is. Nothing at all
    happens when the list has no houses with coordinates yet; the empty strip
    says so in words.
  */
  const fittedList = useRef<string | null>(null)
  useEffect(() => {
    if (!openList) {
      fittedList.current = null
      return
    }
    if (fittedList.current === openList.id) return
    const points = shown
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => ({ lat: p.lat, lng: p.lng }))
    if (points.length === 0) return
    fittedList.current = openList.id
    mapHandle.current?.fit(points)
  }, [openList, shown])

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

      Zero on a wide screen, because there is no sheet there: the form goes in
      the left pane, which the map was never under. Passing the sheet's fraction
      regardless told the map that 46% of itself was hidden and moved the pin
      away from the spot that had just been clicked — undoing the one thing this
      call exists to protect.
    */
    mapHandle.current?.reveal(at, isWide ? 0 : SHEET_FRACTION)
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
    if (
      !matchesMapFilter(p, filter, { onRoute: routeIds.has(p.id), onList: listIds.has(p.id), timezone })
    ) {
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
  /*
    A picked address moves the pin and the map to that door — the tapped point
    was the rep's rough answer, the pick is their exact one. Zoom 18 so the pin
    is its own dot rather than a number in a cluster.
  */
  const leadDraft = useLeadDraft({
    at: draftAt,
    onSaved,
    onPick: (p) => {
      setDraftAt(p)
      mapHandle.current?.flyTo(p.lat, p.lng, 18)
    },
  })

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
    Which kind of nothing this is, in one sentence, decided once.

    The map draws it over the imagery and the list draws it in the middle of an
    empty column, and until now they disagreed: the list said "No doors match
    this filter" whatever the cause, including when there was no filter. One
    string, two renderers.
  */
  const emptyReason =
    refreshing && scoped.length === 0
      ? 'Loading your leads…'
      : scoped.length === 0
        ? 'No leads on this device yet. The office adds them, or use + to add one here.'
        : openList && activeCount === 1
          ? `Nothing on ${openList.name} is on the map yet.`
          : activeCount === 0 && filter.scope === 'route'
            ? 'Nothing on today’s route matches.'
          : activeCount === 0
            ? 'Every lead of yours is finished — won, lost or Do Not Contact.'
            : 'No leads match these filters.'

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
        /*
          The sliders alone, with the count when there is one. The word cost
          most of the width of the one band that floats over the map, and this
          is the control a rep opens twenty times a shift: they learn its shape
          on the first day and never read it again. The accessible name and the
          tooltip still say "Filters", and say how many are on.
        */
        className="icon-sm focusable press metal metal-map flex min-h-[44px] w-11 shrink-0 items-center justify-center gap-1 rounded-pill text-ink-soft data-[on=true]:w-auto data-[on=true]:px-3"
        data-on={activeCount > 0}
        title={activeCount ? `Filters, ${activeCount} active` : 'Filters'}
      >
        <IconFilter />
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
        >
          All
        </Chip>
        {/*
          The list this map was opened from, and the way out of it. Selected
          by definition — it is only here while it is on — and one tap clears
          it, which is what the × says.
        */}
        {openList && (
          <Chip
            size="sm"
            selected
            onClick={() => setFilter((f) => ({ ...f, list: undefined }))}
          >
            <span data-testid="map-list-chip">{openList.name} ×</span>
          </Chip>
        )}
        {hasRoute && (
          <Chip
            size="sm"
            selected={filter.scope === 'route'}
            onClick={() =>
              setFilter((f) => ({ ...f, scope: f.scope === 'route' ? 'all' : 'route' }))
            }
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
      {/*
        The row steps aside while the search is being used.

        At 320px this row is [search | sync | map/list] and the search was left
        about 98px of it — six characters, and one once the clear button
        appeared. Neither the sync badge nor the view switch is something a rep
        needs while they are typing an address, so for as long as focus is
        inside this row they give it the width. Pure `focus-within`: no state to
        get out of step, and it collapses back the moment focus leaves.
      */}
      {/*
        The badge keeps its signal and loses its word.

        At 320px this row is search, sync badge and the map/list switch, and the
        search was left about 98px of it — six characters, and one once the
        clear button appeared. Something had to give. Hiding the badge outright
        was the first answer and the wrong one: this app is offline-first, and
        "is my work saved" is not a question to answer only on another screen.
        The dot and the count say it; the word "Synced" was what cost the room.

        Two earlier attempts made this worse rather than better. Expanding the
        search on focus and hiding the others sounds right and is not: the
        layout moves at the exact moment a rep is reaching for a result, and
        the panel jumps out from under their thumb — `verify:mapsearch` caught
        it as a result that could not be chosen, which is a real finger missing
        a real row. Hiding on `focus-within` was worse still: the map/list
        switch is inside this row, so tapping "List" hid the control that had
        just been tapped. A breakpoint moves nothing while anybody is using it.
      */}
      <SyncBadge plated compact onClick={() => nav('/more')} />
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
          The bottom-left stack, mirroring the map's own controls on the right.

          These were two separately positioned buttons at the same offset —
          `absolute left-3` at `bottom: 96px`, both of them — so whenever a rep
          had a GPS fix and no lead selected, which is the ordinary state of
          this screen in the field, "Nearest door" was drawn directly on top of
          "Street". Neither gate caught it because gates run without a position:
          `nearest` needs one, so in a test only ever one of the two existed.

          One stack, laid out rather than stacked by accident, and the order is
          by urgency: the nearest door is a thing to do next, the street view is
          a way of looking. Both are down here because the left edge at thumb
          height is the one region of a phone screen the map's own controls do
          not use.
        */}
        <div
          className="pointer-events-none absolute left-3 flex flex-col items-start gap-2"
          style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
        >
          {!selected && nearest && (
            <button
              onClick={() => {
                const p = properties[nearest.id]
                mapHandle.current?.flyTo(p.lat, p.lng, 18)
                setSelectedId(nearest.id)
              }}
              /*
                `metal-map`, not `metal-quiet`. The quiet face is translucent,
                and a translucent control over live map imagery is the
                dark-on-dark failure this codebase has already recorded once —
                it read as a hole in the map on a bright basemap.
              */
              className="metal metal-map press focusable pointer-events-auto flex min-h-[48px] items-center gap-2 rounded-pill px-4 text-[14px] font-semibold !text-accent-strong"
            >
              Nearest door
              <span className="nums font-medium text-ink-mute">
                {(nearest.d * 5280).toFixed(0)} ft
              </span>
            </button>
          )}
          <button
            onClick={() => nav('/street')}
            className="focusable metal metal-map press pointer-events-auto flex min-h-[44px] items-center rounded-pill px-4 text-[12.5px] font-semibold text-ink-soft"
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
          {shown.length === 0 && (
            <div
              role="status"
              data-testid="no-matches"
              className="pointer-events-auto mx-3 mt-2 flex items-center gap-2 rounded-field bg-surface px-3 py-2 text-[12.5px] text-ink-soft shadow-card"
            >
              {/*
                Two different nothings, and telling them apart is the whole
                point. "Your filters match nothing" is something the rep did and
                can undo in one tap. "You have no leads" is not their doing at
                all — it means nobody has imported or assigned any yet, and
                offering them a Clear button for it would send them looking for
                a filter they never set.

                Only the first of these existed. An empty map with no leads on
                the device said nothing whatsoever, which is indistinguishable
                from a map that has failed to draw.
              */}
              <span className="flex-1">{emptyReason}</span>
              {/*
                Only when there is something to undo. A rep whose device has no
                leads did not set a filter, and offering them one to clear sends
                them looking for a control they never touched.
              */}
              {scoped.length > 0 && (
                <button
                  onClick={() => setFilter(UNFILTERED_MAP)}
                  className="focusable min-h-[44px] shrink-0 rounded-lg px-2 font-semibold text-accent"
                >
                  Show all
                </button>
              )}
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
          {/*
            Adding wins over a selection.

            Clicking open ground while a lead is open means "add a house here",
            not "keep looking at that one" — and the pin is already on the map
            saying so. Without this the pane would answer a question the rep has
            moved on from.

            This branch did not exist. The Add-lead sheet is suppressed on wide
            screens (`adding && !isWide`) with a comment saying the left pane
            was doing the job instead, and the pane only ever had two states:
            the selected property, or the list. So clicking the map here drew a
            pin and offered nothing — no field to type an address into, no Save,
            and no Cancel, which left the pin stranded with no way to clear it.
            The claim was in a comment and never in the code.
          */}
          {adding ? (
            /*
              Laid out like the sheet on purpose: a scrolling body with the
              actions pinned under it, so Save is in the same place and never
              scrolls away. `LeadFields` deliberately does not render the button
              — the two callers disagree about where it goes, which is why.
            */
            <div data-testid="add-lead-pane" className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
                <p className="eyebrow">Add lead</p>
                <button
                  onClick={cancelDraft}
                  className="focusable min-h-tap rounded-lg px-2 text-sm font-semibold text-accent"
                >
                  Cancel
                </button>
              </div>
              <div className="scroll-pane min-h-0 flex-1 p-4">
                {/*
                  Focused, unlike the phone's. On a phone the keyboard covering
                  the map is the thing being avoided; here the map is beside the
                  form rather than behind it, so the rep can start typing.
                */}
                <LeadFields draft={leadDraft} />
              </div>
              <div className="border-t border-line-soft p-4">
                <Button
                  size="lg"
                  full
                  onClick={() => void leadDraft.save()}
                  disabled={!leadDraft.canSave}
                >
                  {leadDraft.saving ? 'Saving…' : 'Save lead'}
                </Button>
              </div>
            </div>
          ) : selected ? (
            <div className="scroll-pane p-4">
              <button
                onClick={() => setSelectedId(null)}
                className="icon-xs focusable mb-2 flex min-h-tap items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-accent"
              >
                <IconBack />
                All properties
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
            emptyNotice={emptyReason}
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
        footer={
          selected && (
            /*
              Pinned, because at this sheet's opening detent on a 320px phone
              every one of these was below the fold — a sheet whose whole
              purpose is "tap a pin, then act" was showing an address and
              nothing to press.
            */
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="lg"
                className="shrink-0"
                onClick={() => nav(`/property/${selected.id}`)}
              >
                Profile
              </Button>
              <Button size="lg" full buzz onClick={() => nav(`/property/${selected.id}?start=1`)}>
                Start visit
              </Button>
            </div>
          )
        }
      >
        {selected && (
          <PropertyPeek
            property={selected}
            position={position}
            actionsInFooter
            onOpenFull={() => nav(`/property/${selected.id}`)}
          />
        )}
      </BottomSheet>
    </div>
  )
}
