import { readFileSync } from 'node:fs'
import { basemapWarning } from '../src/lib/basemap.ts'

/**
 * The map says why it came up light.
 *
 * A bright basemap inside a near-black app is the kind of fault that gets
 * reported as "the map looks wrong" and then costs somebody an afternoon,
 * because the two causes are invisible and unrelated:
 *
 *   a raster fallback ignores `colorScheme: 'DARK'` outright — the dark scheme
 *   is vector-only
 *
 *   a Map Style attached to the Map ID in the Cloud console overrides it
 *
 * Only the first is observable from the bundle. The second is a styled vector
 * map, which reports VECTOR like any other, and the style lives in Google's
 * console. So what is gated is that the observable half is detected, and that
 * the warning *names* the half that is not — a message that says "raster" and
 * stops there sends the reader looking in the wrong place on the day the cause
 * is the other one.
 *
 * No browser and no Maps key. The decision is a pure function of the rendering
 * type precisely so it can be tested here; a gate in this repo can never have a
 * real key, because a key that works in CI is a key committed somewhere.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

console.log('--- what counts as the map we asked for ---')

ok(basemapWarning('VECTOR') === null, 'a vector map is the one we asked for, and says nothing')
ok(basemapWarning('vector') === null, 'and the check is not defeated by casing')

/*
 * UNINITIALIZED is not a failure, it is "too early". Google reports it before
 * anything has painted, and warning on it would fire on every cold load — a
 * warning that cries wolf on the happy path is a warning nobody reads by the
 * time it means something.
 */
ok(basemapWarning('UNINITIALIZED') === null, 'a map that has not painted yet is not a fault')
ok(basemapWarning(undefined) === null, 'nor is an API too old to answer the question')
ok(basemapWarning(null) === null, 'nor a null answer')

console.log('\n--- and what does not ---')

const raster = basemapWarning('RASTER')
ok(raster !== null, 'a raster map is reported')
ok(/raster/i.test(raster ?? ''), 'and named as raster, which is the cause it can prove', raster?.slice(0, 44))

/*
 * The assertion that earns this file. The raster case is the one this code can
 * detect; the Cloud console case is the one it cannot, and is at least as
 * likely. A warning that only mentions raster would send whoever reads it to
 * check a device setting on the day the real cause was a style somebody
 * attached to the Map ID months ago.
 */
ok(
  /Map Style/i.test(raster ?? '') && /Cloud console/i.test(raster ?? ''),
  'and points at the other cause too, which this code cannot see',
)
ok(
  /VECTOR/.test(raster ?? ''),
  'telling the reader what a healthy map reports, so they can check their own',
)

// Anything unexpected is treated as a problem rather than waved through. A
// rendering type nobody here has heard of is not a reason to assume the map is
// fine.
ok(basemapWarning('SOMETHING_NEW') !== null, 'an unknown rendering type is reported, not assumed good')

console.log('\n--- it is actually wired up ---')

/*
 * A pure function nothing calls is a pure function that passes forever. Checked
 * at the source, because the alternative is a real Maps key.
 */
const map = readFileSync(new URL('../src/components/map/GoogleFieldMap.tsx', import.meta.url), 'utf8')
ok(/basemapWarning\(/.test(map), 'the map renderer calls it')
ok(
  /getRenderingType\(\)/.test(map),
  'with the rendering type Google reports, rather than an assumption',
)
/*
 * On `tilesloaded`, not at construction: the rendering type is not settled until
 * something has been painted, so asking earlier reads UNINITIALIZED and this
 * whole check quietly becomes a no-op.
 */
const tiles = map.slice(map.indexOf("'tilesloaded'"))
ok(
  tiles.indexOf('basemapWarning(') > 0 && tiles.indexOf('basemapWarning(') < 900,
  'after the map has painted, when the rendering type is settled',
)
ok(
  /colorScheme: 'DARK'/.test(map),
  'and the dark scheme it is checking for is still being asked for',
)

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== basemap OK ===')
