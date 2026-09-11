import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import {
  decryptFile,
  encryptFile,
  isEncryptedBackup,
  readBackupHeader,
} from './lib/backup-crypto.mjs'

/**
 * The nightly backup happens without anyone remembering — and the file it leaves
 * is one the existing tooling can actually restore.
 *
 * Two halves, and the second is the one worth the runtime. A cron that fires is
 * easy to believe in and easy to get wrong in a way nothing reports: the whole
 * point of this feature is that nobody is watching, so every failure it can have
 * is a silent one. So this drives a real Worker with a real D1 and a real R2,
 * fires the real scheduled handler, and then takes what landed in the bucket and
 * feeds it to `verify-restore.mjs` — the same drill an operator runs against a
 * backup taken from a laptop, unmodified.
 *
 * What it asserts, in the order these things break:
 *
 *   the five-minute CRM tick does NOT take a backup — 288 dumps a day
 *   an unrecognised or absent cron falls through to the drain, not to a dump
 *   the nightly expression does take one, and stamps it as the cron's work
 *   what lands is encrypted, and is not plaintext SQL under a .enc name
 *   its KDF parameters are the same ones `backup.mjs` writes — not weaker
 *   the Node reader opens a Worker-written file, with no flag and no branch
 *   a single flipped byte is refused rather than half-restored
 *   **and the whole thing passes the restore drill**
 *   with no key, nothing is written at all — no plaintext "for now"
 *
 * The no-key case is last and is not a formality. It is the failure that would
 * put every customer's addresses, contact names, phone numbers and password
 * hashes in a bucket in the clear, and it would look like success from every
 * angle except opening the file.
 *
 * ## Why this reads the bucket rather than the log
 *
 * `scheduled()` logs every outcome, and in production that line is the report —
 * `wrangler tail` answers "did last night's backup happen" without opening
 * anything. Locally it is not observable: wrangler's dev server does not forward
 * console output from a scheduled dispatch the way it does from a request, so a
 * gate that waited for the line would wait forever on code that worked. So the
 * assertions here are about what is durably true afterwards — which objects
 * exist in the bucket, and what they say about themselves — which is a better
 * thing to assert anyway. It outlives the log.
 *
 * The bucket is read through miniflare's own index, which is an internal file
 * layout rather than a promised interface. That is a deliberate cost: wrangler 3
 * has no `r2 object list`, and the alternative is a gate that can only look up
 * objects whose names it already knows — which is exactly the thing under test.
 * If a wrangler upgrade moves it, this fails loudly at `bucketIndex()` rather
 * than passing while checking nothing.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8817)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-backup-pepper'
const STATE = resolve(api, '.wrangler/backup-state')
const BUCKET = 'allstar-backups'

/*
  Long enough to clear MIN_SECRET_CHARS, and fixed rather than random so a failed
  run leaves a file somebody can still open while working out what went wrong.
  It never encrypts anything but this test's throwaway database.
*/
const SECRET = 'smoke-backup-key-not-a-real-secret-0123456789'

const DRAIN_CRON = '*/5 * * * *'
const BACKUP_CRON = '17 7 * * *'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const scratch = mkdtempSync(join(tmpdir(), 'allstar-backup-smoke-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/* --- the crons the Worker actually declares -------------------------------- */
//
// Read out of wrangler.toml rather than trusted from the constants above. The
// expressions in src/backup.ts are what `scheduled()` branches on; the ones in
// wrangler.toml are what Cloudflare will ever fire. Nothing else in the project
// compares them, and if they drift the backup simply never runs — the code is
// correct, the schedule never reaches it, and every log line stays quiet.
{
  const toml = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const line = toml.match(/^crons\s*=\s*\[(.*)\]/m)?.[1] ?? ''
  const declared = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const source = readFileSync(resolve(api, 'src/backup.ts'), 'utf8')
  const inCode = {
    backup: source.match(/BACKUP_CRON\s*=\s*'([^']+)'/)?.[1],
    drain: source.match(/DRAIN_CRON\s*=\s*'([^']+)'/)?.[1],
  }
  ok(
    inCode.backup === BACKUP_CRON && inCode.drain === DRAIN_CRON,
    'the crons this gate fires are the ones src/backup.ts branches on',
    `backup ${inCode.backup}, drain ${inCode.drain}`,
  )
  ok(
    declared.includes(BACKUP_CRON),
    'wrangler.toml actually schedules the nightly backup',
    declared.join(' | ') || 'no crons declared',
  )
  ok(declared.includes(DRAIN_CRON), 'and still schedules the CRM drain')
}

/* --- server lifecycle ------------------------------------------------------ */

function writeConfig(name) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const body = source.replace('main = "src/index.ts"', 'main = "../src/index.ts"')
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

let child = null
/** Everything the Worker printed. Not assertable here — see the note above —
 *  but printed at the end of a failing run, where it is usually the only place
 *  the reason is written down. */
let log = ''

async function start(config, { withKey = true } = {}) {
  log = ''
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
      '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'info',
      // Exposes /__scheduled, which is the only way to reach `scheduled()`
      // without waiting for Cloudflare's clock.
      '--test-scheduled',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
      ...(withKey ? ['--var', `BACKUP_KEY:${SECRET}`] : []),
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
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
  throw new Error(`something is still listening on ${BASE} after stop()`)
}

function applySchema(config) {
  execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE,
     '--file', './schema.sql', '-c', config, '-y'],
    { cwd: api, stdio: 'ignore' },
  )
}

/**
 * Everything in the backups bucket, newest last.
 *
 * Read out of miniflare's own object index. wrangler 3 has no `r2 object list`,
 * and a gate that could only fetch objects whose names it already knew could not
 * tell "no backup was taken" from "a backup was taken under a name I did not
 * guess" — which is most of what this file is for. Each bucket gets its own
 * index keyed by a hash of its name, so the one holding `allstar-db-*` keys is
 * the one wanted; nothing else in this Worker writes objects shaped like that.
 *
 * Throws rather than returning nothing if the layout is not what it expects. A
 * helper that quietly answers "no objects" when it has lost track of where they
 * are would turn every assertion below into a passing one.
 */
function objectsInBucket() {
  const dir = resolve(STATE, 'v3/r2/miniflare-R2BucketObject')
  if (!existsSync(dir)) return []
  const indexes = readdirSync(dir).filter((f) => f.endsWith('.sqlite'))
  if (!indexes.length) return []

  const found = []
  for (const file of indexes) {
    const db = new DatabaseSync(resolve(dir, file), { readOnly: true })
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
      if (!tables.includes('_mf_objects')) {
        throw new Error(
          `miniflare's R2 index no longer has an _mf_objects table (${tables.join(', ')}). ` +
            `This gate reads it directly; a wrangler upgrade has moved it.`,
        )
      }
      for (const row of db.prepare('SELECT key, size, custom_metadata, uploaded FROM _mf_objects').all()) {
        if (String(row.key).startsWith('allstar-db-')) found.push(row)
      }
    } finally {
      db.close()
    }
  }
  return found.sort((a, b) => Number(a.uploaded) - Number(b.uploaded))
}

/**
 * Fire one scheduled event and give the handler time to act.
 *
 * `scheduled()` hands its work to `ctx.waitUntil` and returns, so the response
 * says nothing about the outcome. `settle` is how many objects the bucket should
 * end up holding: waiting for that is the assertion, and a run expected to write
 * nothing is given the same grace period to do the wrong thing in.
 */
async function fire(cron, { settle } = {}) {
  const url = cron === null ? `${BASE}/__scheduled` : `${BASE}/__scheduled?cron=${encodeURIComponent(cron)}`
  await fetch(url)
  for (let i = 0; i < 60; i++) {
    const now = objectsInBucket()
    if (settle !== undefined && now.length >= settle) return now
    await new Promise((r) => setTimeout(r, 500))
    if (settle === undefined && i >= 5) return objectsInBucket()
  }
  return objectsInBucket()
}

/** Pull an object out of the local R2 the Worker just wrote to. */
function fetchObject(config, key, outPath) {
  execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', outPath,
     '--local', '--persist-to', STATE, '-c', config],
    { cwd: api, stdio: 'ignore' },
  )
  return outPath
}

const call = (path, opts = {}) =>
  fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...opts.headers },
    ...opts,
  })

const stamp = Date.now()
const OWNER = { email: `backup-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig('backup-smoke.toml')

  await start(config)
  applySchema(config)
  await stop()
  const health = await start(config)

  ok(
    health.config?.backupBucket === true && health.config?.backupKey === true,
    'health reports that backups are configured, so a missing one is visible',
    JSON.stringify({ bucket: health.config?.backupBucket, key: health.config?.backupKey }),
  )

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner',
      email: OWNER.email, password: OWNER.password,
    }),
  })

  ok(objectsInBucket().length === 0, 'the bucket starts empty, so what appears was put there here')

  /* ===== 0. the console can see whether a backup ever happened ============= */
  //
  // `/api/health` reports that the bucket and the secret exist. That pair stays
  // true through a cron that silently stopped firing, which is the failure this
  // whole feature exists to make visible — so there is a second endpoint that
  // reports what is *in* the bucket, and the console reads it.
  //
  // Checked here, before anything has been written, because "configured and
  // empty" is the state that distinguishes the two claims. Anything can report
  // health once a backup exists.
  const OWNER_SESSION = await (await call('/api/auth/login', {
    method: 'POST', body: JSON.stringify(OWNER),
  })).json()
  const ADMIN_TOKEN = OWNER_SESSION.token
  ok(!!ADMIN_TOKEN, 'the first account signs in, so the ops endpoint can be asked as somebody')

  const opsBackups = (token) =>
    call('/api/ops/backups', token ? { headers: { authorization: `Bearer ${token}` } } : {})

  {
    const r = await opsBackups(ADMIN_TOKEN)
    const b = await r.json()
    ok(r.status === 200, 'a super admin may ask what is in the backup bucket', String(r.status))
    ok(b.configured === true, 'and is told the nightly job is configured')
    ok(
      b.latest === undefined && b.seen === 0,
      'and that nothing has ever been written — the state health cannot report',
      JSON.stringify({ latest: b.latest, seen: b.seen }),
    )
  }

  /* --- and nobody else may ------------------------------------------------- */
  //
  // The payload is a size and a run of dates, and both describe the database —
  // which is every customer's, not one company's. A field rep is the sharpest
  // test of that because a rep is signed in: this must refuse an authenticated
  // caller of the wrong role, not merely an anonymous one.
  {
    const anon = await opsBackups(null)
    ok(anon.status === 401 || anon.status === 403, 'an unauthenticated caller is refused', String(anon.status))

    const email = `backup-rep-${stamp}@example.com`
    const password = 'rep-password-1234'
    const invite = await (await call('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ email, name: 'Rep', role: 'field_rep' }),
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })).json()
    await fetch(invite.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }),
    })
    const rep = await (await call('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    })).json()
    ok(!!rep.token, 'a field rep is signed in, so the refusal is about role and not about auth')
    const r = await opsBackups(rep.token)
    ok(r.status === 403, 'and a signed-in field rep is refused the backup bucket', String(r.status))
  }

  /* ===== 1. the five-minute tick must not take a backup ==================== */
  //
  // 288 dumps a day of the entire database, every day, is the mistake this
  // branch exists to prevent, and it would look exactly like success.
  {
    const after = await fire(DRAIN_CRON)
    ok(after.length === 0, 'the five-minute CRM tick takes no backup', `${after.length} objects`)
  }

  /* ===== 2. an unknown cron falls through to the drain ===================== */
  //
  // A hand-triggered run from the dashboard, and `wrangler dev --test-scheduled`
  // itself, fire with no expression at all. The safe answer is the idempotent
  // five-minute job, not a full dump of the database.
  {
    const after = await fire(null)
    ok(after.length === 0, 'a scheduled event with no cron falls through to the drain')
  }

  /* ===== 3. the nightly expression does take one =========================== */
  let key = null
  {
    const after = await fire(BACKUP_CRON, { settle: 1 })
    ok(after.length === 1, 'the nightly cron takes a backup', `${after.length} objects`)
    key = after[0]?.key ?? null
    ok(
      /^allstar-db-\d{4}-\d{2}-\d{2}T[\d-]+Z\.sql\.enc$/.test(key ?? ''),
      'named and timestamped the way the laptop script names them, so one directory reads as one set',
      key ?? 'nothing was written',
    )
    /*
      Provenance in the object itself, not only in a log line that ages out. Six
      months from now the question "where did this file come from" has to have an
      answer that travels with the file — `wrangler r2 object head` shows this.
    */
    const meta = JSON.parse(after[0]?.custom_metadata ?? '{}')
    ok(meta.takenBy === 'cron', 'and is stamped as the cron\'s work, not a hand-run', JSON.stringify(meta))
  }

  if (!key) throw new Error('nothing was written to the bucket; the rest cannot be checked')

  /* ===== 3b. and the console now sees it ================================== */
  //
  // The same endpoint, after a real backup landed. Asserted against the object
  // the bucket actually holds rather than against itself: a status panel that
  // reports its own optimism is the thing being replaced here.
  {
    const b = await (await opsBackups(ADMIN_TOKEN)).json()
    ok(b.latest?.key === key, 'the ops endpoint names the object that landed', `${b.latest?.key}`)
    ok(b.seen === 1, 'and counts exactly the one backup taken', `${b.seen}`)
    ok(
      typeof b.latest?.bytes === 'number' && b.latest.bytes > 512,
      'with a size, so a dump that collapses overnight is visible',
      `${b.latest?.bytes} bytes`,
    )
    ok(
      typeof b.latest?.uploadedAt === 'number' && Date.now() - b.latest.uploadedAt < 600_000,
      'and a timestamp recent enough to answer "did last night work"',
      new Date(b.latest?.uploadedAt ?? 0).toISOString(),
    )
  }

  /* ===== 4. what landed in the bucket ====================================== */
  const file = fetchObject(config, key, join(scratch, key))
  const raw = readFileSync(file)

  ok(isEncryptedBackup(file), 'the object in the bucket is an Allstar encrypted backup')
  ok(
    !/CREATE TABLE|INSERT INTO/i.test(raw.toString('latin1')),
    'and holds no readable SQL — it is not a plaintext dump under a .enc name',
  )

  const { header } = readBackupHeader(file)

  /*
    Compared against a file the laptop script's own encryptor just wrote, rather
    than against numbers typed here. The Worker has its own copy of these
    parameters — two languages, two runtimes — and the failure if they drift is
    invisible: both files open, both are called encrypted, and one costs an
    attacker less per guess than the other.
  */
  {
    const plain = join(scratch, 'reference.sql')
    writeFileSync(plain, 'CREATE TABLE t (a);\n'.repeat(64))
    const { header: reference } = await encryptFile({
      plainPath: plain, outPath: join(scratch, 'reference.enc'), secret: SECRET, source: 'reference',
    })
    const shape = (h) => JSON.stringify({ kdf: h.kdf, N: h.N, r: h.r, p: h.p, keyBytes: h.keyBytes, cipher: h.cipher })
    ok(
      shape(header) === shape(reference),
      "the Worker's key derivation is the same strength as the laptop's",
      `worker ${shape(header)}`,
    )
  }

  ok(
    header.plainBytes > 512 && header.plainSha256?.length === 64,
    'the header records a plausible dump size and a fingerprint of it',
    `${header.plainBytes} bytes`,
  )
  ok(
    typeof header.source === 'string' && /worker|cron/i.test(header.source),
    'and says it came from the Worker, so a directory of files is legible',
    header.source,
  )

  /* ===== 5. the Node tooling reads a Worker-written file ==================== */
  //
  // The whole reason this was worth doing inside the Worker rather than
  // inventing a second format. If this fails, the backups exist and nothing in
  // this project can open them.
  const plainPath = join(scratch, 'restored.sql')
  let opened = false
  try {
    await decryptFile({ path: file, outPath: plainPath, secret: SECRET })
    opened = true
  } catch (err) {
    ok(false, 'npm run backup:open reads what the cron wrote', String(err.message).split('\n')[0])
  }
  if (opened) ok(true, 'npm run backup:open reads what the cron wrote')

  if (opened) {
    const sql = readFileSync(plainPath, 'utf8')
    ok(/CREATE TABLE/i.test(sql) && /INSERT INTO/i.test(sql), 'and it is a schema with rows in it')
    ok(sql.trimEnd().endsWith(';'), 'ending on a terminated statement, so nothing was cut off')
    ok(
      /INSERT INTO "users"/.test(sql) && /INSERT INTO "clients"/.test(sql),
      'including the rows somebody has to sign in with',
    )
    ok(
      !/CREATE TABLE\s+"?(sqlite_|_cf_)/i.test(sql),
      "and none of Cloudflare's own bookkeeping, which is not ours to restore",
    )
  }

  /* ===== 6. a damaged file is refused, not half-restored =================== */
  {
    const bent = join(scratch, 'bent.sql.enc')
    const copy = Buffer.from(raw)
    // One bit, in the middle of the ciphertext — the shape a truncated upload or
    // a bad disk takes, and the shape that restores cleanly up to the cut.
    copy[Math.floor(copy.length / 2)] ^= 0x01
    writeFileSync(bent, copy)
    let refused = false
    try {
      await decryptFile({ path: bent, outPath: join(scratch, 'bent.sql'), secret: SECRET })
    } catch {
      refused = true
    }
    ok(refused, 'a single flipped byte is refused rather than restored up to the damage')
    ok(!existsSync(join(scratch, 'bent.sql')), 'and no plaintext is left behind by the refusal')
  }

  /* ===== 7. the restore drill, on the cron's own file ====================== */
  //
  // The headline. Everything above says the file is well-formed; this says the
  // database comes back — same script, same arguments, as an operator running it
  // against a backup taken from a laptop.
  {
    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [resolve(here, 'verify-restore.mjs'), file], {
        cwd: api, encoding: 'utf8', env: { ...process.env, BACKUP_KEY: SECRET },
      })
    } catch (err) {
      code = err.status ?? 1
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    ok(code === 0, 'the backup the cron wrote passes the restore drill', `${out.split('\n').filter((l) => l.startsWith('FAIL')).join('; ') || 'all checks passed'}`)
    if (code !== 0) console.log(out.split('\n').slice(-25).join('\n'))
  }

  /* ===== 8. no key, no backup — and no plaintext ========================== */
  await stop()
  await start(config, { withKey: false })
  {
    const health2 = await fetch(`${BASE}/api/health`).then((r) => r.json())
    ok(
      health2.config?.backupKey === false,
      'health reports the missing key, so the deployment gap is visible from outside',
    )
    const before = objectsInBucket().length
    const after = await fire(BACKUP_CRON)
    ok(
      after.length === before,
      'with no key the run writes nothing at all — no plaintext dump "for now"',
      `${before} before, ${after.length} after`,
    )
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  /*
    The Worker's own output, last. It is not assertable here — wrangler's dev
    server does not forward console output from a scheduled dispatch — but when
    something has gone wrong it is usually the only place the reason is written
    down, and hunting for it by hand costs a run.
  */
  console.log(`\n--- what the Worker said ---\n${log.split('\n').slice(-40).join('\n')}`)
  process.exit(1)
}
console.log('\n=== the database backs itself up, and what it writes restores ===')
