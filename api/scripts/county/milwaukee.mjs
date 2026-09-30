import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * City of Milwaukee residential addresses, as GeoJSON for addresses:build.
 *
 * Overture has no address points for the City of Milwaukee (its county does
 * not contribute to the National Address Database), so a territory there was
 * every door estimated from Census ranges. The city publishes both halves of
 * what is needed, under Creative Commons Attribution:
 *
 *   Master Address Index (MAI): every address, with its tax key, unit, ZIP
 *     and a residential/commercial flag (RES_COM_FLAG R or C), no coordinates;
 *   Parcels (reference map layer 24): each tax key's outline.
 *
 * Each residential address is placed at its parcel's centroid. Commercial
 * addresses are left out, which is the residential filter for the city.
 *
 *   node scripts/county/milwaukee.mjs --out milwaukee.geojson
 *   npm run addresses:build -- --bbox -88.0650,42.9205,-87.8680,43.1925 \
 *     --geojson milwaukee.geojson --fields number=number,street=street,unit=unit,city=city,zip=zip \
 *     --state WI --upload --account <id>
 *
 * Credit: "Address data © City of Milwaukee, CC BY" (docs/ADDRESS_SOURCES.md).
 */

const args = process.argv.slice(2)
const out = resolve(args[args.indexOf('--out') + 1] ?? 'milwaukee.geojson')
const MAI = 'https://data.milwaukee.gov/dataset/566af1a6-0499-4766-a89e-2f2a4b4d6e2d/resource/9f905487-720e-4f30-ae70-b5ec8a2a65a1/download/mai.csv'
const PARCELS = 'https://milwaukeemaps.milwaukee.gov/arcgis/rest/services/reference/reference_map/MapServer/24/query'

async function json(url, tries = 5) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (err) {
      if (a >= tries) throw err
      await new Promise((res) => setTimeout(res, 3000 * a))
    }
  }
}

/** Area-weighted centroid of the largest ring, falling back to the vertex mean. */
export function centroid(rings) {
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a), [])
  let A = 0, cx = 0, cy = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    const c = x1 * y2 - x2 * y1
    A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c
  }
  if (Math.abs(A) < 1e-12) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]
  return [cx / (3 * A), cy / (3 * A)]
}

/** A minimal CSV reader: quoted fields, CR, LF or CRLF line ends. */
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0]) rows.push(row)
      row = []
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const title = (s) => s.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')

async function main() {
  const centres = new Map()
  for (let off = 0; ; ) {
    const d = await json(`${PARCELS}?where=1%3D1&outFields=TAXKEY&returnGeometry=true&outSR=4326&geometryPrecision=6&resultOffset=${off}&resultRecordCount=2000&orderByFields=OBJECTID&f=json`)
    const fs = d.features ?? []
    for (const f of fs) if (f.attributes?.TAXKEY && f.geometry?.rings?.length) centres.set(f.attributes.TAXKEY, centroid(f.geometry.rings))
    off += fs.length
    if (fs.length < 2000 && !d.exceededTransferLimit) break
  }
  console.log(`${centres.size.toLocaleString()} parcels`)

  const r = await fetch(MAI)
  if (!r.ok) throw new Error(`MAI: HTTP ${r.status}`)
  const [head, ...rows] = parseCsv(await r.text())
  const at = Object.fromEntries(head.map((h, i) => [h, i]))
  const features = []
  let commercial = 0, unplaced = 0
  for (const row of rows) {
    const v = (k) => (row[at[k]] ?? '').trim()
    if (v('RES_COM_FLAG') !== 'R') { commercial++; continue }
    const c = centres.get(v('TAXKEY'))
    if (!c) { unplaced++; continue }
    const n = v('HSE_NBR')
    if (!n || n === '0') continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(c[0].toFixed(6)), Number(c[1].toFixed(6))] },
      properties: {
        number: v('SFX') ? `${n} ${v('SFX')}` : n,
        street: [v('DIR'), title(v('STREET')), title(v('STTYPE'))].filter(Boolean).join(' '),
        unit: v('UNIT_NBR'),
        city: 'Milwaukee',
        zip: v('ZIP_CODE').slice(0, 5),
      },
    })
  }
  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`${features.length.toLocaleString()} residential addresses → ${out} (${commercial.toLocaleString()} commercial left out, ${unplaced} with no parcel)`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1) })
