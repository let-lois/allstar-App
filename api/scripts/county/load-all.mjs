import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayer } from './arcgis-addresses.mjs'

/**
 * Load (or reload) the local address files in sources.json into the tiles.
 *
 *   node scripts/county/load-all.mjs [--only id,id] [--work dir] [--upload --account <id>]
 *
 * addresses:build rewrites every tile in its box from Overture plus the files
 * it is given, so building one county's box with only that county's file
 * would drop a neighbour's doors where the two boxes overlap. Each box here is
 * built with every source whose box touches it, so any build is whole.
 *
 * Files are downloaded once into --work (default ./county-work) and reused;
 * delete one to fetch it fresh. A source of kind "script" is made by its own
 * loader (clark-wa.mjs, wisconsin-parcels.mjs, milwaukee.mjs).
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const work = resolve(opt('--work', resolve(api, 'county-work')))
const sources = JSON.parse(readFileSync(resolve(here, 'sources.json'), 'utf8'))
const only = opt('--only') ? new Set(opt('--only').split(',')) : null
const targets = sources.filter((s) => !only || only.has(s.id))
mkdirSync(work, { recursive: true })

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
const fileOf = (s) => resolve(work, `${s.id}.geojson`)

async function ensure(s) {
  const file = fileOf(s)
  if (existsSync(file)) return file
  console.log(`fetching ${s.id} (${s.name})`)
  let features
  if (s.kind === 'arcgis') ({ features } = await loadLayer(s.layer, { bbox: s.bbox, where: s.where, map: s.map }))
  else {
    const tmp = `${file}.part`
    execFileSync('node', [resolve(here, s.script), ...(s.args ?? []), '--out', tmp], { cwd: api, stdio: 'inherit' })
    features = JSON.parse(readFileSync(tmp, 'utf8')).features
  }
  // The state each row belongs to, so one build can hold files from two states.
  for (const f of features) f.properties.state = s.state
  writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`  ${features.length.toLocaleString()} addresses`)
  return file
}

for (const t of targets) {
  const with_ = sources.filter((s) => overlaps(s.bbox, t.bbox))
  const files = []
  for (const s of with_) files.push(await ensure(s))
  console.log(`building ${t.id} with ${with_.map((s) => s.id).join(', ')}`)
  execFileSync('npm', ['run', '-s', 'addresses:build', '--', '--bbox', t.bbox.join(','), ...files.flatMap((f) => ['--geojson', f]), '--fields', 'number=number,street=street,unit=unit,city=city,zip=zip,state=state', '--out', resolve(work, 'tiles', t.id), ...(args.includes('--upload') ? ['--upload', '--account', opt('--account', process.env.CLOUDFLARE_ACCOUNT_ID ?? '')] : [])], { cwd: api, stdio: 'inherit' })
}
