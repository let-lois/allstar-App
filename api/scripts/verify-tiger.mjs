import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { addrfeatZip } from './lib/tiger-fixture.mjs'
import { rangeRow, stateForFips, tileFor } from './lib/address-tiles.mjs'

/**
 * The Census TIGER street-range loader, end to end, with no network: a county
 * file written in the real ADDRFEAT format is served from a stand-in Census
 * directory, national-build reads it, and the range tiles it writes are
 * checked row by row. The Worker's use of those tiles is verify:addresses.
 */
const here = dirname(fileURLToPath(import.meta.url))
const fails = []
const ok = (c, m, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? `  (${x})` : ''}`); if (!c) fails.push(m) }

// Anderson County, SC (45007): a block of Cypress Ridge Dr near Powdersville,
// numbered 100–198 on the left and 101–199 on the right, and a road with no
// numbers (a highway), which must be skipped.
const SEGS = [
  { name: 'Cypress Ridge Dr', lf: '100', lt: '198', rf: '101', rt: '199', zl: '29642', zr: '29642', line: [[-82.4980, 34.7820], [-82.4960, 34.7820], [-82.4940, 34.7820]] },
  { name: 'I- 85', line: [[-82.4990, 34.7800], [-82.4900, 34.7850]] },
  { name: 'Oak Ct', lf: '', lt: '', rf: '2', rt: '40', zr: '29642', line: [[-82.4950, 34.7830], [-82.4950, 34.7845]] },
]
const zip = addrfeatZip('tl_2025_45007_addrfeat', SEGS)
const server = createServer((req, res) => {
  if (req.url === '/') { res.end('<a href="tl_2025_45007_addrfeat.zip">tl_2025_45007_addrfeat.zip</a>'); return }
  if (req.url === '/tl_2025_45007_addrfeat.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(Buffer.from(zip)); return }
  res.writeHead(404); res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const work = mkdtempSync(join(tmpdir(), 'tiger-work-'))
const out = mkdtempSync(join(tmpdir(), 'tiger-out-'))
try {
  // Async: the stand-in Census server runs in this process and must keep answering.
  await promisify(execFile)(process.execPath, [resolve(here, 'national-build.mjs'), '--theme', 'tiger', '--tiger-url', `http://127.0.0.1:${port}/`, '--work', work, '--write-local', out, '--parallel', '1'], { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } })
  ok(existsSync(join(work, 'read.complete')), 'the loader reads every county file the directory lists')
  const t = tileFor(-82.496, 34.782)
  const key = join(out, 'r1', '14', String(t.x), `${t.y}.json`)
  ok(existsSync(key), 'and writes a range tile under r1/14/x/y', key.replace(out, ''))
  const rows = existsSync(key) ? JSON.parse(readFileSync(key, 'utf8')) : []
  const cy = rows.find((r) => r[0] === 'Cypress Ridge Dr')
  ok(!!cy && cy[1] === 100 && cy[2] === 198 && cy[3] === 101 && cy[4] === 199, 'a street keeps both sides of its number range', JSON.stringify(cy?.slice(0, 5)))
  ok(cy?.[5] === '29642' && cy?.[7] === 'SC', 'with its ZIP and a state from the county code', JSON.stringify([cy?.[5], cy?.[7]]))
  ok(Array.isArray(cy?.[8]) && cy[8].length === 6 && cy[8][0] === -82.498, 'and its line, as lng/lat pairs', JSON.stringify(cy?.[8]))
  ok(!rows.some((r) => /^I- 85/.test(r[0])), 'a road with no house numbers is left out')
  const oak = rows.find((r) => r[0] === 'Oak Ct')
  ok(!!oak && oak[1] === null && oak[3] === 2, 'a street numbered on one side only keeps that side', JSON.stringify(oak?.slice(0, 5)))
  ok(readdirSync(join(work, 'cells')).length >= 1, 'rows are staged by z9 cell, like the other national loads')
} catch (err) {
  ok(false, `the loader ran: ${String(err.stderr ?? err.message).slice(0, 400)}`)
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
}

ok(stateForFips('45007') === 'SC' && stateForFips('48453') === 'TX' && stateForFips('99999') === '', 'county codes name their state')
ok(rangeRow({ properties: { FULLNAME: 'Main St', LFROMHN: 'N12', LTOHN: 'N40' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }, '45007') === null, 'a range with letters in it (not a simple number) is skipped rather than guessed at')

if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1) }
console.log('\n=== TIGER ranges load from a county file into tiles ===')
