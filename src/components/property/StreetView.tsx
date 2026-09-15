import { useEffect, useState } from 'react'
import { Glyph } from '../ui/Glyph'

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
 * **The trap this file exists to avoid.** Asked for a location it has no imagery
 * for, the Street View Static API does not fail — it returns a grey placeholder
 * image, with status 200, reading "Sorry, we have no imagery here". Rendered
 * blindly, a rural lead shows a picture of nothing and looks like a bug. So the
 * free metadata endpoint is asked first, and the image is only requested when
 * there is genuinely something to see. That also means a location with no
 * coverage costs no image request at all.
 *
 * With no signal there is no photo and no message. Everything else on this
 * screen works offline, and a warning banner about a missing nice-to-have would
 * be noise on the screen a rep uses at every door.
 */

const KEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined)?.trim() || ''

/**
 * Requested pixel size. Wider than tall because houses are, and small enough
 * that it is not the heaviest thing on a lead detail screen over cell data.
 */
const W = 640
const H = 320
/**
 * Slightly tighter than the 90-degree default, so the house fills more of the
 * frame than its neighbours do.
 */
const FOV = 80

type State = 'checking' | 'ready' | 'none'

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
  const [state, setState] = useState<State>(KEY ? 'checking' : 'none')

  useEffect(() => {
    if (!KEY) return
    let cancelled = false
    setState('checking')

    /*
      Metadata is free and documented to report coverage, which is the only
      honest way to know: the image endpoint answers "no coverage" with a picture
      rather than an error. `source=outdoor` keeps this to street-level panoramas
      instead of the inside of someone's shop.
    */
    const url =
      'https://maps.googleapis.com/maps/api/streetview/metadata' +
      `?location=${lat},${lng}&source=outdoor&key=${encodeURIComponent(KEY)}`

    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { status?: string }) => {
        if (cancelled) return
        setState(body.status === 'OK' ? 'ready' : 'none')
      })
      .catch(() => {
        // Offline, quota, rejected key — all the same here, and all of them mean
        // "no photo this time" rather than anything a rep can act on.
        if (!cancelled) setState('none')
      })

    return () => {
      cancelled = true
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
          <p className="mt-2 text-[12.5px] text-ink-mute">
            {state === 'checking' ? 'Looking for a photo of this house…' : 'No photo of this house yet'}
          </p>
        </div>
      </div>
    )
  }

  const img =
    'https://maps.googleapis.com/maps/api/streetview' +
    `?size=${W}x${H}&location=${lat},${lng}&fov=${FOV}&source=outdoor` +
    `&key=${encodeURIComponent(KEY)}`

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
        src={img}
        alt={`Street view of ${address}`}
        width={W}
        height={H}
        loading="lazy"
        // Height is capped rather than fixed: on a 320px screen a 2:1 crop is
        // tall enough to recognise a house and short enough to leave the status
        // and the contact above the fold.
        className="block h-auto max-h-[176px] w-full object-cover"
        // Coverage was confirmed, so a failure here is the network. Removing the
        // frame is better than leaving an empty bordered box.
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
