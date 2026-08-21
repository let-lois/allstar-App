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
import { distanceMiles, formatDistance, navigationUrl, walkMinutes } from '../lib/geo'
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
 */

type Line =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; path: { lat: number; lng: number }[]; meters: number; seconds: number }
  /** Named, because each of these wants a different sentence on screen. */
  | { state: 'failed'; why: 'offline' | 'no-route' | 'demo' | 'unconfigured' }

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))

export function Navigate() {
  const { id } = useParams()
  const nav = useNavigate()
  const property = useAppStore((s) => (id ? s.properties[id] : undefined))
  const position = useAppStore((s) => s.position)
  const [line, setLine] = useState<Line>({ state: 'idle' })

  const direct = useMemo(
    () => (position && property ? distanceMiles(position, property) : null),
    [position, property],
  )

  useEffect(() => {
    if (!property || !position) return
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
          apiDirections(token, position, { lat: property.lat, lng: property.lng }, 'WALK'),
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
        setLine({ state: 'ready', path, meters: leg.distanceMeters, seconds: leg.seconds })
      } catch (err) {
        if (cancelled) return
        // A 404 from the endpoint means there is genuinely no walkable path —
        // different from having no signal, and worth saying differently.
        const noRoute = err instanceof Error && /not.?found|no route/i.test(err.message)
        setLine({ state: 'failed', why: noRoute ? 'no-route' : 'offline' })
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
  const useGoogle = gmapsConfigured() && line.state !== 'failed'

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
      <TopBar title={property.address1} subtitle="Walking route" back />

      {useGoogle ? (
        <GoogleFieldMap
          {...mapProps}
          path={line.state === 'ready' ? line.path : undefined}
          onUnavailable={() => setLine({ state: 'failed', why: 'offline' })}
        />
      ) : (
        <FieldMap {...mapProps} />
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
                  ? `${formatDistance(line.meters / 1609.34)} · ${minutes(line.seconds)} min walk`
                  : direct != null
                    ? `${formatDistance(direct)} · ${walkMinutes(direct)} min`
                    : '—'}
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

            {line.state === 'failed' && (
              <p role="status" className="mt-1.5 text-[12.5px] text-ink-mute">
                {line.why === 'no-route'
                  ? 'No walking route between here and there — the straight-line distance is shown.'
                  : line.why === 'demo'
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
            className="press focusable flex min-h-tap flex-1 items-center justify-center rounded-field bg-brand-50 text-[14px] font-semibold text-brand-600 ring-1 ring-brand-200"
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
