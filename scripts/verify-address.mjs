import {
  fromGeocoder,
  fromPlaces,
  partsToAddress,
  partsToFields,
  precisionOf,
} from '../src/lib/address.ts'
import { reverseGeocode, __resetReverseCache, __cacheSize } from '../src/lib/reverseGeocode.ts'

/**
 * The address under a tapped pin, as arithmetic and bookkeeping.
 *
 * Pure, and deliberately not a browser test — for the same reason
 * `verify:googlemap` cannot test its own happy path. Reverse geocoding needs a
 * real key on an allowed origin, and a key that works in CI is a key committed
 * somewhere. But almost nothing that can go wrong here needs Google:
 *
 *   **The parser.** Two Google APIs describe an address with the same
 *   information under different key names — `longText`/`shortText` from Places,
 *   `long_name`/`short_name` from the Geocoder. One preference order now serves
 *   both; if it stops serving one of them, that is a silent wrong city on every
 *   lead from that path.
 *
 *   **The cache.** This is billed per request, in an app a rep taps all day.
 *   The cache is the difference between a bill that tracks how many houses get
 *   added and one that tracks how much the map gets touched. A cache that
 *   quietly stops hitting is invisible in the UI and arrives as an invoice.
 *
 *   **The coarse rule.** When Google only knows roughly where it is, its street
 *   number is a guess about a door the rep is standing in front of and can
 *   read. Filling it in anyway is how a lead gets saved with the wrong house
 *   number and nobody notices until somebody knocks on it.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- one preference order, two spellings -------------------------------- */
//
// The same house, as each API describes it. If these two ever disagree, a lead
// added by tapping the map gets a different city from the same lead added by
// picking the address out of the suggestions.
const PLACES = [
  { types: ['street_number'], longText: '1302', shortText: '1302' },
  { types: ['route'], longText: 'Deepwood Drive', shortText: 'Deepwood Dr' },
  { types: ['locality', 'political'], longText: 'Round Rock', shortText: 'Round Rock' },
  { types: ['administrative_area_level_1'], longText: 'Texas', shortText: 'TX' },
  { types: ['postal_code'], longText: '78681', shortText: '78681' },
]
const GEOCODER = [
  { types: ['street_number'], long_name: '1302', short_name: '1302' },
  { types: ['route'], long_name: 'Deepwood Drive', short_name: 'Deepwood Dr' },
  { types: ['locality', 'political'], long_name: 'Round Rock', short_name: 'Round Rock' },
  { types: ['administrative_area_level_1'], long_name: 'Texas', short_name: 'TX' },
  { types: ['postal_code'], long_name: '78681', short_name: '78681' },
]
{
  const a = partsToAddress(fromPlaces(PLACES))
  const b = partsToAddress(fromGeocoder(GEOCODER))
  ok(a?.address1 === '1302 Deepwood Drive', 'the street number and name become one line', a?.address1)
  ok(a?.state === 'TX', 'the state is stored short, as the rest of the app stores it', a?.state)
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    'and the two Google APIs produce identical fields from the same house',
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  )
}

/* --- a city arrives under whichever type the place is administered by ---- */
//
// `locality` covers most of the United States and not much else. A preference
// order written against one country produces a blank city in the next one.
{
  const cases = [
    ['locality', 'Round Rock'],
    ['postal_town', 'Guildford'],
    ['sublocality_level_1', 'Brooklyn'],
    ['sublocality', 'Kadıköy'],
  ]
  const missed = cases.filter(([type, name]) => {
    const parts = [
      { types: ['street_number'], long_name: '1', short_name: '1' },
      { types: ['route'], long_name: 'Main Street', short_name: 'Main St' },
      { types: [type, 'political'], long_name: name, short_name: name },
    ]
    return partsToFields(fromGeocoder(parts)).city !== name
  })
  ok(
    missed.length === 0,
    'a city is found under every type Google files one beneath',
    missed.length ? `missed: ${missed.map(([t]) => t).join(', ')}` : cases.map(([t]) => t).join(', '),
  )
}

/* --- a region is not a door --------------------------------------------- */
{
  const region = [
    { types: ['locality', 'political'], long_name: 'Austin', short_name: 'Austin' },
    { types: ['administrative_area_level_1'], long_name: 'Texas', short_name: 'TX' },
  ]
  ok(
    partsToAddress(fromGeocoder(region)) === null,
    'a component list with no street is refused rather than saved as an address',
  )
  ok(
    partsToFields(fromGeocoder(region)).city === 'Austin',
    'though its town is still readable, for the coarse case',
  )
}

/* --- Google's precision vocabulary, narrowed to this app's --------------- */
{
  const map = {
    ROOFTOP: 'rooftop',
    RANGE_INTERPOLATED: 'interpolated',
    GEOMETRIC_CENTER: 'approximate',
    APPROXIMATE: 'approximate',
    undefined: 'approximate',
  }
  const wrong = Object.entries(map).filter(
    ([k, want]) => precisionOf(k === 'undefined' ? undefined : k) !== want,
  )
  ok(wrong.length === 0, 'every Google location type maps to a precision this app stores', wrong.length ? JSON.stringify(wrong) : '5 of 5')
}

/* --- a coarse answer keeps its town and loses its street numbers --------- */
{
  __resetReverseCache()
  const coarse = async () => ({
    parts: [
      { types: ['street_number'], long_name: '900', short_name: '900' },
      { types: ['route'], long_name: 'Sam Bass Road', short_name: 'Sam Bass Rd' },
      { types: ['locality'], long_name: 'Round Rock', short_name: 'Round Rock' },
      { types: ['administrative_area_level_1'], long_name: 'Texas', short_name: 'TX' },
      { types: ['postal_code'], long_name: '78681', short_name: '78681' },
    ],
    locationType: 'APPROXIMATE',
  })
  const r = await reverseGeocode({ lat: 30.51, lng: -97.67 }, coarse)
  /*
    Google offered "900 Sam Bass Road" for a point it admits it only placed
    approximately. The rep is standing in front of the house and can read its
    number; this must not put a different one in front of them and call it
    filled in.
  */
  ok(r?.address1 === '', 'a guessed street number is dropped rather than shown as filled in', `"${r?.address1}"`)
  ok(r?.city === 'Round Rock' && r?.zip === '78681', 'while the town it is definitely in is kept', `${r?.city} ${r?.zip}`)
  ok(r?.precision === 'approximate', 'and the answer says how well it was located', r?.precision)
}

/* --- a precise answer is kept whole ------------------------------------- */
{
  __resetReverseCache()
  const exact = async () => ({ parts: GEOCODER, locationType: 'ROOFTOP' })
  const r = await reverseGeocode({ lat: 30.52, lng: -97.68 }, exact)
  ok(r?.address1 === '1302 Deepwood Drive', 'a rooftop answer fills the street in', r?.address1)
  ok(r?.precision === 'rooftop', 'and says so', r?.precision)
}

/* --- the cache, which is the bill --------------------------------------- */
{
  __resetReverseCache()
  let calls = 0
  const counting = async () => {
    calls += 1
    return { parts: GEOCODER, locationType: 'ROOFTOP' }
  }
  const at = { lat: 30.523456, lng: -97.678901 }
  await reverseGeocode(at, counting)
  await reverseGeocode(at, counting)
  await reverseGeocode({ ...at }, counting)
  ok(calls === 1, 'the same point is paid for once, however often it is asked', `${calls} request(s) for 3 asks`)

  // A metre apart is the same house. Reps correct a pin by a thumb-width.
  await reverseGeocode({ lat: at.lat + 0.000004, lng: at.lng }, counting)
  ok(calls === 1, 'and a pin nudged by a metre is still the same house', `${calls} request(s)`)

  // A different house is a different question.
  await reverseGeocode({ lat: at.lat + 0.0005, lng: at.lng }, counting)
  ok(calls === 2, 'while the house next door is asked about properly', `${calls} request(s)`)

  /*
    Nothing is an answer too, and it costs the same to fetch. A point Google has
    no address for does not acquire one by being asked twice.

    Counted through the same counter as everything else — the first draft of
    this passed a separate `async () => null`, so the number it compared could
    not move and the assertion could not fail. Disabling the cache entirely left
    it green, which is how it was found.
  */
  let empties = 0
  const nothing = async () => {
    empties += 1
    return null
  }
  await reverseGeocode({ lat: 0, lng: 0 }, nothing)
  await reverseGeocode({ lat: 0, lng: 0 }, nothing)
  ok(empties === 1, 'and "no address here" is remembered rather than re-bought', `${empties} request(s) for 2 asks, ${__cacheSize()} cached`)

  /*
    But a question that could not be asked is not an answer.

    This app spends much of its life with no signal. A tap made in a dead zone
    must not record "this house has no address" and leave it blank for the rest
    of the session, long after the rep has walked back into coverage — so a
    lookup that throws is not cached, and the next tap asks again.
  */
  let attempts = 0
  const offline = async () => {
    attempts += 1
    throw new Error('offline')
  }
  const spot = { lat: 41.1, lng: -73.4 }
  ok((await reverseGeocode(spot, offline)) === null, 'a lookup that cannot be made returns nothing')
  await reverseGeocode(spot, offline)
  ok(attempts === 2, 'and is not remembered — the next tap asks again', `${attempts} attempt(s) for 2 asks`)
  // And once it succeeds, that answer is the one that sticks.
  const back = await reverseGeocode(spot, async () => ({ parts: GEOCODER, locationType: 'ROOFTOP' }))
  ok(back?.address1 === '1302 Deepwood Drive', 'so the same house answers properly once there is signal', back?.address1)
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== one parser for both APIs, and one request per house ===')
