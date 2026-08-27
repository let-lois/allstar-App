import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `schema.sql` and `migrate.ts` describe the same database and neither knows
 * about the other.
 *
 * Two files, one schema. `schema.sql` is what an operator applies once to a
 * brand-new database; `migrate.ts` is what the Worker runs to bring an existing
 * one forward. Every table added since the migration system began has to be
 * written into both, by hand, and nothing checks that it was.
 *
 * The dangerous direction is something added to `schema.sql` and forgotten in
 * `migrate.ts`. It works locally, it works for a new customer, and it is
 * missing in production — which is the one place nobody looks. That is the
 * failure `migrate.ts`'s own header calls silent: the code ships, the table is
 * missing, the feature quietly doesn't work.
 *
 * The other direction is real too, and quieter still: a migration that creates
 * something `schema.sql` never gained leaves a *fresh* database behind an
 * existing one, which shows up the first time somebody onboards a customer.
 *
 * Found by accident. While proving an assertion in `smoke-integrations`, an
 * index was deleted from `schema.sql` and the gate still passed, because
 * migration 006 re-created it. The two files disagreed and nothing noticed.
 *
 * No browser and no database: this reads both files and compares names, so it
 * runs anywhere in under a second.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaSql = readFileSync(resolve(root, 'api/schema.sql'), 'utf8')
const migrateTs = readFileSync(resolve(root, 'api/src/migrate.ts'), 'utf8')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/**
 * The objects that predate the migration system.
 *
 * Listed by name rather than inferred, so "this one legitimately has no
 * migration" is a statement somebody made on purpose. Anything new arriving in
 * `schema.sql` without a migration fails rather than quietly joining a rule
 * that says "old things are exempt".
 *
 * Nothing should ever be added here. A new table needs a migration; that is the
 * whole point.
 */
const BASELINE = new Set([
  'clients', 'users', 'users_by_client', 'users_client_email',
  'territories', 'properties', 'properties_by_rep', 'properties_by_territory',
  'contacts', 'contacts_by_property',
  'routes', 'routes_by_rep_date', 'route_stops',
  'visits', 'visits_by_property', 'visits_by_rep_time',
  'notes', 'notes_by_property',
  'photos', 'photos_by_property',
  'appointments', 'appointments_by_rep',
  'tasks', 'tasks_by_rep_due',
  'activity', 'activity_by_client_time',
  'daily_stats', 'daily_stats_by_client_day',
  'applied_mutations', 'applied_mutations_time',
  'invites', 'invites_by_user',
  'sessions', 'sessions_by_user',
])

/* --- what each file says exists -------------------------------------------- */

const CREATE = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi

/**
 * Comments out, before anything is read as schema.
 *
 * Both files talk *about* DDL as well as containing it, and prose describing a
 * statement is not a statement. `migrate.ts` explains why `ALTER TABLE` has no
 * `IF NOT EXISTS` the way `CREATE TABLE IF NOT EXISTS` does — and the backtick
 * closing that sentence stopped the optional clause matching, so the parser
 * read a table named "IF" and reported drift that did not exist. A gate whose
 * first failure is its own parser is a gate people learn to ignore.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/--[^\n]*/g, ' ')
}

function created(source) {
  const out = new Map()
  for (const m of stripComments(source).matchAll(CREATE)) out.set(m[2], m[1].toLowerCase())
  return out
}

/**
 * Only the migrations themselves.
 *
 * The runner creates its own ledger table outside the list, and that one is
 * deliberately not in `schema.sql` — it is bookkeeping about the schema rather
 * than part of it. Reading the whole file would report it as drift forever.
 */
function migrationsBlock(source) {
  const start = source.indexOf('const MIGRATIONS: Migration[] = [')
  if (start < 0) throw new Error('MIGRATIONS array not found — has migrate.ts been restructured?')
  const end = source.indexOf('\n]', start)
  if (end < 0) throw new Error('MIGRATIONS array never closes')
  return source.slice(start, end)
}

const block = migrationsBlock(migrateTs)
const inSchema = created(schemaSql)
const inMigrations = created(block)

ok(inSchema.size > 20, `schema.sql parses (${inSchema.size} objects)`)
ok(inMigrations.size > 0, `migrate.ts parses (${inMigrations.size} objects created)`)
ok(
  !inMigrations.has('schema_migrations'),
  'the migration ledger is read as the runner’s own, not as app schema',
)

/* --- the dangerous direction ----------------------------------------------- */
//
// In schema.sql, no migration, not baseline: a fresh database gets it and every
// existing one silently does not.
{
  const orphans = [...inSchema.keys()].filter((n) => !inMigrations.has(n) && !BASELINE.has(n))
  ok(
    orphans.length === 0,
    orphans.length === 0
      ? 'everything in schema.sql either has a migration or predates them'
      : `these exist only in schema.sql, so no existing database will ever get them: ${orphans.join(', ')}`,
  )
}

/* --- the quieter direction -------------------------------------------------- */
//
// In a migration, absent from schema.sql: an existing database gets it and a
// brand-new one does not, which surfaces the first time somebody onboards.
{
  const missing = [...inMigrations.keys()].filter((n) => !inSchema.has(n))
  ok(
    missing.length === 0,
    missing.length === 0
      ? 'everything a migration creates is also in schema.sql, so a new database is never behind'
      : `these are created by a migration but missing from schema.sql: ${missing.join(', ')}`,
  )
}

/* --- added columns ---------------------------------------------------------- */
//
// `ALTER TABLE ... ADD COLUMN` is the same problem one level down, and easier to
// miss: the table is in both files, so a name comparison alone passes while the
// column exists in only one of them.
{
  /** The body of one `CREATE TABLE`, for looking a column up in. */
  const tableBody = (name) => {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'i')
    return re.exec(schemaSql)?.[1] ?? null
  }

  const adds = [...stripComments(block).matchAll(/ALTER\s+TABLE\s+([a-z_]+)\s+ADD\s+COLUMN\s+([a-z_]+)/gi)].map(
    (m) => ({ table: m[1], column: m[2] }),
  )
  ok(adds.length > 0, `migrations add columns to existing tables (${adds.length})`)

  for (const { table, column } of adds) {
    const body = tableBody(table)
    ok(
      body !== null && new RegExp(`(^|\\s)${column}\\s`, 'm').test(body),
      `schema.sql's ${table} carries ${column}, so a fresh database is not missing it`,
    )
  }

  /*
    A guard on the guard. `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS, so
    each of these migrations must carry `skipIfColumn` or it throws "duplicate
    column name" on a database that already has it — releasing the claim and
    leaving the API reporting a failed migration on a database that was fine.
  */
  const guards = (stripComments(block).match(/skipIfColumn/g) ?? []).length
  ok(
    guards >= adds.length,
    `every added column is guarded against already existing (${guards} guards for ${adds.length} columns)`,
  )
}

/* --- the allowlist does not rot --------------------------------------------- */
//
// A baseline naming a table that has since been renamed or dropped is an
// exemption with nothing behind it, quietly widening the rule it belongs to.
{
  const stale = [...BASELINE].filter((n) => !inSchema.has(n))
  ok(
    stale.length === 0,
    stale.length === 0
      ? 'every name exempted as pre-migration still exists'
      : `exempted but no longer in schema.sql: ${stale.join(', ')}`,
  )

  const overlap = [...BASELINE].filter((n) => inMigrations.has(n))
  ok(
    overlap.length === 0,
    overlap.length === 0
      ? 'and nothing is exempted that a migration actually creates'
      : `exempted as pre-migration but created by a migration: ${overlap.join(', ')}`,
  )
}

/* --- the ledger keys off ids ------------------------------------------------ */
//
// Two migrations sharing an id means the second never runs: the ledger sees the
// first one's row and skips it, forever, on every database.
{
  const ids = [...stripComments(block).matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1])
  ok(ids.length > 0, `migrations are identified (${ids.length})`)
  ok(new Set(ids).size === ids.length, `and no two share an id (${ids.join(', ')})`)
  ok(
    ids.every((id, i) => i === 0 || id > ids[i - 1]),
    'listed in order, so the next one is obvious to whoever adds it',
  )
}

console.log(
  fails.length ? `\n${fails.length} schema drift check(s) failed` : '\n=== schema and migrations agree ===',
)
process.exit(fails.length ? 1 : 0)
