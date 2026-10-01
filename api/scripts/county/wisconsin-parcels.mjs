import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { title } from './clark-wa.mjs'

/**
 * Wisconsin parcel site addresses, as GeoJSON for addresses:build.
 *
 * Overture's address points are thin in parts of Wisconsin — Eau Claire had
 * none in the blocks we measured, Madison about half, Kenosha most but not
 * all — so a territory there was mostly doors estimated from Census street
 * ranges. The State Cartographer's Office publishes every parcel in the state
 * with its site address and a point inside it:
 *
 *   Wisconsin_Statewide_Parcels_DB (V12, 2026) — ADDNUM, PREFIX, STREETNAME,
 *   STREETTYPE, SUFFIX, UNITID, PLACENAME, ZIPCODE, PROPCLASS, LONGITUDE,
 *   LATITUDE.
 *
 * Parcels classed only as commercial or manufacturing (2, 3) are left out;
 * residential (1), farm and undeveloped classes with a house address, and
 * parcels the county left unclassed are kept. The point is the parcel's, a
 * few metres to tens of metres from the house; the lead builder claims the
 * nearest roof for it the same way it does for Clark County's curb points.
 *
 *   node scripts/county/wisconsin-parcels.mjs --county "EAU CLAIRE,DANE,KENOSHA" --out wi.geojson
 *   npm run addresses:build -- --bbox <w,s,e,n> --geojson wi.geojson \
 *     --fields number=number,street=street,unit=unit,city=city,zip=zip --state WI --upload --account <id>
 *
 * Credit: "Product of the Version 12 Statewide Parcel Map Database Project
 * (V12). Created by the Wisconsin State Cartographer's Office, administered by
 * WLIP at DOA" (docs/ADDRESS_SOURCES.md).
 */

const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const out = resolve(opt('--out', 'wisconsin-parcels.geojson'))
const counties = String(opt('--county', 'EAU CLAIRE,DANE,KENOSHA'))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean)
const LAYER = 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query'
const PAGE = 2000

// Through curl rather than fetch, as clark-wa.mjs explains.
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
const WORD_DIR = { NORTH: 'North', SOUTH: 'South', EAST: 'East', WEST: 'West', NORTHEAST: 'Northeast', NORTHWEST: 'Northwest', SOUTHEAST: 'Southeast', SOUTHWEST: 'Southwest' }
const dir = (s) => {
  const k = String(s ?? '').trim().toUpperCase()
  return DIR[k] ?? WORD_DIR[k] ?? title(k)
}
/** "CITY OF EAU CLAIRE" → "Eau Claire", "TOWN OF WASHINGTON" → "Washington". */
const place = (s) => title(String(s ?? '').replace(/^(CITY|VILLAGE|TOWN)\s+OF\s+/i, ''))

/** Only commercial (2) or manufacturing (3): no door to knock for a home service. */
export function commercialOnly(propclass) {
  const parts = String(propclass ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.every((p) => p === '2' || p === '3')
}

/** One parcel record to a GeoJSON feature, or null when it has no door to knock. */
export function toFeature(a) {
  const n = String(a.ADDNUM ?? '').trim()
  if (!/^\d/.test(n) || !a.STREETNAME || a.LONGITUDE == null || a.LATITUDE == null) return null
  if (commercialOnly(a.PROPCLASS)) return null
  const street = [dir(a.PREFIX), title(a.STREETNAME), title(a.STREETTYPE), dir(a.SUFFIX)].filter(Boolean).join(' ')
  const unitId = String(a.UNITID ?? '').trim()
  const unit = unitId ? [title(a.UNITTYPE), unitId].filter(Boolean).join(' ') : undefined
  const number = [String(a.ADDNUMPREFIX ?? '').trim(), n, String(a.ADDNUMSUFFIX ?? '').trim()].filter(Boolean).join(' ')
  const zip = String(a.ZIPCODE ?? '').trim().slice(0, 5)
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(a.LONGITUDE), Number(a.LATITUDE)] },
    properties: { number, street, unit, city: place(a.PLACENAME), zip: /^\d{5}$/.test(zip) ? zip : undefined },
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const features = []
  let skipped = 0
  for (const county of counties) {
    const where = `CONAME='${county.replace(/'/g, "''")}' AND ADDNUM IS NOT NULL`
    const { count } = await json(`${LAYER}?${new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' })}`)
    console.log(`${county}: ${count.toLocaleString()} addressed parcels`)
    for (let offset = 0; offset < count; offset += PAGE) {
      const q = new URLSearchParams({
        where,
        outFields: 'ADDNUM,ADDNUMPREFIX,ADDNUMSUFFIX,PREFIX,STREETNAME,STREETTYPE,SUFFIX,UNITTYPE,UNITID,PLACENAME,ZIPCODE,PROPCLASS,LONGITUDE,LATITUDE',
        returnGeometry: 'false',
        orderByFields: 'OBJECTID',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE),
        f: 'json',
      })
      const page = await json(`${LAYER}?${q}`)
      for (const f of page.features ?? []) {
        const feat = toFeature(f.attributes)
        if (feat) features.push(feat)
        else skipped++
      }
      if ((offset / PAGE) % 20 === 0) console.log(`  ${Math.min(offset + PAGE, count).toLocaleString()} / ${count.toLocaleString()}`)
    }
  }
  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`wrote ${features.length.toLocaleString()} addresses to ${out} (${skipped} commercial-only or without a number/street left out)`)
}
