import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tiler, buildingRow, canonStreet, inUS, featureToTileRow, groupOverlaps, parseBbox, parseFieldMap, snapBoxToTiles, tileBounds, tileFor as tilerTileFor, toTileRow } from './lib/address-tiles.mjs'

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
await build({ entryPoints: ['src/geo.ts'], bundle: true, format: 'esm', outfile: join(dir, 'geo.mjs'), logLevel: 'silent' })
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
  const b = tileBounds(t.x, t.y)
  ok(b.xmin <= -97.68 && -97.68 < b.xmax && b.ymin <= 30.51 && 30.51 < b.ymax, 'tileBounds is the inverse of tileFor: the point lies in its tile’s box', JSON.stringify(b))
  const nw0 = tilerTileFor(b.xmin + 1e-9, b.ymax - 1e-9), se0 = tilerTileFor(b.xmax - 1e-9, b.ymin + 1e-9)
  ok(nw0.x === t.x && nw0.y === t.y && se0.x === t.x && se0.y === t.y, 'and the corners of that box are still the same tile')
  const asked = parseBbox('-97.69,30.505,-97.67,30.515')
  const snapped = snapBoxToTiles(asked)
  ok(snapped.xmin <= asked.xmin && snapped.ymin <= asked.ymin && snapped.xmax >= asked.xmax && snapped.ymax >= asked.ymax, 'a build box is widened to the whole tiles it touches, never narrowed')
  const nw = tilerTileFor(snapped.xmin + 1e-9, snapped.ymax - 1e-9), se = tilerTileFor(snapped.xmax - 1e-9, snapped.ymin + 1e-9)
  ok(nw.x === snapped.tiles.x0 && nw.y === snapped.tiles.y0 && se.x === snapped.tiles.x1 && se.y === snapped.tiles.y1, 'and its edges are tile edges, so a neighbouring build rewrites a shared tile whole')
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
  // Two sources, two spellings, one door: a county file beside Overture.
  ok(canonStreet('NE 78TH ST') === canonStreet('Northeast 78th Street') && canonStreet('SE Rex St.') === canonStreet('Southeast Rex Street'), 'a county spelling and an Overture spelling of a street compare equal', canonStreet('NE 78TH ST'))
  ok(canonStreet('NE 78th Ave') !== canonStreet('NE 78th St'), 'but an avenue and a street of the same number do not')
  {
    const both = new Tiler()
    both.add(['1204', 'Northeast 78th Street', null, 'Vancouver', 'WA', '98665', -122.66, 45.67])
    const second = both.add(['1204', 'NE 78TH ST', null, 'VANCOUVER', 'WA', '98665', -122.66001, 45.67001])
    const third = both.add(['1206', 'NE 78TH ST', null, 'VANCOUVER', 'WA', '98665', -122.66002, 45.67])
    ok(!second && third && both.count === 2, 'so a door already in Overture is not added again from the county, and its neighbour is', `${both.count}`)
  }
  ok(groupOverlaps({ 'bbox.xmin': { min_value: -98 }, 'bbox.xmax': { max_value: -97.5 }, 'bbox.ymin': { min_value: 30 }, 'bbox.ymax': { max_value: 31 } }, parseBbox('-97.7,30.5,-97.6,30.6')), 'a row group whose box overlaps is read')
  ok(!groupOverlaps({ 'bbox.xmin': { min_value: -120 }, 'bbox.xmax': { max_value: -110 }, 'bbox.ymin': { min_value: 30 }, 'bbox.ymax': { max_value: 31 } }, parseBbox('-97.7,30.5,-97.6,30.6')), 'one that does not is skipped — that is what keeps a metro to a minute')
  ok(groupOverlaps({}, parseBbox('-97.7,30.5,-97.6,30.6')), 'a group with no statistics is read rather than assumed empty')
  // A county's address file: parts in named fields, or one whole-address field.
  const parts = parseFieldMap('number=ADDNUM,street=STREET,unit=UNIT,city=CITY,zip=ZIP')
  const pt = { type: 'Feature', properties: { ADDNUM: 104, STREET: 'Cypress Ridge Dr', UNIT: '', CITY: 'Powdersville', ZIP: '29642' }, geometry: { type: 'Point', coordinates: [-82.4921234567, 34.7812345678] } }
  ok(JSON.stringify(featureToTileRow(pt, parts, { state: 'SC' })) === JSON.stringify(['104', 'Cypress Ridge Dr', null, 'Powdersville', 'SC', '29642', -82.492123, 34.781235]), 'a county address point becomes a tile row, the state filled from --state', JSON.stringify(featureToTileRow(pt, parts, { state: 'SC' })))
  const whole = parseFieldMap('address=SITEADDR,zip=ZIP')
  const parcel = { type: 'Feature', properties: { SITEADDR: '12 Oak Ct', ZIP: '29673' }, geometry: { type: 'Polygon', coordinates: [[[-82.50, 34.70], [-82.49, 34.70], [-82.49, 34.71], [-82.50, 34.71], [-82.50, 34.70]]] } }
  const pr = featureToTileRow(parcel, whole, { state: 'SC' })
  ok(pr?.[0] === '12' && pr?.[1] === 'Oak Ct' && Math.abs(pr[6] + 82.495) < 1e-6 && Math.abs(pr[7] - 34.705) < 1e-6, 'a parcel with one address field is split at the number and placed at its middle', JSON.stringify(pr))
  ok(featureToTileRow({ properties: { SITEADDR: '0 Unknown Rd' }, geometry: { type: 'Point', coordinates: [-82.5, 34.7] } }, whole) === null, 'a county row numbered 0 (no house yet) is dropped')
  ok(featureToTileRow({ properties: { ADDNUM: 5, STREET: 'X' }, geometry: null }, parts) === null, 'and so is one with no point')
  let bad = null
  try { parseFieldMap('number=A') } catch (e) { bad = e.message }
  ok(/street=/.test(bad ?? ''), 'a field map with no street is refused, saying what it needs')
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
      if (/FROM territories/.test(sql)) return args[0] === 't_a' && args[1] === 'c_1' ? { id: 't_a', name: 'Territory A', boundary: boundary ? JSON.stringify(boundary) : null } : null
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
        inserted.push({ id: a[0], address1: a[2], zip: a[5], territory: a[8], rep: a[9], provider: a[11], confidence: a[12], residential: a[13] })
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
  // 14 Inside St is a lead by its exact key. 12 Inside St is one under a
  // spelling the key does not fold ("Insde") and a pin a few metres off, so
  // only the same-door rule can find it. 10 Inside St has a lead with the
  // same number forty metres away — a different house, still made.
  const existing = [
    { id: 'p_old12', address1: '12 Insde St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51004, lng: -97.67005 },
    { id: 'p_old14', address1: '14 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 0, lng: 0 },
    { id: 'p_far10', address1: '10 Insde St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.50536, lng: -97.675 },
  ]
  const w = fakeDb({ existing })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.found === 4 && res.created === 2 && res.existed === 2, 'a house that is already a lead — by key, or the same door a few metres off — is counted, not created twice', JSON.stringify(res))
  ok(!w.inserted.some((r) => r.address1.startsWith('12 ') || r.address1.startsWith('14 ')), 'and neither of them was written')
  ok(w.inserted.some((r) => r.address1 === '10 Inside St'), 'the same number forty metres off is another house, and is made')
}

{
  // The building at 16 is a lead; its unit B is its own door. 12 Elm St and
  // 12 Inside Dr sit where 12 Inside St is — other streets, so other houses.
  const existing = [
    { id: 'p_old16', address1: '16 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.518, lng: -97.662 },
    { id: 'p_elm12', address1: '12 Elm St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.510, lng: -97.670 },
    { id: 'p_dr12', address1: '12 Inside Dr', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51002, lng: -97.67002 },
  ]
  const w = fakeDb({ existing })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.created === 4 && res.existed === 0, 'a unit at a building that is a lead, and the same number on another street (Elm St, Inside Dr) a few metres off, are still made', JSON.stringify(res))
  ok(w.inserted.some((r) => r.address1 === '16 Inside St B') && w.inserted.some((r) => r.address1 === '12 Inside St'), 'both of them')
}

{
  const other = await worker.generateLeadsForTerritory(fakeDb().env, { ...MANAGER, clientId: 'c_2' }, 't_a')
  ok(other.status === 404, 'another company’s manager is told there is no such territory', `${other.status}`)
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

/* --- rooftops: homes only, and the doors the address data missed ----------- */
// One tile, as before, now with rooftops beside it under b1/. Round Rock
// coordinates inside BOX; a metre is about 0.000009 degrees here.
const roofBucket = (addrRows, roofRows) => ({
  async get(key) {
    if (key === worker.tileKey(t.x, t.y) && addrRows) return { async json() { return addrRows } }
    if (key === `b1/14/${t.x}/${t.y}.json` && roofRows) return { async json() { return roofRows } }
    return null
  },
})
const HOUSE_ADDR = ['10', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.675, 30.505]
const SHOP_ADDR = ['500', 'Main St', null, 'Round Rock', 'TX', '78664', -97.668, 30.512]
const ROOFS = [
  [-97.67501, 30.50501, 'u'], // the house at 10 Inside St
  [-97.66801, 30.51201, 'n'], // the shop at 500 Main St
  [-97.66500, 30.51500, 'r'], // a house the address data has no address for
  [-97.66200, 30.51800, 'u'], // and another
]
const realFetch = globalThis.fetch
const geocodio = (answer) => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return answer(JSON.parse(init.body), String(url))
  }
  return calls
}
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const named = (q, number, street) => {
  const [lat, lng] = q.split(',').map(Number)
  return { response: { results: [{ address_components: { number, formatted_street: street, city: 'Round Rock', state: 'TX', zip: '78664', country: 'US' }, location: { lat, lng }, accuracy_type: 'rooftop' }] } }
}

{
  // No key: the house on a shop's roof is skipped; the doors with no address are counted and said.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR, SHOP_ADDR], ROOFS)
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.nonResidential === 1 && !w.inserted.some((r) => r.address1.startsWith('500 ')), 'an address on a building Overture calls commercial does not become a lead', JSON.stringify(res))
  ok(res.created === 1 && w.inserted[0].address1 === '10 Inside St', 'the house does')
  ok(res.rooftops === 4 && res.withoutAddress === 2 && res.geocoder === 'off' && res.resolved === 0, 'two home rooftops have no address, and with no Geocodio key that is counted, not guessed', JSON.stringify(res))
}

{
  // With a key: Geocodio names them; the pin stays on the roof; the key never reaches a log.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR, SHOP_ADDR], ROOFS)
  w.env.GEOCODIO_API_KEY = 'test-key'
  const calls = geocodio((qs) => reply(200, { results: qs.map((q, i) => named(q, String(20 + i * 2), 'Oak Ridge Dr')) }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(calls.length === 1 && calls[0].body.length === 2 && /\/reverse\?api_key=test-key$/.test(calls[0].url), 'one batched reverse look-up, for just the two rooftops with no address', `${calls.length} calls, ${calls[0]?.body.length}`)
  ok(res.resolved === 2 && res.created === 3 && res.geocoder === 'on', 'both are named and become leads beside the house', JSON.stringify(res))
  const g = w.inserted.filter((r) => /Oak Ridge Dr/.test(r.address1))
  ok(g.length === 2 && g.every((r) => r.provider === 'geocodio'), 'recorded as Geocodio’s, not Overture’s', JSON.stringify(g))
}

{
  // A result 200 m away is another house; one that is not a street address is nothing.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR], ROOFS)
  w.env.GEOCODIO_API_KEY = 'k'
  geocodio((qs) => reply(200, { results: [
    { response: { results: [{ address_components: { number: '9', formatted_street: 'Far Rd', country: 'US' }, location: { lat: 30.517, lng: -97.665 }, accuracy_type: 'rooftop' }] } },
    { response: { results: [{ address_components: { formatted_street: 'Some Rd', country: 'US' }, location: { lat: 30.518, lng: -97.662 }, accuracy_type: 'street_center' }] } },
  ] }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(res.resolved === 0 && res.unresolved === 2 && res.created === 1, 'a far-off result and a street-centre guess are counted unresolved, not made leads', JSON.stringify(res))
}

{
  // Two rooftops, one address (a house and its garage): one lead.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR], ROOFS)
  w.env.GEOCODIO_API_KEY = 'k'
  geocodio((qs) => reply(200, { results: qs.map((q) => named(q, '30', 'Oak Ridge Dr')) }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(w.inserted.filter((r) => r.address1 === '30 Oak Ridge Dr').length === 1 && res.existed === 1, 'two rooftops that name one address make one lead', JSON.stringify(res))
}

{
  // An address published at the curb, 30 m in front of its house: the house is
  // named, not "a home with no address" that a Census estimate is invented for.
  const w = fakeDb()
  const curb = ['40', 'Inside St', null, 'Round Rock', 'TX', '78664', -97.6720, 30.5070]
  w.env.ADDRESSES = roofBucket([curb], [[-97.6720, 30.50727, 'u'], [-97.6650, 30.5150, 'u']])
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.created === 1 && res.withoutAddress === 1, 'a house whose address point is at the curb is named by it; only the house with nothing near is left unnamed', JSON.stringify({ created: res.created, withoutAddress: res.withoutAddress }))
}

{
  // A complex: six units listed at one point, four buildings around it within
  // 70 m. Every building belongs to the complex — none gets an estimate — and
  // a house well beyond it still does.
  const w = fakeDb()
  const units = [1, 2, 3, 4, 5, 6].map((u) => ['200', 'Inside St', String(u), 'Round Rock', 'TX', '78664', -97.6700, 30.5100])
  const around = [[-97.6700, 30.50955, 'u'], [-97.6700, 30.51045, 'u'], [-97.67052, 30.5100, 'u'], [-97.66948, 30.5100, 'u']]
  w.env.ADDRESSES = roofBucket(units, [...around, [-97.6630, 30.5170, 'u']])
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.created === 6, 'the six units become six leads', `${res.created}`)
  ok(res.withoutAddress === 1, 'the complex’s four buildings are its own, not four houses with no address; the far house still is', `${res.withoutAddress}`)
}

{
  // The provider times out: the addresses the data had are still written, and the failure is said.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR], ROOFS)
  w.env.GEOCODIO_API_KEY = 'k'
  geocodio(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(!('error' in res) && res.created === 1, 'a Geocodio timeout does not fail the territory — the addresses it had are written', JSON.stringify(res))
  ok(res.lookupFailed === 2 && /did not answer within 25s/.test(res.lookupError ?? ''), 'and the rooftops it could not name are counted, with the reason', res.lookupError)
  ok(!JSON.stringify(res).includes('k&') && !/api_key/.test(res.lookupError ?? ''), 'the reason never carries the key')
}

{
  // The provider refuses the key.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR], ROOFS)
  w.env.GEOCODIO_API_KEY = 'bad'
  geocodio(() => reply(403, { error: 'Invalid API key' }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(res.lookupFailed === 2 && /403: Invalid API key/.test(res.lookupError ?? ''), 'a refused key is reported as Geocodio said it', res.lookupError)
}

{
  // Nothing built here at all: said as "no data", not as "no houses".
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket(null, null)
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.coverage === 'none' && res.found === 0 && res.created === 0, 'an area with no data answers coverage "none", so the console can say so', JSON.stringify(res))
  const w2 = fakeDb()
  w2.env.ADDRESSES = roofBucket(null, ROOFS.slice(2))
  const res2 = await worker.generateLeadsForTerritory(w2.env, MANAGER, 't_a')
  ok(res2.coverage === 'rooftops' && res2.withoutAddress === 2, 'an area with rooftops but no address list answers "rooftops"', JSON.stringify(res2))
}

{
  // Outside the United States.
  const LONDON = [{ lat: 51.50, lng: -0.13 }, { lat: 51.51, lng: -0.13 }, { lat: 51.51, lng: -0.12 }]
  const w = fakeDb({ boundary: LONDON })
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.status === 400 && res.code === 'outside_us', 'a territory outside the U.S. is told the look-up is U.S.-only', JSON.stringify(res))
}

{
  // A huge patch: at most MAX_LOOKUPS rooftops per press, and the rest said.
  const roofs = []
  for (let i = 0; i < worker.MAX_LOOKUPS + 30; i++) roofs.push([-97.679 + (i % 60) * 0.0003, 30.501 + Math.floor(i / 60) * 0.0003, 'u'])
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([], roofs)
  w.env.GEOCODIO_API_KEY = 'k'
  const calls = geocodio((qs) => reply(200, { results: qs.map(() => ({ response: { results: [] } })) }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  const sent = calls.reduce((a, c) => a + c.body.length, 0)
  ok(sent === worker.MAX_LOOKUPS && res.lookupSkipped === 30 && calls.every((c) => c.body.length <= 500), `a press looks up at most ${worker.MAX_LOOKUPS} rooftops, in batches, and counts the rest`, `${sent} sent in ${calls.length} batches, ${res.lookupSkipped} skipped`)
}

/* --- Census street ranges: the free estimate for roofs with no address ---------- */
{
  // Cypress Ridge Dr runs west→east along lat 30.5100 across the tile, 100–198
  // on the left (north) side and 101–199 on the right (south). Four roofs: two
  // north of it (one a quarter along, one three quarters), one south, and one
  // 150 m away from any street.
  const rangeBucket = (roofs, extraKeys = {}) => ({
    async get(key) {
      if (key === `r1/14/${t.x}/${t.y}.json`) return { async json() { return [['Cypress Ridge Dr', 100, 198, 101, 199, '78664', '78665', 'TX', [-97.6780, 30.5100, -97.6620, 30.5100]]] } }
      if (key === `b1/14/${t.x}/${t.y}.json`) return { async json() { return roofs } }
      if (extraKeys[key]) return { async json() { return extraKeys[key] } }
      return null
    },
  })
  const q = -97.6780 + 0.25 * 0.016, tq = -97.6780 + 0.75 * 0.016
  const ROOFS = [[q, 30.5102, 'r'], [tq, 30.5102, 'u'], [q, 30.5098, 'u'], [-97.6700, 30.5150, 'u']]
  const w = fakeDb()
  w.env.ADDRESSES = rangeBucket(ROOFS)
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  const est = w.inserted.filter((r) => r.provider === 'census_tiger')
  ok(est.length === 3 && res.interpolated === 3 && res.unranged === 1, 'three roofs near a numbered street are named from its Census range; the one 150 m from any street is not', JSON.stringify(res))
  const byLng = (lng, lat) => est.find((r) => r.address1 && w.inserted) && est
  const north1 = est.find((r) => /^1[0-9][0-9] Cypress/.test(r.address1) && Number(r.address1.split(' ')[0]) % 2 === 0 && Number(r.address1.split(' ')[0]) < 140)
  const north3 = est.find((r) => Number(r.address1.split(' ')[0]) % 2 === 0 && Number(r.address1.split(' ')[0]) > 160)
  const south = est.find((r) => Number(r.address1.split(' ')[0]) % 2 === 1)
  ok(north1?.address1 === '124 Cypress Ridge Dr' && north3?.address1 === '174 Cypress Ridge Dr', 'the left side is even, and the number follows the roof along the block (¼ → 124, ¾ → 174)', JSON.stringify(est.map((r) => r.address1)))
  ok(south?.address1 === '125 Cypress Ridge Dr' && south.zip === '78665', 'the right side is odd, with the right side’s ZIP', JSON.stringify(south))
  ok(est.every((r) => r.confidence === 'INTERPOLATED'), 'every one is stored as INTERPOLATED, never as an address point')
  ok(est.find((r) => r.address1 === '124 Cypress Ridge Dr')?.residential === 'RESIDENTIAL' && south?.residential === 'UNKNOWN', 'a roof Overture calls a house is RESIDENTIAL; an unclassified one stays UNKNOWN')
  ok(res.coverageStatus === 'LIMITED' && res.pointCoverage === 0 && res.bySource.census_tiger === 3 && res.bySource.overture === 0, 'with no address points the area is LIMITED, and says where its leads came from', JSON.stringify({ s: res.coverageStatus, c: res.pointCoverage, b: res.bySource }))
  ok(res.geocoder === 'off' && res.resolved === 0, 'no paid look-up was needed or made')
}

{
  // Two roofs a metre apart land on the same number: the second steps to the next on that side.
  const w = fakeDb()
  const q = -97.6780 + 0.25 * 0.016
  w.env.ADDRESSES = { async get(key) {
    if (key === `r1/14/${t.x}/${t.y}.json`) return { async json() { return [['Cypress Ridge Dr', 100, 198, 101, 199, '78664', '78665', 'TX', [-97.6780, 30.5100, -97.6620, 30.5100]]] } }
    if (key === `b1/14/${t.x}/${t.y}.json`) return { async json() { return [[q, 30.5102, 'u'], [q + 0.00001, 30.5102, 'u']] } }
    return null
  } }
  await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  const got = w.inserted.map((r) => r.address1).sort()
  ok(got.length === 2 && got[0] !== got[1] && got.every((a) => Number(a.split(' ')[0]) % 2 === 0), 'two roofs that estimate to one number become two leads, both on the even side', JSON.stringify(got))
}

{
  // With a Geocodio key, only the roof no street is near is sent.
  const w = fakeDb()
  const q = -97.6780 + 0.25 * 0.016
  w.env.ADDRESSES = { async get(key) {
    if (key === `r1/14/${t.x}/${t.y}.json`) return { async json() { return [['Cypress Ridge Dr', 100, 198, 101, 199, '78664', '78665', 'TX', [-97.6780, 30.5100, -97.6620, 30.5100]]] } }
    if (key === `b1/14/${t.x}/${t.y}.json`) return { async json() { return [[q, 30.5102, 'u'], [-97.6700, 30.5150, 'u']] } }
    return null
  } }
  w.env.GEOCODIO_API_KEY = 'k'
  const calls = geocodio((qs) => reply(200, { results: qs.map((qq) => named(qq, '9', 'Far Ln')) }))
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  globalThis.fetch = realFetch
  ok(calls.length === 1 && calls[0].body.length === 1, 'the free estimate comes first: Geocodio is asked only about the roof no numbered street is near', `${calls.map((c) => c.body.length)}`)
  ok(res.bySource.census_tiger === 1 && res.bySource.geocodio === 1 && w.inserted.find((r) => r.provider === 'geocodio')?.confidence === 'GEOCODED', 'and its answer is stored as GEOCODED, apart from the estimates', JSON.stringify(res.bySource))
}

{
  // Address points present: GOOD coverage, ADDRESS_POINT confidence.
  const w = fakeDb()
  w.env.ADDRESSES = roofBucket([HOUSE_ADDR, SHOP_ADDR], [[-97.67501, 30.50501, 'r'], [-97.66801, 30.51201, 'n']])
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  ok(res.coverageStatus === 'GOOD' && res.pointCoverage === 100 && w.inserted[0]?.confidence === 'ADDRESS_POINT' && w.inserted[0]?.residential === 'RESIDENTIAL', 'where every home has an address point the area is GOOD, and its leads are ADDRESS_POINT', JSON.stringify({ s: res.coverageStatus, c: res.pointCoverage, i: w.inserted[0] }))
}

/* --- rooftop rows at build time ------------------------------------------------ */
{
  const box = (w, h) => ({ xmin: -97.67, xmax: -97.67 + w / (111320 * Math.cos((30.51 * Math.PI) / 180)), ymin: 30.51, ymax: 30.51 + h / 110540 })
  ok(buildingRow({ bbox: box(12, 15), subtype: 'residential', class: 'house' })?.[2] === 'r', 'a residential building is a home')
  ok(buildingRow({ bbox: box(12, 15) })?.[2] === 'u', 'an unclassified house-sized building is kept as a likely home')
  ok(buildingRow({ bbox: box(60, 60), subtype: 'commercial' })?.[2] === 'n', 'a commercial one is marked not a home')
  ok(buildingRow({ bbox: box(80, 80) })?.[2] === 'n', 'an unclassified one too big to be a house is marked not a home')
  ok(buildingRow({ bbox: box(4, 5) }) === null && buildingRow({ bbox: box(8, 8), class: 'garage' }) === null, 'sheds and garages are dropped')
  ok(inUS(-82.49, 34.78) && inUS(-157.85, 21.3) && !inUS(-0.13, 51.5), 'the U.S. boxes hold Powdersville and Honolulu, and not London')
}

/* --- inclusion: inside the line, or on it ------------------------------------ */
//
// A territory drawn along a street runs its line through the houses, and each
// house is one point that lands a few metres to one side of it. The real case
// behind this section: a three-point territory in Clackamas County, OR, where
// the data held 6 address points strictly inside and 9 more 1.3–4.8 m outside
// — every one a house the line crossed — and the next at 8.6 m. Only 6 leads
// were made. Built here in metres around a point in the Round Rock tile.
{
  const geo = await import(join(dir, 'geo.mjs'))
  const O = { lat: 30.51, lng: -97.67 }
  const kx = 111320 * Math.cos((O.lat * Math.PI) / 180), ky = 110574
  const at = (east, north) => ({ lat: O.lat + north / ky, lng: O.lng + east / kx })
  const row = (n, street, p, unit = null) => [String(n), street, unit, 'Round Rock', 'TX', '78664', Number(p.lng.toFixed(7)), Number(p.lat.toFixed(7))]
  // An 80 m square, west edge at 0 m, east edge at 80 m.
  const SQ = [at(0, 0), at(80, 0), at(80, 80), at(0, 80)]

  ok(geo.placeInTerritory(at(40, 40), SQ) === 'inside', 'a house in the middle of the territory is inside')
  ok(geo.placeInTerritory(at(200, 40), SQ) === 'outside', 'one 120 m away is outside')
  ok(geo.placeInTerritory(at(80, 40), SQ) !== 'outside' && geo.placeInTerritory(at(80, 80), SQ) !== 'outside', 'a point exactly on an edge, or on a corner, counts — never dropped for landing on the line')
  ok(geo.placeInTerritory(at(83, 40), SQ) === 'edge', '3 m outside: on the edge, the line runs through that house')
  ok(geo.placeInTerritory(at(85.5, 40), SQ) === 'outside', '5.5 m outside is the house next door, and stays out')
  ok(Math.abs(geo.metresToEdge(at(83, 40), SQ) - 3) < 0.05, 'distance to the line is measured in metres', geo.metresToEdge(at(83, 40), SQ).toFixed(3))
  // Concave: an L, with the notch (40..80, 40..80) cut out.
  const L = [at(0, 0), at(80, 0), at(80, 40), at(40, 40), at(40, 80), at(0, 80)]
  ok(geo.placeInTerritory(at(60, 60), L) === 'outside', 'a concave territory: a house in the notch, 20 m from the line, is out')
  ok(geo.placeInTerritory(at(60, 20), L) === 'inside' && geo.placeInTerritory(at(20, 60), L) === 'inside', 'and houses in both arms are in')
  ok(geo.placeInTerritory(at(42, 60), L) === 'edge', 'a house the notch’s line runs through is in')
  const tiny = [at(0, 0), at(15, 0), at(0, 15)]
  ok(geo.placeInTerritory(at(4, 4), tiny) === 'inside', 'a small territory (15 m triangle) still finds the house inside it')

  // The Clackamas case, rebuilt: 6 inside, 9 on the line at the measured
  // distances, 2 just beyond (8.6 and 11.2 m), 1 far off.
  const inside6 = [[10, 10], [30, 20], [50, 30], [70, 40], [20, 60], [60, 70]].map(([e, n], i) => row(100 + i * 2, 'Swallowtail Pl', at(e, n)))
  const edge9 = [1.3, 1.8, 2.6, 2.6, 3.2, 3.3, 3.3, 4.1, 4.8].map((d, i) => row(201 + i * 2, 'Swallowtail Pl', at(80 + d, 5 + i * 8)))
  const beyond = [row(301, 'Tidewater St', at(88.6, 30)), row(303, 'Tidewater St', at(91.2, 50)), row(999, 'Far Rd', at(400, 400))]
  const CASE = [...inside6, ...edge9, ...beyond]
  const w = fakeDb({ boundary: SQ })
  w.env.ADDRESSES = bucket(CASE)
  const res = await worker.generateLeadsForTerritory(w.env, MANAGER, 't_a')
  const d = res.diagnostics ?? {}
  ok(res.created === 15, 'the case that made 6 leads: all 15 houses in or on the line become leads', `${res.created} created`)
  ok(d.insidePolygon === 6 && d.onEdge === 9, 'counted as 6 inside and 9 on the edge', JSON.stringify({ i: d.insidePolygon, e: d.onEdge }))
  ok(!w.inserted.some((r) => /^(301|303|999) /.test(r.address1)), 'the houses 8.6 m and 11.2 m out, and the one far off, are not leads')
  ok(d.outsidePolygon === 3 && d.recordsRead === CASE.length, 'and the diagnostics account for every row read', JSON.stringify(d))
  ok(d.created === 15 && d.existingLead === 0 && d.invalid === 0 && d.duplicateInData === 0 && d.insertIgnored === 0 && typeof d.rule === 'string', 'with each reason for leaving one out counted, and the rule in words')

  // Close together, duplicates, bad data, existing leads, and 20 in a concave shape.
  const close = [row(10, 'Pine St', at(40, 40)), row(12, 'Pine St', at(42, 40)), row(14, 'Pine St', at(40, 40), '1'), row(14, 'Pine St', at(40, 40), '2')]
  const dupe = [row(20, 'Oak St', at(20, 20)), row(20, 'Oak St', at(20, 20))]
  const bad = [['30', 'Elm St', null, 'Round Rock', 'TX', '78664', null, null], ['', 'Nameless', null, 'Round Rock', 'TX', '78664', at(30, 30).lng, at(30, 30).lat]]
  const w2 = fakeDb({ boundary: SQ, existing: [{ id: 'p_old', address1: '10 Pine St', city: 'Round Rock', state: 'TX', zip: '78664', lat: at(40, 40).lat, lng: at(40, 40).lng }] })
  w2.env.ADDRESSES = bucket([...close, ...dupe, ...bad])
  const r2 = await worker.generateLeadsForTerritory(w2.env, MANAGER, 't_a')
  const d2 = r2.diagnostics ?? {}
  ok(w2.inserted.some((r) => r.address1 === '12 Pine St'), 'two houses 2 m apart are two leads')
  ok(w2.inserted.filter((r) => /^14 Pine St/.test(r.address1)).length === 2, 'two units at one point are two leads')
  ok(w2.inserted.filter((r) => r.address1 === '20 Oak St').length === 1 && d2.duplicateInData === 1, 'the same address listed twice is one lead, and counted as a duplicate')
  ok(!w2.inserted.some((r) => r.address1 === '10 Pine St') && d2.existingLead === 1, 'an address that is already a lead is not made again, and is counted', JSON.stringify(d2))
  ok(d2.invalid === 2 && !w2.inserted.some((r) => /Elm|Nameless/.test(r.address1)), 'a row with no coordinates and one with no number are counted as invalid, not guessed at')

  const twenty = []
  for (let i = 0; i < 10; i++) twenty.push(row(400 + i * 2, 'Arm A Ct', at(8 + i * 7, 15)))
  for (let i = 0; i < 10; i++) twenty.push(row(500 + i * 2, 'Arm B Ct', at(15, 45 + i * 3)))
  const notch = [row(600, 'Notch Ln', at(60, 60)), row(602, 'Notch Ln', at(70, 55))]
  const w3 = fakeDb({ boundary: L })
  w3.env.ADDRESSES = bucket([...twenty, ...notch])
  const r3 = await worker.generateLeadsForTerritory(w3.env, MANAGER, 't_a')
  ok(r3.created === 20, 'a concave territory holding 20 houses makes 20 leads', `${r3.created}`)
  ok(!w3.inserted.some((r) => /Notch Ln/.test(r.address1)), 'and none from the notch it leaves out')

  // A house just past the line can sit in the next map tile.
  const tb = tileBounds(t.x, t.y)
  const edgeX = tb.xmax - 2 / kx // the territory's east edge, 2 m inside this tile
  const nextTile = { x: t.x + 1, y: t.y }
  const beside = [String(700), 'Border Rd', null, 'Round Rock', 'TX', '78664', Number((edgeX + 3 / kx).toFixed(7)), 30.51]
  const EDGEBOX = [{ lat: 30.5095, lng: edgeX - 60 / kx }, { lat: 30.5095, lng: edgeX }, { lat: 30.5105, lng: edgeX }, { lat: 30.5105, lng: edgeX - 60 / kx }]
  const w4 = fakeDb({ boundary: EDGEBOX })
  w4.env.ADDRESSES = { async get(key) { return key === worker.tileKey(nextTile.x, nextTile.y) ? { async json() { return [beside] } } : key === worker.tileKey(t.x, t.y) ? { async json() { return [] } } : null } }
  const r4 = await worker.generateLeadsForTerritory(w4.env, MANAGER, 't_a')
  ok(worker.tileFor(beside[6], beside[7]).x === nextTile.x, 'the fixture house really is in the neighbouring tile')
  ok(r4.created === 1, 'a house on the line whose point lies in the next map tile is still read and made a lead', `${r4.created}`)
}

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== addresses OK ===')
