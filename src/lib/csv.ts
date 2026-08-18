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
