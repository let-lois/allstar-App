-- Run once against an existing database. New deployments get this from schema.sql.
CREATE TABLE IF NOT EXISTS login_attempts (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
