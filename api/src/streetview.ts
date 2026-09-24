import { bearing, distanceMeters, type LatLng } from './geo'

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
 *
 * ## The house is not the camera
 *
 * This file used to send the tapped coordinate to both endpoints and nothing
 * else, and that was two bugs wearing one coat.
 *
 * **No radius.** Street View's default search radius is 50 metres from the
 * point asked about. A lead's coordinate is the *building* — a rooftop from
 * Google, the middle of a block from Census — and the camera was on the road.
 * Any house set back behind a long drive, any corner plot indexed to its far
 * side, any interpolated coordinate that landed mid-parcel: 50 metres was not
 * enough, Google answered `ZERO_RESULTS`, and the screen said "no photo of this
 * house" about a street that is photographed end to end.
 *
 * **A radius on the free call only would have made that worse, not better.**
 * The two endpoints search independently. Widening the metadata radius to 125 m
 * while still handing the image endpoint the property's coordinate means
 * metadata answers `OK` about a camera 90 m away and the image endpoint, still
 * on its own 50 m default, finds nothing — and answers that with the grey
 * "Sorry, we have no imagery here" placeholder at HTTP 200. Billed, rendered,
 * and indistinguishable from a photo to everything upstream of a human eye.
 * That is the trap this file's header has warned about since it was written,
 * reached from a new direction.
 *
 * So the image is addressed by the `pano_id` the metadata call returned. No
 * second search, and no way for the two to disagree about which camera.
 *
 * **Which is what makes `heading` newly mandatory.** Given a `location`, Street
 * View computes a heading itself — "a value that directs the camera towards the
 * specified location, from the point at which the closest photograph was taken"
 * — so the old code, for all its faults, was pointed at the house whenever it
 * got a picture at all. Given a `pano`, there is no location to aim at and that
 * default becomes the panorama's own: the direction the car was facing. Fixing
 * the search without also computing the heading would have traded uncovered
 * houses for well-covered pictures of the road.
 *
 * All of it comes from keeping the two coordinates apart and never confusing
 * them:
 *
 *   **property** — the lead. What the rep tapped. What the camera points *at*.
 *   **panorama** — where Google's car was standing. What the camera points
 *                  *from*, returned by the metadata call and used verbatim for
 *                  the image.
 *
 * The heading is the bearing from the second to the first, which is the
 * definition of "point it at the house".
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
 * How far from the house to look for a camera.
 *
 * 125 metres, and the number is a compromise between two real failures rather
 * than a round guess.
 *
 * Too small is where this started: Google's own default is 50 m, measured from
 * the coordinate we hold for the building. A house forty metres up its own
 * drive on a road the car photographed is already outside that, and so is a
 * Census-interpolated coordinate, which is placed along the block rather than
 * on the parcel and is routinely 60–100 m from the kerb outside the actual
 * door. Every one of those read to a rep as "Google has never been down this
 * street".
 *
 * Too large is worse in a quieter way. At 400 m an urban lookup will happily
 * return a camera two streets over with a clear bearing to the target, and the
 * rep gets a confident, well-aimed photograph of the back of a building they
 * are not standing at — which is more dangerous than no photo, because it looks
 * like an answer.
 *
 * 125 m covers a deep suburban lot, a service road, and a block-interpolated
 * point, and is still inside one city block almost everywhere. Where the
 * nearest camera is genuinely further than this, `NO_COVERAGE` is the honest
 * answer.
 */
export const SEARCH_RADIUS_M = 125

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

/**
 * Below this the panorama and the house are the same place, and the bearing
 * between them is noise.
 *
 * Two metres. A camera that close is inside the plot; asking it to face a
 * bearing computed from a two-metre baseline points it at whatever rounding
 * error the two coordinates happen to carry. Google's own default heading for
 * the panorama is a better answer than a number we made up, so in that case no
 * heading is sent at all.
 */
const MIN_HEADING_BASELINE_M = 2

/**
 * Why there is no photo — one code per thing a person would do about it.
 *
 * The distinction this type exists for: `NO_COVERAGE` is a fact about a street
 * and nobody can fix it, while every other failure here is a fact about an
 * account and somebody can fix it this afternoon. Collapsing them is what had
 * the app telling a rep their whole territory was unphotographed when the real
 * answer was that the Street View Static API had never been switched on.
 */
export type StreetViewCode =
  /** There is imagery, and here it is. */
  | 'AVAILABLE'
  /** Google has been down this street and has nothing within the radius. */
  | 'NO_COVERAGE'
  /** Nobody has given this company a key at all. */
  | 'NOT_CONFIGURED'
  /** The key exists and Google refused it — wrong key, or restricted away. */
  | 'API_KEY_ERROR'
  /** The key is fine; Street View Static is not enabled on the project. */
  | 'API_NOT_ENABLED'
  /** The project has no active billing account. */
  | 'BILLING_ERROR'
  /** Over the daily cap or the per-second rate. */
  | 'QUOTA_ERROR'
  /** We could not reach Google at all. */
  | 'NETWORK_ERROR'
  /** Google answered, and the answer was not one we can use. */
  | 'UPSTREAM_ERROR'

export type StreetViewFailure = Exclude<
  StreetViewCode,
  'AVAILABLE' | 'NO_COVERAGE' | 'NOT_CONFIGURED'
>

export type StreetViewResult =
  | {
      kind: 'image'
      code: 'AVAILABLE'
      bytes: ArrayBuffer
      contentType: string
      /** Where the camera stood. Never the same field as the lead's own point. */
      pano: LatLng
      /** 0–360, pointing from the camera at the house. Absent when they coincide. */
      heading: number | null
      /** How far the camera was from the house, for the log and for a gate. */
      metres: number
    }
  | { kind: 'none'; code: 'NO_COVERAGE' }
  | { kind: 'unconfigured'; code: 'NOT_CONFIGURED' }
  /**
   * `detail` is for the Worker's log and nothing else. It is never put on the
   * wire: it can carry Google's own prose about the project, and a field a
   * client never reads cannot leak.
   */
  | { kind: 'error'; code: StreetViewFailure; detail: string }

/**
 * Which failure Google just described.
 *
 * Exported and pure because it is the part of this file worth testing
 * exhaustively: the status strings are a closed set, the `error_message`
 * prose is the only thing separating three of them, and getting the split
 * wrong sends whoever is on support to the wrong console page.
 *
 * Matched on `error_message` deliberately, and only for the three that share a
 * status. Google documents the statuses and not the prose, so this is
 * best-effort by construction — which is why the fall-through for each status
 * is the *safe* one to be wrong about. `REQUEST_DENIED` with unrecognised prose
 * lands on `API_KEY_ERROR`, because "check the key" is the first thing anyone
 * does for a denial anyway.
 */
export function classifyMetadata(
  status: string | undefined,
  errorMessage?: string | undefined,
): StreetViewCode {
  const why = (errorMessage ?? '').toLowerCase()
  const billing = /billing|payment|not authorized to use this api.*billing/.test(why)
  switch (status) {
    case 'OK':
      return 'AVAILABLE'
    /*
      Both mean "no panorama for what you asked". `NOT_FOUND` is documented for
      an address or a pano id that does not resolve; for a lat/lng within a
      radius it is the same answer as `ZERO_RESULTS` and must not be an error,
      or one uncoverable rural lead reads as a broken account.
    */
    case 'ZERO_RESULTS':
    case 'NOT_FOUND':
      return 'NO_COVERAGE'
    case 'REQUEST_DENIED':
      if (billing) return 'BILLING_ERROR'
      /*
        Google's prose for a disabled API names the API and the project — "This
        API project is not authorized to use this API", or "Street View Static
        API has not been used in project N before or it is disabled". Both are
        the same fix and a completely different one from a bad key.
      */
      if (/not authorized to use this api|has not been used in project|is disabled|api is not enabled/.test(why)) {
        return 'API_NOT_ENABLED'
      }
      return 'API_KEY_ERROR'
    /*
      Over-limit and unpaid arrive under the same status. The prose is the only
      separator and they are not the same phone call: one waits until midnight
      Pacific, the other needs a card.
    */
    case 'OVER_QUERY_LIMIT':
      return billing ? 'BILLING_ERROR' : 'QUOTA_ERROR'
    case 'INVALID_REQUEST':
    case 'UNKNOWN_ERROR':
      return 'UPSTREAM_ERROR'
    default:
      return 'UPSTREAM_ERROR'
  }
}

/**
 * Which failure an HTTP status is, before any body has been parsed.
 *
 * Google answers most key problems with a 200 and a status string, but not all
 * of them — a key rejected at the edge is a bare 403, and a rate limit is a
 * 429 with no JSON at all.
 */
export function classifyHttp(status: number): StreetViewFailure {
  if (status === 401 || status === 403) return 'API_KEY_ERROR'
  if (status === 429) return 'QUOTA_ERROR'
  return 'UPSTREAM_ERROR'
}

/** 0–360, which is the range Street View's `heading` parameter documents. */
export function normaliseHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

interface MetadataBody {
  status?: string
  error_message?: string
  pano_id?: string
  location?: { lat?: unknown; lng?: unknown }
}

/** The panorama's own coordinate, or null if Google did not give one. */
function panoLocation(body: MetadataBody): LatLng | null {
  const lat = Number(body.location?.lat)
  const lng = Number(body.location?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

/**
 * @param key the company's Google key, already decrypted by the caller
 * @param propertyLat the lead's own latitude — the thing to point the camera at
 * @param propertyLng the lead's own longitude
 */
export async function streetViewAt(
  key: string | undefined,
  propertyLat: number,
  propertyLng: number,
): Promise<StreetViewResult> {
  if (!key) return { kind: 'unconfigured', code: 'NOT_CONFIGURED' }

  const property: LatLng = { lat: propertyLat, lng: propertyLng }
  const at = `${propertyLat},${propertyLng}`

  let meta: Response
  try {
    meta = await fetch(
      `${base.meta}?location=${encodeURIComponent(at)}` +
        `&radius=${SEARCH_RADIUS_M}&source=outdoor&key=${encodeURIComponent(key)}`,
    )
  } catch (err) {
    return {
      kind: 'error',
      code: 'NETWORK_ERROR',
      detail: `metadata unreachable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!meta.ok) {
    return { kind: 'error', code: classifyHttp(meta.status), detail: `metadata HTTP ${meta.status}` }
  }

  const body = (await meta.json().catch(() => ({}))) as MetadataBody
  /*
    `NO_COVERAGE` is an answer, not a failure — the client may say so plainly
    and stop asking. Everything else that is not OK is a problem with the key,
    the quota, the billing or the enabled APIs, and must stay distinguishable: a
    rep in a dead zone must not have "no photo" cached for the rest of their
    day, and an office with a disabled API must not be told about the weather.
  */
  const verdict = classifyMetadata(body.status, body.error_message)
  if (verdict === 'NO_COVERAGE') return { kind: 'none', code: 'NO_COVERAGE' }
  if (verdict !== 'AVAILABLE') {
    return {
      kind: 'error',
      code: verdict as StreetViewFailure,
      // Google's own words, kept for the Worker log and never returned.
      detail: `metadata says ${body.status}${body.error_message ? `: ${body.error_message}` : ''}`,
    }
  }

  /*
    The camera, as Google reports it. A metadata response that says OK without a
    location is not something Google does, but a stand-in endpoint in a gate
    might — and falling back to the property coordinate is the old behaviour,
    which is worse but not broken. Never invented: if there is no panorama
    location there is no heading either, because there is nothing to take a
    bearing from.
  */
  const pano = panoLocation(body)
  const metres = pano ? distanceMeters(pano, property) : 0
  /*
    Computed here because addressing by `pano_id` takes away the one Google
    would have computed. See the header: given a `location` it aims at that
    location; given a `pano` it uses the panorama's default bearing.
  */
  const heading =
    pano && metres >= MIN_HEADING_BASELINE_M ? normaliseHeading(bearing(pano, property)) : null

  /*
    Addressed by `pano_id` where Google gave one, by the panorama's coordinate
    where it did not, and only as a last resort by the property's.

    The order matters and the last entry is the one to read twice: falling all
    the way back means asking the image endpoint to search again, on its own
    default 50 m — the case the header describes, where metadata says yes and
    the image comes back grey with a 200. It is reachable only from a metadata
    reply carrying neither a pano id nor a location, which Google does not send;
    the explicit radius is there so that even then the two calls are asking the
    same question.
  */
  const where = body.pano_id
    ? `pano=${encodeURIComponent(body.pano_id)}`
    : pano
      ? `location=${encodeURIComponent(`${pano.lat},${pano.lng}`)}`
      : `location=${encodeURIComponent(at)}&radius=${SEARCH_RADIUS_M}`

  let img: Response
  try {
    img = await fetch(
      `${base.image}?size=${W}x${H}&${where}` +
        (heading === null ? '' : `&heading=${heading.toFixed(1)}`) +
        `&fov=${FOV}&source=outdoor&key=${encodeURIComponent(key)}`,
    )
  } catch (err) {
    return {
      kind: 'error',
      code: 'NETWORK_ERROR',
      detail: `image unreachable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!img.ok) {
    return { kind: 'error', code: classifyHttp(img.status), detail: `image HTTP ${img.status}` }
  }

  return {
    kind: 'image',
    code: 'AVAILABLE',
    bytes: await img.arrayBuffer(),
    contentType: img.headers.get('content-type') ?? 'image/jpeg',
    pano: pano ?? property,
    heading,
    metres,
  }
}
