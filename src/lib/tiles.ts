import { useEffect, useState } from 'react'
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

import * as db from './db'
import { API_URL } from './api-url'

/**
 * Where tiles come from: our own Worker, never MapTiler directly.
 *
 * The key used to be compiled into this bundle and protected by MapTiler's
 * HTTP-origin restriction — which the phone defeats by construction, since a
 * `file://` page sends no Origin. `GET /api/tiles/:layer/:z/:x/:y` on the
 * Worker holds the key as a secret and answers with bytes, and Cloudflare's
 * edge cache answers the second request for any tile itself. One path for the
 * web and the phone, and nothing in either bundle worth lifting. See
 * `api/src/tiles.ts`.
 */
export const TILE_HOST = API_URL

/*
  The layer id and the rep's stored choice moved to `lib/map-layer.ts`.

  Both renderers need them and only one of them draws tiles — see that file.
  Re-exported here so every existing `from '../lib/tiles'` keeps resolving, and
  so that removing this module later takes the MapTiler-specific half with it
  and leaves the preference behind.
*/
import type { LayerId } from './map-layer'
export { loadLayer, saveLayer } from './map-layer'
export type { LayerId }

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
    url: (z, x, y) => `${TILE_HOST}/api/tiles/streets/${z}/${x}/${y}.png`,
    maxZoom: 20,
    attribution: '© MapTiler © OpenStreetMap contributors',
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    url: (z, x, y) => `${TILE_HOST}/api/tiles/satellite/${z}/${x}/${y}.jpg`,
    maxZoom: 19,
    attribution: '© MapTiler © Planet / Landsat',
  },
}

/*
 * Whether the server has imagery to serve.
 *
 * A fact about the deployment, not about this build: the key lives on the
 * Worker, so the only way to know is to ask it. `/api/health` reports
 * `config.tiles`, the answer is remembered on the device so every later launch
 * — including one with no signal — starts from the last known truth, and the
 * two screens that care re-render when it changes. Until the first answer ever
 * arrives the map draws its own basemap, which is what it does with no imagery
 * anyway; nothing is worse than before for a moment, and then it is better.
 */
const TILES_FLAG = 'allstar.tiles.v1'
const TILES_EVENT = 'allstar:tiles'
let serverHasTiles: boolean | null = null

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TILES_FLAG) === '1'
  } catch {
    return false
  }
}

/** Is there imagery to draw? Sync, from the last answer the server gave. */
export function tilesAvailable(): boolean {
  if (serverHasTiles === null) serverHasTiles = readFlag()
  return serverHasTiles
}

/**
 * Ask the server once per launch, and remember. Never throws: a phone in a
 * dead zone keeps whatever it knew.
 */
export async function probeTileSupport(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/api/health`, { cache: 'no-store' })
    if (!res.ok) return
    const body = (await res.json()) as { config?: { tiles?: unknown } }
    const has = body.config?.tiles === true
    if (has === tilesAvailable()) return
    serverHasTiles = has
    try {
      localStorage.setItem(TILES_FLAG, has ? '1' : '0')
    } catch {
      /* private mode — the in-memory answer still holds for this launch */
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(TILES_EVENT))
  } catch {
    /* offline, or the API is down: keep the last answer */
  }
}

/** The same fact, for a component that has to re-render when it changes. */
export function useTilesAvailable(): boolean {
  const [has, setHas] = useState(tilesAvailable)
  useEffect(() => {
    const onChange = () => setHas(tilesAvailable())
    window.addEventListener(TILES_EVENT, onChange)
    return () => window.removeEventListener(TILES_EVENT, onChange)
  }, [])
  return has
}

/**
 * Can this platform keep imagery at all?
 *
 * It used to ask for Cache Storage, and that was the wrong question. Cache
 * Storage is exposed only to a secure context with a network scheme, and a
 * packaged app has neither: WKWebView serves the bundle through a custom scheme
 * handler, where `caches` is absent and no service worker runs. Since tiles were
 * written to Cache Storage and read back only by the worker's fetch handler,
 * iOS lost the feature twice over — the download declined, and had it not, the
 * imagery would never have been served back.
 *
 * IndexedDB is present under every scheme, which is why the tiles now live
 * there. What is left to ask is whether this is a browser-like environment at
 * all: the gates import this module into Node, where it is not.
 *
 * Still asked in one place. The lesson that put it here stands — `cachedCount`
 * returned zero politely, `clearTileCache` swallowed the answer, and
 * `prefetchTiles`, the one a rep actually taps, threw into a caller with a
 * `finally` and no `catch`: the button un-pressed, no note appeared, and a rep
 * walked out believing their territory was saved.
 */
export function tileStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
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
  if (width <= 0 || height <= 0) return []

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

/* --- offline prefetch ------------------------------------------------------
 *
 * Opportunistic caching only covers streets a rep has already looked at. What
 * they need is the streets they are about to walk, cached before they lose
 * signal — so this walks the tile pyramid over a bounding box and pulls it down
 * in one deliberate action.
 */


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
/**
 * The most URLs this will ever build, whatever it is asked for.
 *
 * This exists because of a crash on a phone, and the number is not the
 * interesting part — the ceiling is.
 *
 * Tapping "Offline maps" mounts the panel, which calls this in a `useMemo`.
 * With a rep's leads spread across a state, `zoomsWithinBudget` handed it a
 * 291,551-tile job; with one lead geocoded to 0,0 — an ordinary import
 * failure — the bounds spanned a hemisphere and the job was 6.5 *million*
 * strings; against world bounds, 267 million. A WebView renderer does not
 * survive that. It either restarts, which reads as the app throwing the rep
 * back to the first screen, or the process dies and takes the app with it.
 * Both were reported from the field, from the same tap.
 *
 * 60,000 is comfortably past the 44,000 the byte budget implies and nowhere
 * near what hurts. Anything over it is not a download anybody wants anyway —
 * it is a mistake upstream, and `zoomsWithinBudget` now refuses it before this
 * is ever reached. This is the second line: a cap on the *allocation* rather
 * than on the estimate, because the estimate is arithmetic that can drift and
 * the allocation is the thing that kills the app.
 */
export const MAX_PREFETCH_TILES = 60_000

export function tilesForBounds(
  bounds: Bounds,
  layer: LayerId,
  zooms: number[] = PREFETCH_ZOOMS,
): string[] {
  /*
    Counted before anything is built. `tileCountForBounds` is multiplication
    and costs nothing, which is exactly why it can be the guard — asking "how
    many would this be" must not itself be the expensive operation.
  */
  if (tileCountForBounds(bounds, layer, zooms) > MAX_PREFETCH_TILES) return []
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
  /*
    `length > 0`, not `length > 1`.

    Stopping at one zoom meant this function could not express "none of this
    fits", so it returned `[14]` for bounds where level 14 alone was 2.6 GB —
    six times the budget it exists to enforce — and 2.4 TB for a set of leads
    spanning the world. The caller believed it, showed the number, and the
    panel then tried to build a URL for every one of those tiles.

    An empty list is the honest answer and the callers handle it: the panel
    says the area is too large to save rather than offering a download that
    cannot happen, and `tilesForBounds` builds nothing.
  */
  while (
    zooms.length > 0 &&
    estimateBytes(tileCountForBounds(bounds, layer, zooms), layer) > budget
  ) {
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
 * Download tiles onto the device.
 *
 * Into IndexedDB, which the map reads directly. It used to be Cache Storage,
 * which only the service worker read, and that made the whole feature
 * conditional on something no one could see: a platform without a worker
 * downloaded imagery it could never display.
 *
 * Requests are made in CORS mode deliberately. An image fetch would be opaque —
 * status unreadable — and a rep would be told their territory downloaded fine
 * while a few hundred quota-exceeded error bodies were stored as tiles.
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
  // Snapshot what is already stored once, for the same reason as cachedCount:
  // a lookup per tile inside the loop is a thousand serialised reads.
  const stored = await db.tileKeys()
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
          await db.tilePut(url, await res.blob())
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
  if (!tileStorageAvailable() || urls.length === 0) return 0
  try {
    const stored = await db.tileKeys()
    let n = 0
    for (const url of urls) if (stored.has(url)) n += 1
    return n
  } catch {
    return 0
  }
}

export async function clearTileCache(): Promise<void> {
  try {
    await db.tileClear()
  } catch {
    /* nothing cached, or storage unavailable */
  }
}
