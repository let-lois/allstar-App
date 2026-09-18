import { project } from './geo'

/**
 * Raster basemap tiles.
 *
 * Deliberately a thin layer over the map we already render rather than a
 * mapping library. `FieldMap` already owns Web Mercator, pan/zoom and
 * hit-testing; all that is missing is imagery, and imagery is a grid of images
 * positioned by arithmetic this file does in about forty lines. MapLibre would
 * add ~200 kB gzipped to a bundle that is currently 47 kB, to replace code that
 * already works.
 *
 * The key is optional on purpose. With no key configured every function here
 * reports "no tiles" and the map draws exactly as it did before — imagery is an
 * enhancement, never a dependency.
 */

const KEY = (process.env.EXPO_PUBLIC_MAPTILER_KEY as string | undefined)?.trim() || ''

/** Every host tiles may be fetched from. Mirrored in the CSP in public/_headers. */
export const TILE_HOST = 'https://api.maptiler.com'

export type LayerId = 'streets' | 'satellite'

interface Layer {
  id: LayerId
  label: string
  url: (z: number, x: number, y: number) => string
  /** Past this the provider has no imagery; tiles are upscaled instead. */
  maxZoom: number
  /**
   * Required by the provider's terms and by ODbL for the OSM-derived data.
   * Rendered on the map — not buried in a settings screen.
   */
  attribution: string
}

export const LAYERS: Record<LayerId, Layer> = {
  streets: {
    id: 'streets',
    label: 'Streets',
    url: (z, x, y) => `${TILE_HOST}/maps/streets-v2/256/${z}/${x}/${y}.png?key=${KEY}`,
    maxZoom: 20,
    attribution: '© MapTiler © OpenStreetMap contributors',
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    url: (z, x, y) => `${TILE_HOST}/tiles/satellite-v2/${z}/${x}/${y}.jpg?key=${KEY}`,
    maxZoom: 19,
    attribution: '© MapTiler © Planet / Landsat',
  },
}

/** No key, no imagery. The caller falls back to the drawn basemap. */
export function tilesAvailable(): boolean {
  return KEY.length > 0
}

/**
 * Can this platform keep imagery at all?
 *
 * Cache Storage is not universal. It is exposed only to a secure context, and
 * the native shell's page is loaded from `file://` — an origin some engines
 * treat as trustworthy and some do not. `cachedCount` already asked this
 * question and `clearTileCache` already swallowed the answer, while
 * `prefetchTiles` — the one a rep actually taps — called `caches.open`
 * unguarded. So on a platform without it the *count* politely returned zero
 * and the *download* threw, into a caller with a `finally` and no `catch`: the
 * button un-pressed, no note appeared, and nothing was saved.
 *
 * That is the same lesson learned in two places out of three, which is the
 * shape `download.ts` names in its own header. Asked in one place now, and the
 * screen can decline the offer instead of failing it.
 */
export function tileStorageAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 'caches' in globalThis
}

export interface TileRef {
  key: string
  url: string
  /** Screen position and edge length, in CSS pixels. */
  x: number
  y: number
  size: number
}

/**
 * The tiles covering the viewport, positioned in screen space.
 *
 * One tile is rendered a ring beyond each edge so a pan reveals imagery that is
 * already decoded rather than a gap that fills in a moment later.
 */
export function visibleTiles(opts: {
  layer: LayerId
  /** Fractional map zoom, as the view holds it. */
  zoom: number
  centerLat: number
  centerLng: number
  width: number
  height: number
  /** World pixels across the whole map at this zoom — TILE * 2 ** zoom. */
  scale: number
}): TileRef[] {
  const { layer, zoom, centerLat, centerLng, width, height, scale } = opts
  if (!tilesAvailable() || width <= 0 || height <= 0) return []

  const def = LAYERS[layer]
  // Integer tile zoom, capped at what the provider actually has. Beyond that the
  // tiles simply draw larger, which is how every map handles deep zoom.
  const z = Math.min(Math.floor(zoom), def.maxZoom)
  const n = 2 ** z
  // Edge length on screen. Equals 256 when zoom is integral and z is not capped.
  const tileSize = scale / n

  const center = project(centerLat, centerLng)
  // World-pixel offset of the viewport's top-left corner.
  const originX = center.x * scale - width / 2
  const originY = center.y * scale - height / 2

  const firstX = Math.floor(originX / tileSize) - 1
  const lastX = Math.floor((originX + width) / tileSize) + 1
  const firstY = Math.max(0, Math.floor(originY / tileSize) - 1)
  const lastY = Math.min(n - 1, Math.floor((originY + height) / tileSize) + 1)

  const out: TileRef[] = []
  for (let ty = firstY; ty <= lastY; ty++) {
    for (let tx = firstX; tx <= lastX; tx++) {
      // Longitude wraps, latitude does not — the y range above is already
      // clamped, so only x needs folding back into range.
      const wrapped = ((tx % n) + n) % n
      out.push({
        key: `${layer}/${z}/${wrapped}/${ty}`,
        url: def.url(z, wrapped, ty),
        x: tx * tileSize - originX,
        y: ty * tileSize - originY,
        size: tileSize,
      })
    }
  }
  return out
}

const STORED_LAYER = 'allstar.map.layer'

/**
 * A rep's choice of basemap sticks. Someone assessing roofs works in satellite
 * all day and should not have to re-pick it on every screen.
 */
export function loadLayer(): LayerId {
  try {
    const v = localStorage.getItem(STORED_LAYER)
    return v === 'satellite' ? 'satellite' : 'streets'
  } catch {
    return 'streets'
  }
}

export function saveLayer(id: LayerId) {
  try {
    localStorage.setItem(STORED_LAYER, id)
  } catch {
    /* private mode — the default is fine */
  }
}

/* --- offline prefetch ------------------------------------------------------
 *
 * Opportunistic caching only covers streets a rep has already looked at. What
 * they need is the streets they are about to walk, cached before they lose
 * signal — so this walks the tile pyramid over a bounding box and pulls it down
 * in one deliberate action.
 */

/**
 * Must match TILE_CACHE in public/sw.js.
 *
 * The worker cannot import from here, so this is the one duplicated constant in
 * the codebase. It is duplicated rather than passed at runtime because the
 * worker needs it during `activate`, before any page has spoken to it.
 */
export const TILE_CACHE = 'allstar-tiles-v1'

/**
 * Zooms worth storing.
 *
 * 14 frames a whole territory, 18 is close enough to tell one driveway from the
 * next. Each level is four times the tiles of the one above it, so this range is
 * about 85% of the total — going to 19 would roughly quadruple the download for
 * detail a rep on a pavement does not use.
 */
export const PREFETCH_ZOOMS = [14, 15, 16, 17, 18]

/** Rough bytes per tile, measured by layer. Satellite imagery is the heavy one. */
const BYTES_PER_TILE: Record<LayerId, number> = { streets: 9_000, satellite: 26_000 }

export interface Bounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/**
 * Bounding box around a set of points, with a margin.
 *
 * The margin matters: a rep parks and walks, and a box drawn tight to the
 * assigned pins has no imagery at its edges — exactly where they start.
 */
export function boundsOf(
  points: { lat: number; lng: number }[],
  marginDeg = 0.004,
): Bounds | null {
  if (points.length === 0) return null
  let minLat = 90
  let maxLat = -90
  let minLng = 180
  let maxLng = -180
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng)
    maxLng = Math.max(maxLng, p.lng)
  }
  if (minLat > maxLat) return null
  return {
    minLat: minLat - marginDeg,
    maxLat: maxLat + marginDeg,
    minLng: minLng - marginDeg,
    maxLng: maxLng + marginDeg,
  }
}

/** Every tile URL covering `bounds` across `zooms`, for one layer. */
export function tilesForBounds(
  bounds: Bounds,
  layer: LayerId,
  zooms: number[] = PREFETCH_ZOOMS,
): string[] {
  if (!tilesAvailable()) return []
  const def = LAYERS[layer]
  const urls: string[] = []
  const seen = new Set<string>()

  for (const rawZ of zooms) {
    const z = Math.min(rawZ, def.maxZoom)
    const n = 2 ** z
    const nw = project(bounds.maxLat, bounds.minLng)
    const se = project(bounds.minLat, bounds.maxLng)
    const x0 = Math.floor(nw.x * n)
    const x1 = Math.floor(se.x * n)
    // project() grows y southward, so maxLat is the smaller value.
    const y0 = Math.max(0, Math.floor(nw.y * n))
    const y1 = Math.min(n - 1, Math.floor(se.y * n))

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wrapped = ((x % n) + n) % n
        const key = `${z}/${wrapped}/${y}`
        if (seen.has(key)) continue
        seen.add(key)
        urls.push(def.url(z, wrapped, y))
      }
    }
  }
  return urls
}

export function estimateBytes(tileCount: number, layer: LayerId): number {
  return tileCount * BYTES_PER_TILE[layer]
}

/**
 * How many tiles cover these bounds — without building any of them.
 *
 * The same nested loops as `tilesForBounds`, replaced by the multiplication they
 * were performing. That difference is not a micro-optimisation: a rep whose
 * leads span eighty miles produces 1.39 *million* tiles across these zooms, and
 * the screen that showed the download size was building all 1.39 million URL
 * strings — plus a Set of every key — on mount, before anybody opened the
 * section. Measured at 2.8 seconds on a desktop CPU and several times that on a
 * phone, which is exactly what it felt like.
 *
 * Counting the same tiles takes under a millisecond, because the count is
 * arithmetic and always was.
 */
export function tileCountForBounds(
  bounds: Bounds,
  layer: LayerId,
  zooms: number[] = PREFETCH_ZOOMS,
): number {
  if (!tilesAvailable()) return 0
  const def = LAYERS[layer]
  let total = 0
  for (const rawZ of zooms) {
    const z = Math.min(rawZ, def.maxZoom)
    const n = 2 ** z
    const nw = project(bounds.maxLat, bounds.minLng)
    const se = project(bounds.minLat, bounds.maxLng)
    const x0 = Math.floor(nw.x * n)
    const x1 = Math.floor(se.x * n)
    const y0 = Math.max(0, Math.floor(nw.y * n))
    const y1 = Math.min(n - 1, Math.floor(se.y * n))
    total += Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1)
  }
  return total
}

/**
 * The most detail that will fit in a sane download.
 *
 * Each zoom level is four times the one above it, so the deepest level is about
 * three quarters of any download — and for a wide territory it is tens of
 * gigabytes on its own. Nothing good happens when an app tries to write 12 GB to
 * a phone: it fails slowly, or it succeeds and fills the device.
 *
 * So the deepest levels come off until the estimate fits the budget, and the
 * screen says what was left out. That degrades the way the map itself does —
 * less detail rather than nothing — instead of refusing outright.
 */
export const SAVE_BUDGET_BYTES = 400_000_000

export function zoomsWithinBudget(
  bounds: Bounds,
  layer: LayerId,
  budget = SAVE_BUDGET_BYTES,
): number[] {
  const zooms = [...PREFETCH_ZOOMS].sort((a, b) => a - b)
  while (zooms.length > 1 && estimateBytes(tileCountForBounds(bounds, layer, zooms), layer) > budget) {
    zooms.pop()
  }
  return zooms
}

export interface PrefetchProgress {
  done: number
  total: number
  failed: number
  /**
   * Set only when this platform cannot store imagery at all, so the screen can
   * say that instead of blaming the connection. Absent on every ordinary
   * result, including a completely failed download over a bad link — those two
   * need opposite advice.
   */
  unsupported?: boolean
}

/**
 * Download tiles into the cache the service worker reads from.
 *
 * Writes to Cache Storage directly rather than relying on the worker to catch
 * the fetches, so a download still works on a first visit before any worker has
 * taken control.
 *
 * Requests are made in CORS mode deliberately. An image fetch would be opaque —
 * status unreadable — and a rep would be told their territory downloaded fine
 * while a few hundred quota-exceeded error bodies filled the cache.
 */
export async function prefetchTiles(
  urls: string[],
  opts: {
    onProgress?: (p: PrefetchProgress) => void
    signal?: AbortSignal
    concurrency?: number
  } = {},
): Promise<PrefetchProgress> {
  const { onProgress, signal, concurrency = 6 } = opts
  /*
    Refused rather than thrown. The caller wraps this in `try`/`finally` with no
    `catch`, so a throw here un-pressed the button and said nothing — the rep
    would conclude their territory was saved when nothing had been written. A
    result they can read beats an exception nobody catches.
  */
  if (!tileStorageAvailable()) {
    return { done: 0, total: urls.length, failed: urls.length, unsupported: true }
  }
  const cache = await caches.open(TILE_CACHE)
  // Snapshot what is already stored once, for the same reason as cachedCount:
  // a match() per tile inside the loop is a thousand serialised lookups.
  const stored = new Set((await cache.keys()).map((r) => r.url))
  const progress: PrefetchProgress = { done: 0, total: urls.length, failed: 0 }

  let cursor = 0
  const worker = async () => {
    while (cursor < urls.length) {
      if (signal?.aborted) return
      const url = urls[cursor++]
      try {
        // Skip anything already stored — re-downloading a territory should cost
        // only what changed, which on a second run is nothing.
        if (!stored.has(url)) {
          const res = await fetch(url, { mode: 'cors', signal })
          if (!res.ok) throw new Error(String(res.status))
          await cache.put(url, res.clone())
        }
        progress.done += 1
      } catch {
        if (signal?.aborted) return
        progress.failed += 1
      }
      onProgress?.({ ...progress })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
  return progress
}

/**
 * How much of a territory is already on the device.
 *
 * One `keys()` call and a set intersection, rather than a `match()` per tile.
 * The obvious version issues one IndexedDB lookup per URL — 1,159 of them for a
 * 3.6 km territory, sequentially, every time the screen mounts, which left the
 * count reading zero for seconds after a download had plainly finished.
 */
export async function cachedCount(urls: string[]): Promise<number> {
  if (!('caches' in globalThis) || urls.length === 0) return 0
  try {
    const cache = await caches.open(TILE_CACHE)
    const stored = new Set((await cache.keys()).map((r) => r.url))
    let n = 0
    for (const url of urls) if (stored.has(url)) n += 1
    return n
  } catch {
    return 0
  }
}

export async function clearTileCache(): Promise<void> {
  try {
    await caches.delete(TILE_CACHE)
  } catch {
    /* nothing cached, or storage unavailable */
  }
}
