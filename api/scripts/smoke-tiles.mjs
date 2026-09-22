import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The basemap tile proxy, against a real Worker and a stand-in MapTiler.
 *
 * What is being asserted is the reason the route exists: the key stays on the
 * server. A stand-in upstream records every request it receives, so the smoke
 * can say the key reached MapTiler and never reached the client — in the body,
 * in a header, or in the cache key. The rest is the contract the map relies
 * on: bytes for a tile the app asks for, a refusal for one it never would, and
 * an error that is never stored as imagery.
 *
 * Two Workers, because "no key configured" is a deployment state and not a
 * request: the first runs without MAPTILER_API_KEY and must answer 501 with a
 * sentence the client can show; the second runs with one.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8911)
const UPSTREAM_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/tiles-smoke-state')
const CONFIG = resolve(api, '.wrangler/tiles-smoke.toml')
const KEY = 'smoke-maptiler-key-do-not-reuse'
const ALLOWED = 'http://localhost:5173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

// 1x1 transparent PNG — a real image, so content-type and bytes can be checked.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/* --- the stand-in for api.maptiler.com ------------------------------------ */
const seen = []
let upstreamStatus = 200
const upstream = createServer((req, res) => {
  seen.push(req.url)
  if (upstreamStatus !== 200) {
    res.writeHead(upstreamStatus, { 'content-type': 'text/plain' })
    res.end('rate limited')
    return
  }
  const type = req.url.includes('satellite') ? 'image/jpeg' : 'image/png'
  res.writeHead(200, { 'content-type': type })
  res.end(PNG)
})
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))

/* --- lifecycle ------------------------------------------------------------- */
let child = null

function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  mkdirSync(dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
}

async function start(withKey) {
  const vars = [
    '--var', 'SESSION_PEPPER:local-tiles-pepper',
    '--var', `MAPTILER_BASE_URL:http://127.0.0.1:${UPSTREAM_PORT}`,
  ]
  if (withKey) vars.push('--var', `MAPTILER_API_KEY:${KEY}`)
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', CONFIG, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'warn', ...vars],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('worker did not come up')
}

async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`) } catch { return }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`something is still listening on ${BASE}`)
}

const tile = (path, origin = ALLOWED) => fetch(`${BASE}${path}`, { headers: origin ? { origin } : {} })

try {
  rmSync(STATE, { recursive: true, force: true })
  writeConfig()

  /* --- no key: refused with a sentence, and health says so ---------------- */
  console.log('--- a deployment with no key ---')
  let health = await start(false)
  ok(health.config?.tiles === false, 'health reports tiles as not configured')
  {
    const res = await tile('/api/tiles/streets/16/15234/26856.png')
    ok(res.status === 501, `a tile is refused with 501 (${res.status})`)
    const body = await res.json().catch(() => ({}))
    ok(body.code === 'no_tile_key', `and names the reason (${body.code})`)
    ok(seen.length === 0, 'nothing was asked of MapTiler')
  }
  await stop()

  /* --- with a key ---------------------------------------------------------- */
  console.log('\n--- a deployment with a key ---')
  health = await start(true)
  ok(health.config?.tiles === true, 'health reports tiles as configured')
  ok(!JSON.stringify(health).includes(KEY), 'and never the key itself')

  {
    const res = await tile('/api/tiles/streets/16/15234/26856.png')
    ok(res.status === 200, `a streets tile is served (${res.status})`)
    ok((res.headers.get('content-type') ?? '').startsWith('image/png'), `as an image (${res.headers.get('content-type')})`)
    const bytes = Buffer.from(await res.arrayBuffer())
    ok(bytes.equals(PNG), `with MapTiler's bytes, unchanged (${bytes.length} bytes)`)
    ok(res.headers.get('access-control-allow-origin') === ALLOWED, 'CORS is echoed for an allowed origin, so the offline download can fetch it')
    ok(/immutable/.test(res.headers.get('cache-control') ?? ''), `and marked immutable for the browser (${res.headers.get('cache-control')})`)
    ok(seen.length === 1, `MapTiler was asked once (${seen.length})`)
    ok(seen[0]?.includes(`key=${KEY}`), 'with the key')
    ok(seen[0]?.startsWith('/maps/streets-v2/256/16/15234/26856.png'), `at its streets path (${seen[0]?.split('?')[0]})`)
    // The key must not leak back out in any header.
    const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
    ok(!headers.includes(KEY), 'and the key is in no response header')
  }

  {
    const res = await tile('/api/tiles/satellite/15/7617/13428.jpg')
    ok(res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('image/jpeg'), `a satellite tile is served as JPEG (${res.status}, ${res.headers.get('content-type')})`)
    ok(seen[1]?.startsWith('/tiles/satellite-v2/15/7617/13428.jpg'), `at its satellite path (${seen[1]?.split('?')[0]})`)
  }

  /* --- the edge cache: the second ask never reaches MapTiler ------------- */
  {
    const before = seen.length
    const res = await tile('/api/tiles/streets/16/15234/26856.png')
    ok(res.status === 200, 'the same tile again is still served')
    ok(seen.length === before, `and MapTiler was not asked again (${seen.length - before} extra)`)
    ok(res.headers.get('x-tile-cache') === 'hit', `the response says it came from the cache (${res.headers.get('x-tile-cache')})`)
  }

  /* --- what the app never asks for is refused, not proxied ---------------- */
  console.log('\n--- refusals ---')
  {
    const before = seen.length
    for (const [path, why] of [
      ['/api/tiles/terrain/16/1/1.png', 'a layer the app has no renderer for'],
      ['/api/tiles/streets/16/1/1.jpg', 'the wrong extension for the layer'],
      ['/api/tiles/streets/3/1/1.png', 'a zoom below what the map ever shows'],
      ['/api/tiles/streets/21/1/1.png', 'a zoom above what the map ever shows'],
      ['/api/tiles/streets/16/99999/1.png', 'an x outside the zoom level'],
    ]) {
      const res = await tile(path)
      ok(res.status === 400, `${why} is a 400 (${res.status}) — ${path}`)
    }
    ok(seen.length === before, 'none of them reached MapTiler')
  }

  /* --- an upstream error is never stored as a tile ------------------------ */
  console.log('\n--- MapTiler says no ---')
  {
    upstreamStatus = 429
    const res = await tile('/api/tiles/streets/14/3808/6714.png')
    ok(res.status === 502, `a rate-limited upstream is a 502 (${res.status})`)
    ok(res.headers.get('cache-control') === 'no-store', 'and told not to be cached')
    const body = await res.json().catch(() => ({}))
    ok(body.code === 'tiles_unavailable', `with a code the client can act on (${body.code})`)

    // Now MapTiler recovers. If the error had been cached as a tile, this would
    // serve the error page's bytes; it must go upstream again.
    upstreamStatus = 200
    const before = seen.length
    const again = await tile('/api/tiles/streets/14/3808/6714.png')
    ok(again.status === 200, `the same tile is served once MapTiler recovers (${again.status})`)
    ok(seen.length === before + 1, 'by asking again rather than replaying the failure')
  }

  /* --- a stranger's origin gets the bytes but no CORS ---------------------- */
  {
    const res = await tile('/api/tiles/streets/16/15234/26856.png', 'https://not-on-the-list.example')
    ok(res.status === 200, 'an <image> from anywhere still loads — that is what makes it usable from file://')
    ok(!res.headers.get('access-control-allow-origin'), 'but a foreign page cannot read the bytes with fetch')
  }
} finally {
  await stop().catch(() => {})
  upstream.close()
  rmSync(STATE, { recursive: true, force: true })
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} tile check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the tile proxy keeps the key and serves the map ===')
