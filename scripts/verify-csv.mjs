/**
 * CSV parser verification.
 *
 * Runs against the TypeScript source through esbuild, so there is no second
 * copy of the parser to drift.
 *
 * Every case here is one that a naive `split(',')` gets wrong *quietly*. That's
 * the whole reason this file exists: a CSV bug doesn't throw, it imports a
 * territory with the owner's surname in the city column and nobody notices until
 * a rep knocks on the wrong door.
 */

import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'csv-')), 'csv.mjs')
await build({
  entryPoints: ['src/lib/csv.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
})
const { parseCsv, autoMap } = await import(out)

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`}`)

/* --- the quoting cases ---------------------------------------------------- */
{
  const r = parseCsv('address,owner\n"123 Main St","Smith, John"\n')
  eq(r.headers, ['address', 'owner'], 'headers parse')
  eq(r.rows.length, 1, 'one data row')
  eq(r.rows[0].owner, 'Smith, John', 'a comma inside quotes stays in the field')
}
{
  const r = parseCsv('address,note\n"9 Elm St","He said ""not now"" twice"\n')
  eq(r.rows[0].note, 'He said "not now" twice', 'a doubled quote is an escaped quote')
}
{
  const r = parseCsv('address,note\n"9 Elm St","line one\nline two"\nsecond,row\n')
  eq(r.rows.length, 2, 'a newline inside quotes does not split the record')
  eq(r.rows[0].note, 'line one\nline two', 'the embedded newline is preserved')
  eq(r.rows[1].address, 'second', 'the row after a multiline field is intact')
}

/* --- the encoding and line-ending cases ----------------------------------- */
{
  // An Excel "CSV UTF-8" export starts with a BOM. Without stripping it the
  // first header never matches an alias, so the address column silently
  // disappears and every row fails validation for no visible reason.
  const r = parseCsv('﻿address,city\n1 A St,Austin\n')
  eq(r.headers[0], 'address', 'a byte-order mark is stripped from the first header')
}
{
  const r = parseCsv('address,city\r\n1 A St,Austin\r\n2 B St,Round Rock\r\n')
  eq(r.rows.length, 2, 'CRLF line endings parse')
  eq(r.rows[1].city, 'Round Rock', 'no stray carriage return in the last field')
}
{
  const r = parseCsv('address,city\n1 A St,Austin')
  eq(r.rows.length, 1, 'a file with no trailing newline keeps its last row')
}
{
  const r = parseCsv('address\tcity\n1 A St\tAustin\n')
  eq(r.headers, ['address', 'city'], 'tab-delimited (spreadsheet paste) is detected')
}
{
  const r = parseCsv('address;city\n1 A St;Austin\n')
  eq(r.rows[0].city, 'Austin', 'semicolon-delimited (European Excel) is detected')
}

/* --- ragged and empty ----------------------------------------------------- */
{
  const r = parseCsv('address,city,zip\n1 A St,Austin\n2 B St,Austin,78701\n')
  eq(r.ragged, 1, 'a short row is counted as ragged rather than silently accepted')
  eq(r.rows[0].zip, '', 'a missing trailing field reads as empty, not undefined')
}
{
  const r = parseCsv('address,city\n\n1 A St,Austin\n\n')
  eq(r.rows.length, 1, 'blank lines are not rows')
}
{
  eq(parseCsv('').rows.length, 0, 'an empty file yields no rows')
  eq(parseCsv('   \n').rows.length, 0, 'a whitespace-only file yields no rows')
}

/* --- column mapping ------------------------------------------------------- */
{
  const m = autoMap(['Street Address', 'City', 'ST', 'Zip Code', 'Owner Name', 'Primary Phone'])
  eq(m.address1, 'Street Address', 'maps "Street Address"')
  eq(m.state, 'ST', 'maps the "ST" abbreviation')
  eq(m.zip, 'Zip Code', 'maps "Zip Code"')
  eq(m.ownerName, 'Owner Name', 'maps "Owner Name"')
  eq(m.phone, 'Primary Phone', 'maps "Primary Phone"')
}
{
  const m = autoMap(['PROPERTY_ADDRESS', 'latitude', 'longitude'])
  eq(m.address1, 'PROPERTY_ADDRESS', 'mapping ignores case and underscores')
  eq(m.lat, 'latitude', 'maps latitude')
  eq(m.lng, 'longitude', 'maps longitude')
}
{
  // The one that matters most: lat and lng must never be swapped or share a
  // column. A silent swap puts a Texas territory in the Indian Ocean.
  const m = autoMap(['address', 'Y', 'X'])
  eq(m.lat, 'Y', 'maps Y to latitude')
  eq(m.lng, 'X', 'maps X to longitude')
}
{
  const m = autoMap(['address', 'name', 'contact'])
  ok(m.ownerName === 'name', 'the first matching alias wins rather than the last')
  ok(
    Object.values(m).filter((v) => v === 'name').length === 1,
    'one CSV column is never mapped to two fields',
  )
}
{
  const m = autoMap(['some_id', 'random_column'])
  ok(m.address1 === undefined, 'an unrecognisable header is left unmapped rather than guessed')
}

console.log(fails.length ? `\n${fails.length} csv check(s) failed` : '\ncsv parsing is correct')
process.exit(fails.length ? 1 : 0)
