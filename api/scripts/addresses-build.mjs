import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { Tiler, groupOverlaps, parseBbox, snapBoxToTiles, toTileRow } from './lib/address-tiles.mjs'

/**
 * Build the address tiles the Worker reads when a territory is drawn.
 *
 *   npm run addresses:build -- --bbox -97.95,30.10,-97.55,30.55
 *   npm run addresses:build -- --bbox ... --upload
 *
 * Reads Overture Maps' `addresses` theme straight from its public bucket —
 * no key, no download of the 28 GB release. Each of its 64 Parquet files
 * carries per-row-group bounding boxes, so only the footers (a few MB in all)
 * and the row groups that overlap the wanted box are fetched. A metro is a
 * minute or two; a state is longer and a bigger bucket bill, and rarely what a
 * crew needs — build the ground you sell on.
 *
 * Output: `v1/14/{x}/{y}.json` under --out (default ./addr-tiles), plus a
 * manifest with what was built. --upload puts every file into the
 * `allstar-addresses` bucket with wrangler, which needs the bucket to exist
 * and `wrangler login` (or CLOUDFLARE_API_TOKEN) — see docs/ADDRESSES.md.
 * Re-running over the same box rewrites the same tiles; over a neighbouring
 * box it adds more. Tiles never merge across runs, so build a box whole.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

if (flag('help') || !opt('bbox')) {
  console.log(`usage: node scripts/addresses-build.mjs --bbox minLng,minLat,maxLng,maxLat [--out dir] [--release YYYY-MM-DD.N] [--upload] [--bucket name] [--parallel 8]`)
  process.exit(opt('bbox') ? 0 : 1)
}

// Widened to whole tiles, so every tile written is complete and a neighbouring
// build over the next box reproduces the shared ones rather than halving them.
const asked = parseBbox(opt('bbox'))
const box = snapBoxToTiles(asked)
const out = resolve(opt('out', './addr-tiles'))
const bucket = opt('bucket', 'allstar-addresses')
const parallel = Math.max(1, Number(opt('parallel', 8)) || 8)
const S3 = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/'

/* --- which release ---------------------------------------------------------- */
async function latestRelease() {
  const xml = await (await fetch(`${S3}?list-type=2&prefix=release/&delimiter=/`)).text()
  const names = [...xml.matchAll(/<Prefix>release\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]).sort()
  if (!names.length) throw new Error('could not list Overture releases')
  return names[names.length - 1]
}
const release = opt('release') ?? (await latestRelease())
const prefix = `release/${release}/theme=addresses/type=address/`

/* --- the files ----------------------------------------------------------------- */
async function listKeys() {
  const keys = []
  let token = ''
  for (;;) {
    const url = `${S3}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
    const xml = await (await fetch(url)).text()
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => k.endsWith('.parquet')))
    const next = /<NextContinuationToken>([^<]+)</.exec(xml)
    if (!next) break
    token = next[1]
  }
  return keys
}

const started = Date.now()
const keys = await listKeys()
console.log(`release ${release}: ${keys.length} files; box ${JSON.stringify(asked)} widened to tiles ${box.tiles.x0}-${box.tiles.x1}/${box.tiles.y0}-${box.tiles.y1}`)

/* --- footers first, then only the groups that overlap ----------------------- */
const wanted = []
let scanned = 0
async function scan(key) {
  const file = await asyncBufferFromUrl({ url: S3 + key })
  const meta = await parquetMetadataAsync(file)
  let row = 0
  for (const g of meta.row_groups) {
    const n = Number(g.num_rows)
    const stats = {}
    for (const c of g.columns) {
      const p = c.meta_data.path_in_schema.join('.')
      if (p.startsWith('bbox.')) stats[p] = c.meta_data.statistics ?? {}
    }
    if (groupOverlaps(stats, box)) wanted.push({ key, file, meta, rowStart: row, rowEnd: row + n })
    row += n
  }
  scanned++
}
for (let i = 0; i < keys.length; i += parallel) await Promise.all(keys.slice(i, i + parallel).map(scan))
console.log(`scanned ${scanned} footers in ${((Date.now() - started) / 1000).toFixed(1)}s; ${wanted.length} row groups overlap`)

/* --- read and tile ------------------------------------------------------------- */
const tiler = new Tiler()
let read = 0, kept = 0, dropped = 0, done = 0
async function pull(w) {
  const rows = await parquetReadObjects({
    file: w.file,
    metadata: w.meta,
    rowStart: w.rowStart,
    rowEnd: w.rowEnd,
    columns: ['number', 'street', 'unit', 'postcode', 'postal_city', 'address_levels', 'geometry'],
    compressors,
  })
  for (const r of rows) {
    read++
    const t = toTileRow(r)
    if (!t) { dropped++; continue }
    if (t[6] < box.xmin || t[6] > box.xmax || t[7] < box.ymin || t[7] > box.ymax) continue
    if (tiler.add(t)) kept++
  }
  done++
  if (done % 10 === 0 || done === wanted.length) {
    console.log(`  ${done}/${wanted.length} groups · ${read.toLocaleString()} rows read · ${kept.toLocaleString()} addresses kept`)
  }
}
for (let i = 0; i < wanted.length; i += parallel) await Promise.all(wanted.slice(i, i + parallel).map(pull))

/* --- write --------------------------------------------------------------------- */
let files = 0
for (const t of tiler.entries()) {
  const path = resolve(out, t.key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(t.rows))
  files++
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const manifest = { release, bbox: asked, tileBox: box, tiles: files, addresses: kept, rowsRead: read, droppedNoStreetOrNumber: dropped, builtAt: new Date().toISOString() }
const manifestKey = `v1/manifests/${stamp}.json`
mkdirSync(resolve(out, 'v1/manifests'), { recursive: true })
writeFileSync(resolve(out, manifestKey), JSON.stringify(manifest, null, 2))
console.log(`wrote ${files} tiles holding ${kept.toLocaleString()} addresses to ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`)

/* --- upload -------------------------------------------------------------------- */
if (flag('upload')) {
  const wrangler = resolve(api, 'node_modules/.bin/wrangler')
  const put = (key) =>
    execFileSync(wrangler, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', resolve(out, key), '--content-type', 'application/json', ...(flag('local') ? ['--local'] : [])], { cwd: api, stdio: 'ignore' })
  let n = 0
  for (const t of tiler.entries()) {
    put(t.key)
    n++
    if (n % 25 === 0) console.log(`  uploaded ${n}/${files}`)
  }
  put(manifestKey)
  console.log(`uploaded ${n} tiles and the manifest to ${bucket}`)
} else {
  console.log(`not uploaded; add --upload to put them in the ${bucket} bucket`)
}
