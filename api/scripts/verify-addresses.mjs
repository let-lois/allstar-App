import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tiler, buildingRow, inUS, featureToTileRow, groupOverlaps, parseBbox, parseFieldMap, snapBoxToTiles, tileBounds, tileFor as tilerTileFor, toTileRow } from './lib/address-tiles.mjs'

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

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== addresses OK ===')
