/**
 * CSV parsing.
 *
 * Hand-written rather than `split(',')`, because a real lead list breaks the
 * naive version immediately: `"Smith, John"` becomes two columns, a quoted
 * address with an embedded newline becomes two rows, and an Excel export starts
 * with a byte-order mark that turns the first header into `﻿address` and
 * silently stops matching. Every one of those produces a plausible-looking
 * import with wrong data in it, which is worse than a hard failure.
 *
 * RFC 4180 with the tolerances real files need: CRLF or LF, a BOM, ragged rows,
 * and doubled quotes as an escaped quote.
 */

export type Row = Record<string, string>

export interface ParseResult {
  headers: string[]
  rows: Row[]
  /** Rows whose column count didn't match the header — reported, never guessed at. */
  ragged: number
}

/** Split into records and fields. Delimiter is detected from the header line. */
export function parseCsv(input: string): ParseResult {
  const text = input.replace(/^﻿/, '')
  if (!text.trim()) return { headers: [], rows: [], ragged: 0 }

  const delimiter = detectDelimiter(text)
  const records = splitRecords(text, delimiter)
  if (records.length === 0) return { headers: [], rows: [], ragged: 0 }

  const headers = records[0].map((h) => h.trim())
  const rows: Row[] = []
  let ragged = 0

  for (const record of records.slice(1)) {
    // A trailing newline produces one empty field; that's not a row.
    if (record.length === 1 && record[0].trim() === '') continue
    if (record.length !== headers.length) ragged += 1
    const row: Row = {}
    headers.forEach((h, i) => {
      row[h] = (record[i] ?? '').trim()
    })
    rows.push(row)
  }

  return { headers, rows, ragged }
}

/**
 * Tabs and semicolons show up often enough to be worth handling: a European
 * Excel export is semicolon-delimited, and copy-pasting from a spreadsheet gives
 * tabs. Counted outside quotes only, on the header line.
 */
function detectDelimiter(text: string): string {
  const firstLine = splitRecords(text, ',', 1)[0]?.join(',') ?? ''
  const line = text.slice(0, Math.max(firstLine.length, 200))
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') inQuotes = !inQuotes
      else if (c === '\n' && !inQuotes) break
      else if (c === d && !inQuotes) count += 1
    }
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

function splitRecords(text: string, delimiter: string, limit = Infinity): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (inQuotes) {
      if (c === '"') {
        // A doubled quote is a literal quote; a single one closes the field.
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (c === delimiter) {
      record.push(field)
      field = ''
      continue
    }
    if (c === '\r') continue
    if (c === '\n') {
      record.push(field)
      records.push(record)
      if (records.length >= limit) return records
      record = []
      field = ''
      continue
    }
    field += c
  }

  // Whatever is left when the input ends is the last record.
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

/* --- column mapping ------------------------------------------------------- */

/**
 * The fields an import can fill. `address1` is the only one without a fallback:
 * everything else can be missing, geocoded, or filled in during the visit.
 */
export type ImportField =
  | 'address1'
  | 'city'
  | 'state'
  | 'zip'
  | 'lat'
  | 'lng'
  | 'ownerName'
  | 'phone'
  | 'email'
  | 'opportunityValue'
  | 'roofAgeYears'
  | 'squareFeet'
  | 'notes'

export const IMPORT_FIELDS: { key: ImportField; label: string; required?: boolean }[] = [
  { key: 'address1', label: 'Street address', required: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'lat', label: 'Latitude' },
  { key: 'lng', label: 'Longitude' },
  { key: 'ownerName', label: 'Owner name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'opportunityValue', label: 'Estimated value' },
  { key: 'roofAgeYears', label: 'Roof age (years)' },
  { key: 'squareFeet', label: 'Square feet' },
  { key: 'notes', label: 'Notes' },
]

/**
 * Header aliases, because nobody's export uses our names. Matched on a
 * normalised form so `Street Address`, `street_address` and `STREETADDRESS` are
 * the same header.
 */
const ALIASES: Record<ImportField, string[]> = {
  address1: [
    'address', 'address1', 'addressline1', 'streetaddress', 'street', 'propertyaddress',
    'siteaddress', 'fulladdress', 'addr', 'location',
  ],
  city: ['city', 'town', 'municipality', 'propertycity'],
  state: ['state', 'st', 'province', 'stateabbr', 'propertystate'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode', 'zip5', 'propertyzip'],
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  ownerName: ['owner', 'ownername', 'name', 'contact', 'contactname', 'homeowner', 'fullname'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'telephone', 'primaryphone'],
  email: ['email', 'emailaddress'],
  opportunityValue: ['value', 'estimatedvalue', 'opportunityvalue', 'dealvalue', 'amount'],
  roofAgeYears: ['roofage', 'roofageyears', 'ageofroof', 'roofyear'],
  squareFeet: ['sqft', 'squarefeet', 'squarefootage', 'livingarea', 'buildingarea'],
  notes: ['notes', 'note', 'comments', 'remarks', 'description'],
}

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Best-effort automatic mapping. Deliberately shown to the operator rather than
 * applied silently — a guess that quietly puts longitude in the latitude column
 * drops a whole territory into the Indian Ocean.
 */
export function autoMap(headers: string[]): Partial<Record<ImportField, string>> {
  const mapping: Partial<Record<ImportField, string>> = {}
  const taken = new Set<string>()

  for (const { key } of IMPORT_FIELDS) {
    const aliases = ALIASES[key]
    // Exact alias match first, so `state` doesn't lose to `real_estate`.
    let hit = headers.find((h) => !taken.has(h) && aliases.includes(normalise(h)))
    if (!hit) {
      hit = headers.find(
        (h) => !taken.has(h) && aliases.some((a) => a.length >= 4 && normalise(h).includes(a)),
      )
    }
    if (hit) {
      mapping[key] = hit
      taken.add(hit)
    }
  }
  return mapping
}

/* --- what did they actually drop? ----------------------------------------- */

/**
 * Not every file dropped on an import box is a CSV.
 *
 * The failure this exists to prevent is silent rather than loud: a binary file
 * decodes to mojibake, the parser dutifully finds a "header row" in it, and the
 * operator is shown a column mapper full of garbage and told "2 rows found".
 * Nothing errors. They're left guessing whether the file or the app is broken.
 *
 * The three that actually happen:
 *   - a Windows shortcut (.lnk), which is what you get dragging from some
 *     download shelves — a tiny binary that only *points* at the real file
 *   - an .xlsx, because "my spreadsheet" and "my CSV" are the same thing to
 *     everyone who isn't a programmer
 *   - a PDF of a report someone was sent
 *
 * Each gets its own message, because "that isn't a CSV" is useless next to
 * "that's an Excel workbook — use File, Save As, CSV".
 */
export type FileProblem =
  | 'ok'
  | 'empty'
  | 'shortcut'
  | 'spreadsheet'
  | 'legacy-office'
  | 'pdf'
  | 'binary'

const MAGIC: [number[], FileProblem][] = [
  // "L\0\0\0" — a Windows shell link. Always a pointer, never the data.
  [[0x4c, 0x00, 0x00, 0x00], 'shortcut'],
  // "PK\x03\x04" — a zip, which is what .xlsx, .ods and .numbers all are.
  [[0x50, 0x4b, 0x03, 0x04], 'spreadsheet'],
  // OLE2 compound file: .xls and .doc from before 2007.
  [[0xd0, 0xcf, 0x11, 0xe0], 'legacy-office'],
  [[0x25, 0x50, 0x44, 0x46], 'pdf'], // "%PDF"
]

export interface SniffResult {
  problem: FileProblem
  /** Decoded text, present only when the file looks like text. */
  text?: string
}

/**
 * Decide whether the bytes are text, and decode them if so.
 *
 * UTF-16 is handled rather than rejected: Excel's "Unicode Text" export is
 * UTF-16LE, and it's full of NUL bytes, so the obvious "any NUL means binary"
 * check would throw out a perfectly good file.
 */
export function sniffFile(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { problem: 'empty' }

  for (const [sig, problem] of MAGIC) {
    if (sig.every((b, i) => bytes[i] === b)) return { problem }
  }

  let encoding = 'utf-8'
  let start = 0
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    start = 2
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    start = 2
  }

  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: false }).decode(bytes.subarray(start))
  } catch {
    return { problem: 'binary' }
  }

  if (!text.trim()) return { problem: 'empty' }

  // Sample the front rather than the whole file — a 5MB list doesn't need
  // scanning to answer "is this text", and the answer is always in the first
  // few hundred characters.
  const sample = text.slice(0, 2000)
  let suspect = 0
  for (const ch of sample) {
    const c = ch.charCodeAt(0)
    // NUL, or the replacement character a failed decode leaves behind. Tabs,
    // newlines and carriage returns are of course fine.
    if (c === 0 || c === 0xfffd) suspect += 1
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) suspect += 1
  }
  // A threshold rather than "any", because one stray control character in an
  // otherwise fine export shouldn't cost someone their import.
  if (suspect > sample.length * 0.02) return { problem: 'binary' }

  return { problem: 'ok', text }
}

/** What to tell the operator, in terms of what they should do next. */
export const FILE_PROBLEM_MESSAGE: Record<Exclude<FileProblem, 'ok'>, string> = {
  empty: 'That file is empty.',
  shortcut:
    'That’s a Windows shortcut, not the file itself — it only points at the real one. ' +
    'Open your Downloads folder and drag the actual .csv file, or paste the rows instead.',
  spreadsheet:
    'That’s an Excel workbook. Open it and use File → Save As → CSV, then drag the CSV in. ' +
    'You can also copy the rows straight out of the sheet and paste them here.',
  'legacy-office':
    'That’s an older Excel or Word file. Open it and use File → Save As → CSV, then drag the CSV in.',
  pdf: 'That’s a PDF. An import needs a CSV or a spreadsheet export — a PDF has no columns to read.',
  binary:
    'That doesn’t look like a text file. An import needs a CSV, a tab-separated export, ' +
    'or rows pasted straight from a spreadsheet.',
}
