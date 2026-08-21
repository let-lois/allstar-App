import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { GoogleFieldMap } from '../components/map/GoogleFieldMap'
import { FieldMap } from '../components/map/FieldMap'
import { useAppStore } from '../store/useAppStore'
import { gmapsConfigured, loadGmaps } from '../lib/gmaps'
import { apiDirections } from '../lib/http'
import { liveToken } from '../lib/session'
import {
  distanceMiles,
  formatDistance,
  greatCirclePath,
  navigationUrl,
  walkMinutes,
} from '../lib/geo'
import { haptic } from '../lib/haptics'

/**
 * Getting to the door.
 *
 * Replaces a Navigate button that threw the rep into another tab. That hand-off
 * had a real cost: the visit gets logged in *this* app, and a rep who leaves it
 * to see a map has to find their way back before anything is recorded.
 *
 * So the line is drawn here — the actual path along the roads, from where the rep
 * is standing to the door, with the real walking distance and time. A straight
 * line between two pins is a lie wherever a creek, a fence line or a highway
 * sits between them, and it is exactly the case where a rep needs the map most.
 *
 * **What this deliberately does not try to be.** It is not turn-by-turn
 * navigation. A web app cannot speak directions, cannot keep running in a
 * pocket, and should not pretend otherwise — so "Open in Google Maps" stays,
 * one tap away, for the times a rep is driving between neighbourhoods. This
 * screen is for the last two hundred metres, on foot, which is most of the day.
 *
 * Every degraded state is a real one and each says what it is rather than
 * showing an empty map: no location permission, no signal, no route between the
 * two points, and the demo account, which has no server to ask.
 *
 * **The map is always drawn.** The first version of this screen gated the whole
 * map on knowing where the rep was, so a browser with location denied got a
 * paragraph of text and a link that left the app — which is the exact thing this
 * screen exists to stop. Only the *line* needs the rep's position. The door's
 * coordinates are already on the device, so the map has something to show
 * regardless, and it falls back to the self-rendered one if Google cannot load.
 *
 * **And too far away still gets a line.** Asked for directly: what does someone
 * in another state or another country see? Previously the honest sentence and an
 * empty map, which is honest and useless. Now the direct path is drawn as a
 * dashed arc with a plane on it — the real great circle, sampled on the device,
 * so it costs no request and needs no route. It says *that way, and a very long
 * way* in one glance, and the dashes and the plane are what stop it reading as a
 * route somebody could drive.
 *
 * The renderer choice used to hang off `line.state`, so *any* routing failure
 * dropped the Google map — including the two that have nothing to do with the
 * map being available. That is how the far-away case ended up on a renderer
 * whose minimum zoom cannot show two continents. Only the map failing takes the
 * map away now.
 */

type Mode = 'WALK' | 'DRIVE'

type Line =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      path: { lat: number; lng: number }[]
      meters: number
      seconds: number
      mode: Mode
    }
  /**
   * Not a failure. There is no route, and the direct line *is* the answer — so
   * this is a state the screen succeeds in, drawn and labelled, rather than an
   * error with a consolation number attached.
   *
   * It used to be `failed: 'too-far'`, and modelling it that way is what made
   * everything downstream treat a rep in another country as a broken app: the
   * renderer was dropped, the reason competed with "no signal", and the screen
   * apologised for a fact about geography.
   */
  | { state: 'direct'; path: { lat: number; lng: number }[]; miles: number; why: 'too-far' | 'no-route' }
  /** Named, because each of these wants a different sentence on screen. */
  | { state: 'failed'; why: 'offline' | 'demo' | 'unconfigured' }

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))

/**
 * Beyond this, ask for a driving route instead of a walking one.
 *
 * Three miles is about an hour on foot. A rep covering more ground than that is
 * in a truck, and a walking route for a distance nobody walks is a wrong answer
 * delivered confidently.
 */
const WALK_LIMIT_MILES = 3

/**
 * Beyond this there is no route at all.
 *
 * Matches `MAX_KM` in api/src/directions.ts — 80 km — and is checked here as
 * well so a rep in another state is told the truth without spending a request to
 * find it out. The server keeps its own check; this one exists to give an honest
 * reason rather than to save the round trip.
 */
const ROUTE_LIMIT_MILES = 49

export function Navigate() {
  const { id } = useParams()
  const nav = useNavigate()
  const property = useAppStore((s) => (id ? s.properties[id] : undefined))
  const position = useAppStore((s) => s.position)
  const [line, setLine] = useState<Line>({ state: 'idle' })
  /*
    Only the map failing. Kept apart from `line` on purpose: a route we cannot
    compute and a map we cannot draw are different problems with different
    answers, and collapsing them is what took the world map away from the one
    case that needs it most.
  */
  const [mapDead, setMapDead] = useState(false)

  const direct = useMemo(
    () => (position && property ? distanceMiles(position, property) : null),
    [position, property],
  )

  useEffect(() => {
    if (!property || !position) return

    /*
      Checked before anything else because it is a fact about the world rather
      than about this deployment: a rep in another state is too far for a route
      whatever the configuration says. The server refuses this too, and its
      refusal used to arrive here as "no signal" — telling somebody their
      connection was broken when their actual problem was being four hundred
      miles away.
    */
    const miles = distanceMiles(position, property)
    if (miles > ROUTE_LIMIT_MILES) {
      /*
        Answered here and now: the line is arithmetic on the device, so there is
        nothing to wait for and nothing to ask. No request is made at this
        distance either — the Worker refuses over 80 km — so this costs a
        millisecond and no quota.
      */
      setLine({
        state: 'direct',
        path: greatCirclePath(position, { lat: property.lat, lng: property.lng }),
        miles,
        why: 'too-far',
      })
      return
    }
    const mode: Mode = miles > WALK_LIMIT_MILES ? 'DRIVE' : 'WALK'

    const token = liveToken()
    if (!gmapsConfigured()) {
      setLine({ state: 'failed', why: 'unconfigured' })
      return
    }
    if (!token) {
      // The demo account has no server to ask, and inventing a path would be
      // the one dishonest thing this screen could do.
      setLine({ state: 'failed', why: 'demo' })
      return
    }

    let cancelled = false
    setLine({ state: 'loading' })
    void (async () => {
      try {
        const [{ leg }] = await Promise.all([
          apiDirections(token, position, { lat: property.lat, lng: property.lng }, mode),
          loadGmaps(),
        ])
        if (cancelled) return
        // Decoding needs the geometry library, which `loadGmaps` brings in.
        const { encoding } = (await google.maps.importLibrary(
          'geometry',
        )) as google.maps.GeometryLibrary
        const path = encoding
          .decodePath(leg.polyline)
          .map((p) => ({ lat: p.lat(), lng: p.lng() }))
        if (cancelled) return
        setLine({
          state: 'ready',
          path,
          meters: leg.distanceMeters,
          seconds: leg.seconds,
          mode,
        })
      } catch (err) {
        if (cancelled) return
        // A 404 from the endpoint means there is genuinely no walkable path —
        // different from having no signal, and worth saying differently.
        // The server's own reasons, mapped rather than collapsed. Falling back
        // to "offline" for everything is what produced "no signal" for a
        // distance problem.
        const msg = err instanceof Error ? err.message : ''
        // Both of the server's substantive refusals mean the same thing to a
        // rep: there is no route, and the direct line is what is left. Only a
        // failure to *ask* is a failure.
        if (/too far apart/i.test(msg) || /not.?found|no route/i.test(msg)) {
          setLine({
            state: 'direct',
            path: greatCirclePath(position, { lat: property.lat, lng: property.lng }),
            miles,
            why: /too far apart/i.test(msg) ? 'too-far' : 'no-route',
          })
          return
        }
        setLine({ state: 'failed', why: 'offline' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [property, position])

  if (!property) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="Navigate" back />
        <p className="p-6 text-[15px] text-ink-mute">That lead is not on this device.</p>
      </div>
    )
  }

  const external = navigationUrl({
    lat: property.lat,
    lng: property.lng,
    label: property.address1,
  })

  /*
    Google when it is available, the self-rendered map when it is not. Same
    contract, and the fallback works with no signal — so this screen has a map in
    a dead zone too, which is where a rep most needs to see which way the door
    is.
  */
  const useGoogle = gmapsConfigured() && !mapDead

  /*
    The line, and which of the two maps draws it — either, now. The self-rendered
    map could not zoom out past a neighbourhood, which is why this case used to be
    Google-only and why the sentence had to hedge about whether there was a line
    to look at. Both renderers take the same `path` prop and both frame it, so
    the arc is there with no key, no billing account and no signal.
  */
  const flightPath = line.state === 'direct' ? line.path : undefined

  const drawn =
    line.state === 'ready'
      ? { path: line.path, pathKind: 'route' as const }
      : { path: flightPath, pathKind: 'flight' as const }

  const mapProps = {
    className: 'min-h-0 flex-1',
    properties: [property],
    position: position ?? null,
    selectedId: property.id,
    onSelect: () => {},
    disableClustering: true,
    initialCenter: { lat: property.lat, lng: property.lng },
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Named only once it is known. Claiming "Walking route" for a twenty-mile
        drive, or for a door we cannot route to at all, is the same class of
        small lie as the distance label.
      */}
      <TopBar
        title={property.address1}
        subtitle={
          line.state === 'ready'
            ? line.mode === 'DRIVE'
              ? 'Driving route'
              : 'Walking route'
            : // Named for what it is. Calling the intercontinental case "Route"
              // was the same small lie as the walking time underneath it.
              line.state === 'direct'
              ? 'Direct line'
              : 'Route'
        }
        back
      />

      {useGoogle ? (
        <GoogleFieldMap
          {...mapProps}
          {...drawn}
          onUnavailable={() => {
            setMapDead(true)
            /*
              Never over the top of an answer we already have. A map that
              cannot draw says nothing about why there is no route, and writing
              'offline' here unconditionally put "No signal" back on the screen
              for the rep in another state and the demo account — the exact
              wrong-reason bug this screen was fixed for once already. Caught by
              the gate written for it, which is the whole argument for having
              written it. `direct` is protected for the same reason: the line is
              already computed and drawn, and the map falling back to the
              self-rendered one changes nothing about it.
            */
            setLine((l) =>
              l.state === 'failed' || l.state === 'direct'
                ? l
                : { state: 'failed', why: 'offline' },
            )
          }}
        />
      ) : (
        <FieldMap {...mapProps} {...drawn} />
      )}

      <div
        className="shrink-0 bg-surface px-4 pt-3 shadow-nav"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
      >
        {position ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p className="nums text-[15px] font-bold">
                {line.state === 'ready'
                  ? `${formatDistance(line.meters / 1609.34)} · ${minutes(line.seconds)} min ${
                      line.mode === 'DRIVE' ? 'drive' : 'walk'
                    }`
                  : direct == null
                    ? '—'
                    : /*
                        A walking time, only for a distance somebody walks. This
                        used to be unconditional, so a lead opened from another
                        country read "8,397 mi · 162,533 min" — arithmetic
                        presented as a plan. Beyond the walk limit the distance
                        stands on its own; the line on the map is what says how
                        to think about it.
                      */
                      direct <= WALK_LIMIT_MILES
                      ? `${formatDistance(direct)} · ${walkMinutes(direct)} min`
                      : formatDistance(direct)}
              </p>
              {/*
                Which number a rep is looking at, said plainly. A road distance
                and a straight-line distance can differ by a factor of three, and
                a rep planning around the wrong one walks into a fence.
              */}
              <p className="text-[12px] text-ink-mute">
                {line.state === 'ready'
                  ? 'along the roads'
                  : line.state === 'loading'
                    ? 'finding the route…'
                    : 'direct distance'}
              </p>
            </div>

            {/*
              A statement, not an apology. Nothing is broken when a rep opens a
              lead from another state — there is simply no route to draw, and the
              dashed line is the answer rather than a substitute for one. The
              screen can promise the line unconditionally now, because both
              renderers draw it.
            */}
            {line.state === 'direct' && (
              <p role="status" className="mt-1.5 text-[12.5px] text-ink-mute">
                {line.why === 'too-far'
                  ? 'This door is too far away to route to — the dashed line is the direct distance, not a way to get there.'
                  : 'No road route between here and there — the dashed line is the direct distance.'}
              </p>
            )}

            {line.state === 'failed' && (
              <p role="status" className="mt-1.5 text-[12.5px] text-ink-mute">
                {line.why === 'demo'
                  ? 'Walking routes need a live account; the demo shows the straight-line distance.'
                  : line.why === 'unconfigured'
                    ? 'Walking routes are not configured on this deployment.'
                    : 'No signal for the route — showing the straight-line distance.'}
              </p>
            )}
          </>
        ) : (
          /*
            One line, under a map that is drawn anyway. Both fixes named, and the
            first needs no permission from us — because "enable location" alone
            leaves a rep who has already denied it with nowhere to go.
          */
          <p role="status" className="text-[12.5px] text-ink-soft">
            <span className="font-semibold text-ink">Showing the door, not the walk.</span>{' '}
            A route needs your location — turn it on for this site with the padlock next to the
            address, or use Google Maps, which asks for its own.
          </p>
        )}

        <div className="mt-3 flex gap-2">
          <a
            href={external}
            target="_blank"
            rel="noreferrer"
            onClick={() => haptic('tap')}
            className="metal metal-quiet press focusable flex min-h-tap flex-1 items-center justify-center rounded-field text-[14px] font-semibold !text-brand-700"
          >
            Google Maps
          </a>
          <Button className="flex-1" onClick={() => nav(`/property/${property.id}?start=1`)}>
            Start visit
          </Button>
        </div>
      </div>
    </div>
  )
}
