/**
 * Whether the basemap that rendered is the one this app asked for.
 *
 * Its own module, and pure, for one reason: it is the only part of the Google
 * map that a gate in this repo can ever check. `lib/gmaps.ts` reads
 * `import.meta.env` at load, so it belongs to a bundler; a real map needs a real
 * key, and a key that works in CI is a key committed somewhere. A decision that
 * takes a string and returns a string can be tested by anybody.
 */

/**
 * `colorScheme: 'DARK'` is a request, and there are two ways it does not happen.
 *
 * A **raster** map ignores it outright — the dark scheme is vector-only — so a
 * device or browser that falls back to raster drops Google's light basemap into
 * the middle of a near-black app. `map.getRenderingType()` says so, which is
 * what makes this half observable at all.
 *
 * A **Map Style attached to the Map ID** in the Cloud console overrides it, and
 * that half is not observable from here: a styled vector map reports VECTOR like
 * any other, and the style lives in Google's console rather than in anything
 * this bundle can read.
 *
 * So the message names both. A warning that says "raster" and stops there sends
 * whoever reads it to check a device setting on the day the real cause was a
 * style somebody attached to the Map ID months ago — and "the map looks wrong"
 * with no explanation is precisely the afternoon this exists to save.
 *
 * Returns null when there is nothing to say, including when the answer is not
 * yet knowable. A warning that cries wolf on every cold load is a warning nobody
 * reads by the time it means something.
 */
export function basemapWarning(renderingType: string | undefined | null): string | null {
  if (!renderingType) return null
  const type = renderingType.toUpperCase()
  // Not a fault, just too early: Google reports this before anything has painted.
  if (type === 'UNINITIALIZED') return null
  if (type === 'VECTOR') return null
  return (
    `the map rendered as ${type}, not VECTOR, so the dark colour scheme does not apply — ` +
    `this device or browser fell back to raster tiles. If the map is light on a device that ` +
    `does report VECTOR, look instead for a Map Style attached to this Map ID in the Cloud ` +
    `console, which overrides colorScheme and cannot be read from here.`
  )
}
