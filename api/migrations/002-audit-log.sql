-- Applied automatically by the Worker on the first request after a deploy
-- (see api/src/migrate.ts). Kept here as a readable record and as a manual
-- fallback if that ever needs to be bypassed.
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, target_label TEXT, detail TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS audit_by_client_time ON audit_log(client_id, at DESC);
