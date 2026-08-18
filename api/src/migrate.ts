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
]

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
