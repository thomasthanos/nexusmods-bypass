-- Additive: safe to apply to an existing diagnostics database before deployment.
CREATE TABLE IF NOT EXISTS store_monitor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR (length(CAST(snapshot_json AS BLOB)) <= 8192 AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')),
  baseline_at INTEGER CHECK (baseline_at IS NULL OR baseline_at BETWEEN 0 AND 253402300799999),
  last_checked_at INTEGER CHECK (last_checked_at IS NULL OR last_checked_at BETWEEN 0 AND 253402300799999),
  last_success_at INTEGER CHECK (last_success_at IS NULL OR last_success_at BETWEEN 0 AND 253402300799999),
  last_error_at INTEGER CHECK (last_error_at IS NULL OR last_error_at BETWEEN 0 AND 253402300799999),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 253402300799999),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS store_reviews (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*' AND instr(id, char(0)) = 0),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 200 AND instr(author, char(0)) = 0),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK (length(body) <= 4096 AND instr(body, char(0)) = 0),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 253402300799999),
  version TEXT CHECK (version IS NULL OR (length(version) BETWEEN 1 AND 24 AND instr(version, char(0)) = 0)),
  language TEXT CHECK (language IS NULL OR (length(language) BETWEEN 1 AND 35 AND instr(language, char(0)) = 0)),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at BETWEEN 0 AND 253402300799999),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at BETWEEN first_seen_at AND 253402300799999),
  acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at BETWEEN 0 AND 253402300799999),
  first_seen_run_token TEXT NOT NULL CHECK (length(first_seen_run_token) BETWEEN 1 AND 128)
) STRICT;

CREATE TABLE IF NOT EXISTS store_review_deliveries (
  review_id TEXT NOT NULL REFERENCES store_reviews(id),
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 9 AND 2048 AND substr(endpoint, 1, 8) = 'https://' AND instr(endpoint, char(0)) = 0),
  p256dh TEXT NOT NULL CHECK (length(p256dh) = 87 AND p256dh NOT GLOB '*[^A-Za-z0-9_-]*'),
  auth TEXT NOT NULL CHECK (length(auth) = 22 AND auth NOT GLOB '*[^A-Za-z0-9_-]*'),
  expiration_time INTEGER CHECK (expiration_time IS NULL OR expiration_time BETWEEN 0 AND 253402300799999),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at BETWEEN created_at AND 253402300799999),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 253402300799999),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at BETWEEN created_at AND 253402300799999),
  abandoned_at INTEGER CHECK (abandoned_at IS NULL OR abandoned_at BETWEEN created_at AND 253402300799999),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  PRIMARY KEY (review_id, subscription_id)
) STRICT;

-- Only aggregate reports enter this cache. OAuth credentials stay in Worker secrets.
CREATE TABLE IF NOT EXISTS analytics_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR (length(CAST(snapshot_json AS BLOB)) <= 8192 AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')),
  checked_at INTEGER NOT NULL DEFAULT 0 CHECK (checked_at BETWEEN 0 AND 253402300799999),
  lease_token TEXT,
  lease_expires_at INTEGER,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_store_reviews_created ON store_reviews (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_store_reviews_new ON store_reviews (acknowledged_at) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_store_deliveries_pending ON store_review_deliveries (next_attempt_at, lease_expires_at) WHERE delivered_at IS NULL AND abandoned_at IS NULL;
