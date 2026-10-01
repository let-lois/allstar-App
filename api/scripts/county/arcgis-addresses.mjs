import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

/**
 * Any public ArcGIS address-point layer, as GeoJSON for addresses:build.
 *
 * Counties publish their address points on ArcGIS servers under a hundred
 * different field names. This reads one layer inside a box, finds the house
 * number, street (whole, or in parts), unit, town and ZIP fields by name, and
 * writes each address the way Overture spells it ("North Main Street"), so the
 * builder can tell a door it already has from a new one.
 *
 *   node scripts/county/arcgis-addresses.mjs --layer <FeatureServer/N url> \
 *     --bbox -82.77,34.47,-82.15,35.22 --out greenville.geojson [--map number=F,street=F,...] [--where SQL]
 *
 * --map overrides what was found: number, address (a whole "12 Main St"
 * line), street, predir, name, type, sufdir, unit, city, zip. Retired,
 * proposed and historic addresses are left out where the layer says so.
 *
 * sources.json lists the layers loaded so far and load-all.mjs rebuilds them.
 */

const run = promisify(execFile)
/* Through curl rather than fetch: the build sandbox's proxy refuses Node's client. */
export async function getJson(url, tries = 6) {
  for (let a = 1; ; a++) {
    try {
      const { stdout } = await run('curl', ['-sS', '--fail', '--max-time', '180', '--compressed', url], { maxBuffer: 256 * 1024 * 1024 })
      const body = JSON.parse(stdout)
      if (body.error) throw new Error(body.error.message ?? 'server error')
      return body
    } catch (err) {
      if (a >= tries) throw err
      await new Promise((res) => setTimeout(res, 2500 * a))
    }
  }
}

const DIRS = { N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest', NORTH: 'North', SOUTH: 'South', EAST: 'East', WEST: 'West', NORTHEAST: 'Northeast', NORTHWEST: 'Northwest', SOUTHEAST: 'Southeast', SOUTHWEST: 'Southwest' }
const TYPES = {
  ST: 'Street', STR: 'Street', AVE: 'Avenue', AV: 'Avenue', AVN: 'Avenue', DR: 'Drive', DRV: 'Drive', RD: 'Road', LN: 'Lane', CT: 'Court', CRT: 'Court', CIR: 'Circle', CIRC: 'Circle',
  BLVD: 'Boulevard', BLV: 'Boulevard', PL: 'Place', TRL: 'Trail', TR: 'Trail', PKWY: 'Parkway', PKY: 'Parkway', TER: 'Terrace', TERR: 'Terrace', HWY: 'Highway', WAY: 'Way', WY: 'Way',
  LOOP: 'Loop', LP: 'Loop', SQ: 'Square', CRES: 'Crescent', XING: 'Crossing', PT: 'Point', RDG: 'Ridge', HTS: 'Heights', RUN: 'Run', PATH: 'Path', ALY: 'Alley', COVE: 'Cove', CV: 'Cove',
  CRK: 'Creek', EXT: 'Extension', FWY: 'Freeway', GRV: 'Grove', HOLW: 'Hollow', HL: 'Hill', HLS: 'Hills', LNDG: 'Landing', MDW: 'Meadow', MDWS: 'Meadows', PIKE: 'Pike', PLZ: 'Plaza',
  ROW: 'Row', SPGS: 'Springs', SPG: 'Spring', TPKE: 'Turnpike', TRCE: 'Trace', VW: 'View', VLG: 'Village', WALK: 'Walk', BND: 'Bend', BR: 'Branch', BRG: 'Bridge', CTR: 'Center',
  CTS: 'Courts', EST: 'Estate', ESTS: 'Estates', FRK: 'Fork', GLN: 'Glen', GRN: 'Green', HBR: 'Harbor', KNL: 'Knoll', LK: 'Lake', LKS: 'Lakes', MNR: 'Manor', ML: 'Mill', MT: 'Mount',
  OVAL: 'Oval', PARK: 'Park', PSGE: 'Passage', PNE: 'Pine', PNES: 'Pines', RTE: 'Route', SHR: 'Shore', SHRS: 'Shores', STA: 'Station', TRAK: 'Track', VIS: 'Vista', VL: 'Ville', XRD: 'Crossroad',
}
/** "78TH" → "78th", "MAIN" → "Main", "MC KENZIE" → "Mc Kenzie". */
export const title = (s) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, sfx) => n + sfx.toLowerCase())
const up = (s) => String(s ?? '').trim().toUpperCase().replace(/\.$/, '')
const dir = (s) => DIRS[up(s)] ?? title(s)
const typ = (s) => TYPES[up(s)] ?? title(s)

/**
 * A whole street name in county spelling, "N MAIN ST" or "SE 12TH AVE", in
 * Overture's: "North Main Street", "Southeast 12th Avenue". A street called
 * "N" or "Avenue B" keeps its name.
 */
export function overtureStreet(s) {
  const w = String(s ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  if (!w.length) return ''
  const out = w.map(title)
  if (w.length >= 3 && TYPES[up(w[w.length - 2])] && DIRS[up(w[w.length - 1])]) {
    out[w.length - 1] = DIRS[up(w[w.length - 1])]
    out[w.length - 2] = TYPES[up(w[w.length - 2])]
  } else if (w.length >= 2 && TYPES[up(w[w.length - 1])]) out[w.length - 1] = TYPES[up(w[w.length - 1])]
  if (w.length >= 3 && DIRS[up(w[0])]) out[0] = DIRS[up(w[0])]
  return out.join(' ')
}

const PICK = {
  number: ['SAN', 'HOUSE_NUMB', 'HOUSENUMBE', 'ADDRESSNUM', 'ADDR_HN', 'FULL_HOUSE', 'ADD_NUMBER', 'NUMB', 'HSENO', 'HSE_NO', 'STRNUM', 'STR_NUM', 'ST_NO', 'STNO', 'ADDNUM', 'ADD_NUM', 'ADDRNUM', 'ADDR_NUM', 'ADDNUMBER', 'ADDRESSNUMBER', 'ADDRESS_NUMBER', 'ADDRESS_NUM', 'HOUSENUM', 'HOUSE_NUM', 'HOUSENO', 'HOUSE_NO', 'HOUSE_NUMBER', 'HOUSENUMBER', 'HSE_NUM', 'HSENUM', 'HSE_NBR', 'HSNBR', 'HOUSE_NBR', 'ST_NUM', 'STNUM', 'STREET_NUM', 'STREETNUM', 'STR_NUM', 'ADDNO', 'ADDR_NO', 'ADD_NO', 'ANUMBER', 'NUMBER', 'ADDRESS_NO', 'PRIMARYADDRESSNUMBER', 'BLDG_NUM', 'SITE_NUM', 'SITUS_NUM', 'SITUSNUM', 'ADRNUM'],
  numsuf: ['SANSUF', 'HOUSESUFFI', 'ADDNUMSUF', 'ADD_NUM_SUF', 'ADDNUM_SUF', 'NUM_SUF', 'NUMSUF', 'ADDR_NUM_SUF', 'ADDRNUMSUF', 'HOUSE_SUF', 'ADDNUMSUFFIX', 'ADD_NUMBER_SUFFIX', 'NUMSUFFIX', 'HSE_SUF', 'ST_NUM_SUF'],
  predir: ['PRD', 'PFX_DIR', 'PREDIRECTI', 'ADDR_PD', 'ST_PREDIR', 'STPREDIR', 'ST_PRE_DIR', 'PREDIR', 'PRE_DIR', 'PREDIRECTION', 'PRE_DIRECTION', 'PREDIRECTIONAL', 'PREFIXDIR', 'PREFIX_DIR', 'DIRPRE', 'DIR_PRE', 'PRE_DIRECT', 'PREFIX', 'STREET_PREFIX', 'ST_PREFIX', 'DIR', 'DIRECTION', 'STDIR', 'ST_DIR', 'SITUS_DIR', 'PRE_DIR_CD', 'ADRDIR'],
  premod: ['PRT', 'PFX_TYPE', 'PRETYPE', 'PREMOD', 'ST_PREMOD', 'STPREMOD', 'PREMOD', 'PRE_MOD', 'ST_PRETYP', 'STPRETYP', 'PRETYPE', 'PRE_TYPE', 'ST_PRE_TYP'],
  name: ['STN', 'STREET_NAM', 'STREETNAME', 'ADDR_SN', 'ST_NAME', 'STNAME', 'STREETNAME', 'STREET_NAME', 'STR_NAME', 'STRNAME', 'ST_NM', 'NAME', 'STREET', 'ROAD_NAME', 'RDNAME', 'SITUS_STREET', 'SITUS_ST', 'BASENAME', 'BASE_NAME', 'ADRSTR'],
  type: ['STS', 'SFX_TYPE', 'POSTTYPE', 'ADDR_ST', 'ST_POSTYP', 'STPOSTYP', 'ST_POS_TYP', 'POSTTYPE', 'POST_TYPE', 'POSTYPE', 'POS_TYPE', 'ST_TYPE', 'STTYPE', 'STREETTYPE', 'STREET_TYPE', 'STR_TYPE', 'ST_SUFFIX', 'STSUFFIX', 'STR_SUFFIX', 'STREET_SUFFIX', 'SUFFIX_TYPE', 'SUFFIX', 'TYPE', 'ST_SUF', 'SUF', 'ROAD_TYPE', 'RDTYPE', 'SITUS_TYPE', 'ADRSUF'],
  sufdir: ['POD', 'SFX_DIR', 'POSTDIRECT', 'SFXDIR', 'ADDR_SD', 'ST_POSDIR', 'STPOSDIR', 'ST_POS_DIR', 'POSTDIR', 'POST_DIR', 'POSDIR', 'POS_DIR', 'SUFDIR', 'SUF_DIR', 'SUFFIXDIR', 'SUFFIX_DIR', 'SUF_DIRECT', 'POSTDIRECTION', 'POST_DIRECTION', 'POSTDIRECTIONAL', 'DIRSUF', 'DIR_SUF', 'ST_POSTDIR', 'SITUS_SUFDIR'],
  street: ['FSN', 'FULLNAME', 'FULL_NAME', 'FULL_STREET', 'FULLSTREET', 'FULL_ST', 'ST_FULL', 'STFULL', 'STREETFULL', 'STREET_FULL', 'FULL_ST_NAME', 'FULLSTNAME', 'FULL_STNAME', 'ST_FULLNAME', 'STREETNAME_FULL', 'FULL_STREET_NAME', 'FULLSTREETNAME', 'COMPLETE_STREET_NAME', 'CMPLT_STREET', 'STREET_NAME_FULL', 'LSN', 'ST_NAME_FULL', 'STREETNAMEFULL', 'RD_FULL', 'ROAD_FULL', 'STREETLABEL', 'STR_LABEL'],
  address: ['FSA', 'WHOLE_ADDR', 'MASTERADD', 'MASTER_ADD', 'DLVRY_ADD', 'DELIVERY_ADD', 'ALISTR', 'FULLADDR', 'FULL_ADDR', 'FULLADDRESS', 'FULL_ADDRESS', 'FULL_ADD', 'ADD_FULL', 'ADDR_FULL', 'ADDRESS_FULL', 'ADDRESSFULL', 'FULLADD', 'SITEADDR', 'SITE_ADDR', 'SITEADDRESS', 'SITE_ADDRESS', 'SITUS', 'SITUSADDR', 'SITUS_ADDR', 'SITUS_ADDRESS', 'ADDRESS', 'ADDR', 'STREETADDRESS', 'STREET_ADDRESS', 'ADDRESS1', 'ADDRESS_1', 'ADDRESSLINE', 'ADDR_LINE1', 'LOCATION', 'LOC_ADDR', 'PROPADDR', 'PROP_ADDR', 'ADDRLABEL', 'ADDR_LABEL', 'LABEL', 'FULL_ADDRE', 'FULLADDRES', 'ADDRESS_LA'],
  unit: ['UNIT', 'UNITS', 'UNIT_NUM', 'UNITNUM', 'UNIT_NO', 'UNITNO', 'UNIT_NUMBER', 'UNITNUMBER', 'UNITID', 'UNIT_ID', 'ADDR_UNIT', 'ADD_UNIT', 'ADDRUNIT', 'APT', 'APT_NUM', 'APTNUM', 'APARTMENT', 'SUITE', 'SUITE_NUM', 'UNIT_DESIG', 'UNITDESIG', 'SUBADDRESS', 'SUB_ADDRESS', 'SECONDARY', 'SEC_UNIT'],
  unittype: ['UNIT_TYPE', 'UNITTYPE', 'UNIT_TYP', 'UNITTYP', 'APT_TYPE', 'SUBADDTYPE', 'SUBADDRESSTYPE', 'SUB_TYPE'],
  city: ['PCN', 'MCN', 'POSTAL_TOW', 'POSTAL_TWN', 'POST_COMM', 'POSTCOMM', 'POSTAL_COMM', 'POSTALCOMM', 'POSTAL_COM', 'POST_CITY', 'POSTALCITY', 'POSTAL_CITY', 'MAIL_CITY', 'MAILCITY', 'USPS_CITY', 'ZIP_CITY', 'ZIPCITY', 'ZIP_NAME', 'MSAG_COMM', 'MSAGCOMM', 'MSAG_COMMUNITY', 'CITY', 'CITYNAME', 'CITY_NAME', 'COMMUNITY', 'PLACE_NAME', 'PLACENAME', 'PLACE', 'MUNICIPALITY', 'MUNI', 'MUNI_NAME', 'INC_MUNI', 'INCMUNI', 'JURIS', 'JURISDICTION', 'TOWN', 'TOWNSHIP', 'SITUS_CITY', 'SITUSCITY', 'LOC_CITY', 'MUNICIPAL'],
  zip: ['ZIP_CODE', 'POSTAL_ZIP', 'ZIP', 'ZIPCODE', 'ZIP_CODE', 'ZIP5', 'ZIPCODE5', 'ZIP_5', 'POST_CODE', 'POSTCODE', 'POSTAL', 'POSTALCODE', 'POSTAL_CODE', 'ADD_ZIP', 'ADDR_ZIP', 'ZIPCD', 'ZIP_CD', 'USPS_ZIP', 'SITUS_ZIP', 'SITUSZIP', 'ZIP1', 'ZP1', 'MAIL_ZIP', 'ZIPPOSTAL'],
  status: ['ADDR_STATU', 'STATUS', 'ADDR_STATUS', 'ADDRSTATUS', 'ADD_STATUS', 'ADDRESS_STATUS', 'ADDSTATUS', 'LIFECYCLE', 'LIFE_CYCLE', 'STAGE'],
}
/** The layer's field for each part, by name; `map` overrides. */
export function pickFields(fieldNames, map = {}) {
  const byUpper = new Map(fieldNames.map((f) => [f.toUpperCase(), f]))
  const out = {}
  for (const [part, names] of Object.entries(PICK)) {
    const hit = names.find((n) => byUpper.has(n))
    if (hit) out[part] = byUpper.get(hit)
  }
  for (const [k, v] of Object.entries(map)) out[k] = v
  // "PREFIX" or "TYPE" as a name field is too loose once the real parts are known.
  if (out.name && out.street && !map.name) delete out.name
  return out
}

const DEAD = /retir|inactiv|histor|propos|delet|vacat|void|pending|planned|unbuilt|demol|^no$|^n$|^false$|^0$/i
const NUM = /^(\d+(?:-\d+)?[A-Za-z]?)(?:\s+(\d\/\d|[A-Za-z](?=\s)))?\s+(.+)$/
const UNIT_IN = /\s+(?:(APT|APARTMENT|UNIT|STE|SUITE|BLDG|BUILDING|LOT|RM|ROOM|TRLR|SPC|SPACE|FL|FLOOR)\.?\s*|#\s*)([\w-]+)\s*$/i

/** One layer record to a GeoJSON feature, or null when it has no door to knock. */
export function toFeature(a, geometry, f) {
  if (!geometry || !Number.isFinite(geometry.x) || !Number.isFinite(geometry.y)) return null
  if (f.status && a[f.status] != null && DEAD.test(String(a[f.status]).trim())) return null
  let number = f.number != null ? String(a[f.number] ?? '').trim() : ''
  if (number === '0') number = ''
  if (number && f.numsuf && a[f.numsuf]) number = `${number} ${String(a[f.numsuf]).trim()}`
  let street = ''
  let unit = ''
  if (f.street && a[f.street]) street = overtureStreet(a[f.street])
  else if (f.name && a[f.name]) {
    street = [f.predir && a[f.predir] ? dir(a[f.predir]) : '', f.premod && a[f.premod] ? title(a[f.premod]) : '', title(a[f.name]), f.type && a[f.type] ? typ(a[f.type]) : '', f.sufdir && a[f.sufdir] ? dir(a[f.sufdir]) : '']
      .filter(Boolean)
      .join(' ')
  }
  if ((!number || !street) && f.address && a[f.address]) {
    let line = String(a[f.address]).trim().replace(/\s+/g, ' ').split(',')[0]
    const u = UNIT_IN.exec(line)
    if (u) {
      unit = `${u[1] ? title(u[1]) + ' ' : '#'}${u[2]}`.replace(/^Apartment /, 'Apt ').replace(/^Suite /, 'Ste ')
      line = line.slice(0, u.index)
    }
    const m = NUM.exec(line)
    if (!m) return null
    number = number || (m[2] ? `${m[1]} ${m[2]}` : m[1])
    street = street || overtureStreet(m[3])
  }
  if (!/^\d/.test(number) || !street || /^\d+$/.test(street)) return null
  if (f.unit && a[f.unit] != null && String(a[f.unit]).trim() && !/^(0|none|n\/a)$/i.test(String(a[f.unit]).trim())) {
    const id = String(a[f.unit]).trim()
    const kind = f.unittype && a[f.unittype] ? title(a[f.unittype]) : ''
    unit = /^[A-Za-z]{2,}\s/.test(id) ? title(id) : kind ? `${kind} ${id}` : /^\d|^[A-Z]$/i.test(id) ? `Unit ${id}` : title(id)
  }
  const zip = f.zip ? String(a[f.zip] ?? '').trim().slice(0, 5) : ''
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(geometry.x.toFixed(6)), Number(geometry.y.toFixed(6))] },
    properties: { number, street, unit: unit || undefined, city: f.city && a[f.city] ? title(a[f.city]) : undefined, zip: /^\d{5}$/.test(zip) && zip !== '00000' ? zip : undefined },
  }
}

/** Every address in a layer inside a box (by object id, so no server paging limits apply). */
export async function loadLayer(layer, { bbox, where = '1=1', map = {}, log = console.log } = {}) {
  const meta = await getJson(`${layer}?f=json`)
  const names = (meta.fields ?? []).map((f) => f.name)
  const fields = pickFields(names, map)
  if (!fields.number && !fields.address) throw new Error(`no house number or address field in ${names.join(', ')}`)
  const box = bbox ? { geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' } : {}
  const ids = (await getJson(`${layer}/query?${new URLSearchParams({ where, returnIdsOnly: 'true', f: 'json', ...box })}`)).objectIds ?? []
  ids.sort((x, y) => x - y)
  log(`  ${ids.length.toLocaleString()} records; fields ${JSON.stringify(fields)}`)
  const outFields = [...new Set(Object.values(fields))].join(',')
  const step = Math.min(Number(meta.maxRecordCount) || 1000, 1000)
  const features = []
  let skipped = 0
  const chunks = []
  for (let i = 0; i < ids.length; i += step) chunks.push(ids.slice(i, i + step))
  let done = 0
  const width = 4
  await Promise.all(Array.from({ length: width }, async () => {
    for (let c; (c = chunks.shift()); ) {
      // A range of ids rather than a list of them keeps the URL short.
      const q = new URLSearchParams({ where: `(${where}) AND ${meta.objectIdField ?? 'OBJECTID'} >= ${c[0]} AND ${meta.objectIdField ?? 'OBJECTID'} <= ${c[c.length - 1]}`, outFields, outSR: '4326', returnGeometry: 'true', f: 'json', ...box })
      const page = await getJson(`${layer}/query?${q}`)
      for (const r of page.features ?? []) {
        const g = r.geometry && (r.geometry.x != null ? r.geometry : r.geometry.points?.[0] ? { x: r.geometry.points[0][0], y: r.geometry.points[0][1] } : null)
        const feat = toFeature(r.attributes ?? {}, g, fields)
        if (feat) features.push(feat)
        else skipped++
      }
      if (++done % 50 === 0) log(`  ${Math.min(done * step, ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`)
    }
  }))
  return { features, skipped, fields }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2)
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
  const layer = opt('--layer')
  if (!layer) {
    console.log('usage: node scripts/county/arcgis-addresses.mjs --layer URL [--bbox w,s,e,n] [--where SQL] [--map number=F,street=F,...] --out file.geojson')
    process.exit(1)
  }
  const map = Object.fromEntries(String(opt('--map', '')).split(',').filter(Boolean).map((kv) => kv.split('=')))
  const bbox = opt('--bbox') ? opt('--bbox').split(',').map(Number) : undefined
  const out = resolve(opt('--out', 'arcgis-addresses.geojson'))
  const { features, skipped } = await loadLayer(layer, { bbox, where: opt('--where', '1=1'), map })
  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`wrote ${features.length.toLocaleString()} addresses to ${out} (${skipped.toLocaleString()} without a number, street or point, or retired, left out)`)
}
