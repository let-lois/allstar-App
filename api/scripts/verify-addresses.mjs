import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tiler, groupOverlaps, parseBbox, tileFor as tilerTileFor, toTileRow } from './lib/address-tiles.mjs'

/**
 * The houses inside a territory, made into leads — without a bucket or a database.
 *
 * Two halves. The tiler (`lib/address-tiles.mjs`) is what `addresses:build`
 * runs over Overture's rows; the Worker (`src/addresses.ts`) reads what it
 * wrote. They agree on tile arithmetic or nothing lines up, so that is the
 * first thing pinned. Then the Worker's look-up over a stand-in bucket, and
 * the lead-making over a stand-in database: what is a duplicate, what was
 * erased, who gets the house, and what a deployment with no data says.
 */

const dir = mkdtempSync(join(tmpdir(), 'addr-'))
const out = join(dir, 'addresses.mjs')
await build({ entryPoints: ['src/addresses.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const worker = await import(out)

const fails = []
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  (${extra})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- tile arithmetic: two copies, one answer ------------------------------ */
{
  const points = [
    [-97.68, 30.51], [-97.6801, 30.5101], [0, 0], [-179.99, 84.9], [179.99, -84.9], [-122.4194, 37.7749], [-97.7431, 30.2672],
  ]
  ok(points.every(([lng, lat]) => {
    const a = tilerTileFor(lng, lat), b = worker.tileFor(lng, lat)
    return a.x === b.x && a.y === b.y
  }), 'the tiler and the Worker put every point in the same tile')
  const t = worker.tileFor(-97.68, 30.51)
  ok(t.x === 3746 && t.y === 6732, 'and it is the Web-Mercator z14 tile a map would name', `${t.x}/${t.y}`)
  ok(worker.tileKey(t.x, t.y) === 'v1/14/3746/6732.json', 'named the way the bucket is laid out')
  const cover = worker.tilesCovering([{ lat: 30.50, lng: -97.70 }, { lat: 30.53, lng: -97.70 }, { lat: 30.53, lng: -97.66 }, { lat: 30.50, lng: -97.66 }])
  ok(cover.length >= 4 && cover.length <= 9 && cover.some((c) => c.x === 3746 && c.y === 6732), 'a small box touches a handful of tiles, including the one its houses are in', `${cover.length}`)
}

/* --- the tiler ------------------------------------------------------------- */
{
  const row = toTileRow({ number: '12', street: 'Inside St', unit: null, postcode: '78664', postal_city: 'Round Rock', address_levels: [{ value: 'TX' }], geometry: { type: 'Point', coordinates: [-97.6701234567, 30.5101234567] } })
  ok(JSON.stringify(row) === JSON.stringify(['12', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.670123, 30.510123]), 'an Overture row becomes a compact tile row, coordinates to six decimals', JSON.stringify(row))
  ok(toTileRow({ street: 'Inside St', geometry: { coordinates: [1, 2] } }) === null, 'a row with no house number is dropped')
  ok(toTileRow({ number: '1', street: 'X', geometry: null }) === null, 'and so is one with no point')
  const tiler = new Tiler()
  tiler.add(row); tiler.add([...row]); tiler.add(['14', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.6702, 30.5102])
  const tiles = [...tiler.entries()]
  ok(tiler.count === 2 && tiles.length === 1 && tiles[0].rows.length === 2, 'the same door twice is one row', `${tiler.count}`)
  ok(tiles[0].rows[0][0] === '12' && tiles[0].rows[1][0] === '14', 'rows come out in street then number order')
  ok(groupOverlaps({ 'bbox.xmin': { min_value: -98 }, 'bbox.xmax': { max_value: -97.5 }, 'bbox.ymin': { min_value: 30 }, 'bbox.ymax': { max_value: 31 } }, parseBbox('-97.7,30.5,-97.6,30.6')), 'a row group whose box overlaps is read')
  ok(!groupOverlaps({ 'bbox.xmin': { min_value: -120 }, 'bbox.xmax': { max_value: -110 }, 'bbox.ymin': { min_value: 30 }, 'bbox.ymax': { max_value: 31 } }, parseBbox('-97.7,30.5,-97.6,30.6')), 'one that does not is skipped — that is what keeps a metro to a minute')
  ok(groupOverlaps({}, parseBbox('-97.7,30.5,-97.6,30.6')), 'a group with no statistics is read rather than assumed empty')
  let threw = null
  try { parseBbox('1,2,3') } catch (e) { threw = e.message }
  ok(/minLng,minLat,maxLng,maxLat/.test(threw ?? ''), 'a malformed --bbox is refused with the shape it wants')
}

/* --- a stand-in bucket ----------------------------------------------------- */
// Four houses on Inside St inside the box, two on Outside Ave beyond it, one
// duplicate spelling of a door, one corner shop with a unit, all in one tile.
const t = worker.tileFor(-97.67, 30.51)
const ROWS = [
  ['10', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.675, 30.505],
  ['12', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.670, 30.510],
  ['12', 'Inside Street', null, 'Round Rock', 'TX', '78664', -97.6700, 30.5100],
  ['14', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.665, 30.515],
  ['16', 'Inside St', 'B', 'Round Rock', 'TX', '78664', -97.662, 30.518],
  ['1', 'Outside Ave', null, 'Round Rock', 'TX', '78664', -97.600, 30.600],
  ['', 'Nameless', null, 'Round Rock', 'TX', '78664', -97.671, 30.511],
]
const bucket = (rows = ROWS) => ({
  async get(key) {
    if (key !== worker.tileKey(t.x, t.y)) return null
    return { async json() { return rows } }
  },
})
const BOX = [{ lat: 30.500, lng: -97.680 }, { lat: 30.520, lng: -97.680 }, { lat: 30.520, lng: -97.660 }, { lat: 30.500, lng: -97.660 }]

{
  const res = await worker.addressesInside({ ADDRESSES: bucket() }, BOX)
  ok(!('error' in res), 'the look-up answers over a bucket')
  ok(res.addresses.length === 4, 'four doors inside the shape — the duplicate spelling, the house outside and the nameless row are not among them', `${res.addresses.length}`)
  ok(res.addresses.some((a) => a.address1 === '16 Inside St B'), 'a unit rides on the address line')
  const none = await worker.addressesInside({}, BOX)
  ok(none.code === 'addresses_not_configured' && none.status === 501, 'with no bucket it says so, in words, as a 501')
  const huge = await worker.addressesInside({ ADDRESSES: bucket() }, [{ lat: 29, lng: -99 }, { lat: 32, lng: -99 }, { lat: 32, lng: -95 }, { lat: 29, lng: -95 }])
  ok(huge.code === 'territory_too_large' && huge.status === 413, 'a shape the size of a county is refused rather than read tile by tile')
}

/* --- a stand-in database ---------------------------------------------------- */
function fakeDb({ existing = [], erased = [], reps = ['u_curtis'], boundary = BOX } = {}) {
  const inserted = []
  const audit = []
  // `bind` answers a new statement, as D1 does: the Worker binds one prepared
  // insert many times and batches the results, so a fake that kept one `args`
  // would record only the last house.
  const statement = (sql, args = []) => ({
    bind(...a) { return statement(sql, a) },
    async first() {
      if (/FROM territories/.test(sql)) return args[0] === 't_a' ? { id: 't_a', name: 'Territory A', boundary: boundary ? JSON.stringify(boundary) : null } : null
      return null
    },
    async all() {
      if (/FROM territory_reps/.test(sql)) return { results: reps.map((user_id) => ({ user_id })) }
      if (/FROM properties/.test(sql)) return { results: existing }
      if (/FROM deletions/.test(sql)) return { results: args.slice(1).filter((id) => erased.includes(id)).map((entity_id) => ({ entity_id })) }
      return { results: [] }
    },
    async run() {
      if (/INSERT INTO audit_log/.test(sql)) audit.push(JSON.parse(args[8] ?? '{}'))
      return { meta: { changes: 1 } }
    },
    _args: () => args,
  })
  const db = {
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      return stmts.map((s) => {
        const a = s._args()
        inserted.push({ id: a[0], address1: a[2], territory: a[8], rep: a[9] })
        return { meta: { changes: 1 } }
      })
    },
  }
  return { env: { DB: db, ADDRESSES: bucket() }, inserted, audit }
}
const MANAGER = { id: 'u_mgr', clientId: 'c_1', role: 'manager', name: 'Ray' }
const REP = { id: 'u_curtis', clientId: 'c_1', role: 'field_rep', name: 'Curtis' }

{
  const w = fakeDb()
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(!('error' in res), 'a manager makes leads from the houses in a territory', res.error)
  ok(res.found === 4 && res.created === 4 && res.existed === 0, 'every door inside becomes a lead', JSON.stringify(res))
  ok(w.inserted.every((r) => r.territory === 't_a'), 'each one in the territory')
  ok(w.inserted.every((r) => r.rep === 'u_curtis'), 'and handed to its sole rep')
  ok(w.inserted.every((r) => /^p_[0-9a-f]{24}$/.test(r.id)), 'with the import’s deterministic id, so a second run writes nothing twice')
  ok(w.audit.length === 1 && w.audit[0].created === 4, 'the audit log records the counts')
}

{
  const w = fakeDb({ reps: ['u_curtis', 'u_matthew'] })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.created === 4 && w.inserted.every((r) => r.rep === null), 'on a shared patch the new houses are handed to nobody — both reps see them anyway')
}

{
  // 12 Inside St is already a lead under a different spelling and a slightly
  // different pin; 14 Inside St is a lead by its exact key.
  const existing = [
    { id: 'p_old12', address1: '12 Inside Street', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51004, lng: -97.67005 },
    { id: 'p_old14', address1: '14 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 0, lng: 0 },
  ]
  const w = fakeDb({ existing })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.found === 4 && res.created === 2 && res.existed === 2, 'a house that is already a lead — by key, or the same door a few metres off — is counted, not created twice', JSON.stringify(res))
  ok(!w.inserted.some((r) => r.address1.startsWith('12 ') || r.address1.startsWith('14 ')), 'and neither of them was written')
}

{
  const w = fakeDb()
  const idOf10 = w.inserted // filled below
  await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  const erasedId = idOf10.find((r) => r.address1 === '10 Inside St').id
  const w2 = fakeDb({ erased: [erasedId] })
  const res = await worker.generateLeadsForTerritory(w2.env, MANAGER, 't_a')
  ok(res.erased === 1 && res.created === 3 && !w2.inserted.some((r) => r.id === erasedId), 'a homeowner who was erased is not made a lead again by a redraw', JSON.stringify(res))
}

{
  const w = fakeDb()
  const rep = await worker.generateLeadsForTerritory(w.env, REP, 't_a')
  ok(rep.status === 403, 'a field rep cannot')
  const gone = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_nope')
  ok(gone.status === 404, 'a territory that is not this company’s is "no such territory"')
  const flat = fakeDb({ boundary: null })
  const noShape = await worker.generateLeadsForTerritory(flat.env, MANAGER, 't_a')
  ok(noShape.status === 400 && noShape.code === 'no_boundary', 'a territory from an import, with no outline, is told to be drawn first')
  const unset = fakeDb(); delete unset.env.ADDRESSES
  const none = await worker.generateLeadsForTerritory(unset.env, MANAGER, 't_a')
  ok(none.status === 501 && none.code === 'addresses_not_configured', 'and a deployment with no address data says so rather than finding nothing')
}

{
  // The cap: more doors than one call writes.
  const many = []
  for (let i = 0; i < worker.MAX_NEW_LEADS + 7; i++) many.push([String(100 + i), 'Cap St', null, 'Round Rock', 'TX', '78664', -97.670 + (i % 50) * 0.0001, 30.510 + Math.floor(i / 50) * 0.00005])
  const w = fakeDb()
  w.env.ADDRESSES = bucket(many)
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.created === worker.MAX_NEW_LEADS && res.skipped === 7, 'past the cap the rest are counted as skipped, and said so', `${res.created} created, ${res.skipped} skipped`)
}

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== addresses OK ===')
