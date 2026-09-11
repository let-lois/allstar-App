import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { IconCheck, IconClose, IconWarn } from '../components/nav/icons'
import { GmapsError, gmapId, gmapsConfigured, loadGmaps, placesConfigured } from '../lib/gmaps'

/**
 * Is Google actually working on this deployment?
 *
 * This panel exists because of a specific failure that has now confused this
 * project twice. Google is four separate switches in the Cloud console — Maps
 * JavaScript, Places, Geocoding, and a Map ID — and the app degrades
 * *gracefully* when any of them is off. Graceful degradation is the right
 * behaviour for a rep standing in a driveway, and it is the reason nobody finds
 * out: address suggestions simply never appear, the address under a tapped pin
 * simply never fills in, and the map silently keeps our own renderer. There is
 * no error, because from the app's point of view nothing went wrong.
 *
 * `reverseGeocode` does say so — once per session, to the browser console, on
 * the phone of a rep who cannot fix it and will never open a console. So the
 * answer is to put it where the person who holds the Cloud console can see it,
 * and nowhere else: this is admin-only, on the tab that already deals with who
 * turns addresses into pins.
 *
 * ## Why one of these checks is a button
 *
 * Three of the four are free: what got compiled into the bundle is a variable,
 * loading the Maps script is not billed, and asking for a library is not
 * billed. They run on their own when the tab opens.
 *
 * A geocode is billed per request. If it ran automatically, opening this screen
 * would cost money, and a screen that quietly bills its own viewer is exactly
 * the shape of cost this codebase spends comments arguing against. So it is one
 * button, one request, on a landmark rather than a customer's address.
 */

type State = 'checking' | 'ok' | 'warn' | 'bad' | 'idle'

interface Check {
  label: string
  state: State
  detail: string
  /** What a rep loses while this is failing. Empty when it is fine. */
  cost?: string
}

const TONE: Record<State, string> = {
  checking: 'text-ink-mute',
  idle: 'text-ink-mute',
  ok: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
}

function Mark({ state }: { state: State }) {
  if (state === 'ok') return <IconCheck />
  if (state === 'bad') return <IconClose />
  if (state === 'warn') return <IconWarn />
  // Checking and idle both mean "no answer yet", and a spinner for a check that
  // resolves in a few milliseconds is more motion than information.
  return <span className="block h-1.5 w-1.5 rounded-full bg-ink-mute" />
}

function Row({ check }: { check: Check }) {
  return (
    <li className="flex gap-3 border-t border-line py-3 first:border-t-0">
      <span className={`mt-0.5 shrink-0 icon-sm ${TONE[check.state]}`} aria-hidden>
        <Mark state={check.state} />
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-ink">{check.label}</p>
        <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-mute">{check.detail}</p>
        {check.cost && (
          <p className="mt-1 text-[13.5px] leading-relaxed text-warn">{check.cost}</p>
        )}
      </div>
    </li>
  )
}

/** A public landmark. Nothing about a customer is sent to see whether the API answers. */
const PROBE = { lat: 38.8977, lng: -77.0365 }

export function GoogleStatusPanel() {
  const [load, setLoad] = useState<Check>({
    label: 'Maps JavaScript accepts this key',
    state: 'checking',
    detail: 'Loading the API…',
  })
  const [places, setPlaces] = useState<Check>({
    label: 'Places is enabled',
    state: 'checking',
    detail: 'Waiting for the API…',
  })
  const [geo, setGeo] = useState<Check>({
    label: 'Geocoding is enabled',
    state: 'idle',
    detail: 'Not checked. A geocode is billed per request, so this one is on request.',
  })
  const [probing, setProbing] = useState(false)

  useEffect(() => {
    let live = true
    if (!placesConfigured()) {
      setLoad({
        label: 'Maps JavaScript accepts this key',
        state: 'bad',
        detail: 'No key is compiled into this build, so the API was not loaded.',
      })
      setPlaces({ label: 'Places is enabled', state: 'bad', detail: 'Needs the key first.' })
      return
    }
    void (async () => {
      try {
        await loadGmaps()
        if (!live) return
        setLoad({
          label: 'Maps JavaScript accepts this key',
          state: 'ok',
          detail: 'The API loaded and the key was not rejected for this site.',
        })
      } catch (err) {
        if (!live) return
        const reason = err instanceof GmapsError ? err.reason : 'unreachable'
        setLoad({
          label: 'Maps JavaScript accepts this key',
          state: 'bad',
          detail: err instanceof Error ? err.message : 'The API did not load.',
          cost:
            reason === 'rejected'
              ? 'Reps see our own map instead of Google’s, and no address suggestions.'
              : 'Reps see our own map. If they are online, check the key’s website restrictions.',
        })
        setPlaces({
          label: 'Places is enabled',
          state: 'bad',
          detail: 'The API never loaded, so this could not be checked.',
        })
        return
      }
      /*
        Asking for the library is free — what costs is a request made with a
        session token, and none is made here. `AutocompleteSuggestion` is the
        class the address field actually uses; its absence is what a key
        without Places (New) looks like from in here.
      */
      try {
        const lib = (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary
        if (!live) return
        const ready = typeof lib?.AutocompleteSuggestion !== 'undefined'
        setPlaces({
          label: 'Places is enabled',
          state: ready ? 'ok' : 'bad',
          detail: ready
            ? 'Address suggestions are available while a rep types.'
            : 'The Places library loaded without the suggestion API. Enable Places API (New) on this key.',
          cost: ready ? undefined : 'Reps type the whole address by hand.',
        })
      } catch (err) {
        if (!live) return
        setPlaces({
          label: 'Places is enabled',
          state: 'bad',
          detail: `Places would not load. (${String(err).slice(0, 120)})`,
          cost: 'Reps type the whole address by hand.',
        })
      }
    })()
    return () => {
      live = false
    }
  }, [])

  async function probeGeocoder() {
    setProbing(true)
    setGeo({ label: 'Geocoding is enabled', state: 'checking', detail: 'Asking Google once…' })
    try {
      await loadGmaps()
      const { Geocoder } = (await google.maps.importLibrary(
        'geocoding',
      )) as google.maps.GeocodingLibrary
      const { results } = await new Geocoder().geocode({ location: PROBE })
      setGeo({
        label: 'Geocoding is enabled',
        state: results[0] ? 'ok' : 'warn',
        detail: results[0]
          ? 'Tapping a house on the map fills in its address.'
          : 'Google answered but had no address for the test point. The API is enabled.',
      })
    } catch (err) {
      /*
        REQUEST_DENIED is the one worth naming. It is what a key with Maps
        JavaScript on and Geocoding off returns, and it is indistinguishable on
        a phone from "this house has no address".
      */
      const text = String(err)
      setGeo({
        label: 'Geocoding is enabled',
        state: 'bad',
        detail: /REQUEST_DENIED/.test(text)
          ? 'Google refused the request. Enable the Geocoding API on this key — it is a separate switch from Maps JavaScript.'
          : `Google refused the request. (${text.slice(0, 140)})`,
        cost: 'Tapping a house on the map leaves the address blank, with no error shown to the rep.',
      })
    } finally {
      setProbing(false)
    }
  }

  const key: Check = {
    label: 'A browser key is compiled in',
    state: placesConfigured() ? 'ok' : 'bad',
    detail: placesConfigured()
      ? 'VITE_GOOGLE_MAPS_KEY was set when this build was made.'
      : 'VITE_GOOGLE_MAPS_KEY was empty at build time. Set it and redeploy — it is baked into the bundle, not read at runtime.',
    cost: placesConfigured()
      ? undefined
      : 'No Google map, no address suggestions, no address under a tapped pin.',
  }

  const mapId: Check = {
    label: 'A Map ID is compiled in',
    state: gmapId() ? 'ok' : 'warn',
    detail: gmapId()
      ? 'Advanced markers can render, so the map is Google’s.'
      : 'VITE_GOOGLE_MAP_ID was empty at build time. Advanced markers need one.',
    cost: gmapId() ? undefined : 'Reps see our own map renderer instead of Google’s.',
  }

  return (
    <section className="flex flex-col gap-4 p-4" data-testid="google-status">
      <div>
        <h3 className="text-[17px] font-semibold text-ink">Google Maps on this build</h3>
        <p className="mt-1 text-[15px] leading-relaxed text-ink-mute">
          Google is four separate switches, and the app keeps working with any of them
          off — which is why nobody notices. This says which are on. Only you can see
          it; a rep is never shown a problem they cannot act on.
        </p>
      </div>

      <ul className="rounded-card border border-line px-4">
        <Row check={key} />
        <Row check={mapId} />
        <Row check={load} />
        <Row check={places} />
        <Row check={geo} />
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={probeGeocoder}
          disabled={probing || !placesConfigured()}
          data-testid="probe-geocoder"
        >
          {probing ? 'Checking…' : 'Check geocoding'}
        </Button>
        <p className="text-[13px] text-ink-mute">One billed request against a public landmark.</p>
      </div>

      {!gmapsConfigured() && (
        <p className="rounded-card bg-warn-bg px-4 py-3 text-[13.5px] leading-relaxed text-warn">
          These values are read at build time, so changing them in Cloudflare Pages takes
          effect on the next deploy, not on a refresh.
        </p>
      )}
    </section>
  )
}
