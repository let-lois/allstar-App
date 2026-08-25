import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

/**
 * Restore a backup and prove it came back whole.
 *
 * "We have backups" is a claim. This is the only thing that turns it into a
 * fact, and the reason to run it on a schedule rather than during an incident:
 * the failure mode of an untested backup is discovering at the worst possible
 * moment that the dump was truncated, or that it restores a schema the Worker
 * then tries to migrate again, or that it restores rows whose foreign keys point
 * at nothing.
 *
 * The drill restores into a scratch database and never touches the one the
 * backup came from — a restore test that can damage production is a second
 * disaster waiting behind the first.
 *
 *   node scripts/verify-restore.mjs backups/allstar-db-....sql
 *
 * What it asserts, in the order the failures actually happen:
 *
 *   the file is a database at all, not an error page or a truncated write
 *   every table the app needs exists after restoring
 *   the row counts survive the round trip
 *   no foreign key points at a row that is not there
 *   SQLite's own integrity check passes
 *   the migration ledger came back, so the Worker does not re-run migrations
 *   the things that make it a *usable* account are present, not just non-empty
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const dump = process.argv[2]
if (!dump) {
  console.error('Usage: node scripts/verify-restore.mjs <backup.sql>')
  process.exit(2)
}

const sql = readFileSync(resolve(dump), 'utf8')

/* --- is it a database at all? ---------------------------------------------- */
//
// Checked before anything expensive, because the common failure is not a subtle
// one: an export that hit an auth error, or a write that ran out of disk, leaves
// a file that looks plausible in a directory listing.
ok(sql.length > 512, 'the file has enough in it to be a database', `${(sql.length / 1024).toFixed(1)} KB`)
ok(/CREATE TABLE/i.test(sql), 'it contains a schema')
ok(
  !/<html|<!doctype|Authentication error|error code/i.test(sql.slice(0, 2000)),
  'and is SQL rather than an error page somebody saved',
)
/*
  A dump ends with a complete statement. A truncated one usually ends mid-INSERT,
  which SQLite will happily apply up to the cut and report success on.
*/
const tail = sql.trimEnd().slice(-1)
ok(tail === ';', 'the last statement is terminated, so the write completed', `ends with "${tail}"`)

/* --- restore it, somewhere harmless ---------------------------------------- */

const scratch = mkdtempSync(join(tmpdir(), 'allstar-restore-'))
const RESTORED = 'allstar-restore-drill'
const cfg = join(scratch, 'wrangler.toml')

/*
  A generated config with its own database name and its own state directory. The
  drill must not be able to reach the database it is testing a backup of — a
  restore test that can overwrite production is a second disaster queued behind
  the first.
*/
writeFileSync(
  cfg,
  [
    `name = "allstar-restore-drill"`,
    `main = "${resolve(api, 'src/index.ts')}"`,
    `compatibility_date = "2025-07-18"`,
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "${RESTORED}"`,
    `database_id = "00000000-0000-0000-0000-000000000000"`,
    ``,
  ].join('\n'),
)

const wrangler = resolve(api, 'node_modules/.bin/wrangler')
const state = join(scratch, 'state')

const d1 = (args, opts = {}) =>
  execFileSync(
    wrangler,
    ['d1', 'execute', RESTORED, '--local', '--persist-to', state, '-c', cfg, '-y', ...args],
    { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts },
  )

/**
 * Every read happens against the restored file, not through D1.
 *
 * Two reasons, and the second is the one that decided it. D1 refuses
 * `foreign_key_check` and `integrity_check` outright — `not authorized:
 * SQLITE_AUTH` — so the checks that catch a *silently* broken restore could not
 * run through it at all. And each `wrangler d1 execute` is a process spawn worth
 * several seconds; twenty tables turned a drill into a coffee break, and a drill
 * nobody runs is not a drill.
 *
 * The restore itself still goes through D1, which is the path a real recovery
 * takes. This only reads what that produced.
 */
let handle = null
const query = (statement) => handle.prepare(statement).all()

/** Miniflare hides the restored database under a hashed filename. */
function findSqlite(root) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.sqlite')) return full
    }
  }
  return null
}

let restored = false
try {
  d1(['--file', resolve(dump)])
  restored = true
} catch (err) {
  const detail = (err.stderr || err.stdout || String(err)).toString().split('\n').slice(-6).join('\n')
  ok(false, 'the backup restores without error', detail.trim().slice(0, 200))
}

if (restored) {
  ok(true, 'the backup restores without error')

  const file = findSqlite(state)
  if (!file) {
    ok(false, 'the restored database can be opened')
    fails.push('unreadable')
  }
  handle = file ? new DatabaseSync(file, { readOnly: true }) : null
}

if (restored && handle) {

  /* --- every table the app needs ------------------------------------------- */
  //
  // Read from schema.sql rather than listed here, so a table added later is
  // covered by this drill without anyone remembering to come back.
  const schema = readFileSync(resolve(api, 'schema.sql'), 'utf8')
  const expected = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1])
  const present = new Set(
    query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name),
  )
  const missing = expected.filter((t) => !present.has(t))
  ok(
    missing.length === 0,
    `every table in schema.sql came back`,
    missing.length ? `missing ${missing.join(', ')}` : `${expected.length} tables`,
  )

  /* --- the rows -------------------------------------------------------------- */
  //
  // Counted from the dump's own INSERTs and compared against what landed. This is
  // what catches a truncated file that still parsed: the schema restores, the
  // early tables restore, and the tail is simply gone.
  let totalRows = 0
  const shortfalls = []
  for (const table of expected) {
    if (!present.has(table)) continue
    const inDump = (sql.match(new RegExp(`INSERT INTO "?${table}"?[\\s(]`, 'gi')) ?? []).length
    const inDb = Number(query(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n ?? 0)
    totalRows += inDb
    // A multi-row INSERT is one statement, so the dump count is a floor rather
    // than an equality — fewer rows than statements means rows were lost.
    if (inDump > 0 && inDb < inDump) shortfalls.push(`${table}: ${inDb} rows from ${inDump} inserts`)
  }
  ok(
    shortfalls.length === 0,
    'no table came back with fewer rows than the dump had inserts for it',
    shortfalls.length ? shortfalls.join('; ') : `${totalRows} rows restored`,
  )
  ok(totalRows > 0, 'the restored database is not empty', `${totalRows} rows`)

  /* --- referential integrity -------------------------------------------------- */
  //
  // A dump whose tables restored in the wrong order, or that lost a parent row,
  // gives a database that queries fine right up until somebody opens the one
  // lead whose contact is gone.
  //
  // Read off the restored file directly, because D1 refuses these two PRAGMAs —
  // `wrangler d1 execute` answers `not authorized: SQLITE_AUTH`. The restore
  // itself still goes through D1 above, which is the path a real recovery takes;
  // this only opens what that produced. Dropping the checks because the platform
  // will not run them would leave the drill unable to see the failure it exists
  // for.
  const orphans = query('PRAGMA foreign_key_check')
  ok(
    orphans.length === 0,
    'no row points at a parent that is not there',
    orphans.length ? `${orphans.length} orphaned rows` : 'foreign keys intact',
  )
  const verdict = query('PRAGMA integrity_check')[0]?.integrity_check ?? 'unknown'
  ok(verdict === 'ok', "SQLite's own integrity check passes", verdict)

  /* --- the Worker will not fight it ------------------------------------------ */
  //
  // The migration ledger matters more than it looks. Restore without it and the
  // Worker's first request re-runs every migration against a schema that already
  // has them — the additive ones are idempotent, the ALTER TABLE is not, and the
  // migration state goes to `failed` on a database that is otherwise fine.
  if (present.has('schema_migrations')) {
    const ledger = query('SELECT id FROM schema_migrations ORDER BY id')
    ok(ledger.length > 0, 'the migration ledger came back', `${ledger.length} applied`)
    const inSource = [...readFileSync(resolve(api, 'src/migrate.ts'), 'utf8').matchAll(
      /id:\s*'([^']+)'/g,
    )].map((m) => m[1])
    const unapplied = inSource.filter((id) => !ledger.some((r) => r.id === id))
    ok(
      unapplied.length === 0,
      'and every migration this code knows about is recorded in it',
      unapplied.length ? `would re-run: ${unapplied.join(', ')}` : `${inSource.length} in step`,
    )
  } else {
    ok(false, 'the migration ledger came back')
  }

  /* --- is it a usable account? ------------------------------------------------ */
  //
  // Non-empty is not the same as usable. A restore that brings back properties
  // and no users is a database nobody can sign in to and look at them.
  const users = Number(query('SELECT COUNT(*) AS n FROM users')[0]?.n ?? 0)
  const clients = Number(query('SELECT COUNT(*) AS n FROM clients')[0]?.n ?? 0)
  ok(clients > 0, 'at least one client survived', `${clients}`)
  ok(users > 0, 'and somebody can sign in to it', `${users} users`)
  const withPassword = Number(
    query('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL')[0]?.n ?? 0,
  )
  ok(
    withPassword > 0,
    'and their credentials came back, not just their names',
    `${withPassword} of ${users}`,
  )
}

handle?.close()
rmSync(scratch, { recursive: true, force: true })

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  console.log(`\nThis backup is not one you can rely on. Find out why before trusting the next.`)
  process.exit(1)
}
console.log('\n=== restore drill OK — this backup brings the database back ===')
