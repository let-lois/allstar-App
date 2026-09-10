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
  -- The company's own calendar. An IANA zone name; see api/src/day.ts.
  --
  -- Reporting is bucketed by day, and a day has to belong to the company rather
  -- than to a server in Virginia or a phone in a truck. Cut in UTC — as this
  -- was — a Texas crew's evening doors land in tomorrow's row while the reps'
  -- own phones count them as today, and nobody sees an error because there
  -- isn't one: just two answers to "which day is this".
  --
  -- Defaults to UTC so applying this migration changes nothing. A company gets
  -- the fix when it sets its zone, which is also the moment its history wants
  -- rebuilding.
  timezone    TEXT NOT NULL DEFAULT 'UTC',
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
  -- Profile photo, as a compressed data URL (~20KB). Inline because every
  -- device wants the roster's faces offline; see migration 005.
  avatar_url     TEXT,
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
  rep_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  /* The drawn outline, as a JSON array of {lat,lng}. Null for the territories
     that came from an import, which is all of them until somebody draws one. */
  boundary   TEXT
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
  -- How well the coordinates above are actually known: 'rooftop' (on the
  -- building), 'interpolated' (a house number estimated along a block) or
  -- 'approximate'. Null means the lead predates this column, which is a
  -- different claim from 'approximate' and the map treats it as such.
  geo_precision      TEXT,
  geo_provider       TEXT,          -- who said so
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

-- ---------------------------------------------------------------------------
-- Outbound integrations (GoHighLevel, and whatever follows it).
--
-- Three tables, and the reason for each is worth stating because two of them
-- look like overhead until the first thing goes wrong.
--
-- `client_integrations` holds the connection. Tokens are stored ENCRYPTED —
-- see api/src/secretbox.ts. The key lives as a Worker secret and never in D1,
-- so a stolen database dump is useless on its own. That matters here more than
-- it would elsewhere: a dump of this table would otherwise hand over write
-- access to every customer's CRM, and we now take backups of it nightly.
--
-- `integration_links` maps our ids to theirs, permanently and in both
-- directions. Without it every retry creates a duplicate contact in the
-- customer's CRM, and an inbound webhook has no way to find the record it is
-- talking about. It is the least interesting table here and the one whose
-- absence would do the most damage.
--
-- `integration_outbox` is the same pattern as the phone's outbox, for the same
-- reason: the other end will be down sometimes, and work must not be lost when
-- it is. A rep's sync must never wait on a third party, so nothing is sent
-- inline — it is queued here and drained separately.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_integrations (
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,               -- 'ghl'
  -- 'pit' is a Private Integration Token: a static bearer token the customer
  -- generates in their own sub-account. 'oauth' is the marketplace flow and is
  -- not built yet — the columns exist so adding it needs no migration.
  auth_type     TEXT NOT NULL DEFAULT 'pit',
  access_token  TEXT NOT NULL,               -- encrypted, never returned by any API
  refresh_token TEXT,                        -- encrypted; oauth only
  expires_at    INTEGER,                     -- oauth only
  location_id   TEXT,                        -- the customer's GHL sub-account
  config        TEXT NOT NULL DEFAULT '{}',  -- stage/field mapping, JSON
  status        TEXT NOT NULL DEFAULT 'active',
  last_ok_at    INTEGER,
  last_error    TEXT,
  last_error_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (client_id, provider)
);

-- ---------------------------------------------------------------------------
-- Per-company geocoding providers.
--
-- Separate from `client_integrations` on purpose, though both hold an encrypted
-- third-party credential. That table is the CRM connection: it has an outbox
-- draining against it and links mapping our ids to theirs, and anything that
-- lists it is listing "who is this company connected to". A geocoder key is
-- none of those things, and putting it in the same table would mean every
-- integration listing had to remember to exclude it. One forgotten WHERE clause
-- and a customer's API key appears on a screen built for something else.
--
-- `api_key` is ENCRYPTED — see api/src/secretbox.ts, same as CRM tokens, same
-- Worker secret, and never returned by any endpoint. A row is kept per provider
-- so a company can hold keys for two vendors and switch between them without
-- pasting a key again; the partial unique index is what enforces that exactly
-- one of them is the chosen one.
--
-- No row at all is the normal state. It means the free Census geocoder, which
-- needs no account and no card, and which is what every company gets until
-- somebody deliberately chooses otherwise.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_geocoders (
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,               -- matches GEOCODE_PROVIDERS[].id
  api_key       TEXT NOT NULL,               -- encrypted, never returned by any API
  active        INTEGER NOT NULL DEFAULT 0,  -- exactly one per client, see index
  status        TEXT NOT NULL DEFAULT 'active',
  last_ok_at    INTEGER,
  last_error    TEXT,
  last_error_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (client_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_geocoders_active
  ON client_geocoders(client_id) WHERE active = 1;

-- ---------------------------------------------------------------------------
-- How many addresses we have sent to a company's own geocoding provider.
--
-- Counted because the cost estimate on the import screen is otherwise a lie by
-- omission: without it, every batch is priced as though the free allowance were
-- untouched, so three medium imports in a day cross the vendor's daily cap and
-- nothing warns anybody. One row per client, provider and day; a monthly figure
-- is the sum of that month's rows, so one table answers both kinds of allowance.
--
-- The day is a UTC date, and that is a deliberate approximation. Vendors reset
-- their allowances on their own boundary — UTC for some, a billing month for
-- others — and this app cannot know which. What it can state honestly is what
-- IT sent and when, which is a floor on what the vendor has counted: the same
-- key used from anywhere else adds to their number and not to ours. The wording
-- on screen says "we have sent", never "you have left".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS geocode_usage (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider  TEXT NOT NULL,               -- matches GEOCODE_PROVIDERS[].id
  day       TEXT NOT NULL,               -- YYYY-MM-DD, UTC
  lookups   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, provider, day)
);

-- ---------------------------------------------------------------------------
-- Erasures, kept so they cannot be undone by accident.
--
-- A deleted lead has to stay deleted. `properties.id` is derived from the client
-- and the normalised address, so the same address always resolves to the same
-- id — one row here blocks every route back in: a CSV containing that address
-- again, a GoHighLevel webhook for the same contact, a rep adding it at the
-- door. Without it, a deletion made on Monday is undone by Tuesday's import.
--
-- What is kept is the minimum that makes the block work and the act
-- accountable: the id, who did it, when, and their stated reason. No address,
-- no name, no phone — a table of erased people's details would defeat the
-- erasure.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deletions (
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entity       TEXT NOT NULL,               -- 'property'
  entity_id    TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  reason       TEXT,
  photos       INTEGER NOT NULL DEFAULT 0,  -- how many files went with it
  at           INTEGER NOT NULL,
  PRIMARY KEY (client_id, entity, entity_id)
);
CREATE INDEX IF NOT EXISTS deletions_by_client ON deletions(client_id, at);

-- ---------------------------------------------------------------------------
-- Work that arrived late and landed on something that had moved.
--
-- The conflict rule is that Allstar wins, and it still does — nothing recorded
-- here changes an outcome. What changes is that somebody finds out. A rep works
-- a rural route with no signal on Monday and syncs on Friday; if the office
-- moved one of those leads on Wednesday, the rep's Monday answer overwrites it,
-- correctly and silently. Silently is the part worth fixing: the office edit
-- does not come back and nobody knows it went.
--
-- A record, not a queue. Nothing blocks and nothing waits for approval — a rep
-- on a doorstep is never held up by this.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rep_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,               -- the mutation that arrived late
  acted_at    INTEGER NOT NULL,            -- when the rep did it, their clock
  arrived_at  INTEGER NOT NULL,            -- when it reached us
  changed_at  INTEGER NOT NULL,            -- the lead's updated_at before this
  detail      TEXT,
  reviewed_at INTEGER                      -- null until a manager has looked
);
CREATE INDEX IF NOT EXISTS sync_conflicts_open
  ON sync_conflicts(client_id, reviewed_at, arrived_at);


/* ---------------------------------------------------------------------------
   Lead lists.

   A list is a working set: "Monday Route", "Follow Ups", "Northwest Territory
   – Sept 10". It is deliberately not a territory. A territory answers *whose
   ground is this* — one rep, one patch, and it drives where an import lands and
   what the coverage figures count. A list answers *what are we working on* —
   many leads, many reps, and a lead can be on several at once. Folding the
   second into the first would have meant changing the cardinality of a working,
   gated pipeline to get a feature it was never shaped for.

   Membership and assignment are both join tables, so both directions are N:N
   without a JSON column anybody has to keep in step by hand. `boundary` is kept
   when a list was made by drawing round an area — so the manager can see the
   shape later, and so a lead added to the area afterwards can be offered to it —
   and is null for a list somebody typed a name for.

   `archived` rather than deleted, because a list that a rep worked last week is
   history worth keeping. DELETE exists for the empty one made by mistake.
--------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS lead_lists (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  /* JSON [{lat,lng}] when made from a drawn area; null otherwise. */
  boundary    TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_lists_by_client ON lead_lists(client_id, archived);

CREATE TABLE IF NOT EXISTS lead_list_members (
  list_id     TEXT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  added_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (list_id, property_id)
);
CREATE INDEX IF NOT EXISTS lead_list_members_by_property ON lead_list_members(property_id);

CREATE TABLE IF NOT EXISTS lead_list_reps (
  list_id     TEXT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS lead_list_reps_by_user ON lead_list_reps(user_id);

CREATE TABLE IF NOT EXISTS integration_links (
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- 'contact' | 'opportunity' | 'appointment'
  local_id    TEXT NOT NULL,   -- ours
  remote_id   TEXT NOT NULL,   -- theirs
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (client_id, provider, kind, local_id)
);
-- Both directions have to be unique. Without this second index two of our
-- properties could each claim the same remote contact, and an inbound webhook
-- would have no single answer to "which lead is this?".
CREATE UNIQUE INDEX IF NOT EXISTS integration_links_remote
  ON integration_links(client_id, provider, kind, remote_id);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  -- Collapses a burst of edits to the same thing into one send. A rep who
  -- corrects an outcome three times should cost the customer's API quota once.
  dedupe_key      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS integration_outbox_due
  ON integration_outbox(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_dedupe
  ON integration_outbox(client_id, provider, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';
