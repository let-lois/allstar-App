import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { AwsClient } from 'aws4fetch'
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { unzipSync } from 'fflate'
import * as shapefile from 'shapefile'
import { Tiler, US_BOXES, US_COUNTRIES, buildingKey, buildingRow, inUS, rangeKey, rangeRow, tileFor, tilesForRange, toTileRow } from './lib/address-tiles.mjs'

/**
 * Every U.S. address — or every U.S. rooftop — from Overture, into R2.
 *
 *   npm run national:build -- --theme addresses --upload --account <id>
 *   npm run national:build -- --theme buildings --upload --account <id>
 *
 * addresses:build does one box in memory; the whole country does not fit, so
 * this works in three passes that each survive a restart:
 *
 *   1. read    every Overture row group that can hold U.S. rows, keep the U.S.
 *              rows, and append them to one file per z9 cell (~70 km) on disk
 *   2. tile    each z9 file is cut into its z14 tiles — a z14 tile lies inside
 *              exactly one z9 cell, so every tile is whole
 *   3. upload  through R2's S3 API, many at once. The Cloudflare REST API that
 *              wrangler uses allows about four writes a second, which is a day
 *              for a country; the S3 API is not limited that way
 *
 * Credentials: CLOUDFLARE_API_TOKEN, an account token with R2 write access. Its
 * S3 key is derived the way Cloudflare documents it (key id = token id,
 * secret = SHA-256 of the token); nothing is printed or stored.
 *
 * Resuming: pass 1 records each finished row group in <work>/read.done, pass 3
 * records each uploaded z9 cell in <work>/upload.done. Run the same command
 * again and it carries on.
 */

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const flag = (n) => args.includes(`--${n}`)
const theme = opt('theme')
if (!['addresses', 'buildings', 'tiger'].includes(theme)) {
  console.log('usage: node scripts/national-build.mjs --theme addresses|buildings|tiger [--release YYYY-MM-DD.N] [--tiger-url URL] [--work dir] [--upload --account ID | --write-local dir] [--bucket name] [--parallel 6] [--upload-parallel 48] [--max-groups N]')
  process.exit(1)
}
const work = resolve(opt('work', `./national-${theme}`))
const bucket = opt('bucket', 'allstar-addresses')
const parallel = Number(opt('parallel', 6))
const upParallel = Number(opt('upload-parallel', 48))
const maxGroups = Number(opt('max-groups', 0)) || Infinity
const S3 = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/'
mkdirSync(resolve(work, 'cells'), { recursive: true })

async function latestRelease() {
  const xml = await (await fetch(`${S3}?list-type=2&prefix=release/&delimiter=/`)).text()
  const names = [...xml.matchAll(/<Prefix>release\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]).sort()
  return names[names.length - 1]
}
const release = theme === 'tiger' ? 'tiger' : opt('release') ?? (await latestRelease())
const prefix = `release/${release}/theme=${theme}/type=${theme === 'addresses' ? 'address' : 'building'}/`

async function listKeys() {
  const keys = []
  let token = ''
  for (;;) {
    const xml = await (await fetch(`${S3}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`)).text()
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => k.endsWith('.parquet')))
    const next = /<NextContinuationToken>([^<]+)</.exec(xml)
    if (!next) break
    token = next[1]
  }
  return keys
}

const started = Date.now()
const secs = () => `${((Date.now() - started) / 1000).toFixed(0)}s`
const overlapsUS = (st) => {
  const x0 = st['bbox.xmin']?.min_value, x1 = st['bbox.xmax']?.max_value, y0 = st['bbox.ymin']?.min_value, y1 = st['bbox.ymax']?.max_value
  if ([x0, x1, y0, y1].some((v) => typeof v !== 'number')) return true
  return US_BOXES.some((b) => x0 <= b.xmax && x1 >= b.xmin && y0 <= b.ymax && y1 >= b.ymin)
}

/* --- pass 1: read ---------------------------------------------------------- */
const readDone = resolve(work, 'read.done')
const doneGroups = new Set(existsSync(readDone) ? readFileSync(readDone, 'utf8').split('\n').filter(Boolean) : [])
const readComplete = existsSync(resolve(work, 'read.complete'))

/*
  Census TIGER street ranges: one ADDRFEAT zip per county from the Census
  Bureau (or a mirror, --tiger-url), parsed with the shapefile reader. Each
  segment is written to every z14 tile its box touches, grouped by z9 cell
  like the other themes so a tile is always written whole.
*/
if (theme === 'tiger' && !readComplete) {
  const root = opt('tiger-url', 'https://www2.census.gov/geo/tiger/TIGER2025/ADDRFEAT/').replace(/\/?$/, '/')
  const index = await (await fetch(root)).text()
  const zips = [...new Set([...index.matchAll(/tl_\d{4}_(\d{5})_addrfeat\.zip/g)].map((m) => m[0]))].sort()
  const todo = zips.filter((z) => !doneGroups.has(z)).slice(0, maxGroups)
  console.log(`TIGER ADDRFEAT at ${root}: ${zips.length} county files; ${todo.length} to read (${secs()})`)
  let segs = 0, finished = 0
  // Rows are held per county and written only once that county is fully
  // read, so a crash never leaves half a county on disk to be read again.
  const flushAll = (out) => {
    for (const [cell, lines] of out) if (lines.length) appendFileSync(resolve(work, 'cells', `${cell}.ndjson`), lines.join('\n') + '\n')
  }
  async function readCounty(zip) {
    const out = new Map()
    const fips = /tl_\d{4}_(\d{5})_/.exec(zip)[1]
    let files
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(root + zip)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        // The Census firewall answers a burst of downloads with a small HTML
        // "Request Rejected" page (status 200). Back off hard and try again.
        if (!/zip|octet-stream/.test(r.headers.get('content-type') ?? '')) throw new Error('rejected by the server (rate limit)')
        // A cut-off or garbled download fails here too, so it is retried.
        files = unzipSync(new Uint8Array(await r.arrayBuffer()))
        break
      } catch (err) {
        if (attempt >= 5) {
          // One county the server keeps refusing must not stop the other
          // 3,000; it is listed in read.skipped and retried on the next run.
          console.log(`  skipped ${zip}: ${err.message}`)
          appendFileSync(resolve(work, 'read.skipped'), zip + '\n')
          return
        }
        await new Promise((res) => setTimeout(res, 15_000 * attempt))
      }
    }
    const shp = Object.keys(files).find((f) => f.endsWith('.shp'))
    const dbf = Object.keys(files).find((f) => f.endsWith('.dbf'))
    if (!shp || !dbf) throw new Error(`${zip}: no .shp/.dbf inside`)
    const src = await shapefile.open(files[shp].buffer.slice(files[shp].byteOffset, files[shp].byteOffset + files[shp].byteLength), files[dbf].buffer.slice(files[dbf].byteOffset, files[dbf].byteOffset + files[dbf].byteLength))
    for (;;) {
      const { done, value } = await src.read()
      if (done) break
      const row = rangeRow(value, fips)
      if (!row) continue
      segs++
      for (const t of tilesForRange(row)) {
        const c = tileFor(...(() => { const n = 2 ** 14; return [((t.x + 0.5) / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 0.5)) / n))) * 180) / Math.PI] })(), 9)
        const cell = `${c.x}_${c.y}`
        let a = out.get(cell)
        if (!a) { a = []; out.set(cell, a) }
        a.push(JSON.stringify([`${t.x}/${t.y}`, row]))
      }
    }
    flushAll(out)
    appendFileSync(readDone, zip + '\n')
    finished++
    if (finished % 50 === 0 || finished === todo.length) console.log(`  read ${finished}/${todo.length} counties · ${segs.toLocaleString()} ranged segments (${secs()})`)
  }
  for (let i = 0; i < todo.length; i += parallel) await Promise.all(todo.slice(i, i + parallel).map(readCounty))
  const skipped = existsSync(resolve(work, 'read.skipped')) ? new Set(readFileSync(resolve(work, 'read.skipped'), 'utf8').split('\n').filter(Boolean)) : new Set()
  const stillSkipped = [...skipped].filter((z) => !readFileSync(readDone, 'utf8').includes(z))
  if (stillSkipped.length) console.log(`${stillSkipped.length} county files were refused and skipped: ${stillSkipped.join(', ')}. They are left out of this load; fetch them later with a separate --work folder.`)
  if (todo.length === zips.filter((z) => !doneGroups.has(z)).length) writeFileSync(resolve(work, 'read.complete'), new Date().toISOString())
  else { console.log('stopped at --max-groups; run again to continue reading'); process.exit(0) }
}
if (theme !== 'tiger' && !readComplete) {
  const keys = await listKeys()
  console.log(`release ${release}, ${theme}: ${keys.length} files`)
  const groups = []
  for (let i = 0; i < keys.length; i += 16) {
    await Promise.all(keys.slice(i, i + 16).map(async (key) => {
      const file = await asyncBufferFromUrl({ url: S3 + key })
      const meta = await parquetMetadataAsync(file)
      let row = 0
      meta.row_groups.forEach((g, gi) => {
        const n = Number(g.num_rows)
        const st = {}
        for (const c of g.columns) {
          const p = c.meta_data.path_in_schema.join('.')
          if (p.startsWith('bbox.') || p === 'country') st[p] = c.meta_data.statistics ?? {}
        }
        let us = overlapsUS(st)
        if (us && theme === 'addresses' && typeof st.country?.min_value === 'string') {
          const lo = st.country.min_value, hi = st.country.max_value
          us = [...US_COUNTRIES].some((c) => lo <= c && c <= hi)
        }
        if (us) groups.push({ id: `${key.split('/').pop()}#${gi}`, file, meta, rowStart: row, rowEnd: row + n })
        row += n
      })
    }))
  }
  const todo = groups.filter((g) => !doneGroups.has(g.id)).slice(0, maxGroups)
  console.log(`${groups.length} row groups can hold U.S. rows; ${todo.length} to read (${secs()})`)

  const buffers = new Map()
  let kept = 0, read = 0, finished = 0
  const flush = (cell) => {
    const b = buffers.get(cell)
    if (!b?.length) return
    appendFileSync(resolve(work, 'cells', `${cell}.ndjson`), b.join('\n') + '\n')
    buffers.set(cell, [])
  }
  const columns = theme === 'addresses'
    ? ['number', 'street', 'unit', 'postcode', 'postal_city', 'address_levels', 'geometry', 'country']
    : ['bbox', 'subtype', 'class']
  async function readGroup(g) {
    const rows = await parquetReadObjects({ file: g.file, metadata: g.meta, rowStart: g.rowStart, rowEnd: g.rowEnd, columns, compressors })
    for (const r of rows) {
      read++
      let t
      if (theme === 'addresses') {
        if (!US_COUNTRIES.has(String(r.country ?? ''))) continue
        t = toTileRow(r)
        if (!t) continue
      } else {
        t = buildingRow(r)
        if (!t || !inUS(t[0], t[1])) continue
      }
      const lng = theme === 'addresses' ? t[6] : t[0], lat = theme === 'addresses' ? t[7] : t[1]
      const c = tileFor(lng, lat, 9)
      const cell = `${c.x}_${c.y}`
      let b = buffers.get(cell)
      if (!b) { b = []; buffers.set(cell, b) }
      b.push(JSON.stringify(t))
      kept++
      if (b.length >= 4000) flush(cell)
    }
    // A group's rows reach disk before it is marked read, so a restart never
    // skips rows it had only buffered.
    for (const cell of buffers.keys()) flush(cell)
    appendFileSync(readDone, g.id + '\n')
    finished++
    if (finished % 200 === 0 || finished === todo.length) console.log(`  read ${finished}/${todo.length} groups · ${read.toLocaleString()} rows · ${kept.toLocaleString()} U.S. kept (${secs()})`)
  }
  // Groups are read in parallel but flushed one at a time: appendFileSync is
  // synchronous, so two groups never interleave half-lines in one file.
  for (let i = 0; i < todo.length; i += parallel) await Promise.all(todo.slice(i, i + parallel).map(readGroup))
  if (todo.length === groups.filter((g) => !doneGroups.has(g.id)).length) writeFileSync(resolve(work, 'read.complete'), new Date().toISOString())
  else { console.log('stopped at --max-groups; run again to continue reading'); process.exit(0) }
}

/* --- passes 2 and 3: tile each cell, upload it ------------------------------ */
const localOut = opt('write-local')
if (!flag('upload') && !localOut) {
  const cells = readdirSync(resolve(work, 'cells')).length
  console.log(`read complete: ${cells} z9 cells on disk in ${work}. Add --upload --account <id> to tile and upload them.`)
  process.exit(0)
}
let s3 = null, base = ''
if (!localOut) {
  const account = opt('account', process.env.CLOUDFLARE_ACCOUNT_ID)
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) { console.error('--upload needs --account (or CLOUDFLARE_ACCOUNT_ID) and CLOUDFLARE_API_TOKEN'); process.exit(1) }
  const verify = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, { headers: { authorization: `Bearer ${token}` } })).json()
  if (!verify.success || !verify.result?.id) { console.error('CLOUDFLARE_API_TOKEN is not an active token for that account'); process.exit(1) }
  s3 = new AwsClient({ accessKeyId: verify.result.id, secretAccessKey: createHash('sha256').update(token).digest('hex'), service: 's3', region: 'auto' })
  base = `https://${account}.r2.cloudflarestorage.com/${bucket}`
}

async function put(key, body) {
  if (localOut) {
    const path = resolve(localOut, key)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body)
    return
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await s3.fetch(`${base}/${key}`, { method: 'PUT', body, headers: { 'content-type': 'application/json' } })
      if (r.ok) return
      throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    } catch (err) {
      if (attempt >= 5) throw new Error(`upload of ${key} failed after 5 tries: ${err.message}`)
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt))
    }
  }
}

const upDone = resolve(work, 'upload.done')
const doneCells = new Set(existsSync(upDone) ? readFileSync(upDone, 'utf8').split('\n').filter(Boolean) : [])
const cells = readdirSync(resolve(work, 'cells')).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -7)).filter((c) => !doneCells.has(c))
console.log(`uploading ${cells.length} z9 cells (${doneCells.size} already done) to ${bucket}`)
let tiles = 0, rowsUp = 0, cellsUp = 0
for (const cell of cells) {
  const lines = readFileSync(resolve(work, 'cells', `${cell}.ndjson`), 'utf8').split('\n').filter(Boolean)
  const entries = []
  if (theme === 'tiger') {
    const by = new Map()
    const seen = new Set()
    for (const l of lines) {
      // A county re-read after an interrupted run repeats its lines exactly.
      if (seen.has(l)) continue
      seen.add(l)
      const [xy, row] = JSON.parse(l)
      let a = by.get(xy)
      if (!a) { a = []; by.set(xy, a) }
      a.push(row)
    }
    for (const [xy, rows] of by) { const [x, y] = xy.split('/').map(Number); entries.push([rangeKey(x, y), rows]) }
  } else if (theme === 'addresses') {
    const tiler = new Tiler()
    for (const l of lines) tiler.add(JSON.parse(l))
    for (const t of tiler.entries()) entries.push([t.key, t.rows])
  } else {
    const by = new Map()
    const seen = new Set()
    for (const l of lines) {
      const r = JSON.parse(l)
      const k = `${r[0]},${r[1]}`
      if (seen.has(k)) continue
      seen.add(k)
      const t = tileFor(r[0], r[1])
      const key = buildingKey(t.x, t.y)
      let a = by.get(key)
      if (!a) { a = []; by.set(key, a) }
      a.push(r)
    }
    for (const e of by) entries.push(e)
  }
  for (let i = 0; i < entries.length; i += upParallel) {
    await Promise.all(entries.slice(i, i + upParallel).map(([key, rows]) => put(key, JSON.stringify(rows))))
  }
  tiles += entries.length
  rowsUp += entries.reduce((a, [, r]) => a + r.length, 0)
  appendFileSync(upDone, cell + '\n')
  cellsUp++
  if (cellsUp % 25 === 0 || cellsUp === cells.length) console.log(`  ${cellsUp}/${cells.length} cells · ${tiles.toLocaleString()} tiles · ${rowsUp.toLocaleString()} rows (${secs()})`)
  if (flag('clean')) rmSync(resolve(work, 'cells', `${cell}.ndjson`))
}
const manifest = { theme, release, cells: doneCells.size + cellsUp, tilesThisRun: tiles, rowsThisRun: rowsUp, builtAt: new Date().toISOString() }
await put(`v1/manifests/national-${theme}-${release}.json`, JSON.stringify(manifest, null, 2))
console.log(`done: ${tiles.toLocaleString()} tiles, ${rowsUp.toLocaleString()} rows this run (${secs()})`)
