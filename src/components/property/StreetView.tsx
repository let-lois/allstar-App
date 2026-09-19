import { useEffect, useState } from 'react'
import { Glyph } from '../ui/Glyph'
import { apiStreetView } from '../../lib/http'
import { liveToken } from '../../lib/session'

/**
 * A photo of the house, on the lead detail screen.
 *
 * This answers a porch question that no amount of address text does: *is this
 * the right house?* A rep walking a numbered street with missing kerb numbers,
 * or a shared driveway, or a flag lot behind another property, currently has an
 * address and a pin and no way to recognise the door from twenty feet away.
 *
 * A still image rather than the interactive panorama, deliberately. The
 * panorama is a WebGL canvas that has to load and initialise, on a screen a rep
 * opens dozens of times a day, to answer a question a single photo answers
 * instantly. Tapping the photo hands off to Google Maps for a proper look
 * around, which costs nothing and is better than the embedded version anyway.
 *
 * **The trap this avoids.** Asked for a location it has no imagery for, the
 * Street View Static API does not fail — it returns a grey placeholder image,
 * with status 200, reading "Sorry, we have no imagery here". Rendered blindly,
 * a rural lead shows a picture of nothing and looks like a bug. So the free
 * metadata endpoint is asked first and the image only when there is genuinely
 * something to see, which also means an uncovered location costs nothing. That
 * ordering now lives in `api/src/streetview.ts`, which is where the request is
 * made.
 *
 * **Why the server makes it.** This used to call Google from the browser with
 * a key compiled into the bundle and restricted by HTTP referrer. That works
 * on the web and cannot work in the native app, which is why the phone showed
 * a blank frame on every lead: the shell's page is `file://` and sends no
 * referrer, so the restriction can never match — and Google's Android and iOS
 * key restrictions authenticate their own SDKs by app signature, which a
 * `fetch()` from inside a webview has no way to present. An in-app key is
 * either unrestricted, sitting in a downloadable APK for anyone to bill, or
 * refused. So the call goes to our Worker, which holds the company's key
 * encrypted, and the app deals in coordinates and pixels. The web bundle
 * stopped carrying a key as a side effect, which is the same exposure in a
 * milder form.
 *
 * With no signal there is no photo and no message. Everything else on this
 * screen works offline, and a warning banner about a missing nice-to-have would
 * be noise on the screen a rep uses at every door.
 */

/**
 * Requested pixel size. Wider than tall because houses are, and small enough
 * that it is not the heaviest thing on a lead detail screen over cell data.
 *
 * Decided by the server now — see `api/src/streetview.ts`, where it is bounded
 * so a signed-in client cannot ask for something enormous on the company's
 * key. These are kept only as the `<img>` element's intrinsic size, which is
 * what stops the layout jumping while the bytes arrive.
 */
const W = 640
const H = 300

/**
 * What the frame is showing.
 *
 * `unconfigured` is the state this component used to be unable to express, and
 * getting it wrong was expensive: with no key it said "No photo of this house
 * yet", so every rep on a phone was told their whole territory had no Street
 * View coverage. One is a fact about a street; the other is a setting nobody
 * has turned on. They are not the same sentence and they are not fixed by the
 * same person.
 */
type State = 'checking' | 'ready' | 'none' | 'unconfigured'

/**
 * The original browser call, kept for the demo alone.
 *
 * Metadata first, for the reason in the header: the image endpoint answers "no
 * coverage" with a grey picture and a 200, so asking it blind both costs a
 * request and renders nothing. Returns its own cleanup, so the caller's effect
 * can cancel it like any other.
 */
const DEMO_KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string | undefined)?.trim() || ''
const DEMO_FOV = 80

function demoLookup(
  lat: number,
  lng: number,
  setState: (s: State) => void,
  setSrc: (s: string | null) => void,
): (() => void) | undefined {
  if (!DEMO_KEY) {
    setState('none')
    return
  }
  let cancelled = false
  setState('checking')

  fetch(
    'https://maps.googleapis.com/maps/api/streetview/metadata' +
      `?location=${lat},${lng}&source=outdoor&key=${encodeURIComponent(DEMO_KEY)}`,
  )
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: { status?: string }) => {
      if (cancelled) return
      if (body.status !== 'OK') {
        setState('none')
        return
      }
      setSrc(
        'https://maps.googleapis.com/maps/api/streetview' +
          `?size=${W}x${H}&location=${lat},${lng}&fov=${DEMO_FOV}&source=outdoor` +
          `&key=${encodeURIComponent(DEMO_KEY)}`,
      )
      setState('ready')
    })
    .catch(() => {
      // Offline, quota, rejected key — all "no photo this time" here.
      if (!cancelled) setState('none')
    })

  return () => {
    cancelled = true
  }
}

export function StreetView({
  lat,
  lng,
  address,
  placeholder = false,
  className = '',
}: {
  lat: number
  lng: number
  address: string
  /**
   * Show something when there is no photo, instead of nothing.

   * Off on the profile, where the screen is complete without a picture and an
   * apology would only take the room. On the map's sheet the picture is what
   * lets a rep recognise the house they tapped, so its absence is worth a
   * frame that says so — and a frame is what stops the address from jumping
   * up the sheet when a photo arrives a second later.
   */
  placeholder?: boolean
  className?: string
}) {
  const [state, setState] = useState<State>('checking')
  const [src, setSrc] = useState<string | null>(null)

  /*
    Through our own server, not to Google.

    The key cannot live in the app: the shell's page is `file://`, which sends
    no referrer, so Google's referrer restriction can never match it — and the
    Android/iOS restrictions authenticate their native SDKs by app signature,
    which a `fetch()` from a webview cannot present. An in-app key is therefore
    either unrestricted, sitting in a downloadable APK, or refused. So the call
    moved to the Worker, which reads the company's own encrypted key exactly as
    reverse geocoding does. That took the key out of the web bundle too.
  */
  useEffect(() => {
    const token = liveToken()
    /*
      The demo has no company, so there is no stored key for the server to use
      — and the demo is the one place the old browser call still works and is
      still worth having. It runs on the web, from the real origin, where a
      referrer-restricted key is exactly what Google wants; and it is what lets
      a photo of a house appear in a sales demo rather than a grey frame.

      Signed-in traffic never comes down here, on the web or on a phone. So the
      only key left in a bundle is a referrer-restricted one that a browser
      demo uses, which is the arrangement that already existed — nothing new is
      exposed, and the native app, which cannot secure a key at all, has none.
    */
    if (!token) return demoLookup(lat, lng, setState, setSrc)

    let cancelled = false
    let created: string | null = null
    setState('checking')
    setSrc(null)

    void apiStreetView(token, lat, lng).then((shot) => {
      if (cancelled) {
        // Arrived after the lead changed. The bytes still allocated an object
        // URL, and nothing else will ever free it.
        if (shot.kind === 'image') URL.revokeObjectURL(shot.url)
        return
      }
      if (shot.kind === 'image') {
        created = shot.url
        setSrc(shot.url)
        setState('ready')
      } else if (shot.kind === 'unconfigured') {
        setState('unconfigured')
      } else {
        /*
          `none` and `error` both land here, and that is deliberate on this
          screen: neither produces a photo, and a rep at a door does not need
          to know which. The distinction is kept on the wire so the server can
          log a revoked key — see the 502 branch in the route — rather than
          having it look like a street with no coverage.
        */
        setState('none')
      }
    })

    return () => {
      cancelled = true
      // An object URL pins its blob in memory until it is revoked, and a rep
      // opens dozens of these an hour.
      if (created) URL.revokeObjectURL(created)
    }
  }, [lat, lng])

  if (state !== 'ready') {
    if (!placeholder) return null
    return (
      <div
        data-testid="property-image"
        data-state={state}
        className={`grid min-h-[150px] place-items-center overflow-hidden rounded-card bg-surface-sunk px-4 text-center ${className}`}
        aria-hidden={state === 'checking'}
      >
        <div>
          <Glyph name="house" className="icon-lg mx-auto text-ink-faint" />
          {/*
            Three different sentences, because they are three different facts
            and only one of them is about the house.

            Without a key this said "No photo of this house yet", which reads as
            "Google has not been down this street". In the native app that was
            wrong on every lead at once, because the app had no key it could
            use — so every rep on a phone was told their whole territory had no
            imagery, and nothing on screen suggested otherwise.

            Naming it as a setting rather than a gap is what makes it
            actionable: it is a thing the office can turn on, in Settings →
            Address lookup, not a thing about the address. The server decides
            which of the two it is; see the 501 branch of `/api/streetview`.
          */}
          <p className="mt-2 text-[12.5px] text-ink-mute">
            {state === 'unconfigured'
              ? 'Street View isn’t switched on for this app'
              : state === 'checking'
                ? 'Looking for a photo of this house…'
                : 'No photo of this house yet'}
          </p>
        </div>
      </div>
    )
  }

  // Google's own deep link, which opens the app if it is installed. Not an API
  // call and not billed.
  const pano = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`

  return (
    <a
      href={pano}
      target="_blank"
      rel="noreferrer"
      className={`focusable block overflow-hidden rounded-card ring-1 ring-line ${className || 'mt-3.5'}`}
      data-testid="property-image"
      data-state="ready"
      aria-label={`Street view of ${address} — opens in Google Maps`}
    >
      <img
        src={src ?? ''}
        alt={`Street view of ${address}`}
        width={W}
        height={H}
        loading="lazy"
        // Height is capped rather than fixed: on a 320px screen a 2:1 crop is
        // tall enough to recognise a house and short enough to leave the status
        // and the contact above the fold.
        className="block h-auto max-h-[176px] w-full object-cover"
        /*
          Bytes we already hold, so this can only fire on something we produced
          — a truncated body, or a content type the decoder will not take.
          Dropping the frame is better than an empty bordered box, and the
          object URL is revoked by the effect's cleanup either way.
        */
        onError={() => setState('none')}
      />
    </a>
  )
}

/**
 * The picture of a house on the map's sheet: the photo when there is one, a
 * frame that says so when there is not. The same component the profile uses,
 * with the placeholder on — one implementation of "what does this house look
 * like", not one per screen.
 */
export function PropertyImage(props: { lat: number; lng: number; address: string; className?: string }) {
  return <StreetView {...props} placeholder />
}
