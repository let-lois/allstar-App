import type { Env } from './types'

/**
 * Basemap tiles, fetched by the server so the key never ships.
 *
 * The map's imagery came straight from MapTiler with a key compiled into the
 * web bundle. A key in a bundle is readable by anyone who downloads it, so the
 * only thing protecting it was MapTiler's HTTP-origin restriction — and the
 * phone defeats that by construction: the native app's page is `file://`, sends
 * no `Origin`, and can only ever match an origin-free key. LAUNCH.md item 4
 * records where that left things: a `?` wildcard on the key's allowed origins
 * so the phone would work, which also let anyone with the key spend the quota
 * from `curl`.
 *
 * Moving the fetch here removes the choice, the same way `/api/streetview` and
 * `/api/geocode/reverse` did for Google. The key is a Worker secret, the app
 * asks for `z/x/y` and receives bytes, and Cloudflare's edge cache answers the
 * second request for any tile without touching MapTiler at all. Web and phone
 * then use one path and one key, and the browser key can be retired.
 *
 * ## Public, and why that is acceptable
 *
 * The map draws tiles with `<image href>`, which cannot carry a bearer token,
 * so this route sits above the session boundary. What that exposes is our
 * MapTiler quota to anyone who finds the URL. Three things bound it: the layer
 * and zoom are whitelisted (nothing outside what the app itself asks for), the
 * edge cache absorbs repeats, and MapTiler's free tier is a hard cap with no
 * overage billing — so the worst case is a blank map until the month rolls
 * over, an outage rather than an invoice. Per-request rate limiting through D1
 * would cost more than it protects on the map's hot path.
 */

const UPSTREAM = 'https://api.maptiler.com'

/**
 * Overridable for the smoke, for the same reason as `useStreetViewBase`: the
 * refusals are the cases worth driving, and only a real response exercises
 * them. Unset in every real deployment.
 */
export function upstreamBase(env: Env): string {
  return (env.MAPTILER_BASE_URL ?? UPSTREAM).replace(/\/$/, '')
}

export type TileLayer = 'streets' | 'satellite'

/**
 * Exactly the two layers the app renders, at MapTiler's paths for them. The
 * extension is part of the contract: streets are PNG, satellite is JPEG, and
 * asking for the other is a 400 rather than a guess.
 */
const LAYERS: Record<TileLayer, { path: (z: number, x: number, y: number) => string; ext: string; type: string }> = {
  streets: {
    path: (z, x, y) => `/maps/streets-v2/256/${z}/${x}/${y}.png`,
    ext: 'png',
    type: 'image/png',
  },
  satellite: {
    path: (z, x, y) => `/tiles/satellite-v2/${z}/${x}/${y}.jpg`,
    ext: 'jpg',
    type: 'image/jpeg',
  },
}

/**
 * What the app can ask for. The map renders from about zoom 10 (a whole city)
 * to 20 (a driveway); the offline download covers 14–18. Anything outside is
 * not a request this app makes, so it is refused rather than proxied.
 */
const MIN_ZOOM = 8
const MAX_ZOOM = 20

export type TileResult =
  | { kind: 'image'; body: ArrayBuffer; contentType: string; fromCache: boolean }
  | { kind: 'unconfigured' }
  | { kind: 'error'; detail: string }

export function parseTilePath(
  layer: string,
  z: string,
  x: string,
  y: string,
  ext: string,
): { layer: TileLayer; z: number; x: number; y: number } | { bad: string } {
  if (!(layer in LAYERS)) return { bad: `no layer ${layer}` }
  const def = LAYERS[layer as TileLayer]
  if (ext !== def.ext) return { bad: `${layer} tiles are .${def.ext}` }
  const zn = Number(z)
  const xn = Number(x)
  const yn = Number(y)
  if (!Number.isInteger(zn) || zn < MIN_ZOOM || zn > MAX_ZOOM) return { bad: `zoom ${z} is outside ${MIN_ZOOM}–${MAX_ZOOM}` }
  const n = 2 ** zn
  if (!Number.isInteger(xn) || xn < 0 || xn >= n) return { bad: `x ${x} is outside zoom ${zn}` }
  if (!Number.isInteger(yn) || yn < 0 || yn >= n) return { bad: `y ${y} is outside zoom ${zn}` }
  return { layer: layer as TileLayer, z: zn, x: xn, y: yn }
}

/**
 * @param cacheKey the request URL as the app asked for it — the key never
 *   appears in it, which is what makes the cached response safe to share
 *   between everyone who asks for the same tile.
 */
export async function tileFor(
  env: Env,
  cacheKey: string,
  tile: { layer: TileLayer; z: number; x: number; y: number },
): Promise<TileResult> {
  const key = env.MAPTILER_API_KEY?.trim()
  if (!key) return { kind: 'unconfigured' }
  const def = LAYERS[tile.layer]

  /*
    Cloudflare's cache, keyed on our URL rather than MapTiler's. A tile for a
    given z/x/y never changes, so a hit is correct forever, and it is what turns
    "every rep on the crew loads the same streets every morning" into one
    upstream request per tile per edge location.
  */
  const cache = (caches as unknown as { default: Cache }).default
  const hit = await cache.match(cacheKey).catch(() => undefined)
  if (hit) {
    return { kind: 'image', body: await hit.arrayBuffer(), contentType: hit.headers.get('content-type') ?? def.type, fromCache: true }
  }

  let res: Response
  try {
    res = await fetch(`${upstreamBase(env)}${def.path(tile.z, tile.x, tile.y)}?key=${encodeURIComponent(key)}`)
  } catch (err) {
    return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  /*
    Never cached and never stored as a tile: a 429 or a 403 body is a page of
    text, and the old service worker's habit of storing whatever came back is
    exactly how a rep ended up with error pages drawn on their map.
  */
  if (!res.ok) return { kind: 'error', detail: `upstream ${res.status}` }

  const body = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') ?? def.type
  await cache
    .put(
      cacheKey,
      new Response(body.slice(0), {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
      }),
    )
    .catch(() => {})
  return { kind: 'image', body, contentType, fromCache: false }
}
