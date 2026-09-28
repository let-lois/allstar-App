import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Many reps on a territory, and what assigning one does to the others.
 *
 * Until `territory_reps`, putting a second person on a patch replaced the
 * first — on the territory and on every lead in it. Every assertion here is
 * about what an assignment leaves alone: the reps already on the patch, and
 * the houses somebody is already working. Pure: `assign.ts` and `lists.ts` are
 * bundled and run against a stand-in database that records the statements.
 */

const dir = mkdtempSync(join(tmpdir(), 'treps-'))
const out = join(dir, 'assign.mjs')
await build({ entryPoints: ['src/assign.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const { assignTerritory } = await import(out)
const outLists = join(dir, 'lists.mjs')
await build({ entryPoints: ['src/lists.ts'], bundle: true, format: 'esm', outfile: outLists, logLevel: 'silent' })
const { repScopeSql } = await import(outLists)

const fails = []
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  (${extra})` : ''}`)
  if (!cond) fails.push(msg)
}

const MANAGER = { id: 'u_mgr', clientId: 'c_1', role: 'manager', name: 'Ray' }
const REP = { id: 'u_curtis', clientId: 'c_1', role: 'field_rep', name: 'Curtis' }

/**
 * A tenant with one territory, two reps on the team, and four houses in the
 * patch: two Curtis is working, one Matthew is working, one nobody is.
 */
function world({ onPatch = ['u_curtis'] } = {}) {
  const reps = new Set(onPatch.map((r) => `t_a:${r}`))
  const houses = new Map([
    ['h1', { territory: 't_a', rep: 'u_curtis' }],
    ['h2', { territory: 't_a', rep: 'u_curtis' }],
    ['h3', { territory: 't_a', rep: 'u_matthew' }],
    ['h4', { territory: 't_a', rep: null }],
    ['h5', { territory: null, rep: null }],
  ])
  const team = new Set(['u_curtis', 'u_matthew'])
  let primary = onPatch[0] ?? null
  const log = []
  const db = {
    prepare(sql) {
      let args = []
      const api = {
        bind(...a) {
          args = a
          return api
        },
        async first() {
          log.push(sql)
          if (/FROM users/.test(sql)) return team.has(args[0]) && args[1] === 'c_1' ? { id: args[0] } : null
          if (/FROM territories/.test(sql)) return args[0] === 't_a' && args[1] === 'c_1' ? { id: 't_a' } : null
          return null
        },
        async all() {
          log.push(sql)
          if (/FROM territory_reps WHERE territory_id/.test(sql)) {
            return { results: [...reps].filter((k) => k.startsWith(`${args[0]}:`)).map((k) => ({ user_id: k.split(':')[1] })) }
          }
          return { results: [] }
        },
        async run() {
          log.push(sql)
          if (/INSERT OR IGNORE INTO territory_reps/.test(sql)) {
            for (const id of args.slice(3)) reps.add(`${args[0]}:${id}`)
          } else if (/DELETE FROM territory_reps WHERE territory_id = \?1 AND user_id/.test(sql)) {
            reps.delete(`${args[0]}:${args[1]}`)
          } else if (/DELETE FROM territory_reps WHERE territory_id = \?1$/.test(sql.trim())) {
            for (const k of [...reps]) if (k.startsWith(`${args[0]}:`)) reps.delete(k)
          } else if (/UPDATE territories SET rep_id/.test(sql)) {
            primary = args[0]
          } else if (/UPDATE properties SET assigned_rep_id = \?1.*territory_id IS NULL/s.test(sql)) {
            let n = 0
            for (const h of houses.values()) if (h.territory === null) { h.rep = args[0]; n++ }
            return { meta: { changes: n } }
          } else if (/UPDATE properties SET assigned_rep_id = NULL/.test(sql)) {
            let n = 0
            for (const h of houses.values()) if (h.territory === args[2]) { h.rep = null; n++ }
            return { meta: { changes: n } }
          } else if (/UPDATE properties SET assigned_rep_id = \?1.*assigned_rep_id IS NULL/s.test(sql)) {
            let n = 0
            for (const h of houses.values()) if (h.territory === args[3] && h.rep === null) { h.rep = args[0]; n++ }
            return { meta: { changes: n } }
          } else if (/UPDATE properties/.test(sql)) {
            throw new Error(`an UPDATE this test does not expect: ${sql}`)
          }
          return { meta: { changes: 0 } }
        },
      }
      return api
    },
  }
  return { env: { DB: db }, reps, houses, log, primary: () => primary }
}

const repsOn = (w) => [...w.reps].map((k) => k.split(':')[1]).sort()

/* --- adding a second rep keeps the first, and their houses ---------------- */
{
  const w = world()
  const res = await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: 'u_matthew', action: 'add' })
  ok(!('error' in res), 'a manager adds Matthew to a patch Curtis is already on', res.error)
  ok(repsOn(w).join() === 'u_curtis,u_matthew', 'both are on it afterwards', repsOn(w).join())
  ok(res.repIds?.length === 2, 'and the answer names both', JSON.stringify(res.repIds))
  ok(w.houses.get('h1').rep === 'u_curtis' && w.houses.get('h2').rep === 'u_curtis', 'the houses Curtis was working are still his')
  ok(w.houses.get('h3').rep === 'u_matthew', 'and the one Matthew was working is still his')
  ok(w.houses.get('h4').rep === null && res.assigned === 0, 'the unclaimed house stays unclaimed on a shared patch — nobody is handed anything')
  ok(w.primary() === 'u_curtis', 'rep_id still mirrors the first rep, for imports and older readers')
}

/* --- the first rep on an empty patch is handed the unclaimed houses -------- */
{
  const w = world({ onPatch: [] })
  const res = await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: 'u_matthew' })
  ok(repsOn(w).join() === 'u_matthew', 'Matthew goes on the empty patch (no action given means add)')
  ok(res.assigned === 1 && w.houses.get('h4').rep === 'u_matthew', 'as its only rep he is handed the unclaimed house', `${res.assigned}`)
  ok(w.houses.get('h1').rep === 'u_curtis', 'and not a house somebody else is working — that was the old overwrite')
  ok(w.primary() === 'u_matthew', 'rep_id follows')
}

/* --- adding the same person twice is one row --------------------------------- */
{
  const w = world()
  await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: 'u_curtis' })
  ok(repsOn(w).join() === 'u_curtis', 'adding a rep already on the patch changes nothing')
}

/* --- taking a rep off leaves their houses with them --------------------------- */
{
  const w = world({ onPatch: ['u_curtis', 'u_matthew'] })
  const res = await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: 'u_curtis', action: 'remove' })
  ok(repsOn(w).join() === 'u_matthew', 'Curtis comes off the patch, Matthew stays')
  ok(w.houses.get('h1').rep === 'u_curtis', 'the houses Curtis was working keep him — who walks a house and which patch it is in are two facts')
  ok(res.repIds?.length === 1 && res.repIds[0] === 'u_matthew', 'the answer names who is left')
  ok(w.primary() === 'u_matthew', 'rep_id moves to who is left')
}

/* --- clearing a patch is the one action that takes houses away ---------------- */
{
  const w = world({ onPatch: ['u_curtis', 'u_matthew'] })
  const res = await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: null })
  ok(repsOn(w).length === 0, 'the "Unassigned" choice takes everybody off the patch')
  ok(res.assigned === 4 && [...w.houses.values()].filter((h) => h.territory === 't_a').every((h) => h.rep === null), 'and every house in it goes back to nobody — said so, and only here', `${res.assigned}`)
  ok(w.houses.get('h5').rep === null, 'a house outside the patch is untouched')
  ok(w.primary() === null, 'rep_id is cleared')
}

/* --- the unassigned bucket is houses, not a patch ------------------------------- */
{
  const w = world()
  const res = await assignTerritory(w.env, MANAGER, { territoryId: null, repId: 'u_matthew' })
  ok(res.assigned === 1 && w.houses.get('h5').rep === 'u_matthew', 'handing over the unassigned bucket gives every no-territory house to that rep', `${res.assigned}`)
  ok(w.houses.get('h1').rep === 'u_curtis' && repsOn(w).join() === 'u_curtis', 'and touches nothing inside a territory')
}

/* --- what it refuses ------------------------------------------------------------ */
{
  const w = world()
  const rep = await assignTerritory(w.env, REP, { territoryId: 't_a', repId: 'u_matthew' })
  ok(rep.status === 403, 'a field rep cannot assign a territory')
  const stranger = await assignTerritory(w.env, MANAGER, { territoryId: 't_a', repId: 'u_elsewhere' })
  ok(stranger.status === 400, 'a person outside the team cannot be put on a patch')
  const gone = await assignTerritory(w.env, MANAGER, { territoryId: 't_nope', repId: 'u_matthew' })
  ok(gone.status === 404, 'a territory that is not this company’s is "no such territory"')
}

/* --- the phone sees what the patch sees ------------------------------------------ */
{
  const sql = repScopeSql('p', '?2')
  ok(/territory_reps/.test(sql) && /p\.territory_id IN/.test(sql), 'a rep’s scope includes every lead in a territory they are on')
  ok(/assigned_rep_id = \?2/.test(sql) && /lead_list_reps/.test(sql), 'without losing the two ways in it always had')
}

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== territory reps OK ===')
