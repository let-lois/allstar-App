-- Applied automatically by the Worker on the first request after a deploy
-- (see api/src/migrate.ts). Kept here as a readable record and as a manual
-- fallback if that ever needs to be bypassed.
CREATE TABLE IF NOT EXISTS login_attempts (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
