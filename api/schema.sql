-- Allstar API schema (Cloudflare D1 / SQLite)
--
-- Two ideas shape this schema, both consequences of the client being
-- offline-first rather than the server being clever:
--
--   1. **The client owns identity.** Every id is a client-generated string,
--      because records are created on a phone with no signal and must be
--      addressable immediately. The server adopts the id; it never mints one.
--
--   2. **Writes are replayed, not streamed.** The outbox retries, so the same
--      mutation will arrive more than once. `applied_mutations` is the ledger
--      that makes replay harmless.

PRAGMA foreign_keys = ON;

/* --- tenancy ------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('super_admin','client_admin','manager','field_rep')),
  phone          TEXT,
  -- PBKDF2; null until the invited user sets a password.
  password_hash  TEXT,
  password_salt  TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
-- Email is the login handle, unique per tenant rather than globally: the same
-- person can legitimately be a rep at two contracting companies.
CREATE UNIQUE INDEX IF NOT EXISTS users_client_email ON users(client_id, lower(email));
CREATE INDEX IF NOT EXISTS users_by_client ON users(client_id);

/* --- territory ----------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS territories (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  rep_id     TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id                 TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  address1           TEXT NOT NULL,
  city               TEXT,
  state              TEXT,
  zip                TEXT,
  lat                REAL NOT NULL,
  lng                REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'new',
  score              INTEGER NOT NULL DEFAULT 50,
  opportunity_value  INTEGER,
  owner_occupied     INTEGER,
  roof_age_years     INTEGER,
  square_feet        INTEGER,
  last_outcome       TEXT,
  last_visit_at      INTEGER,
  next_action_at     INTEGER,
  next_action_label  TEXT,
  territory_id       TEXT REFERENCES territories(id) ON DELETE SET NULL,
  assigned_rep_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  tags               TEXT,          -- JSON array
  updated_at         INTEGER NOT NULL
);
-- The rep's bootstrap query is "my properties" — this is the index it rides.
CREATE INDEX IF NOT EXISTS properties_by_rep ON properties(client_id, assigned_rep_id);
CREATE INDEX IF NOT EXISTS properties_by_territory ON properties(territory_id);

CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  relationship  TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS contacts_by_property ON contacts(property_id);

/* --- the working day ----------------------------------------------------- */

CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rep_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,           -- YYYY-MM-DD, local to the rep
  name        TEXT NOT NULL,
  started_at  INTEGER
);
CREATE INDEX IF NOT EXISTS routes_by_rep_date ON routes(rep_id, date);

CREATE TABLE IF NOT EXISTS route_stops (
  route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  completed_at  INTEGER,
  PRIMARY KEY (route_id, property_id)
);

CREATE TABLE IF NOT EXISTS visits (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rep_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  outcome           TEXT,
  duration_ms       INTEGER,
  -- Proof-of-visit: where the rep actually stood.
  start_lat         REAL,
  start_lng         REAL,
  start_accuracy    REAL,
  next_action_at    INTEGER,
  next_action_type  TEXT
);
CREATE INDEX IF NOT EXISTS visits_by_property ON visits(property_id);
CREATE INDEX IF NOT EXISTS visits_by_rep_time ON visits(rep_id, started_at);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  visit_id     TEXT REFERENCES visits(id) ON DELETE SET NULL,
  body         TEXT NOT NULL DEFAULT '',
  tags         TEXT,                  -- JSON array
  author_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_by_property ON notes(property_id);

CREATE TABLE IF NOT EXISTS photos (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  visit_id     TEXT REFERENCES visits(id) ON DELETE SET NULL,
  category     TEXT NOT NULL,
  -- The image lives in R2; only the key is relational.
  r2_key       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  bytes        INTEGER,
  captured_lat REAL,
  captured_lng REAL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_by_property ON photos(property_id);

CREATE TABLE IF NOT EXISTS appointments (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rep_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at    INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 45,
  title        TEXT NOT NULL,
  contact_id   TEXT,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS appointments_by_rep ON appointments(rep_id, starts_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rep_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id  TEXT REFERENCES properties(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'follow_up'
);
CREATE INDEX IF NOT EXISTS tasks_by_rep_due ON tasks(rep_id, due_at);

CREATE TABLE IF NOT EXISTS activity (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id  TEXT REFERENCES properties(id) ON DELETE CASCADE,
  rep_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  outcome      TEXT,
  at           INTEGER NOT NULL
);
-- The console's live feed reads this newest-first, per tenant.
CREATE INDEX IF NOT EXISTS activity_by_client_time ON activity(client_id, at DESC);

/* --- reporting ----------------------------------------------------------- */

-- Rolled up rather than derived on read: reporting spans weeks and the console
-- must not scan every visit ever recorded to draw a 30-day line.
CREATE TABLE IF NOT EXISTS daily_stats (
  id             TEXT PRIMARY KEY,     -- `${rep_id}:${day}`
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rep_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,        -- YYYY-MM-DD
  knocks         INTEGER NOT NULL DEFAULT 0,
  conversations  INTEGER NOT NULL DEFAULT 0,
  appointments   INTEGER NOT NULL DEFAULT 0,
  quotes         INTEGER NOT NULL DEFAULT 0,
  sold           INTEGER NOT NULL DEFAULT 0,
  pipeline_value INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS daily_stats_by_client_day ON daily_stats(client_id, day);

/* --- idempotency --------------------------------------------------------- */

-- The client's outbox retries on every reconnect, and a retry after a response
-- was lost in flight is indistinguishable from a first attempt. Recording the
-- mutation id makes a replayed "visit.complete" a no-op instead of a duplicate
-- visit — which is the difference between correct numbers and a manager
-- disputing their team's stats.
CREATE TABLE IF NOT EXISTS applied_mutations (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS applied_mutations_time ON applied_mutations(applied_at);

/* --- invitations --------------------------------------------------------- */

-- How an account gets a password. Nobody — not an admin, not a developer —
-- ever types or generates a hash by hand: the person who will use the account
-- sets it themselves, so the signing pepper never leaves the Worker.
CREATE TABLE IF NOT EXISTS invites (
  -- SHA-256 of the token, not the token. A leaked database yields no usable
  -- invite links.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE INDEX IF NOT EXISTS invites_by_user ON invites(user_id);

/* --- sessions ------------------------------------------------------------ */

-- What a company has customised about the field app: the labels on the outcome
-- buttons, the quick note templates, the photo categories.
--
-- One JSON blob per tenant rather than a row per setting. These are read
-- together on every bootstrap and written together from one screen, so a
-- normalised version would be five joins to answer a question nobody asks in
-- parts. The *codes* stay in the source; only presentation is stored here, which
-- is what keeps a relabelled outcome from breaking a year of reporting.
CREATE TABLE IF NOT EXISTS client_settings (
  client_id  TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  settings   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who did what to whom.
--
-- Two things about this table are load-bearing and easy to get wrong.
--
-- **The names are denormalised on purpose.** `actor_name` and `target_label`
-- are copies taken at the time of the action, not joins. An audit record has to
-- outlive the rows it describes — the most important entry in the log is the one
-- that says who deleted the account you can no longer look up, and a join would
-- render exactly that entry as two nulls.
--
-- **Nothing deletes from here.** There is no API path that removes a row, and
-- `actor_id` is SET NULL rather than CASCADE so removing a user cannot take
-- their history with them. A log that the accused can edit is not evidence.
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name    TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  target_label  TEXT,
  detail        TEXT,               -- JSON, action-specific
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_client_time ON audit_log(client_id, at DESC);

-- Failed sign-in attempts, bucketed by email and by source address.
--
-- Password hashing is deliberately slow, which raises the cost of guessing but
-- does not bound it — a patient attacker still gets unlimited attempts, and the
-- Worker pays the CPU for every one of them. This bounds both.
--
-- Buckets are rows rather than a log: one row per key, reset when its window
-- rolls over. Nothing here needs to be kept, and a table that grows per attempt
-- is a table that gets huge precisely when you're under attack.
CREATE TABLE IF NOT EXISTS login_attempts (
  id            TEXT PRIMARY KEY,   -- 'email:<lowercased>' or 'ip:<address>'
  window_start  INTEGER NOT NULL,
  attempts      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- Revocation: a lost phone must be cuttable without rotating the signing key.
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
