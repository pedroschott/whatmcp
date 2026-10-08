-- Request audit log behind GET /v1/logs/requests: every non-GET request plus
-- every failed request. Never stores bodies, query strings or tokens.
CREATE TABLE request_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  agent_id   TEXT,
  agent_name TEXT,
  ip         TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ms         INTEGER NOT NULL,
  error_code TEXT
);
CREATE INDEX request_log_ts ON request_log(ts);
