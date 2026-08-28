import type { Env } from './types'

/**
 * Schema migrations, applied by the Worker itself.
 *
 * The alternative was a human pasting DDL into the D1 console after every
 * deploy that touched the schema. That is a step which is easy to forget, easy
 * to do to the wrong database, and impossible to do at all for anyone who isn't
 * the account owner — and the failure mode is silent: the code ships, the table
 * is missing, and the feature quietly doesn't work.
 *
 * So: migrations live in the source, run on the first request after a deploy,
 * and record themselves. A deploy is now the whole operation.
 *
 * Three rules keep this safe:
 *
 *   **Additive only.** Nothing here drops a column or a table. A migration that
 *   destroys data on deploy is a migration that destroys data on rollback.
 *
 *   **Claimed before applied.** The ledger insert is the lock — two isolates
 *   starting at once can't both run the same migration, for the same reason the
 *   mutation ledger works.
 *
 *   **Never blocks a request twice.** One check per isolate, and a failure is
 *   reported through /api/health rather than by taking the API down.
 */

interface Migration {
  id: string
  statements: string[]
  /**
   * Skip the whole migration when this column already exists.
   *
   * `CREATE TABLE IF NOT EXISTS` is idempotent, so every migration up to now was
   * safe to run against a database that already had the table — which is what
   * happens on a *fresh* database, because `schema.sql` carries the current
   * schema rather than a historical baseline.
   *
   * `ALTER TABLE ... ADD COLUMN` has no such guard: it errors with "duplicate
   * column name", which would release the claim, throw, and leave the API
   * reporting a failed migration on a database that was perfectly correct. So
   * the guard is explicit rather than swallowing the error, because a swallowed
   * DDL error is how a column silently never gets added.
   */
  skipIfColumn?: { table: string; column: string }
}

const MIGRATIONS: Migration[] = [
  {
    id: '001-login-attempts',
    statements: [
      `CREATE TABLE IF NOT EXISTS login_attempts (
         id TEXT PRIMARY KEY,
         window_start INTEGER NOT NULL,
         attempts INTEGER NOT NULL
       )`,
    ],
  },
  {
    id: '002-audit-log',
    statements: [
      `CREATE TABLE IF NOT EXISTS audit_log (
         id TEXT PRIMARY KEY,
         client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
         actor_name TEXT NOT NULL,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         target_label TEXT,
         detail TEXT,
         at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS audit_by_client_time ON audit_log(client_id, at DESC)`,
    ],
  },
  {
    id: '003-client-settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS client_settings (
         client_id  TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
         settings   TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    /*
      The outline a manager drew, as JSON.

      A column rather than a table of vertices: the shape is only ever read and
      written whole, it is a few dozen points, and SQLite has no geometry type to
      make the normalised version worth anything. Nullable, because every
      territory that exists today came from an import and has no shape.

      `ALTER TABLE ... ADD COLUMN` is additive, which is the rule up top, but it
      is not idempotent the way `CREATE TABLE IF NOT EXISTS` is — it errors if the
      column is already there. That is fine here and only here: the ledger claim
      means this statement runs exactly once per database.
    */
    id: '004-territory-boundary',
    statements: ['ALTER TABLE territories ADD COLUMN boundary TEXT'],
    skipIfColumn: { table: 'territories', column: 'boundary' },
  },
  {
    /*
      Profile photos.

      A ~20KB data URL on the user row rather than a key into R2, which is where
      property photos are headed. The reasoning is not that inline is better —
      it is that an avatar is one small row per person that every device wants
      offline anyway, while a property photo is dozens of multi-megabyte blobs a
      day that only one screen ever opens. Different shapes, different homes.

      Revisit if this ever grows a per-client asset store; until then the row is
      the simplest thing that lets a rep see a face in a basement.
    */
    id: '005-user-avatar',
    statements: ['ALTER TABLE users ADD COLUMN avatar_url TEXT'],
    skipIfColumn: { table: 'users', column: 'avatar_url' },
  },
  {
    /*
      Connecting a company's own CRM. Mirrors schema.sql — see the commentary
      there for why each of these three tables exists.

      The two unique indexes are the load-bearing part. Without the reverse one
      on `integration_links`, two of our leads can both claim the same remote
      record and an inbound webhook has no single answer to "which lead is
      this". Without the partial one on `integration_outbox`, a rep correcting
      an outcome three times sends three times.
    */
    id: '006-integrations',
    statements: [
      `CREATE TABLE IF NOT EXISTS client_integrations (
         client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         provider      TEXT NOT NULL,
         auth_type     TEXT NOT NULL DEFAULT 'pit',
         access_token  TEXT NOT NULL,
         refresh_token TEXT,
         expires_at    INTEGER,
         location_id   TEXT,
         config        TEXT NOT NULL DEFAULT '{}',
         status        TEXT NOT NULL DEFAULT 'active',
         last_ok_at    INTEGER,
         last_error    TEXT,
         last_error_at INTEGER,
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL,
         PRIMARY KEY (client_id, provider)
       )`,
      `CREATE TABLE IF NOT EXISTS integration_links (
         client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         provider    TEXT NOT NULL,
         kind        TEXT NOT NULL,
         local_id    TEXT NOT NULL,
         remote_id   TEXT NOT NULL,
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL,
         PRIMARY KEY (client_id, provider, kind, local_id)
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS integration_links_remote
         ON integration_links(client_id, provider, kind, remote_id)`,
      `CREATE TABLE IF NOT EXISTS integration_outbox (
         id              TEXT PRIMARY KEY,
         client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         provider        TEXT NOT NULL,
         event           TEXT NOT NULL,
         payload         TEXT NOT NULL,
         dedupe_key      TEXT,
         status          TEXT NOT NULL DEFAULT 'pending',
         attempts        INTEGER NOT NULL DEFAULT 0,
         next_attempt_at INTEGER NOT NULL,
         last_error      TEXT,
         created_at      INTEGER NOT NULL,
         sent_at         INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS integration_outbox_due
         ON integration_outbox(status, next_attempt_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_dedupe
         ON integration_outbox(client_id, provider, dedupe_key)
         WHERE dedupe_key IS NOT NULL AND status = 'pending'`,
    ],
  },
  {
    /*
      The company's own calendar — see api/src/day.ts for why a day cannot be
      cut in UTC for a business whose people work evenings.

      Defaults to UTC, so applying this changes no existing behaviour and
      re-buckets no existing row. A company opts into the fix by setting its
      zone, and that is the moment its reporting history wants rebuilding.
    */
    id: '007-client-timezone',
    statements: [`ALTER TABLE clients ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`],
    skipIfColumn: { table: 'clients', column: 'timezone' },
  },
  {
    id: '008-client-geocoders',
    statements: [
      `CREATE TABLE IF NOT EXISTS client_geocoders (
         client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         provider      TEXT NOT NULL,
         api_key       TEXT NOT NULL,
         active        INTEGER NOT NULL DEFAULT 0,
         status        TEXT NOT NULL DEFAULT 'active',
         last_ok_at    INTEGER,
         last_error    TEXT,
         last_error_at INTEGER,
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL,
         PRIMARY KEY (client_id, provider)
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS client_geocoders_active
         ON client_geocoders(client_id) WHERE active = 1`,
    ],
  },
]

async function hasColumn(
  env: Env,
  { table, column }: { table: string; column: string },
): Promise<boolean> {
  // PRAGMA cannot be parameterised, and the values come from the table above
  // rather than from a request — but the assertion is cheap and this is DDL.
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) return false
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all()
  return (info.results as { name: string }[]).some((c) => c.name === column)
}

export type MigrationState = 'pending' | 'ok' | 'failed'

let state: MigrationState = 'pending'
let lastError: string | null = null

export function migrationState(): { state: MigrationState; error: string | null } {
  return { state, error: lastError }
}

/**
 * Run anything not yet applied. Cheap on the happy path: one indexed read of a
 * tiny table, once per isolate.
 */
export async function ensureSchema(env: Env): Promise<void> {
  if (state === 'ok') return

  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
    ).run()

    const applied = await env.DB.prepare('SELECT id FROM schema_migrations').all()
    const done = new Set((applied.results as { id: string }[]).map((r) => r.id))

    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue

      // A fresh database already has the column, because schema.sql is current.
      // Recorded as applied so the check happens once rather than every boot.
      if (migration.skipIfColumn && (await hasColumn(env, migration.skipIfColumn))) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?1, ?2)',
        )
          .bind(migration.id, Date.now())
          .run()
        continue
      }

      // Claim first. Two isolates booting at the same moment both reach this
      // line; only one insert changes a row, and only that one runs the DDL.
      const claimed = await env.DB.prepare(
        'INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?1, ?2)',
      )
        .bind(migration.id, Date.now())
        .run()
      if (!claimed.meta.changes) continue

      try {
        for (const sql of migration.statements) {
          await env.DB.prepare(sql).run()
        }
      } catch (err) {
        // Release the claim so the next deploy retries rather than skipping a
        // migration that never actually ran.
        await env.DB.prepare('DELETE FROM schema_migrations WHERE id = ?1')
          .bind(migration.id)
          .run()
        throw err
      }
    }

    state = 'ok'
    lastError = null
  } catch (err) {
    state = 'failed'
    lastError = err instanceof Error ? err.message : String(err)
    // Deliberately not rethrown. A failed migration must be visible in health,
    // not a total outage — the features that need the new table degrade on their
    // own, and everything else keeps working.
    console.error('migration failed', err)
  }
}
