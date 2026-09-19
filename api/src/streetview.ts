/**
 * A photo of the house, fetched by the server so the key never ships.
 *
 * Street View was a browser call: the web bundle carried
 * `VITE_GOOGLE_MAPS_KEY` and Google refused anybody else's page by HTTP
 * referrer. That works on the web and cannot work in the native app, which is
 * why the phone showed a blank frame on every lead.
 *
 * The shell's page is `file://`. It sends no referrer, so a referrer
 * restriction can never match it; and Google's Android/iOS key restrictions
 * authenticate a request from their *native SDKs* by app signature, which a
 * `fetch()` from inside a webview has no way to present. So a key in the app
 * is either unrestricted — sitting in a downloadable APK, billable by anyone
 * who unzips it — or rejected. There is no third setting.
 *
 * Moving the call here removes the choice. The key is read server-side from the
 * company's own encrypted record, exactly as `/api/geocode/reverse` already
 * does, and the app sends coordinates and receives pixels. It also takes the
 * key out of the *web* bundle, which was a weaker version of the same exposure.
 *
 * ## Two requests, and only one of them is billed
 *
 * The metadata endpoint reports coverage and is free. The image endpoint is
 * billed per request and answers "no coverage" with a picture of grey rather
 * than an error — so asking it first would mean paying for every uncovered
 * address and then rendering the grey. Metadata first is what makes an
 * uncovered lead cost nothing.
 */

const META_ENDPOINT = 'https://maps.googleapis.com/maps/api/streetview/metadata'
const IMAGE_ENDPOINT = 'https://maps.googleapis.com/maps/api/streetview'

/**
 * Overridable for the gate, for the same reason as `useGoogleBase`: the cases
 * worth driving end to end are the refusals, and only a real response from a
 * real endpoint exercises them. A Worker variable, settable by whoever deploys,
 * pointing at Google whenever it is unset.
 */
let base: { meta: string; image: string } = { meta: META_ENDPOINT, image: IMAGE_ENDPOINT }
export function useStreetViewBase(url: string | undefined): void {
  base = url
    ? { meta: `${url.replace(/\/$/, '')}/metadata`, image: url.replace(/\/$/, '') }
    : { meta: META_ENDPOINT, image: IMAGE_ENDPOINT }
}

/**
 * What the rep's phone is shown, at 2× for a retina screen.
 *
 * Bounded here rather than taken from the caller: size is a billing dimension
 * on some Google SKUs and an unbounded one would let any signed-in client ask
 * for something enormous on the company's key. The field of view is the same
 * 80° the component asked for when it made this call itself — wide enough to
 * show the house and its neighbours, narrow enough to recognise a door.
 */
const W = 640
const H = 300
const FOV = 80

export type StreetViewResult =
  /** There is imagery, and here it is. */
  | { kind: 'image'; bytes: ArrayBuffer; contentType: string }
  /** Google has been down this street and has nothing for this point. */
  | { kind: 'none' }
  /** Nobody has given this company a key that can answer. */
  | { kind: 'unconfigured' }
  /** We asked and could not get an answer — never cached by the client. */
  | { kind: 'error'; detail: string }

/**
 * @param key the company's Google key, already decrypted by the caller
 */
export async function streetViewAt(
  key: string | undefined,
  lat: number,
  lng: number,
): Promise<StreetViewResult> {
  if (!key) return { kind: 'unconfigured' }

  const point = `${lat},${lng}`
  let meta: Response
  try {
    meta = await fetch(
      `${base.meta}?location=${encodeURIComponent(point)}&source=outdoor&key=${encodeURIComponent(key)}`,
    )
  } catch (err) {
    return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!meta.ok) return { kind: 'error', detail: `metadata ${meta.status}` }

  const body = (await meta.json().catch(() => ({}))) as { status?: string }
  /*
    `ZERO_RESULTS` is an answer, not a failure — the client may cache it and
    stop asking. Everything else that is not OK is a problem with the key, the
    quota or the enabled APIs, and must be distinguishable: a rep in a dead
    zone must not have "no photo" cached for the rest of their day.
  */
  if (body.status === 'ZERO_RESULTS') return { kind: 'none' }
  if (body.status !== 'OK') return { kind: 'error', detail: `metadata says ${body.status}` }

  let img: Response
  try {
    img = await fetch(
      `${base.image}?size=${W}x${H}&location=${encodeURIComponent(point)}` +
        `&fov=${FOV}&source=outdoor&key=${encodeURIComponent(key)}`,
    )
  } catch (err) {
    return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!img.ok) return { kind: 'error', detail: `image ${img.status}` }

  return {
    kind: 'image',
    bytes: await img.arrayBuffer(),
    contentType: img.headers.get('content-type') ?? 'image/jpeg',
  }
}
