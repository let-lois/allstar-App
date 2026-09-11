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

/**
 * One statement, optionally guarded by the column it adds.
 *
 * Migration 016 adds fifteen columns to `users`. With a single guard on the
 * whole migration, a failure on the ninth statement releases the claim, the
 * next boot retries, the first statement fails with "duplicate column name",
 * and the migration is wedged forever — while the guard column, added last,
 * is still missing, so nothing skips it either. Guarding each `ALTER TABLE`
 * by its own column makes a retry pick up exactly where it stopped.
 */
type Statement = string | { sql: string; skipIfColumn: { table: string; column: string } }

interface Migration {
  id: string
  statements: Statement[]
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
  {
    id: '009-geocode-usage',
    statements: [
      `CREATE TABLE IF NOT EXISTS geocode_usage (
         client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         provider  TEXT NOT NULL,
         day       TEXT NOT NULL,
         lookups   INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (client_id, provider, day)
       )`,
    ],
  },
  {
    /*
      Erasures, kept so they cannot be undone by accident.

      A deleted lead has to stay deleted. `properties.id` is derived from the
      client and the normalised address, so the same address always resolves to
      the same id — which means one row here blocks every route back in: a CSV
      containing that address again, a GoHighLevel webhook for the same contact,
      a rep adding it at the door. Without that, a deletion made on Monday is
      undone by Tuesday's import and nobody notices.

      What is kept is deliberately the minimum that makes the block work and the
      act accountable: the id, who did it, when, and their stated reason. No
      address, no name, no phone — a table of erased people's details would
      defeat the erasure.
    */
    id: '010-deletions',
    statements: [
      `CREATE TABLE IF NOT EXISTS deletions (
         client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         entity       TEXT NOT NULL,
         entity_id    TEXT NOT NULL,
         actor_id     TEXT,
         actor_name   TEXT,
         reason       TEXT,
         photos       INTEGER NOT NULL DEFAULT 0,
         at           INTEGER NOT NULL,
         PRIMARY KEY (client_id, entity, entity_id)
       )`,
      `CREATE INDEX IF NOT EXISTS deletions_by_client ON deletions(client_id, at)`,
    ],
  },
  {
    /*
      Work that arrived late and landed on something that had moved.

      The conflict rule is that Allstar wins, and it still does — nothing here
      changes an outcome. What changes is that somebody finds out. A rep works a
      rural route with no signal on Monday and syncs on Friday; if the office
      moved one of those leads on Wednesday, the rep's Monday answer overwrites
      it, correctly and silently. Silently is the part worth fixing: the office
      edit does not come back and nobody knows it went.

      Deliberately a record and not a queue. Nothing blocks, nothing waits for
      approval, and a rep on a doorstep is never held up by it.
    */
    id: '011-sync-conflicts',
    statements: [
      `CREATE TABLE IF NOT EXISTS sync_conflicts (
         id          TEXT PRIMARY KEY,
         client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
         rep_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
         kind        TEXT NOT NULL,
         acted_at    INTEGER NOT NULL,
         arrived_at  INTEGER NOT NULL,
         changed_at  INTEGER NOT NULL,
         detail      TEXT,
         reviewed_at INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS sync_conflicts_open
         ON sync_conflicts(client_id, reviewed_at, arrived_at)`,
    ],
  },
  /*
    How well we actually know where a lead is.

    The geocoders have always computed this and the import preview has always
    shown it — Google reports a rooftop, Census interpolates a house number
    along a block — and it was thrown away before the lead was saved. Every pin
    then rendered identically, so a rep looking at the map could not tell a
    house we know from a house we are estimating. That is the worst version of
    this: not an inaccurate pin, but an inaccurate pin that looks exactly as
    confident as an accurate one.

    Nullable, and null means "imported before this existed" rather than
    "approximate". Those are different claims and the map has to be able to say
    "we do not know how good this is", which is not the same as saying it is bad.

    The provider is stored beside it because the question that follows "is this
    pin any good" is always "according to whom" — and because a re-geocoding
    pass needs to know which rows came from which source.
  */
  {
    id: '012-geo-precision',
    statements: ['ALTER TABLE properties ADD COLUMN geo_precision TEXT'],
    skipIfColumn: { table: 'properties', column: 'geo_precision' },
  },
  {
    id: '013-geo-provider',
    statements: ['ALTER TABLE properties ADD COLUMN geo_provider TEXT'],
    skipIfColumn: { table: 'properties', column: 'geo_provider' },
  },
  /*
    Lead lists: a working set of leads that many reps can be assigned to, and
    that a lead can belong to several of. Not a change to territories — see the
    note above the tables in schema.sql for why the two coexist. Three tables,
    all `IF NOT EXISTS`, so this is idempotent against a database that was
    created from schema.sql after they were added.
  */
  {
    id: '014-lead-lists',
    statements: [
      `CREATE TABLE IF NOT EXISTS lead_lists (
         id          TEXT PRIMARY KEY,
         client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         name        TEXT NOT NULL,
         description TEXT,
         created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
         boundary    TEXT,
         archived    INTEGER NOT NULL DEFAULT 0,
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS lead_lists_by_client ON lead_lists(client_id, archived)',
      `CREATE TABLE IF NOT EXISTS lead_list_members (
         list_id     TEXT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
         property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
         added_at    INTEGER NOT NULL,
         added_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
         PRIMARY KEY (list_id, property_id)
       )`,
      'CREATE INDEX IF NOT EXISTS lead_list_members_by_property ON lead_list_members(property_id)',
      `CREATE TABLE IF NOT EXISTS lead_list_reps (
         list_id     TEXT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
         user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         assigned_at INTEGER NOT NULL,
         assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
         PRIMARY KEY (list_id, user_id)
       )`,
      'CREATE INDEX IF NOT EXISTS lead_list_reps_by_user ON lead_list_reps(user_id)',
    ],
  },
  /*
    Team member onboarding, in five migrations rather than one.

    Split by table so each can be guarded by what it adds, and so the backfill
    at the end is its own recorded step — a statement that changes rows should
    be visible in the ledger as a thing that happened, not folded into DDL.
    Mirrors schema.sql; the commentary on each column lives there.
  */
  {
    id: '015-teams',
    statements: [
      `CREATE TABLE IF NOT EXISTS teams (
         id          TEXT PRIMARY KEY,
         client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
         name        TEXT NOT NULL,
         created_at  INTEGER NOT NULL
       )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS teams_client_name ON teams(client_id, lower(name))',
    ],
  },
  {
    id: '016-users-onboarding',
    // Written out rather than generated from a list: a migration is frozen
    // history and should read as the SQL it ran, and `verify:schema` checks
    // each literal ALTER against schema.sql — a generated one is invisible to it.
    statements: [
      {
        sql: 'ALTER TABLE users ADD COLUMN first_name TEXT',
        skipIfColumn: { table: 'users', column: 'first_name' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN last_name TEXT',
        skipIfColumn: { table: 'users', column: 'last_name' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN job_title TEXT',
        skipIfColumn: { table: 'users', column: 'job_title' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL',
        skipIfColumn: { table: 'users', column: 'team_id' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN onboarding_step TEXT',
        skipIfColumn: { table: 'users', column: 'onboarding_step' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0',
        skipIfColumn: { table: 'users', column: 'onboarding_version' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN onboarding_completed_at INTEGER',
        skipIfColumn: { table: 'users', column: 'onboarding_completed_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN walkthrough_completed_at INTEGER',
        skipIfColumn: { table: 'users', column: 'walkthrough_completed_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN setup_completed_at INTEGER',
        skipIfColumn: { table: 'users', column: 'setup_completed_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN location_status TEXT',
        skipIfColumn: { table: 'users', column: 'location_status' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN badge_id TEXT',
        skipIfColumn: { table: 'users', column: 'badge_id' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN badge_issued_at INTEGER',
        skipIfColumn: { table: 'users', column: 'badge_issued_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN badge_expires_at INTEGER',
        skipIfColumn: { table: 'users', column: 'badge_expires_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN badge_confirmed_at INTEGER',
        skipIfColumn: { table: 'users', column: 'badge_confirmed_at' },
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN last_seen_at INTEGER',
        skipIfColumn: { table: 'users', column: 'last_seen_at' },
      },
      'CREATE UNIQUE INDEX IF NOT EXISTS users_badge_id ON users(badge_id)',
    ],
  },
  {
    id: '017-invites-kind',
    statements: [
      {
        sql: 'ALTER TABLE invites ADD COLUMN revoked_at INTEGER',
        skipIfColumn: { table: 'invites', column: 'revoked_at' },
      },
      {
        sql: "ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite'",
        skipIfColumn: { table: 'invites', column: 'kind' },
      },
    ],
  },
  {
    id: '018-clients-company',
    statements: [
      {
        sql: 'ALTER TABLE clients ADD COLUMN logo_url TEXT',
        skipIfColumn: { table: 'clients', column: 'logo_url' },
      },
      {
        sql: 'ALTER TABLE clients ADD COLUMN website TEXT',
        skipIfColumn: { table: 'clients', column: 'website' },
      },
      {
        sql: 'ALTER TABLE clients ADD COLUMN join_code TEXT',
        skipIfColumn: { table: 'clients', column: 'join_code' },
      },
      {
        sql: 'ALTER TABLE clients ADD COLUMN join_code_created_at INTEGER',
        skipIfColumn: { table: 'clients', column: 'join_code_created_at' },
      },
      'CREATE UNIQUE INDEX IF NOT EXISTS clients_join_code ON clients(join_code)',
    ],
  },
  {
    /*
      Everyone who already had an account is not asked to onboard.

      Forcing every existing rep through six screens on their next sign-in is
      the wrong first impression of a feature meant to welcome new people, and
      they have what the flow exists to collect: a name, a role, a working
      login. What they lack — a photo, a badge — is offered to them, not
      required of them (see the badge card on Today).

      The literal `1` is ONBOARDING_VERSION as it stood when this migration was
      written. A migration is frozen history and must not read a constant that
      moves: when the version is bumped to ask everyone again, these rows must
      still say they completed version 1, not whatever the constant says today.

      Pending invitees — no password yet — are left untouched. They have never
      signed in, and they onboard in full.
    */
    id: '019-onboarding-backfill',
    statements: [
      `UPDATE users
          SET onboarding_completed_at = created_at, onboarding_version = 1
        WHERE password_hash IS NOT NULL AND onboarding_completed_at IS NULL`,
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
        for (const statement of migration.statements) {
          if (typeof statement === 'string') {
            await env.DB.prepare(statement).run()
            continue
          }
          if (await hasColumn(env, statement.skipIfColumn)) continue
          await env.DB.prepare(statement.sql).run()
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
