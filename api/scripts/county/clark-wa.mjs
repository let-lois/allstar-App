import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

/**
 * Clark County, Washington site addresses, as GeoJSON for addresses:build.
 *
 * Overture's address points cover only about four in ten homes in
 * unincorporated Clark County (Hazel Dell, Orchards, Salmon Creek — the
 * Vancouver suburbs), so a territory there was mostly doors estimated from
 * Census street ranges, and some with no address at all. The county publishes
 * every physical address as a point on its public GIS server:
 *
 *   ClarkView_Public/SiteAddress — about 250,000 points, house number,
 *   direction, street, type, building, apartment, ZIP and city.
 *
 * Street parts are written the way Overture writes them ("Northeast 78th
 * Street"), so the same door from both sources is one row in a tile — the
 * builder also compares streets in a canonical spelling (`canonStreet`), and
 * keeps Overture's row when both have it.
 *
 *   node scripts/county/clark-wa.mjs --out clark-wa.geojson
 *   npm run addresses:build -- --bbox -122.80,45.54,-122.24,45.98 \
 *     --geojson clark-wa.geojson --fields number=number,street=street,unit=unit,city=city,zip=zip \
 *     --state WA --upload --account <id>
 *
 * The county offers the data with a no-warranty disclaimer and no restriction
 * on use. Credit: "Address data © Clark County WA" (docs/ADDRESS_SOURCES.md).
 */

const args = process.argv.slice(2)
const out = resolve(args[args.indexOf('--out') + 1] ?? 'clark-wa.geojson')
const LAYER = 'https://gis.clark.wa.gov/arcgisfed/rest/services/ClarkView_Public/SiteAddress/MapServer/0/query'
const PAGE = 2000

/*
  Through curl rather than fetch: in the build sandbox the egress proxy lets
  curl reach the county and refuses Node's own client, and curl is on every
  machine this runs from.
*/
const run = promisify(execFile)
async function json(url, tries = 6) {
  for (let a = 1; ; a++) {
    try {
      const { stdout } = await run('curl', ['-sS', '--fail', '--max-time', '120', url], { maxBuffer: 64 * 1024 * 1024 })
      const body = JSON.parse(stdout)
      if (body.error) throw new Error(body.error.message ?? 'server error')
      return body
    } catch (err) {
      if (a >= tries) throw err
      await new Promise((res) => setTimeout(res, 2500 * a))
    }
  }
}

const DIR = { N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest' }
const TYPE = {
  ST: 'Street', AVE: 'Avenue', AV: 'Avenue', DR: 'Drive', RD: 'Road', LN: 'Lane', CT: 'Court', CIR: 'Circle', BLVD: 'Boulevard',
  PL: 'Place', TRL: 'Trail', PKWY: 'Parkway', TER: 'Terrace', HWY: 'Highway', WAY: 'Way', LOOP: 'Loop', SQ: 'Square',
  CRES: 'Crescent', XING: 'Crossing', PT: 'Point', RDG: 'Ridge', HTS: 'Heights', RUN: 'Run', PATH: 'Path', ALY: 'Alley',
}
/** "78TH" → "78th", "MAIN" → "Main", "MC KENZIE" → "Mc Kenzie". */
export const title = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, sfx) => n + sfx.toLowerCase())

/** One county record to a GeoJSON feature, or null when it has no door to knock. */
export function toFeature(a, geometry) {
  const n = a.HsNbr
  if (!n || !a.StName || !geometry || geometry.x == null) return null
  const street = [DIR[String(a.StDir ?? '').trim().toUpperCase()] ?? title(a.StDir), title(a.StName), TYPE[String(a.Stype ?? '').trim().toUpperCase()] ?? title(a.Stype)]
    .filter(Boolean)
    .join(' ')
  const unit = [a.Building && `Bldg ${String(a.Building).trim()}`, a.Apt && String(a.Apt).trim()].filter(Boolean).join(' ') || undefined
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [geometry.x, geometry.y] },
    properties: {
      number: a.HsSub ? `${n} ${String(a.HsSub).trim()}` : String(n),
      street,
      unit,
      city: title(a.StCity),
      zip: a.Zp1 ? String(a.Zp1).padStart(5, '0') : undefined,
    },
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { count } = await json(`${LAYER}?where=1%3D1&returnCountOnly=true&f=json`)
  console.log(`${count.toLocaleString()} site addresses`)
  const features = []
  let skipped = 0
  for (let offset = 0; offset < count; offset += PAGE) {
    const q = new URLSearchParams({
      where: '1=1',
      outFields: 'HsNbr,HsSub,StDir,StName,Stype,Building,Apt,Zp1,StCity',
      outSR: '4326',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'json',
    })
    const page = await json(`${LAYER}?${q}`)
    for (const f of page.features ?? []) {
      const feat = toFeature(f.attributes, f.geometry)
      if (feat) features.push(feat)
      else skipped++
    }
    if ((offset / PAGE) % 10 === 0) console.log(`  ${Math.min(offset + PAGE, count).toLocaleString()} / ${count.toLocaleString()}`)
  }
  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`wrote ${features.length.toLocaleString()} addresses to ${out} (${skipped} without a number or street left out)`)
}
