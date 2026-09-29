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
const { createTerritory, deleteTerritory, renameTerritory } = await import(out)

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
  const onPatch = []
  return {
    log,
    updated,
    inserted,
    onPatch,
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
            // The team check for a list of reps: those that exist, as rows.
            if (/FROM users/.test(sql)) {
              return { results: args.slice(1).filter((id) => reps.includes(id)).map((id) => ({ id })) }
            }
            return { results: [] }
          },
          async run() {
            log.push({ sql, args })
            if (/INSERT INTO territories/.test(sql)) inserted.push(args)
            // args: territoryId, now, actorId, ...repIds
            if (/INSERT OR IGNORE INTO territory_reps/.test(sql)) {
              for (const id of args.slice(3)) onPatch.push({ territory: args[0], rep: id })
            }
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

/* --- more than one rep: a shared patch ------------------------------------ */
//
// The territory holds any number of people. With two, every house inside is
// visible to both (that is `territory_reps`), and nobody is handed the unclaimed
// ones — a shared patch is worked door by door, and claiming them all for the
// first name on the list would be a decision nobody made.
{
  const f = fakeDb({ reps: ['u_rep', 'u_rep2'], properties: [{ id: 'p_in', lat: 30.52, lng: -97.68 }] })
  const res = await createTerritory({ DB: f.db }, ACTOR, {
    name: 'Shared',
    repIds: ['u_rep', 'u_rep2'],
    boundary: square,
  })
  ok(res.territory?.repIds?.length === 2, `both reps come back on the territory (${res.territory?.repIds?.length})`)
  ok(
    f.onPatch.filter((r) => r.territory === res.territory.id).map((r) => r.rep).sort().join() === 'u_rep,u_rep2',
    'and both are written to territory_reps',
  )
  ok(f.inserted[0][3] === 'u_rep', 'the first of them is mirrored into rep_id, for imports and older readers')
  ok(res.assigned === 1 && f.updated.get('p_in')?.rep === null, 'the lead inside joins the patch but is handed to nobody — shared, not claimed')

  const stranger = await createTerritory({ DB: fakeDb({ reps: ['u_rep'] }).db }, ACTOR, {
    name: 'Mixed company',
    repIds: ['u_rep', 'u_elsewhere'],
    boundary: square,
  })
  ok(stranger.status === 400, 'one stranger in the list refuses the whole territory')

  const folded = await createTerritory({ DB: fakeDb({ reps: ['u_rep'] }).db }, ACTOR, {
    name: 'Old caller',
    repId: 'u_rep',
    repIds: ['u_rep'],
    boundary: square,
  })
  ok(folded.territory?.repIds?.length === 1, 'repId and repIds naming the same person is one rep, not two')
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

/* === renaming and deleting ================================================
 *
 * Both arrived long after creation did, which is the interesting part: for the
 * whole life of the feature a drawn patch could be made and never unmade, so a
 * typo was permanent and a shape round the wrong streets stayed there.
 *
 * What is pinned here is the same shape as above — what they refuse, and what
 * they leave alone. Two of those matter more than the rest:
 *
 *   - **Another company's id is "no such territory", not "not permitted".**
 *     An id is a guess anybody can make, and a different answer for a real one
 *     tells a caller that a row exists in a tenant they cannot see.
 *   - **A delete keeps the leads.** It clears `territory_id` and nothing else.
 *     A delete that removed the properties, or that cleared the rep along with
 *     the patch, would be a catastrophe wearing the same button as a tidy-up —
 *     so the SQL itself is inspected, not just the number it returns.
 */

/**
 * A second stand-in, for the statements these two run.
 *
 * Separate from `fakeDb` rather than grown into it: that one answers "does this
 * name already exist" from a list of strings, and these need a table with ids
 * in it. Bending one fake to serve both would make every existing assertion
 * depend on the shape of the new ones.
 */
function fakeStore({ rows = [], held = 0 } = {}) {
  const sqls = []
  const renamed = []
  const deleted = []
  let released = 0
  return {
    sqls,
    renamed,
    deleted,
    get released() {
      return released
    },
    db: {
      prepare(sql) {
        let args = []
        const api = {
          bind(...a) {
            args = a
            return api
          },
          async first() {
            sqls.push({ sql, args })
            if (/SELECT id, name FROM territories/.test(sql)) {
              // Scoped by client_id in the statement, so the fake honours it
              // too — a fake that ignored the tenant would let a cross-tenant
              // bug pass here and only fail in production.
              return rows.find((r) => r.id === args[0] && r.clientId === args[1]) ?? null
            }
            if (/FROM territories/.test(sql)) {
              /*
                Read off the statement, not off the bindings.

                The first version took `args[2]` whenever it was there, which
                made the fake exclude the row being renamed even when the SQL
                did not — so dropping `AND id <> ?3` from the query still
                passed here. A fake that is kinder than the database turns the
                gate into decoration.
              */
              const exclude = /id <> \?3/.test(sql) ? args[2] : undefined
              return (
                rows.find(
                  (r) =>
                    r.clientId === args[0] &&
                    r.name.toLowerCase() === String(args[1]).toLowerCase() &&
                    r.id !== exclude,
                ) ?? null
              )
            }
            return null
          },
          async all() {
            sqls.push({ sql, args })
            return { results: [] }
          },
          async run() {
            sqls.push({ sql, args })
            if (/UPDATE territories SET name/.test(sql)) renamed.push(args)
            if (/DELETE FROM territories/.test(sql)) deleted.push(args)
            if (/UPDATE properties/.test(sql) && /territory_id = NULL/.test(sql)) {
              released = held
              return { meta: { changes: held } }
            }
            return { meta: { changes: 0 } }
          },
        }
        return api
      },
    },
  }
}

const HOME = [{ id: 't_1', clientId: 'c_1', name: 'Cypress Ridge' }]

/* --- rename: what it refuses ---------------------------------------------- */
{
  const f = fakeStore({ rows: HOME })
  const env = { DB: f.db }

  ok(
    (await renameTerritory(env, REP, 't_1', { name: 'Mine' })).status === 403,
    'a field rep cannot rename a territory',
  )
  ok(
    (await renameTerritory(env, ACTOR, 't_1', { name: '   ' })).status === 400,
    'a rename to blank is refused rather than storing "  "',
  )
  ok(
    (await renameTerritory(env, ACTOR, 't_1', { name: 'x'.repeat(121) })).status === 400,
    'and an absurdly long name is refused',
  )

  const other = { ...ACTOR, clientId: 'c_2' }
  const cross = await renameTerritory(env, other, 't_1', { name: 'Theirs' })
  ok(cross.status === 404, `another company's territory is 404, not 403 (${cross.status})`)
  ok(
    !/not permitted/i.test(cross.error ?? ''),
    'so existence does not leak across the tenant line',
  )
}

/* --- rename: the clash check excludes the row being renamed --------------- */
{
  const f = fakeStore({
    rows: [...HOME, { id: 't_2', clientId: 'c_1', name: 'Marigold' }],
  })
  const env = { DB: f.db }

  const clash = await renameTerritory(env, ACTOR, 't_1', { name: 'marigold' })
  ok(clash.status === 409, 'a name another territory already has is refused, case-insensitively')

  /*
    The one that a naive clash check gets wrong: re-saving a territory's own
    name, or only its capitalisation. Without `id <> ?3` this is a 409 against
    itself, and the operator is told the name is taken by the row they are
    editing.
  */
  const itself = await renameTerritory(env, ACTOR, 't_1', { name: 'CYPRESS RIDGE' })
  ok(
    !('error' in itself),
    `a territory may be renamed to its own name in different case (${itself.error ?? 'ok'})`,
  )
  ok(f.renamed.length === 1 && f.renamed[0][0] === 'CYPRESS RIDGE', 'and the new name is stored')
  ok(
    f.renamed[0][2] === 'c_1',
    'with the update scoped to the caller’s company, not just the id',
  )
}

/* --- delete: what it refuses ---------------------------------------------- */
{
  const f = fakeStore({ rows: HOME, held: 42 })
  const env = { DB: f.db }

  ok((await deleteTerritory(env, REP, 't_1')).status === 403, 'a field rep cannot delete one')
  ok((await deleteTerritory(env, ACTOR, 't_nope')).status === 404, 'an id that does not exist is 404')
  ok(
    (await deleteTerritory(env, { ...ACTOR, clientId: 'c_2' }, 't_1')).status === 404,
    'and so is another company’s, for the same reason as the rename',
  )
  ok(f.deleted.length === 0, 'none of which deleted anything')
}

/* --- delete: the leads survive it ----------------------------------------- */
{
  const f = fakeStore({ rows: HOME, held: 42 })
  const res = await deleteTerritory({ DB: f.db }, ACTOR, 't_1')

  ok(res.ok === true && res.released === 42, `the leads it held are reported (${res.released})`)
  ok(f.deleted.length === 1, 'the territory row is deleted')

  const onProps = f.sqls.filter((q) => /UPDATE properties|DELETE FROM properties/.test(q.sql))
  ok(onProps.length === 1, `exactly one statement touches the leads (${onProps.length})`)
  /*
    The assertion this whole block exists for. `DELETE FROM properties` here
    would destroy a few hundred houses, their visit history and their contact
    details, and the returned count would look identical.
  */
  ok(
    !onProps.some((q) => /DELETE FROM properties/.test(q.sql)),
    'and it is an update, not a delete — the houses are not erased',
  )
  ok(
    /territory_id = NULL/.test(onProps[0].sql),
    'the leads are returned to the unassigned bucket',
  )
  ok(
    !/assigned_rep_id/.test(onProps[0].sql),
    'and keep whoever was walking them — deleting a patch is not unassigning a rep',
  )
  ok(
    /client_id = \?2/.test(onProps[0].sql),
    'scoped to the caller’s company, so an id cannot reach across tenants',
  )
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== territories OK ===')
process.exit(fails.length ? 1 : 0)
