-- agents-hub schema. All timestamps are integer milliseconds since the Unix epoch.

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,            -- "agt_<hex>"
  name             TEXT NOT NULL UNIQUE,
  token_hash       TEXT NOT NULL UNIQUE,        -- sha256(token), the token itself is never stored
  capabilities     TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  meta             TEXT NOT NULL DEFAULT '{}',  -- JSON object (hostname, os, version...)
  state            TEXT NOT NULL DEFAULT 'idle',
  note             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  offline_notified INTEGER NOT NULL DEFAULT 0,
  disabled         INTEGER NOT NULL DEFAULT 0,
  rl_window        INTEGER NOT NULL DEFAULT 0,  -- current rate-limit minute
  rl_count         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- the polling cursor
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT,                              -- agent id that caused it (NULL = system)
  target     TEXT,                              -- agent id for direct events, NULL = broadcast
  payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_target ON events(target, seq);
CREATE INDEX events_ts ON events(ts);

CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,         -- "tsk_<hex>"
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  payload             TEXT NOT NULL DEFAULT '{}',
  priority            INTEGER NOT NULL DEFAULT 0,
  required_capability TEXT,
  assigned_to         TEXT,                     -- only this agent may claim it
  status              TEXT NOT NULL DEFAULT 'open', -- open|claimed|done|failed|cancelled
  created_by          TEXT NOT NULL,
  claimed_by          TEXT,
  lease_id            TEXT UNIQUE,
  lease_expires_at    INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  result              TEXT,
  error               TEXT,
  artifacts           TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX tasks_claimable ON tasks(status, priority DESC, created_at);
CREATE INDEX tasks_claimed_by ON tasks(claimed_by, status);
CREATE INDEX tasks_lease ON tasks(status, lease_expires_at);

CREATE TABLE idempotency (
  agent_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      INTEGER,
  response    TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, key)
);
CREATE INDEX idempotency_created ON idempotency(created_at);

CREATE TABLE ip_rate (
  key    TEXT PRIMARY KEY,                      -- "<bucket>:<ip>:<window>"
  count  INTEGER NOT NULL,
  window INTEGER NOT NULL
);

CREATE TABLE kv_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
