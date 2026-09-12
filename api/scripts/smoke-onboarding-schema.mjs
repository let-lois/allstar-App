import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

/**
 * Migrations 015-019 against a database from before onboarding existed.
 *
 * The shared smoke Worker starts from today's `schema.sql`, so on it every
 * guarded migration is skipped and the backfill has nothing to touch. That is
 * the fresh-install path, and it is the *easy* one. This is the other: a
 * database with the schema as it stood at the last commit before this feature,
 * with real rows in it, brought forward by the Worker on its first request.
 *
 * Three things are pinned that nothing else can pin:
 *
 *   **The ALTERs run.** Fifteen columns on `users`, two on `invites`, four on
 *   `clients`, a new table — and afterwards a login and a roster read work.
 *
 *   **A half-applied migration finishes rather than wedging.** One of the
 *   columns is added by hand *before* the Worker starts, which is what a
 *   failure between two ALTERs on a previous boot leaves behind. With the old
 *   runner that database is stuck forever: retry, "duplicate column name",
 *   claim released, retry. The per-statement guard is what makes it finish.
 *
 *   **The backfill.** An account that existed before the feature reads as
 *   onboarding *complete* at version 1, with its completion dated to when the
 *   account was made; an invitee who never set a password does not, and their
 *   old invite row — written before `kind` existed — reads as a pending
 *   invitation.
 *
 * The baseline is a frozen fixture, not `git show`: a test that needs git
 * history to run is a test that fails on a shallow clone for a reason that has
 * nothing to do with the code.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8861)
const BASE = `http://127.0.0.1:${PORT}`
const STATE = resolve(api, '.wrangler/onboarding-schema-state')
const PEPPER = 'local-onboarding-pepper'
const BASELINE = resolve(here, 'fixtures/schema-before-onboarding.sql')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- the fixture is what it claims to be ------------------------------------ */
{
  const baseline = readFileSync(BASELINE, 'utf8')
  ok(!/first_name|badge_id|CREATE TABLE IF NOT EXISTS teams/.test(baseline), 'the baseline schema predates onboarding — no teams, no badge, no first_name')
  ok(/CREATE TABLE IF NOT EXISTS invites/.test(baseline) && !/revoked_at/.test(baseline), 'and its invites table has no revoked_at or kind')
}

/* --- helpers ---------------------------------------------------------------- */

const wrangler = resolve(api, 'node_modules/.bin/wrangler')

function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const path = resolve(api, '.wrangler/onboarding-schema.toml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
  return path
}

function d1(config, args) {
  return execFileSync(
    wrangler,
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '-c', config, '-y', ...args],
    { cwd: api, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString()
}
const d1json = (config, sql) => {
  const out = d1(config, ['--json', '--command', sql])
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  return parsed[0]?.results ?? []
}

let child = null
let log = ''
async function start(config) {
  log = ''
  child = spawn(
    wrangler,
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
     '--persist-to', STATE, '--log-level', 'info',
     '--var', `SESSION_PEPPER:${PEPPER}`],
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

/** The Worker's own recipe (src/auth.ts), so a seeded account can sign in. */
async function hashPassword(password, salt, pepper) {
  const enc = new TextEncoder()
  const key = await webcrypto.subtle.importKey('raw', enc.encode(`${password}${pepper}`), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256)
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const api_ = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })

/* --- the database from before ----------------------------------------------- */

const OLD = { email: 'old-admin@example.com', password: 'an-old-password-1234' }
const MADE_AT = 1_700_000_000_000

let config
try {
  rmSync(STATE, { recursive: true, force: true })
  config = writeConfig()

  d1(config, ['--file', BASELINE])
  const hash = await hashPassword(OLD.password, 'seedsalt', PEPPER)
  const seed = resolve(api, '.wrangler/onboarding-schema-seed.sql')
  writeFileSync(seed, `
    INSERT INTO clients (id, name, created_at) VALUES ('c_old', 'Legacy Roofing', ${MADE_AT});
    INSERT INTO users (id, client_id, email, name, role, password_hash, password_salt, active, created_at)
      VALUES ('u_old_admin', 'c_old', '${OLD.email}', 'Old Hand', 'super_admin', '${hash}', 'seedsalt', 1, ${MADE_AT});
    INSERT INTO users (id, client_id, email, name, role, active, created_at)
      VALUES ('u_pending', 'c_old', 'pending@example.com', 'Never Opened', 'field_rep', 0, ${MADE_AT + 1000});
    INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at)
      VALUES ('not-a-real-hash', 'u_pending', 'u_old_admin', ${MADE_AT + 1000}, 9999999999999);
  `)
  d1(config, ['--file', seed])

  /*
    The half-applied state. On a previous boot, imagine migration 016 got as far
    as adding `job_title` and then lost the isolate. The next boot must finish
    the job, not fail on the column that is already there.
  */
  d1(config, ['--command', 'ALTER TABLE users ADD COLUMN job_title TEXT'])
  const before = d1json(config, "SELECT name FROM pragma_table_info('users')").map((r) => r.name)
  ok(before.includes('job_title') && !before.includes('first_name'), 'the database starts half-migrated: job_title present, first_name absent')

  /* --- the Worker brings it forward on its first request --------------------- */
  const health = await start(config)
  ok(health.config?.migrations?.state === 'ok', 'migrations applied themselves on first request', `state=${health.config?.migrations?.state} error=${health.config?.migrations?.error}`)

  /* --- and the account from before signs in, complete ------------------------ */
  const res = await api_('/api/auth/login', { method: 'POST', body: JSON.stringify(OLD) })
  ok(res.ok, 'an account from before the feature still signs in', String(res.status))
  const session = res.ok ? await res.json() : { user: {} }
  const u = session.user
  ok(u.onboarding?.status === 'complete', 'and reads as onboarding COMPLETE — nobody who already worked here is sent through the flow', u.onboarding?.status)
  ok(u.onboarding?.version === 1, 'at version 1, the literal the backfill wrote', `${u.onboarding?.version}`)
  ok(u.onboarding?.completedAt === MADE_AT, 'dated to when the account was made, not to the deploy', `${u.onboarding?.completedAt}`)
  ok(u.name === 'Old Hand', 'the stored name survives with no first/last split', u.name)
  ok(u.badge === null, 'with no badge — that is offered, not assumed')
  ok(u.company?.name === 'Legacy Roofing' && u.company?.logoUrl === undefined && u.company?.website === undefined, 'the company appears with the new, empty badge fields')

  /* --- the roster sees the invitee who never opened their link --------------- */
  const roster = await (await api_('/api/users', {}, session.token)).json()
  const p = roster.users?.find((r) => r.email === 'pending@example.com')
  ok(!!p, 'the pending invitee is on the roster')
  ok(p?.onboarding === 'not_started', 'and was NOT backfilled — they never signed in, so they onboard in full', p?.onboarding)
  ok(p?.invitation === 'pending', 'their invite row from before `kind` existed reads as a pending invitation', p?.invitation)
  ok(p?.pending === true && p?.badge === 'none', 'pending, no badge')
  const o = roster.users?.find((r) => r.email === OLD.email)
  ok(o?.onboarding === 'complete' && o?.invitation === 'not_sent', 'and the roster agrees with the login payload about the old account', `${o?.onboarding} / ${o?.invitation}`)

  /* --- a team can be made on the migrated database -------------------------- */
  const t = await api_('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Legacy crew' }) }, session.token)
  ok(t.status === 201, 'the new teams table is usable', String(t.status))

  /* --- second request finds nothing left to do ------------------------------ */
  const again = await (await fetch(`${BASE}/api/health`)).json()
  ok(again.config?.migrations?.state === 'ok', 'a second request finds nothing left to do')

  await stop()

  /* --- what the database says afterwards ------------------------------------ */
  const ledger = d1json(config, 'SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id)
  for (const id of ['015-teams', '016-users-onboarding', '017-invites-kind', '018-clients-company', '019-onboarding-backfill']) {
    ok(ledger.includes(id), `${id} is recorded as applied`)
  }
  const cols = d1json(config, "SELECT name FROM pragma_table_info('users')").map((r) => r.name)
  const expected = ['first_name', 'last_name', 'job_title', 'team_id', 'onboarding_step', 'onboarding_version', 'onboarding_completed_at', 'walkthrough_completed_at', 'setup_completed_at', 'location_status', 'badge_id', 'badge_issued_at', 'badge_expires_at', 'badge_confirmed_at', 'last_seen_at']
  const missing = expected.filter((c) => !cols.includes(c))
  ok(missing.length === 0, `every users column arrived, including the ones after the pre-added one${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
  ok(cols.filter((c) => c === 'job_title').length === 1, 'and the pre-added column exists exactly once')
  // `revoked_at IS NULL` as an integer, not the column itself: wrangler's --json
  // output renders SQL NULL as the string "null", which is not a fact about
  // the database and not something this gate should be testing.
  const inv = d1json(config, "SELECT kind, (revoked_at IS NULL) AS unrevoked FROM invites WHERE user_id = 'u_pending'")[0]
  ok(inv?.kind === 'invite' && Number(inv?.unrevoked) === 1, "the old invite row took the default kind 'invite' and is not revoked", JSON.stringify(inv))
  const seen = d1json(config, "SELECT last_seen_at FROM users WHERE id = 'u_old_admin'")[0]
  ok(typeof seen?.last_seen_at === 'number' && Date.now() - seen.last_seen_at < 120_000, 'signing in wrote last_seen_at')
} catch (err) {
  ok(false, `the run completed: ${err instanceof Error ? err.message : String(err)}`)
  if (log) console.log('\n--- worker log ---\n' + log.slice(-4000))
} finally {
  await stop().catch(() => {})
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\n=== the schema comes forward, and nobody who already worked here is asked to onboard ===')
process.exit(fails.length ? 1 : 0)
