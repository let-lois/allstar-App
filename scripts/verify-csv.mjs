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
const { parseCsv, autoMap, sniffFile, FILE_PROBLEM_MESSAGE } = await import(out)

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

/* --- is this even a CSV? -------------------------------------------------- */
//
// Every case here was reported as "2 rows found" before the sniff existed: the
// bytes decoded to mojibake, the parser found a header row in it, and the
// operator was shown a column mapper full of binary garbage with no error.

const bytes = (...n) => new Uint8Array(n)
const ascii = (str) => new TextEncoder().encode(str)
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

{
  // A real Windows shell link: "L\0\0\0" then the link GUID, and further in
  // the path of the file it points at. This is what dragging from a download
  // shelf can hand you, and it is what actually happened.
  const lnk = concat(
    bytes(0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00),
    bytes(0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46),
    ascii('C:\\Users\\me\\DOWNLO~1\\TEST-L~1.CSV'),
  )
  const r = sniffFile(lnk)
  ok(r.problem === 'shortcut', `a Windows shortcut is recognised as one (${r.problem})`)
  ok(r.text === undefined, 'a shortcut is never handed to the parser')
  ok(
    /shortcut/i.test(FILE_PROBLEM_MESSAGE.shortcut) && /\.csv/i.test(FILE_PROBLEM_MESSAGE.shortcut),
    'the message names the problem and what to drag instead',
  )
}
{
  const xlsx = concat(bytes(0x50, 0x4b, 0x03, 0x04), ascii('\x14\x00\x06\x00xl/workbook.xml'))
  ok(sniffFile(xlsx).problem === 'spreadsheet', 'an .xlsx is recognised as a workbook')
  ok(
    /save as/i.test(FILE_PROBLEM_MESSAGE.spreadsheet),
    'the workbook message says how to turn it into a CSV',
  )
}
{
  ok(sniffFile(concat(bytes(0xd0, 0xcf, 0x11, 0xe0), ascii('old xls'))).problem === 'legacy-office',
    'a pre-2007 Excel or Word file is recognised')
  ok(sniffFile(ascii('%PDF-1.7\n...')).problem === 'pdf', 'a PDF is recognised')
}
{
  // Random bytes with no known signature still must not reach the parser.
  const junk = new Uint8Array(600)
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256
  ok(sniffFile(junk).problem === 'binary', 'unrecognised binary is refused')
}
{
  ok(sniffFile(new Uint8Array(0)).problem === 'empty', 'an empty file is reported as empty')
  ok(sniffFile(ascii('   \n\n  ')).problem === 'empty', 'a whitespace-only file is reported as empty')
}

/* --- and the files that ARE fine ------------------------------------------ */
{
  const r = sniffFile(ascii('address,city\n1 A St,Austin\n'))
  ok(r.problem === 'ok', 'a plain CSV passes')
  ok(r.text?.startsWith('address,city'), 'the decoded text is handed back for parsing')
}
{
  // Excel's "Unicode Text" export is UTF-16LE — full of NUL bytes. A naive
  // "any NUL means binary" check would throw out a perfectly good file.
  const utf16 = concat(
    bytes(0xff, 0xfe),
    new Uint8Array(
      [...'address,city\n1 A St,Austin\n'].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
    ),
  )
  const r = sniffFile(utf16)
  ok(r.problem === 'ok', `a UTF-16 export is accepted, not mistaken for binary (${r.problem})`)
  ok(parseCsv(r.text ?? '').rows.length === 1, 'and it parses once decoded')
}
{
  // A UTF-8 file with accented names must survive.
  const r = sniffFile(ascii('address,owner\n1 A St,"Núñez, José"\n'))
  ok(r.problem === 'ok', 'accented characters do not read as binary')
  ok(parseCsv(r.text ?? '').rows[0].owner === 'Núñez, José', 'and they round-trip intact')
}

console.log(fails.length ? `\n${fails.length} csv check(s) failed` : '\ncsv parsing is correct')
process.exit(fails.length ? 1 : 0)
