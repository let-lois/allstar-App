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

const KEY = (import.meta.env.VITE_MAPTILER_KEY as string | undefined)?.trim() || ''

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
