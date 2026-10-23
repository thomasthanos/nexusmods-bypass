-- Phase 1, Cloudflare D1 / SQLite. Server timestamps are UTC epoch milliseconds.
-- Payload validation, sanitization, classification, and SemVer grammar belong to
-- the Worker. SQL independently enforces types, bounded storage, and invariants.
-- D1 enables foreign keys; this also makes local SQLite application equivalent.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE
    CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(fingerprint, char(0)) = 0),

  -- These are the immutable inputs used to compute the fingerprint.
  error_category TEXT NOT NULL
    CHECK (length(error_category) BETWEEN 1 AND 80 AND error_category NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(error_category, char(0)) = 0),
  error_code TEXT NOT NULL
    CHECK (length(error_code) BETWEEN 1 AND 80 AND error_code NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(error_code, char(0)) = 0),
  failure_stage TEXT NOT NULL
    CHECK (length(failure_stage) BETWEEN 1 AND 80 AND failure_stage NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(failure_stage, char(0)) = 0),
  normalized_top_frame TEXT NOT NULL
    CHECK (length(normalized_top_frame) <= 2048 AND instr(normalized_top_frame, char(0)) = 0),
  destination TEXT NOT NULL CHECK (destination IN ('browser', 'vortex', 'mo2')),

  -- Rule output is separate from the original error identity and may evolve.
  category TEXT NOT NULL
    CHECK (length(category) BETWEEN 1 AND 80 AND category NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(category, char(0)) = 0),
  fault_origin TEXT NOT NULL
    CHECK (fault_origin IN ('client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown')),
  suggested_action TEXT NOT NULL
    CHECK (length(suggested_action) BETWEEN 1 AND 2048 AND instr(suggested_action, char(0)) = 0),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'investigating', 'fixed', 'regressed', 'ignored')),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  total_occurrences INTEGER NOT NULL DEFAULT 0
    CHECK (total_occurrences BETWEEN 0 AND 9007199254740991),
  affected_installs_count INTEGER NOT NULL DEFAULT 0
    CHECK (affected_installs_count BETWEEN 0 AND 9007199254740991 AND affected_installs_count <= total_occurrences),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at BETWEEN 0 AND 253402300799999),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at BETWEEN first_seen_at AND 253402300799999),
  first_seen_version TEXT NOT NULL
    CHECK (length(first_seen_version) BETWEEN 5 AND 64 AND first_seen_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND first_seen_version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(first_seen_version, char(0)) = 0),
  last_seen_version TEXT NOT NULL
    CHECK (length(last_seen_version) BETWEEN 5 AND 64 AND last_seen_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND last_seen_version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(last_seen_version, char(0)) = 0),
  fixed_in_version TEXT
    CHECK (fixed_in_version IS NULL OR (length(fixed_in_version) BETWEEN 5 AND 64 AND fixed_in_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND fixed_in_version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(fixed_in_version, char(0)) = 0)),
  github_issue_url TEXT
    CHECK (github_issue_url IS NULL OR (length(github_issue_url) BETWEEN 1 AND 2048 AND github_issue_url LIKE 'https://github.com/%/issues/%' AND instr(github_issue_url, char(0)) = 0)),
  last_pushed_at INTEGER CHECK (last_pushed_at IS NULL OR last_pushed_at BETWEEN 0 AND 253402300799999),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 253402300799999),
  CHECK (status NOT IN ('fixed', 'regressed') OR fixed_in_version IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS reports (
  -- Payload report_id maps to this immutable canonical UUID, never a server ID.
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND substr(id, 15, 1) = '4' AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*' AND instr(id, char(0)) = 0),
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL
    CHECK (length(install_id) = 64 AND install_id NOT GLOB '*[^0-9a-f]*' AND instr(install_id, char(0)) = 0),
  version TEXT NOT NULL
    CHECK (length(version) BETWEEN 5 AND 64 AND version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(version, char(0)) = 0),
  browser TEXT NOT NULL CHECK (browser IN ('chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other')),
  browser_version TEXT NOT NULL CHECK (length(browser_version) BETWEEN 1 AND 40 AND instr(browser_version, char(0)) = 0),
  os TEXT NOT NULL CHECK (os IN ('windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'other')),
  os_version TEXT CHECK (os_version IS NULL OR (length(os_version) BETWEEN 1 AND 40 AND instr(os_version, char(0)) = 0)),
  mod_id TEXT CHECK (mod_id IS NULL OR (length(mod_id) BETWEEN 1 AND 16 AND mod_id NOT GLOB '*[^0-9]*' AND instr(mod_id, char(0)) = 0)),
  collection_id TEXT CHECK (collection_id IS NULL OR (length(collection_id) BETWEEN 1 AND 64 AND collection_id NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(collection_id, char(0)) = 0)),
  download_mode TEXT NOT NULL CHECK (download_mode IN ('manual', 'auto')),
  destination TEXT NOT NULL CHECK (destination IN ('browser', 'vortex', 'mo2')),
  severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'error', 'fatal')),
  error_category TEXT NOT NULL
    CHECK (length(error_category) BETWEEN 1 AND 80 AND error_category NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(error_category, char(0)) = 0),
  error_code TEXT NOT NULL
    CHECK (length(error_code) BETWEEN 1 AND 80 AND error_code NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(error_code, char(0)) = 0),
  failure_stage TEXT NOT NULL
    CHECK (length(failure_stage) BETWEEN 1 AND 80 AND failure_stage NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(failure_stage, char(0)) = 0),
  error_name TEXT NOT NULL CHECK (length(error_name) BETWEEN 1 AND 120 AND instr(error_name, char(0)) = 0),
  error_message TEXT NOT NULL CHECK (length(error_message) BETWEEN 1 AND 2048 AND instr(error_message, char(0)) = 0),
  stack_trace TEXT CHECK (stack_trace IS NULL OR (length(stack_trace) <= 12000 AND instr(stack_trace, char(0)) = 0)),
  breadcrumbs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(CAST(breadcrumbs_json AS BLOB)) <= 65536 AND json_valid(breadcrumbs_json) AND json_type(breadcrumbs_json) = 'array'),
  dom_state_json TEXT
    CHECK (dom_state_json IS NULL OR (length(CAST(dom_state_json AS BLOB)) <= 65536 AND json_valid(dom_state_json) AND json_type(dom_state_json) = 'object')),
  context_json TEXT NOT NULL DEFAULT '{}'
    CHECK (length(CAST(context_json AS BLOB)) <= 65536 AND json_valid(context_json) AND json_type(context_json) = 'object'),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  retry_after TEXT CHECK (retry_after IS NULL OR (length(retry_after) <= 128 AND instr(retry_after, char(0)) = 0)),
  category TEXT NOT NULL
    CHECK (length(category) BETWEEN 1 AND 80 AND category NOT GLOB '*[^A-Za-z0-9_.:-]*' AND instr(category, char(0)) = 0),
  fault_origin TEXT NOT NULL
    CHECK (fault_origin IN ('client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown')),
  suggested_action TEXT NOT NULL
    CHECK (length(suggested_action) BETWEEN 1 AND 2048 AND instr(suggested_action, char(0)) = 0),
  -- occurred_at is client time; created_at is server time used for spike windows.
  occurred_at INTEGER NOT NULL CHECK (occurred_at BETWEEN 0 AND 253402300799999),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999)
) STRICT;

-- Keep these minimal tombstones for the lifetime of an issue, even when report
-- bodies expire. Otherwise a replay after retention would inflate lifetime counts.
CREATE TABLE IF NOT EXISTS report_receipts (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND substr(id, 15, 1) = '4' AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*' AND instr(id, char(0)) = 0),
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL
    CHECK (length(install_id) = 64 AND install_id NOT GLOB '*[^0-9a-f]*' AND instr(install_id, char(0)) = 0),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE TABLE IF NOT EXISTS issue_installs (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL
    CHECK (length(install_id) = 64 AND install_id NOT GLOB '*[^0-9a-f]*' AND instr(install_id, char(0)) = 0),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at BETWEEN 0 AND 253402300799999),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at BETWEEN first_seen_at AND 253402300799999),
  PRIMARY KEY (issue_id, install_id)
) STRICT;

-- Receipts store immutable counter deltas, never an installation's cumulative
-- total. Retain them until a bounded replay/retention protocol is implemented.
CREATE TABLE IF NOT EXISTS heartbeat_receipts (
  heartbeat_id TEXT NOT NULL
    CHECK (length(heartbeat_id) = 36 AND substr(heartbeat_id, 15, 1) = '4' AND substr(heartbeat_id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(heartbeat_id, 9, 1) = '-' AND substr(heartbeat_id, 14, 1) = '-' AND substr(heartbeat_id, 19, 1) = '-' AND substr(heartbeat_id, 24, 1) = '-' AND length(replace(heartbeat_id, '-', '')) = 32 AND replace(heartbeat_id, '-', '') NOT GLOB '*[^0-9a-f]*' AND instr(heartbeat_id, char(0)) = 0),
  install_id TEXT NOT NULL
    CHECK (length(install_id) = 64 AND install_id NOT GLOB '*[^0-9a-f]*' AND instr(install_id, char(0)) = 0),
  metric_date TEXT NOT NULL
    CHECK (length(metric_date) = 10 AND metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(metric_date, '+0 days') IS metric_date AND instr(metric_date, char(0)) = 0),
  version TEXT NOT NULL
    CHECK (length(version) BETWEEN 5 AND 64 AND version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(version, char(0)) = 0),
  browser TEXT NOT NULL CHECK (browser IN ('chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other')),
  destination TEXT NOT NULL CHECK (destination IN ('browser', 'vortex', 'mo2')),
  attempts_count INTEGER NOT NULL CHECK (attempts_count BETWEEN 0 AND 1000000),
  success_count INTEGER NOT NULL CHECK (success_count BETWEEN 0 AND attempts_count),
  fallback_triggered_count INTEGER NOT NULL CHECK (fallback_triggered_count BETWEEN 0 AND attempts_count),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (heartbeat_id, install_id)
) STRICT;

CREATE TABLE IF NOT EXISTS release_metrics (
  version TEXT NOT NULL
    CHECK (length(version) BETWEEN 5 AND 64 AND version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(version, char(0)) = 0),
  metric_date TEXT NOT NULL
    CHECK (length(metric_date) = 10 AND metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(metric_date, '+0 days') IS metric_date AND instr(metric_date, char(0)) = 0),
  browser TEXT NOT NULL CHECK (browser IN ('chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other')),
  destination TEXT NOT NULL CHECK (destination IN ('browser', 'vortex', 'mo2')),
  attempts_count INTEGER NOT NULL DEFAULT 0 CHECK (attempts_count BETWEEN 0 AND 9007199254740991),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count BETWEEN 0 AND attempts_count),
  fallback_triggered_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_triggered_count BETWEEN 0 AND attempts_count),
  heartbeat_count INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_count BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 253402300799999),
  PRIMARY KEY (version, metric_date, browser, destination)
) STRICT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE
    CHECK (length(endpoint) BETWEEN 9 AND 2048 AND substr(endpoint, 1, 8) = 'https://' AND instr(endpoint, ' ') = 0 AND instr(endpoint, char(0)) = 0),
  -- Keys are stored as unpadded base64url: 65-byte uncompressed P-256 and 16-byte auth.
  p256dh TEXT NOT NULL CHECK (length(p256dh) = 87 AND p256dh NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(p256dh, char(0)) = 0),
  auth TEXT NOT NULL CHECK (length(auth) = 22 AND auth NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(auth, char(0)) = 0),
  user_agent TEXT CHECK (user_agent IS NULL OR (length(user_agent) <= 512 AND instr(user_agent, char(0)) = 0)),
  expiration_time INTEGER CHECK (expiration_time IS NULL OR expiration_time BETWEEN 0 AND 253402300799999),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 253402300799999)
) STRICT;

-- key_hash is HMAC-SHA-256(JSON.stringify([route, scope, input]), secret).
-- Route separation keeps ingest and heartbeat limits independent. Never insert an IP address,
-- a plain IP digest, or a raw installation identifier into a bucket key.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'install')),
  key_hash TEXT NOT NULL
    CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*' AND instr(key_hash, char(0)) = 0),
  window_started_at INTEGER NOT NULL CHECK (window_started_at BETWEEN 0 AND 253402300799999),
  window_duration_ms INTEGER NOT NULL CHECK (window_duration_ms BETWEEN 1 AND 86400000),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN window_started_at + window_duration_ms AND 253402300799999),
  PRIMARY KEY (scope, key_hash, window_started_at, window_duration_ms)
) STRICT;

-- A stable event dedupe key plus an optional owned lease supports atomic claims.
-- Dispatching and retry policy are implemented in later phases.
CREATE TABLE IF NOT EXISTS notification_claims (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('NEW_CRITICAL', 'REGRESSION', 'SPIKE_DETECTED', 'UPSTREAM_CHANGE')),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 128 AND instr(dedupe_key, char(0)) = 0),
  lease_token TEXT CHECK (lease_token IS NULL OR (length(lease_token) BETWEEN 1 AND 128 AND instr(lease_token, char(0)) = 0)),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at BETWEEN created_at AND 253402300799999),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at BETWEEN created_at AND 253402300799999),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  PRIMARY KEY (issue_id, event_type, dedupe_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_reports_issue_time_install ON reports (issue_id, created_at DESC, install_id);
CREATE INDEX IF NOT EXISTS idx_reports_category_time_install_issue ON reports (category, created_at DESC, install_id, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_version_time_issue ON reports (version, created_at DESC, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_browser_time_issue ON reports (browser, created_at DESC, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_os_time_issue ON reports (os, created_at DESC, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_destination_time_issue ON reports (destination, created_at DESC, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_mode_time_issue ON reports (download_mode, created_at DESC, issue_id);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at);
CREATE INDEX IF NOT EXISTS idx_report_receipts_issue ON report_receipts (issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_status_seen ON issues (status, last_seen_at DESC, muted);
CREATE INDEX IF NOT EXISTS idx_issues_fault_seen ON issues (fault_origin, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_category_seen ON issues (category, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_seen ON issues (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_release_metrics_date_version ON release_metrics (metric_date, version);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expiry ON rate_limit_buckets (expires_at);
CREATE INDEX IF NOT EXISTS idx_notification_claims_lease ON notification_claims (lease_expires_at) WHERE delivered_at IS NULL;

CREATE TRIGGER IF NOT EXISTS issues_identity_immutable
BEFORE UPDATE OF fingerprint, error_category, error_code, failure_stage, normalized_top_frame, destination ON issues
WHEN NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.error_category IS NOT OLD.error_category
  OR NEW.error_code IS NOT OLD.error_code
  OR NEW.failure_stage IS NOT OLD.failure_stage
  OR NEW.normalized_top_frame IS NOT OLD.normalized_top_frame
  OR NEW.destination IS NOT OLD.destination
BEGIN
  SELECT RAISE(ABORT, 'issue fingerprint inputs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS reports_immutable
BEFORE UPDATE ON reports
BEGIN
  SELECT RAISE(ABORT, 'reports are immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_receipts_immutable
BEFORE UPDATE ON report_receipts
BEGIN
  SELECT RAISE(ABORT, 'report receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_receipts_retain
BEFORE DELETE ON report_receipts
WHEN EXISTS (SELECT 1 FROM issues WHERE id = OLD.issue_id)
BEGIN
  SELECT RAISE(ABORT, 'retain report replay receipts for the lifetime of the issue');
END;

CREATE TRIGGER IF NOT EXISTS reports_rollup_insert
AFTER INSERT ON reports
BEGIN
  -- All report CHECK/FK constraints have run before this trigger. A replay whose
  -- old body has expired must not recreate a recent row in spike/canary windows.
  DELETE FROM reports
  WHERE id = NEW.id AND EXISTS (SELECT 1 FROM report_receipts WHERE id = NEW.id);

  INSERT INTO report_receipts (id, issue_id, install_id, created_at)
  VALUES (NEW.id, NEW.issue_id, NEW.install_id, NEW.created_at)
  ON CONFLICT (id) DO NOTHING;

  -- changes() here is exactly the preceding receipt INSERT, never the report
  -- INSERT. The whole trigger is one atomic statement, including membership.
  UPDATE issues
  SET affected_installs_count = affected_installs_count + CASE
        WHEN EXISTS (SELECT 1 FROM issue_installs WHERE issue_id = NEW.issue_id AND install_id = NEW.install_id) THEN 0 ELSE 1 END,
      first_seen_at = CASE WHEN total_occurrences = 0 THEN NEW.created_at ELSE min(first_seen_at, NEW.created_at) END,
      last_seen_at = CASE WHEN total_occurrences = 0 THEN NEW.created_at ELSE max(last_seen_at, NEW.created_at) END,
      first_seen_version = CASE WHEN total_occurrences = 0 OR NEW.created_at < first_seen_at THEN NEW.version ELSE first_seen_version END,
      last_seen_version = CASE WHEN total_occurrences = 0 OR NEW.created_at >= last_seen_at THEN NEW.version ELSE last_seen_version END,
      total_occurrences = total_occurrences + 1,
      updated_at = max(updated_at, NEW.created_at)
  WHERE id = NEW.issue_id AND changes() = 1;

  INSERT INTO issue_installs (issue_id, install_id, first_seen_at, last_seen_at)
  SELECT issue_id, install_id, created_at, created_at FROM report_receipts WHERE id = NEW.id
  ON CONFLICT (issue_id, install_id) DO NOTHING;

  -- Use the original receipt time, including on replays after body retention.
  UPDATE issue_installs
  SET first_seen_at = min(first_seen_at, (SELECT created_at FROM report_receipts WHERE id = NEW.id)),
      last_seen_at = max(last_seen_at, (SELECT created_at FROM report_receipts WHERE id = NEW.id))
  WHERE (issue_id, install_id) = (SELECT issue_id, install_id FROM report_receipts WHERE id = NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS heartbeat_receipts_immutable
BEFORE UPDATE ON heartbeat_receipts
BEGIN
  SELECT RAISE(ABORT, 'heartbeat receipts and counter deltas are immutable');
END;

CREATE TRIGGER IF NOT EXISTS heartbeat_receipts_retain
BEFORE DELETE ON heartbeat_receipts
BEGIN
  SELECT RAISE(ABORT, 'retain heartbeat replay receipts until a bounded replay policy exists');
END;

CREATE TRIGGER IF NOT EXISTS heartbeat_receipts_rollup_insert
AFTER INSERT ON heartbeat_receipts
BEGIN
  INSERT INTO release_metrics (
    version, metric_date, browser, destination, attempts_count, success_count,
    fallback_triggered_count, heartbeat_count, created_at, updated_at
  ) VALUES (
    NEW.version, NEW.metric_date, NEW.browser, NEW.destination, NEW.attempts_count,
    NEW.success_count, NEW.fallback_triggered_count, 1, NEW.created_at, NEW.created_at
  )
  ON CONFLICT (version, metric_date, browser, destination) DO UPDATE SET
    attempts_count = release_metrics.attempts_count + excluded.attempts_count,
    success_count = release_metrics.success_count + excluded.success_count,
    fallback_triggered_count = release_metrics.fallback_triggered_count + excluded.fallback_triggered_count,
    heartbeat_count = release_metrics.heartbeat_count + 1,
    created_at = min(release_metrics.created_at, excluded.created_at),
    updated_at = max(release_metrics.updated_at, excluded.updated_at);
END;

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

