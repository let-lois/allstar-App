import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Photo storage, end to end, against a real Worker.
 *
 * The reason this one starts its own server instead of assuming `wrangler dev`
 * like the other smokes: it needs to run the same Worker under two different
 * configurations, and only one of them is what wrangler.toml says.
 *
 * The R2 binding is live now, so the interesting case is the *other* one. A
 * deployment whose account has no `allstar-photos` bucket — a fork, a second
 * environment, a customer's own account before someone adds a payment method —
 * still has to refuse photos plainly rather than accept bytes it drops. That
 * path is unreachable from a config file that binds the bucket, so this
 * generates one that doesn't, into a gitignored directory, and tears it down.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8799)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-smoke-pepper'
const STATE = resolve(api, '.wrangler/photos-smoke-state')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/*
  A local dev server talks to 127.0.0.1 and must not be sent through an outbound
  proxy. `fetch` honours the proxy env in this environment, so every request
  here goes through an explicit no-proxy agent rather than hoping.
*/
const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

/* --- config generation ---------------------------------------------------- */

const R2_LIVE = '[[r2_buckets]]\nbinding = "PHOTOS"\nbucket_name = "allstar-photos"'
const R2_REMOVED = '# no photo storage on this deployment'

function writeConfig(name, withR2) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  if (!source.includes(R2_LIVE)) {
    // Loud rather than silently testing the wrong thing. If the binding has been
    // removed or renamed, the first half of this script is asserting nothing.
    throw new Error('wrangler.toml no longer binds PHOTOS to allstar-photos')
  }
  const body = source
    // The config lands one directory down, and `main` resolves relative to it.
    .replace('main = "src/index.ts"', 'main = "../src/index.ts"')
    .replace(R2_LIVE, withR2 ? R2_LIVE : R2_REMOVED)
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

/* --- server lifecycle ----------------------------------------------------- */

let child = null

async function start(config) {
  /*
    The local binary rather than `npx`, and its own process group.

    `npx wrangler` is two processes, and a SIGTERM to the outer one leaves the
    Worker holding the port. The next `start` then fails to bind, the health
    check reaches the *previous* server, and every assertion after it silently
    tests the wrong configuration — which is precisely the assertion this
    script exists to make.
  */
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '-c', config,
      '--port', String(PORT),
      '--ip', '127.0.0.1',
      '--local-protocol', 'http',
      '--persist-to', STATE,
      '--log-level', 'warn',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}

async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null

  // Wait for the port, not for the process. A dead parent with a live listener
  // is the exact state that makes the next phase test the wrong server.
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/api/health`)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`something is still listening on ${BASE} after stop()`)
}

const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.raw ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? opts.body,
  })

const form = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  })

/** A one-pixel JPEG, so the bytes compared at the end are real image bytes. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

let exitCode = 0
try {
  rmSync(STATE, { recursive: true, force: true })
  rmSync(resolve(api, '.wrangler/photos-smoke.toml'), { force: true })
  rmSync(resolve(api, '.wrangler/photos-nostorage.toml'), { force: true })

  /* --- with photo storage bound ------------------------------------------- */

  const withR2 = writeConfig('photos-smoke.toml', true)
  let health = await start(withR2)
  ok(health.config.r2 === true, 'the Worker reports photo storage as configured')

  // A fresh state directory has no tables. The Worker migrates on first request,
  // but the base schema is applied by the operator, so do that here too.
  await new Promise((done, fail) => {
    const p = spawn(
      resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE,
       '--file', './schema.sql', '-c', withR2, '-y'],
      { cwd: api, stdio: 'ignore' },
    )
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`d1 execute exited ${code}`))))
  })
  await stop()
  health = await start(withR2)
  ok(health.config.migrations.state !== 'failed', 'the database is ready')

  await form('/setup', {
    token: SETUP_TOKEN,
    clientName: 'Ridgeline Roofing',
    name: 'Nadia Petrov',
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  })
  const admin = await (
    await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
    })
  ).json()
  ok(!!admin.token, 'an administrator can sign in')

  const photoId = 'ph_smoke_1'

  const push = (mutations, token) =>
    call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations }) }, token)

  // A property to hang the photo on. There is no property.create mutation —
  // leads enter through the import endpoint, which mints the id itself, so it
  // has to be read back rather than chosen.
  await call(
    '/api/import/properties',
    {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          {
            ref: '1',
            address1: '18 Chestnut Row',
            city: 'Rochester',
            state: 'NY',
            zip: '14607',
            lat: 43.14,
            lng: -77.6,
          },
        ],
      }),
    },
    admin.token,
  )
  const boot = await (await call('/api/bootstrap', {}, admin.token)).json()
  const propertyId = boot.properties?.[0]?.id
  ok(!!propertyId, 'a property exists to attach a photo to')

  /* --- bytes are refused until the metadata row exists --------------------- */
  //
  // This is the ordering the client's queue depends on, so it is worth an
  // assertion of its own rather than an assumption: the row is what proves the
  // photo belongs to a property in this tenant, and without it there is nothing
  // to authorize against.
  {
    const res = await call(
      `/api/photos/${photoId}`,
      { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } },
      admin.token,
    )
    ok(res.status === 404, 'bytes for a photo with no metadata row are refused')
  }

  const created = await (
    await push(
      [
        {
          id: 'mut_photo',
          kind: 'photo.create',
          createdAt: Date.now(),
          payload: {
            id: photoId,
            propertyId,
            category: 'roof',
            width: 1600,
            height: 1200,
            bytes: JPEG.byteLength,
            createdAt: Date.now(),
          },
        },
      ],
      admin.token,
    )
  ).json()
  ok(created.results?.[0]?.status === 'applied', 'the photo metadata row is accepted')

  /* --- the round trip ------------------------------------------------------ */
  {
    const res = await call(
      `/api/photos/${photoId}`,
      { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } },
      admin.token,
    )
    ok(res.status === 200, 'the bytes are accepted once the row exists')

    const back = await call(`/api/photos/${photoId}`, {}, admin.token)
    ok(back.status === 200, 'and can be read back')
    const bytes = Buffer.from(await back.arrayBuffer())
    // Byte-for-byte, not "some bytes came back". A truncated or re-encoded
    // image is exactly the failure a length check would wave through.
    ok(bytes.equals(JPEG), 'byte for byte, it is the image that went up')
    ok(
      (back.headers.get('content-type') ?? '').startsWith('image/jpeg'),
      'served as an image rather than as a download',
    )
  }

  /* --- the office finds out the photo exists --------------------------------- */
  //
  // The path a device that never took the photo has to walk: ask the property
  // what it holds, then fetch the bytes by id. Without the listing there is no
  // id to fetch, which is why "it uploaded" was invisible to everyone but the
  // phone that shot it.
  {
    const res = await call(`/api/properties/${propertyId}/photos`, {}, admin.token)
    ok(res.status === 200, 'a property will list the photos it holds')
    const body = await res.json()
    ok(body.photos?.length === 1, 'and the uploaded photo is in that list')
    const row = body.photos?.[0] ?? {}
    ok(row.id === photoId, 'listed by the id the bytes are fetched with')
    ok(row.category === 'roof', 'carrying the category it was filed under')
    ok(row.bytes === JPEG.byteLength, 'and its size, so a strip can say what a fetch will cost')
    ok(
      row.r2Key === undefined && row.r2_key === undefined,
      'and not the storage key — a client has no use for it and no business knowing it',
    )
  }

  /* --- another tenant's property listing ------------------------------------- */
  {
    const res = await call('/api/properties/p_not_ours/photos', {}, admin.token)
    ok(res.status === 404, 'a property outside the account lists nothing')
  }

  /* --- unauthenticated ------------------------------------------------------ */
  {
    const res = await call(`/api/photos/${photoId}`)
    ok(res.status === 401, 'a photo cannot be read without a session')
  }

  /* --- another tenant ------------------------------------------------------- */
  //
  // Photos are the most sensitive thing in this database — someone's house,
  // their address, and when a stranger stood outside it.
  {
    const res = await call(`/api/photos/${photoId}`, {}, 'not-a-real-session-token')
    ok(res.status === 401, 'a forged token reads nothing')
  }

  /* --- tenant scoping, read off the source ---------------------------------- */
  //
  // A second company cannot be conjured on a deployment where /setup runs once,
  // so this is asserted where the guarantee actually lives: both photo handlers
  // look the row up by id *and* client_id together. Dropping that second
  // predicate is a one-word edit that makes every photo in the database
  // readable by anyone with a session and an id, and it would leave every
  // request in this file passing.
  {
    const source = readFileSync(resolve(api, 'src/index.ts'), 'utf8')
    const lookups = source.match(/'SELECT r2_key FROM photos WHERE[^']*'/g) ?? []
    ok(lookups.length === 2, 'both photo handlers look the row up before touching storage')
    ok(
      lookups.every((q) => /id = \?1 AND client_id = \?2/.test(q)),
      'and each one scopes that lookup to the signed-in tenant',
    )
  }

  /* --- oversize -------------------------------------------------------------- */
  {
    const huge = Buffer.alloc(8_000_001)
    const res = await call(
      `/api/photos/${photoId}`,
      { method: 'POST', raw: huge, headers: { 'content-type': 'image/jpeg' } },
      admin.token,
    )
    ok(res.status === 413, 'an oversize body is refused rather than stored')

    const back = await call(`/api/photos/${photoId}`, {}, admin.token)
    const bytes = Buffer.from(await back.arrayBuffer())
    ok(bytes.equals(JPEG), 'and the refusal did not overwrite the photo already there')
  }

  /* --- unknown photo ---------------------------------------------------------- */
  {
    const res = await call('/api/photos/ph_does_not_exist', {}, admin.token)
    ok(res.status === 404, 'an unknown photo id is a 404, not a 500')
  }

  await stop()

  /* --- without photo storage bound -------------------------------------------- */
  //
  // Any deployment whose account has no bucket. The client marks these photos
  // local and stops asking; what it must never be told is "stored".
  {
    const withoutR2 = writeConfig('photos-nostorage.toml', false)
    const h = await start(withoutR2)
    ok(h.config.r2 === false, 'the Worker reports photo storage as absent')

    const login = await (
      await call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
      })
    ).json()

    const res = await call(
      `/api/photos/${photoId}`,
      { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } },
      login.token,
    )
    const body = await res.json()
    ok(res.status === 503, 'an upload with nowhere to go is refused, not silently dropped')
    ok(
      body.code === 'no_photo_storage',
      'and refused with the code the client needs to stop retrying',
    )

    const read = await call(`/api/photos/${photoId}`, {}, login.token)
    ok(read.status === 503, 'reading is refused the same way rather than 500-ing')
  }
} catch (err) {
  console.log(`FAIL  ${err instanceof Error ? err.message : String(err)}`)
  fails.push('threw')
} finally {
  await stop()
  rmSync(STATE, { recursive: true, force: true })
  rmSync(resolve(api, '.wrangler/photos-smoke.toml'), { force: true })
  rmSync(resolve(api, '.wrangler/photos-nostorage.toml'), { force: true })
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  exitCode = 1
} else {
  console.log('\n=== photo storage OK ===')
}
process.exit(exitCode)
