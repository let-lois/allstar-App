/**
 * Which basemap a rep chose, and remembering it.
 *
 * Its own module rather than part of `lib/tiles.ts`, for two reasons that both
 * turned out to matter.
 *
 * **Two renderers have to agree.** `FieldMap` draws raster tiles and
 * `GoogleFieldMap` asks Google for `roadmap` or `hybrid`; they share nothing
 * else about imagery, but a rep switching between them — which happens
 * automatically, when Google cannot draw — must not find their choice
 * forgotten. It was: the Google map held `useState(false)` and reset to streets
 * on every mount, so somebody assessing roofs re-picked satellite on every
 * screen, all day. The preference is a fact about the person, not about the
 * provider, so it lives where neither provider owns it.
 *
 * **`lib/tiles.ts` is scheduled for removal.** It is the MapTiler module: the
 * layer definitions, the proxy URL, the offline prefetch. When that goes, this
 * must not go with it — the streets/satellite choice outlives the vendor that
 * happened to serve the streets.
 *
 * Re-exported from `lib/tiles.ts` so existing imports keep resolving.
 */

export type LayerId = 'streets' | 'satellite'

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
