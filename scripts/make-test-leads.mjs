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
const OUT = process.argv[3] || 'fixtures/test-leads-round-rock.csv'

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
 * Streets in and around the Forest Creek / Old Settlers area of Round Rock,
 * with the ZIP each sits in. Kept to a dozen so the result clusters.
 */
const STREETS = [
  { name: 'Deepwood Dr', zip: '78681', from: 1000, to: 1400 },
  { name: 'Frontier Trail', zip: '78681', from: 1500, to: 1900 },
  { name: 'Chisholm Trail Rd', zip: '78681', from: 1200, to: 1800 },
  { name: 'Forest Creek Dr', zip: '78664', from: 2000, to: 2600 },
  { name: 'Oakmont Dr', zip: '78664', from: 1600, to: 2000 },
  { name: 'Creek Bend Blvd', zip: '78664', from: 1300, to: 1900 },
  { name: 'Wyoming Springs Dr', zip: '78681', from: 2400, to: 3000 },
  { name: 'Sunrise Rd', zip: '78664', from: 1100, to: 1700 },
  { name: 'Bowman Rd', zip: '78664', from: 1000, to: 1500 },
  { name: 'Great Oaks Dr', zip: '78681', from: 1800, to: 2300 },
  { name: 'Lake Creek Dr', zip: '78681', from: 1400, to: 1900 },
  { name: 'Meadow Lake Dr', zip: '78664', from: 1200, to: 1600 },
]

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

/**
 * Mostly empty on purpose. A bought list does not come with notes on every
 * house — notes are what a rep adds later, and a file where all fifty rows have
 * one reads as fabricated.
 */
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

/** Even numbers on one side of the street, so a route walks one side then back. */
function houseNumber(street) {
  const span = street.to - street.from
  return street.from + 2 * Math.floor(rand() * (span / 2))
}

const rows = []
const used = new Set()

// Spread the count across the streets so no single street gets all of them.
let streetIdx = 0
while (rows.length < COUNT) {
  const street = STREETS[streetIdx % STREETS.length]
  // Three to five houses per street before moving on — a rep works a stretch,
  // not one door.
  const run = int(3, 5)
  for (let i = 0; i < run && rows.length < COUNT; i++) {
    const number = houseNumber(street)
    const address = `${number} ${street.name}`
    if (used.has(address)) continue
    used.add(address)

    // Not every house has an owner on file. A list with a contact for all fifty
    // is not a list anyone has ever bought.
    const hasOwner = rand() > 0.28
    const first = pick(FIRST)
    const last = pick(LAST)
    const name = hasOwner ? `${first} ${last}` : ''
    const hasPhone = hasOwner && rand() > 0.2
    const hasEmail = hasOwner && rand() > 0.55

    rows.push({
      address,
      city: 'Round Rock',
      state: 'TX',
      zip: street.zip,
      owner: name,
      // 555-01XX is the range reserved for fiction. A rep tapping "Call" in a
      // test must never reach a real person.
      phone: hasPhone ? `(512) 555-01${String(int(0, 99)).padStart(2, '0')}` : '',
      email: hasEmail
        ? `${first.toLowerCase()}.${last.toLowerCase()}@example.com`
        : '',
      // A residential re-roof, which is the job these leads are for. Priced in
      // $500 steps the way an estimator actually quotes.
      value: rand() > 0.22 ? `$${(int(17, 62) * 500).toLocaleString()}` : '',
      roofAge: rand() > 0.24 ? String(int(6, 27)) : '',
      sqft: rand() > 0.15 ? String(int(1400, 3600)) : '',
      notes: pick(NOTES),
    })
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
    [r.address, r.city, r.state, r.zip, r.owner, r.phone, r.email, r.value, r.roofAge, r.sqft, r.notes]
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
