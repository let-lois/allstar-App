import { AwsClient } from 'aws4fetch'
import { unzipSync, strFromU8 } from 'fflate'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * The ZIP → postal town table the Worker fills blank towns from.
 *
 * Leads estimated from Census street ranges carry a ZIP but no town (see
 * src/zip-city.ts). This builds the table from GeoNames' US postal codes —
 * CC BY 4.0, credited in docs/ADDRESS_SOURCES.md — and puts it in the address
 * bucket at meta/zip-city.json, about 600 KB.
 *
 *   npm run zip-cities:build -- --upload --account <id>     build and upload
 *   npm run zip-cities:build -- --write-local <dir>         write the file only
 *   npm run zip-cities:build -- --file US.txt ...           from a downloaded file
 */

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const flag = (n) => args.includes(`--${n}`)
const KEY = 'meta/zip-city.json'
const URL_US = 'https://download.geonames.org/export/zip/US.zip'

/** One row per postal code: country, code, place, state name, state code, … */
export function parseGeonames(text) {
  const map = {}
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 5 || f[0] !== 'US') continue
    const zip = f[1]?.trim()
    const town = f[2]?.trim()
    if (!/^\d{5}$/.test(zip) || !town) continue
    // The first row for a ZIP is its preferred place; later ones are alternates.
    if (!(zip in map)) map[zip] = town
  }
  return map
}

async function main() {
  let text
  if (opt('file')) text = readFileSync(opt('file'), 'utf8')
  else {
    const r = await fetch(URL_US)
    if (!r.ok) throw new Error(`GeoNames download: HTTP ${r.status}`)
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()))
    const name = Object.keys(files).find((f) => /US\.txt$/i.test(f))
    if (!name) throw new Error('GeoNames zip has no US.txt')
    text = strFromU8(files[name])
  }
  const map = parseGeonames(text)
  const count = Object.keys(map).length
  if (count < 30_000) throw new Error(`only ${count} ZIPs parsed; refusing to replace the table with a partial one`)
  const body = JSON.stringify(map)
  console.log(`${count.toLocaleString()} ZIPs, ${(body.length / 1024).toFixed(0)} KB`)

  if (opt('write-local')) {
    const path = resolve(opt('write-local'), KEY)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    console.log(`wrote ${path}`)
    return
  }
  if (!flag('upload')) { console.log('add --upload --account <id> to put it in the bucket, or --write-local <dir>'); return }
  const account = opt('account', process.env.CLOUDFLARE_ACCOUNT_ID)
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) throw new Error('--upload needs --account (or CLOUDFLARE_ACCOUNT_ID) and CLOUDFLARE_API_TOKEN')
  const verify = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, { headers: { authorization: `Bearer ${token}` } })).json()
  if (!verify.success || !verify.result?.id) throw new Error('CLOUDFLARE_API_TOKEN is not an active token for that account')
  const s3 = new AwsClient({ accessKeyId: verify.result.id, secretAccessKey: createHash('sha256').update(token).digest('hex'), service: 's3', region: 'auto' })
  const url = `https://${account}.r2.cloudflarestorage.com/${opt('bucket', 'allstar-addresses')}/${KEY}`
  const put = await s3.fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/json' } })
  if (!put.ok) throw new Error(`upload: HTTP ${put.status} ${await put.text()}`)
  const back = await s3.fetch(url)
  const n = back.ok ? Object.keys(await back.json()).length : 0
  if (n !== count) throw new Error(`read back ${n} ZIPs, expected ${count}`)
  console.log(`uploaded ${KEY} and read it back: ${n.toLocaleString()} ZIPs`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1) })
