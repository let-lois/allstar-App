/**
 * Generate a test lead list.
 *
 * Why a generator rather than fifty hand-typed rows: it's reviewable, it's
 * reproducible, and the size is a parameter — a 10-row list to check the wizard
 * and a 200-row list to see what a real territory feels like on the map are the
 * same command.
 *
 * Two rules govern what goes in it.
 *
 * **Real streets, fictional everything else.** The addresses have to be real
 * enough to geocode, because a lead with no coordinates is invisible on the map
 * and the whole product is built around that screen. But the *people* are
 * invented, and deliberately so:
 *
 *   - Phone numbers are all 555-01XX, the range reserved for fiction. A rep
 *     testing the app will tap "Call" — that must never dial a stranger.
 *   - Emails are on example.com, reserved by RFC 2606 for exactly this.
 *   - The names are common first and last names paired at random. They are not
 *     residents of these houses.
 *
 * **Clustered, not scattered.** Fifty addresses spread across a city produce a
 * route nobody could walk. Real D2D work is a handful of houses on each of a
 * dozen nearby streets, so that's the shape here.
 *
 * Note on the addresses: these are real Round Rock street names with plausible
 * house numbers, not verified individual properties. The Census geocoder matches
 * against road centrelines and interpolates the number, so a mid-range number on
 * a real street resolves. The import wizard reports anything that doesn't, which
 * is the honest place for that to surface.
 *
 *   node scripts/make-test-leads.mjs [count] [outfile]
 */

import { writeFileSync } from 'node:fs'

const COUNT = Number(process.argv[2] || 50)
const OUT = process.argv[3] || 'fixtures/test-leads-austin.csv'

/** Deterministic, so the same command always produces the same list. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
const rand = rng(20260818)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))

/**
 * A real street grid, laid out with coordinates.
 *
 * The first version of this file guessed at Round Rock street names from
 * memory and shipped them without coordinates, leaving the geocoder to resolve
 * them. 32 of 50 didn't exist and were silently unimportable — a list is only as
 * good as its worst address, and inventing street names is not a thing you can
 * do carefully.
 *
 * So this version does two things differently. It uses a **numbered grid**,
 * where the street names are structural rather than remembered — W 39th through
 * W 45th Street in Austin's Hyde Park are as real as the numbers they're named
 * for. And it emits **coordinates**, so the import doesn't depend on a lookup
 * succeeding at all.
 *
 * The grid is genuine: streets run east-west about a block apart, houses run
 * along each one, and the whole thing spans roughly half a kilometre — a
 * territory a rep could actually walk in a morning.
 */
const ORIGIN = { lat: 30.3040, lng: -97.7300 }
/** ~120m between streets; at this latitude that's 0.00108° of latitude. */
const BLOCK_LAT = 0.00108
/** ~18m between houses along a street. */
const HOUSE_LNG = 0.00019

const STREETS = [
  { name: 'W 39th St', zip: '78751', base: 600 },
  { name: 'W 40th St', zip: '78751', base: 700 },
  { name: 'W 41st St', zip: '78751', base: 700 },
  { name: 'W 42nd St', zip: '78751', base: 800 },
  { name: 'W 43rd St', zip: '78751', base: 800 },
  { name: 'W 44th St', zip: '78751', base: 900 },
  { name: 'W 45th St', zip: '78751', base: 900 },
]
const CITY = 'Austin'
const STATE = 'TX'

const FIRST = [
  'Marcus', 'Dana', 'Priya', 'Andre', 'Sofia', 'Trevor', 'Nia', 'Curtis', 'Elena', 'Devon',
  'Rosa', 'Hank', 'Imani', 'Owen', 'Lucia', 'Grant', 'Aisha', 'Reid', 'Camila', 'Terrence',
  'Bianca', 'Joel', 'Yara', 'Shane', 'Delia', 'Omar', 'Kendra', 'Wesley', 'Anika', 'Bruno',
  'Farrah', 'Colin', 'Renata', 'Milo', 'Tessa', 'Rafael', 'Naomi', 'Dwight', 'Paloma', 'Ezra',
]
const LAST = [
  'Whitfield', 'Okafor', 'Raman', 'Vance', 'Delgado', 'Brennan', 'Castille', 'Nakamura',
  'Duarte', 'Halloway', 'Ibarra', 'Sowell', 'Mendes', 'Krantz', 'Ferrell', 'Aziz', 'Lindqvist',
  'Boone', 'Marchetti', 'Osei', 'Prewitt', 'Salcedo', 'Tran', 'Wexler', 'Yates', 'Zamora',
]

const NOTES = [
  '', '', '', '', '', '', '', '', '', '', '', '',
  'Corner lot, gate on the side',
  'Two dogs - knock, do not open the gate',
  'Storm damage visible on the north slope',
  'Works nights, best after 5pm',
  'Renter - owner lives out of state',
  'Asked to be contacted in the spring',
  'Neighbor across the street already replaced theirs',
]

const rows = []

// Walk the grid street by street, a run of houses on each — which is what a
// territory actually looks like, and what makes the route walkable.
let placed = 0
let streetIdx = 0
while (placed < COUNT) {
  const street = STREETS[streetIdx % STREETS.length]
  const lat = ORIGIN.lat + BLOCK_LAT * (streetIdx % STREETS.length)
  const run = Math.min(int(6, 9), COUNT - placed)

  for (let i = 0; i < run; i++) {
    // Even numbers on one side, so a route walks up one side rather than
    // crossing the road between every door.
    const number = street.base + 2 * (i + Math.floor(streetIdx / STREETS.length) * 12)
    const lng = ORIGIN.lng + HOUSE_LNG * i + HOUSE_LNG * 12 * Math.floor(streetIdx / STREETS.length)

    const hasOwner = rand() > 0.28
    const first = pick(FIRST)
    const last = pick(LAST)
    const hasPhone = hasOwner && rand() > 0.2
    const hasEmail = hasOwner && rand() > 0.55

    rows.push({
      address: `${number} ${street.name}`,
      city: CITY,
      state: STATE,
      zip: street.zip,
      // Rounded to six decimals: about 10cm, far finer than a house needs and
      // shorter than the float noise that would otherwise print.
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      owner: hasOwner ? `${first} ${last}` : '',
      // 555-01XX is the range reserved for fiction. A rep tapping "Call" in a
      // test must never reach a real person.
      phone: hasPhone ? `(512) 555-01${String(int(0, 99)).padStart(2, '0')}` : '',
      email: hasEmail ? `${first.toLowerCase()}.${last.toLowerCase()}@example.com` : '',
      // A residential re-roof, which is the job these leads are for. Priced in
      // $500 steps the way an estimator actually quotes.
      value: rand() > 0.22 ? `$${(int(17, 62) * 500).toLocaleString()}` : '',
      roofAge: rand() > 0.24 ? String(int(6, 27)) : '',
      sqft: rand() > 0.15 ? String(int(1400, 3600)) : '',
      notes: pick(NOTES),
    })
    placed += 1
  }
  streetIdx += 1
}

/** Quote anything containing a comma or a quote, and double internal quotes. */
const cell = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Headers written the way a real export writes them — spaces, abbreviations, and
// none of them matching our internal field names. The import wizard's automatic
// mapping should recognise every one, which makes this file a live test of it.
const HEADERS = [
  'Property Address',
  'City',
  'State',
  'Zip Code',
  'Latitude',
  'Longitude',
  'Owner Name',
  'Primary Phone',
  'Email',
  'Est. Value',
  'Roof Age',
  'Sq Ft',
  'Notes',
]

const lines = [HEADERS.join(',')]
for (const r of rows) {
  lines.push(
    [r.address, r.city, r.state, r.zip, r.lat, r.lng, r.owner, r.phone, r.email, r.value, r.roofAge, r.sqft, r.notes]
      .map(cell)
      .join(','),
  )
}

writeFileSync(OUT, lines.join('\n') + '\n')

const streets = new Set(rows.map((r) => r.address.replace(/^\d+\s+/, '')))
console.log(`${rows.length} leads across ${streets.size} streets -> ${OUT}`)
console.log(`  with an owner name:  ${rows.filter((r) => r.owner).length}`)
console.log(`  with a phone:        ${rows.filter((r) => r.phone).length}`)
console.log(`  with a note:         ${rows.filter((r) => r.notes).length}`)
console.log(`  all have coordinates: ${rows.every((r) => r.lat && r.lng)}`)
