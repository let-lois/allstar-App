/**
 * Route building.
 *
 * The ordering is the product here — a route a rep won't follow is worse than no
 * route, because they abandon it at 9am and go back to freelancing. So these
 * assertions are about whether the sequence is *walkable*, not whether it's
 * mathematically minimal.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'route-')), 'route.mjs')
await build({ entryPoints: ['src/lib/route.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const { buildRoute, orderStops, routableLeads, routeName, routeMiles, DEFAULT_ROUTE_SIZE, MAX_ROUTE_SIZE } =
  await import(out)

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const prop = (over = {}) => ({
  id: over.id ?? `p${Math.random()}`,
  address1: over.address1 ?? '1 Test St',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  lat: 30.51,
  lng: -97.68,
  status: 'new',
  score: 50,
  contacts: [],
  ...over,
})

/* --- what counts as walkable --------------------------------------------- */
{
  const now = new Date('2026-08-18T15:00:00Z').getTime()
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const leads = [
    prop({ id: 'open', status: 'new' }),
    prop({ id: 'won', status: 'won' }),
    prop({ id: 'lost', status: 'lost' }),
    prop({ id: 'dnc', status: 'dnc' }),
    prop({ id: 'knocked-today', status: 'contacted', lastVisitAt: startOfToday + 3_600_000 }),
    prop({ id: 'knocked-last-week', status: 'contacted', lastVisitAt: startOfToday - 7 * 86_400_000 }),
    prop({ id: 'no-coords', lat: 0, lng: 0 }),
  ]
  const ids = routableLeads(leads, now).map((p) => p.id)

  ok(ids.includes('open'), 'an open lead is routable')
  ok(!ids.includes('won') && !ids.includes('lost') && !ids.includes('dnc'), 'closed leads are not re-knocked')
  ok(
    !ids.includes('knocked-today'),
    'a door already knocked today is excluded — knocking twice annoys the prospect and inflates the rep’s numbers',
  )
  ok(ids.includes('knocked-last-week'), 'a door knocked last week is fair game again')
  ok(
    !ids.includes('no-coords'),
    'a lead with no coordinates is excluded — it cannot be walked to',
  )
}

/* --- the ordering --------------------------------------------------------- */
{
  // A street laid out west to east, handed over deliberately shuffled.
  const street = [0, 1, 2, 3, 4, 5].map((i) =>
    prop({ id: `s${i}`, address1: `${100 + i * 2} Cedar Bend Dr`, lat: 30.51, lng: -97.68 + i * 0.001 }),
  )
  const shuffled = [street[3], street[0], street[5], street[1], street[4], street[2]]
  const ordered = orderStops(shuffled, { lat: 30.51, lng: -97.68 }, 10)

  ok(
    ordered.map((p) => p.id).join(',') === 's0,s1,s2,s3,s4,s5',
    `a shuffled street comes back in walking order (${ordered.map((p) => p.id).join(',')})`,
  )
  ok(ordered[0].id === 's0', 'the route starts at the lead nearest the rep')
}
{
  // Two clusters a mile apart. A walkable route finishes one before starting the
  // other; a naive sort by a single coordinate would zig-zag between them.
  const near = [0, 1, 2].map((i) => prop({ id: `n${i}`, lat: 30.51 + i * 0.0002, lng: -97.68 }))
  const far = [0, 1, 2].map((i) => prop({ id: `f${i}`, lat: 30.53 + i * 0.0002, lng: -97.68 }))
  const mixed = [far[0], near[0], far[1], near[1], far[2], near[2]]
  const ordered = orderStops(mixed, { lat: 30.51, lng: -97.68 }, 10).map((p) => p.id)

  const lastNear = Math.max(...ordered.map((id, i) => (id.startsWith('n') ? i : -1)))
  const firstFar = Math.min(...ordered.map((id, i) => (id.startsWith('f') ? i : 99)))
  ok(lastNear < firstFar, `one cluster is finished before the next is started (${ordered.join(',')})`)
}
{
  // With no GPS fix the route must not begin at the far edge and walk inward.
  const spread = [
    prop({ id: 'edge', lat: 30.60, lng: -97.68 }),
    prop({ id: 'mid1', lat: 30.510, lng: -97.68 }),
    prop({ id: 'mid2', lat: 30.511, lng: -97.68 }),
    prop({ id: 'mid3', lat: 30.512, lng: -97.68 }),
  ]
  const ordered = orderStops(spread, undefined, 10).map((p) => p.id)
  ok(ordered[0] !== 'edge', `with no GPS the route starts in the cluster, not at the outlier (${ordered.join(',')})`)
  ok(ordered[ordered.length - 1] === 'edge', 'the outlier is walked last')
}

/* --- the size cap --------------------------------------------------------- */
{
  const many = Array.from({ length: 300 }, (_, i) =>
    prop({ id: `m${i}`, lat: 30.51 + i * 0.0001, lng: -97.68 }),
  )
  const r = buildRoute(many, { repId: 'u1', from: { lat: 30.51, lng: -97.68 } })
  ok(r.stops.length === DEFAULT_ROUTE_SIZE, `a default route is a day's work, not the whole list (${r.stops.length})`)

  const big = buildRoute(many, { repId: 'u1', size: 9999 })
  ok(big.stops.length === MAX_ROUTE_SIZE, `an absurd size is clamped (${big.stops.length})`)
}

/* --- the route record ----------------------------------------------------- */
{
  const leads = [0, 1, 2].map((i) =>
    prop({ id: `p${i}`, address1: `${100 + i} Cedar Bend Dr`, lat: 30.51 + i * 0.0002, lng: -97.68 }),
  )
  const now = new Date('2026-08-18T15:00:00Z').getTime()
  const a = buildRoute(leads, { repId: 'u1', now, from: { lat: 30.51, lng: -97.68 } })
  const b = buildRoute(leads, { repId: 'u1', now, from: { lat: 30.51, lng: -97.68 } })

  ok(a.id === b.id, 'building twice in a day produces one route id, not two competing routes')
  ok(a.repId === 'u1', 'the route belongs to the rep who built it')
  ok(a.stops.filter((s) => s.status === 'active').length === 1, 'exactly one stop is active')
  ok(a.stops[0].status === 'active', 'the active stop is the first one')
  ok(
    a.stops.every((s, i) => s.order === i),
    'stop order is dense and zero-based',
  )
  ok(buildRoute([], { repId: 'u1' }) === null, 'no leads produces no route rather than an empty one')
}

/* --- naming --------------------------------------------------------------- */
{
  ok(
    routeName([prop({ address1: '1420 Cedar Bend Dr' }), prop({ address1: '1422 Cedar Bend Dr' })]) ===
      'Cedar Bend Dr',
    'a single-street route is named after the street',
  )
  const two = routeName([prop({ address1: '1 Cedar Bend Dr' }), prop({ address1: '2 Oak Ridge Ln' })])
  ok(two === 'Cedar Bend Dr + 1 street', `a two-street route names the first and counts the rest (${two})`)
  const three = routeName([
    prop({ address1: '1 Cedar Bend Dr' }),
    prop({ address1: '2 Oak Ridge Ln' }),
    prop({ address1: '3 Elm Ct' }),
  ])
  ok(three === 'Cedar Bend Dr + 2 streets', `three streets pluralise (${three})`)
}

/* --- distance ------------------------------------------------------------- */
{
  const miles = routeMiles([
    { lat: 30.51, lng: -97.68 },
    { lat: 30.52, lng: -97.68 },
  ])
  ok(miles > 0.6 && miles < 0.8, `a hundredth of a degree of latitude is about 0.69 miles (got ${miles.toFixed(3)})`)
  ok(routeMiles([]) === 0 && routeMiles([{ lat: 1, lng: 1 }]) === 0, 'a route of one stop has no walking distance')
}

console.log(fails.length ? `\n${fails.length} route check(s) failed` : '\nroute building is correct')
process.exit(fails.length ? 1 : 0)
