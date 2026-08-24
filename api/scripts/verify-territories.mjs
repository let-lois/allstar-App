/**
 * Creating a territory from a drawn outline.
 *
 * The endpoint takes a polygon from a browser and then rewrites rows with it, so
 * what is pinned here is mostly what it refuses. An authenticated but careless —
 * or hostile — caller controls every field, and two of them are dangerous in
 * different ways: `repId` can name somebody in another company, and `boundary` is
 * unbounded input that gets stored and then evaluated against every property in
 * the tenant.
 *
 * The other half is the geometry. A bounding box would have been simpler and
 * wrong: on any concave shape it claims the leads sitting in the notch, which is
 * exactly the shape somebody draws when a patch wraps around a park. So the
 * L-shaped case is here, and it is the reason this file exists rather than a
 * trust in `lat BETWEEN ? AND ?`.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'terr-')), 'territories.mjs')
await build({
  entryPoints: ['src/territories.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
})
const { createTerritory } = await import(out)

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const ACTOR = { id: 'u_mgr', clientId: 'c_1', role: 'manager', name: 'Ray Okafor' }
const REP = { id: 'u_rep', clientId: 'c_1', role: 'field_rep', name: 'Dana' }

/**
 * A D1 stand-in that answers by looking at the SQL.
 *
 * Crude on purpose: the point is to observe *which* statements run and with what
 * bindings, which a real database would hide behind its results.
 */
function fakeDb({ properties = [], reps = ['u_rep'], names = [] } = {}) {
  const log = []
  const updated = new Map()
  const inserted = []
  return {
    log,
    updated,
    inserted,
    db: {
      prepare(sql) {
        let args = []
        const api = {
          bind(...a) {
            args = a
            return api
          },
          async first() {
            log.push({ sql, args })
            if (/FROM users/.test(sql)) return reps.includes(args[0]) ? { id: args[0] } : null
            if (/FROM territories/.test(sql)) {
              return names.some((n) => n.toLowerCase() === String(args[1]).toLowerCase())
                ? { id: 't_existing' }
                : null
            }
            return null
          },
          async all() {
            log.push({ sql, args })
            if (/FROM properties/.test(sql)) return { results: properties }
            return { results: [] }
          },
          async run() {
            log.push({ sql, args })
            if (/INSERT INTO territories/.test(sql)) inserted.push(args)
            if (/UPDATE properties/.test(sql)) {
              // args: territoryId, repId, now, clientId, ...ids
              for (const id of args.slice(4)) updated.set(id, { territory: args[0], rep: args[1] })
              return { meta: { changes: args.length - 4 } }
            }
            return { meta: { changes: 0 } }
          },
        }
        return api
      },
    },
  }
}

const square = [
  { lat: 30.50, lng: -97.70 },
  { lat: 30.54, lng: -97.70 },
  { lat: 30.54, lng: -97.66 },
  { lat: 30.50, lng: -97.66 },
]

/* --- what it refuses ------------------------------------------------------ */
{
  const { db } = fakeDb()
  const env = { DB: db }

  const rep = await createTerritory(env, REP, { name: 'Mine', boundary: square })
  ok(rep.status === 403, `a field rep cannot create a territory (${rep.status})`)

  const noName = await createTerritory(env, ACTOR, { name: '   ', boundary: square })
  ok(noName.status === 400, 'an unnamed area is refused')

  const twoPoints = await createTerritory(env, ACTOR, {
    name: 'Line',
    boundary: square.slice(0, 2),
  })
  ok(twoPoints.status === 400, 'two points is not an area')

  const tooMany = await createTerritory(env, ACTOR, {
    name: 'Fractal',
    boundary: Array.from({ length: 201 }, (_, i) => ({ lat: 30 + i / 1000, lng: -97 })),
  })
  ok(tooMany.status === 400, 'an outline with 201 points is refused')

  const junk = await createTerritory(env, ACTOR, {
    name: 'Junk',
    boundary: [{ lat: 30, lng: -97 }, { lat: 'x', lng: -97 }, { lat: 31, lng: -97 }],
  })
  ok(junk.status === 400, 'a point with a non-numeric coordinate is refused')

  const offEarth = await createTerritory(env, ACTOR, {
    name: 'Space',
    boundary: [{ lat: 200, lng: -97 }, { lat: 31, lng: -97 }, { lat: 30, lng: -98 }],
  })
  ok(offEarth.status === 400, 'a latitude of 200 is refused')

  const notArray = await createTerritory(env, ACTOR, { name: 'Nope', boundary: 'square' })
  ok(notArray.status === 400, 'a boundary that is not a list is refused')
}

/* --- a rep from another company ------------------------------------------- */
//
// The whole reason every id is re-checked against the tenant: this one would hand
// a stranger a street's worth of leads, and nothing about the request looks wrong.
{
  const { db } = fakeDb({ reps: ['u_rep'] })
  const res = await createTerritory({ DB: db }, ACTOR, {
    name: 'Elsewhere',
    repId: 'u_someone_elses_rep',
    boundary: square,
  })
  ok(res.status === 400, 'a rep outside the tenant is refused')
  ok(
    /not on this team/i.test(res.error ?? ''),
    `and told so plainly (${res.error})`,
  )
}

/* --- a name already in use ------------------------------------------------ */
{
  const { db } = fakeDb({ names: ['Cypress Ridge'] })
  const res = await createTerritory({ DB: db }, ACTOR, {
    name: 'cypress ridge',
    boundary: square,
  })
  ok(res.status === 409, 'a duplicate name is refused regardless of case')
}

/* --- the geometry, which is the point ------------------------------------- */
{
  const properties = [
    { id: 'p_in', lat: 30.52, lng: -97.68 },
    { id: 'p_north', lat: 30.60, lng: -97.68 },
    { id: 'p_west', lat: 30.52, lng: -97.80 },
    { id: 'p_no_coords', lat: null, lng: null },
  ]
  const f = fakeDb({ properties })
  const res = await createTerritory({ DB: f.db }, ACTOR, {
    name: 'Patch',
    repId: 'u_rep',
    boundary: square,
  })
  ok(res.assigned === 1, `only the lead inside is claimed (${res.assigned})`)
  ok(f.updated.has('p_in'), 'the inside lead is moved')
  ok(!f.updated.has('p_north') && !f.updated.has('p_west'), 'the outside leads are left alone')
  ok(!f.updated.has('p_no_coords'), 'a lead with no coordinates is skipped, not claimed')
  ok(f.updated.get('p_in')?.rep === 'u_rep', 'and the chosen rep gets it')

  const stored = JSON.parse(f.inserted[0][4])
  ok(stored.length === 4, 'the outline is stored, so the shape can be shown again')
}

/* --- concave: the case a bounding box gets wrong -------------------------- */
{
  // An L: the notch is inside the bounding box but outside the shape.
  const L = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 4 },
    { lat: 2, lng: 4 },
    { lat: 2, lng: 2 },
    { lat: 4, lng: 2 },
    { lat: 4, lng: 0 },
  ]
  const f = fakeDb({
    properties: [
      { id: 'p_arm', lat: 1, lng: 3 },
      { id: 'p_notch', lat: 3, lng: 3 },
    ],
  })
  const res = await createTerritory({ DB: f.db }, ACTOR, { name: 'L patch', boundary: L })
  ok(res.assigned === 1, `an L-shaped patch claims one of the two (${res.assigned})`)
  ok(f.updated.has('p_arm'), 'the lead in the arm is claimed')
  ok(
    !f.updated.has('p_notch'),
    'the lead in the notch is not — which a bounding-box query would have taken',
  )
}

/* --- no rep chosen -------------------------------------------------------- */
{
  const f = fakeDb({ properties: [{ id: 'p_in', lat: 30.52, lng: -97.68 }] })
  const res = await createTerritory({ DB: f.db }, ACTOR, { name: 'Unclaimed', boundary: square })
  ok(res.assigned === 1, 'a territory can be drawn before anybody is assigned to it')
  ok(
    f.updated.get('p_in')?.rep === null,
    'and the lead keeps whoever had it — COALESCE, not an overwrite with null',
  )
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== territories OK ===')
process.exit(fails.length ? 1 : 0)
