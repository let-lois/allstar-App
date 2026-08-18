/**
 * Geocoder response parsing, and the import dedupe key.
 *
 * Both are pure functions, deliberately, so they can be tested without the
 * internet — the Census geocoder can't be reached from a development sandbox, and
 * a test that needs a government service to be up is a test that gets skipped.
 *
 * The response fixtures below are the documented format. If the live service
 * ever diverges from them, `GET /api/selftest/geocode` on the deployed Worker is
 * what catches it: it geocodes a known address and asserts the coordinates land
 * where that address actually is.
 */

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'geo-'))
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
  return import(out)
}
const { parseCensusResponse, toCensusCsv } = await load('src/geocode.ts', 'geocode')
const { addressKey, propertyIdFor } = await load('src/import.ts', 'import')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/* --- the coordinate-order trap -------------------------------------------- */
//
// The service returns "longitude,latitude". Read left-to-right into lat,lng and
// every US address lands in the Indian Ocean — silently, with no error anywhere.
{
  const body =
    '"1","1600 Pennsylvania Ave NW, Washington, DC, 20500","Match","Exact",' +
    '"1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500","-77.03535,38.898754","76225813","L"'
  const [m] = parseCensusResponse(body)
  ok(m.status === 'match', 'a matched address is reported as a match')
  ok(
    Math.abs(m.lat - 38.898754) < 1e-6,
    `latitude comes from the second coordinate (got ${m.lat})`,
  )
  ok(
    Math.abs(m.lng + 77.03535) < 1e-6,
    `longitude comes from the first coordinate (got ${m.lng})`,
  )
  ok(m.matchedAddress?.includes('PENNSYLVANIA'), 'the normalised address is kept')
}

/* --- the failure statuses ------------------------------------------------- */
{
  const [m] = parseCensusResponse('"7","123 Nowhere Rd, Nowhere, ZZ, 00000","No_Match"')
  ok(m.status === 'no_match', 'an unmatched address is reported, not dropped')
  ok(m.lat === undefined, 'an unmatched address carries no coordinates')
}
{
  const [m] = parseCensusResponse('"8","100 Main St","Tie"')
  ok(m.status === 'tie', 'an ambiguous address is a tie, distinct from no match')
}
{
  // A quoted comma inside the input-address echo must not shift the columns and
  // turn a match into a no-match.
  const body =
    '"9","100 Main St, Apt 2, Austin, TX","Match","Non_Exact",' +
    '"100 MAIN ST, AUSTIN, TX, 78701","-97.7431,30.2672","1234","R"'
  const [m] = parseCensusResponse(body)
  ok(m.status === 'match' && Math.abs(m.lat - 30.2672) < 1e-6, 'commas inside quoted fields do not shift columns')
}
{
  const rows = parseCensusResponse(
    '"1","a","No_Match"\n\n"2","b","Match","Exact","B","-97.1,30.1","x","L"\n',
  )
  ok(rows.length === 2, 'blank lines in the response are skipped')
  ok(rows[0].ref === '1' && rows[1].ref === '2', 'refs survive so results can be matched to rows')
}
{
  // Defence against the service ever returning the pair the other way round.
  const [m] = parseCensusResponse('"1","a","Match","Exact","A","38.9,-770.3","x","L"')
  ok(m.status === 'no_match', 'an impossible latitude is refused rather than stored')
}

/* --- the upload format ---------------------------------------------------- */
{
  const csv = toCensusCsv([
    { ref: 'r1', address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' },
  ])
  ok(csv.split('\n').length === 1, 'one line per address')
  ok(csv.startsWith('"r1","1420 Cedar Bend Dr"'), 'id first, then street')
  const quoted = toCensusCsv([{ ref: 'r2', address1: '5 "The Oaks" Ln' }])
  ok(quoted.includes('""The Oaks""'), 'a quote in an address is escaped, not left to break the row')
}

/* --- the dedupe key ------------------------------------------------------- */
//
// The same house arrives spelled three ways across three files. Importing it
// three times means three reps knock on the same door.
{
  const a = { address1: '1420 Cedar Bend Dr.', city: 'Round Rock', state: 'TX', zip: '78664' }
  const b = { address1: '1420 CEDAR BEND DRIVE', city: 'round rock', state: 'tx', zip: '78664' }
  const c = { address1: '1420  Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  ok(addressKey(a) === addressKey(b), 'street-type spelling and case fold to one key')
  ok(addressKey(a) === addressKey(c), 'punctuation and repeated spaces fold to one key')

  const d = { address1: '1422 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  ok(addressKey(a) !== addressKey(d), 'a different house number is a different key')

  const e = { address1: '1420 Cedar Bend Dr', city: 'Austin', state: 'TX', zip: '78701' }
  ok(addressKey(a) !== addressKey(e), 'the same street in another city is a different key')
}
{
  const row = { address1: '1420 Cedar Bend Dr', city: 'Round Rock', state: 'TX', zip: '78664' }
  const one = await propertyIdFor('c_alpha', row)
  const two = await propertyIdFor('c_alpha', row)
  const other = await propertyIdFor('c_beta', row)
  ok(one === two, 're-importing the same row produces the same id — imports are idempotent')
  ok(one !== other, 'the same address in two tenants is two different properties')
  ok(/^p_[0-9a-f]{24}$/.test(one), `the id is a well-formed property id (${one})`)
}

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\ngeocode parsing and dedupe are correct')
process.exit(fails.length ? 1 : 0)
