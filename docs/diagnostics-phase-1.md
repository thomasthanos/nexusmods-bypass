# Phase 1: Complete diagnostics configuration and contracts

This delivery contains the full requested Phase 1 code. The executable sources in diagnostics/ are authoritative. No Phase 2, 3, or 4 implementation is included. The server entrypoint is supplied in Phase 3; deployment waits for that phase and real account configuration.

## Directory structure

```text
diagnostics/
  .gitignore
  README.md
  package.json
  package-lock.json
  tsconfig.json
  wrangler.toml
  schema.sql
  examples/
    send-report.ts
  src/
    schemas/
      ingest.ts
  test/
    example.test.mjs
    ingest.test.mjs
    schema.test.mjs
```

`npm run cf:types` generates the ignored `worker-configuration.d.ts`. Dependencies and local database state live in ignored `node_modules/` and `.wrangler/` directories.

The remaining requested files will be added only in their authorized phase:

```text
diagnostics/
  src/
    utils/
      sanitize.ts                 Phase 2
      fingerprint.ts              Phase 2
    services/
      ruleEngine.ts               Phase 2
      notifications.ts            Phase 2
    index.ts                      Phase 3
  public/
    index.html                    Phase 4
    app.js                        Phase 4
    sw.js                         Phase 4
    manifest.json                 Phase 4
```

## diagnostics/package.json

```json
{
  "name": "nexusmods-diagnostics",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Private Cloudflare diagnostics API and PWA for NexusMods Bypass.",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "cf:types": "wrangler types worker-configuration.d.ts",
    "db:init:local": "wrangler d1 execute DB --local --file=schema.sql",
    "db:init:remote": "wrangler d1 execute DB --remote --file=schema.sql",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@block65/webcrypto-web-push": "2.0.0",
    "@hono/cloudflare-access": "0.4.0",
    "@hono/zod-validator": "0.9.1",
    "compare-versions": "6.1.1",
    "error-stack-parser-es": "2.0.1",
    "hono": "4.13.13",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "5.20261021.1",
    "typescript": "7.0.2",
    "wrangler": "4.151.3"
  }
}
```

## diagnostics/wrangler.toml

```toml
name = "nexusmods-diagnostics"
main = "src/index.ts"
compatibility_date = "2026-10-21"
workers_dev = false
preview_urls = false

# The entrypoint is delivered in Phase 3; assets are delivered in Phase 4.
# Every asset request must pass the Access-verifying Worker first.
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "nexusmods-diagnostics"
# Wrangler provisions this database when deployed; no invented database ID.

[vars]
MAX_BODY_BYTES = "65536"
PUSH_COOLDOWN_SECONDS = "1800"
DETECTION_WINDOW_SECONDS = "900"
SPIKE_REPORT_THRESHOLD = "10"
DISTINCT_INSTALL_THRESHOLD = "3"
RATE_LIMIT_WINDOW_SECONDS = "60"
INGEST_IP_LIMIT = "60"
INGEST_INSTALL_LIMIT = "20"
HEARTBEAT_IP_LIMIT = "120"
HEARTBEAT_INSTALL_LIMIT = "10"

# Required runtime environment bindings; values are set outside version control.
# Public configuration is also bound as secrets to avoid fabricated account values.
[secrets]
required = [
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "DISCORD_WEBHOOK_URL",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "RATE_LIMIT_HASH_SECRET"
]

[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = false
```

## diagnostics/schema.sql

```sql
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
```

## diagnostics/src/schemas/ingest.ts

```typescript
import { z } from 'zod';

export const MAX_BODY_BYTES = 65_536;
export const MAX_BREADCRUMBS = 80;
export const MAX_COUNTER = 1_000_000;

const identifier = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const shortVersion = z.string().min(1).max(40).regex(/^[A-Za-z0-9._+ -]+$/);
const hasNoNul = (value: string): boolean => !value.includes('\u0000');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const versionSchema = z.string().max(64).regex(semverPattern).refine((value) => {
  const precedence = value.split('+')[0] ?? '';
  return precedence.split(/[.-]/).every((part) => !/^\d+$/.test(part) || Number.isSafeInteger(Number(part)));
}, 'Numeric version components must be safe integers');

export const installIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const browserSchema = z.enum(['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other']);
export const osSchema = z.enum(['windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'other']);
export const destinationSchema = z.enum(['browser', 'vortex', 'mo2']);
export const severitySchema = z.enum(['debug', 'info', 'warning', 'error', 'fatal']);

export const timestampSchema = z.iso.datetime({ precision: 3 }).refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value;
}, 'Expected a real UTC timestamp with millisecond precision');

export const metricDateSchema = z.iso.date().refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'Expected a real UTC calendar date');

type JsonScalar = string | number | boolean | null;
export type MetadataValue = JsonScalar | MetadataValue[] | { [key: string]: MetadataValue };

const metadataKey = z.string().min(1).max(48).regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe metadata key');
const scalarSchema = z.union([
  z.string().max(1024),
  z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.null()
]);

function boundedRecord(value: z.ZodType<MetadataValue>) {
  return z.preprocess((input, ctx) => {
    if (input && typeof input === 'object' && Object.keys(input).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      ctx.addIssue({ code: 'custom', message: 'Unsafe metadata key' });
      return z.NEVER;
    }
    return input;
  }, z.record(metadataKey, value).refine((record) => Object.keys(record).length <= 32, 'At most 32 metadata keys'));
}

// Construct a finite schema instead of accepting unrestricted recursive JSON.
let metadataValue: z.ZodType<MetadataValue> = scalarSchema;
for (let level = 0; level < 2; level += 1) {
  metadataValue = z.union([scalarSchema, z.array(metadataValue).max(16), boundedRecord(metadataValue)]);
}
export const metadataSchema = boundedRecord(metadataValue);

export const breadcrumbSchema = z.strictObject({
  timestamp_offset_ms: z.number().int().min(0).max(86_400_000),
  stage: identifier,
  action: identifier,
  status: z.enum(['ok', 'warn', 'error']),
  http_status: z.number().int().min(100).max(599).optional(),
  duration_ms: z.number().int().min(0).max(86_400_000).optional(),
  metadata: metadataSchema.default({})
});

const breadcrumbsSchema = z.array(breadcrumbSchema).max(MAX_BREADCRUMBS).superRefine((items, ctx) => {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous && current && current.timestamp_offset_ms < previous.timestamp_offset_ms) {
      ctx.addIssue({ code: 'custom', message: 'Breadcrumbs must be chronological', path: [index, 'timestamp_offset_ms'] });
    }
  }
});

export const domStateSchema = z.strictObject({
  document_ready_state: z.enum(['loading', 'interactive', 'complete']),
  page_kind: z.enum(['mod', 'collection', 'other']),
  collection_host_present: z.boolean().optional(),
  selectors: z.array(z.strictObject({
    selector: z.string().min(1).max(200),
    matched: z.boolean(),
    match_count: z.number().int().min(0).max(10_000).optional()
  })).max(20).default([]),
  api_schema: z.strictObject({
    expected: z.string().min(1).max(128).optional(),
    received: z.string().min(1).max(128).optional(),
    missing_fields: z.array(identifier).max(20).default([])
  }).optional()
});

const endpointSchema = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Endpoint must use HTTPS without credentials, query parameters, or fragments');

const contextSchema = z.strictObject({
  api_endpoint: endpointSchema.optional(),
  online: z.boolean().optional()
});

// This checks the parsed representation. Phase 3 must also cap the raw request
// stream before JSON parsing, including whitespace and chunked request bodies.
function enforcePayloadBudget(value: unknown, ctx: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BODY_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Payload exceeds 65,536 UTF-8 bytes' });
  }
}

export const errorReportSchema = z.strictObject({
  schema_version: z.literal(1),
  consent: z.literal('diagnostics-v1'),
  report_id: z.uuidv4().toLowerCase(),
  install_id: installIdSchema,
  occurred_at: timestampSchema,
  version: versionSchema,
  browser: browserSchema,
  browser_version: shortVersion,
  os: osSchema,
  os_version: shortVersion.optional(),
  mod_id: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)), 'Unsafe mod ID').optional(),
  collection_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  download_mode: z.enum(['manual', 'auto']),
  destination: destinationSchema,
  severity: severitySchema,
  error_category: identifier,
  error_code: identifier,
  failure_stage: identifier,
  error_name: z.string().min(1).max(120).refine(hasNoNul, 'NUL characters are not allowed').default('Error'),
  error_message: z.string().min(1).max(2048).refine(hasNoNul, 'NUL characters are not allowed'),
  stack_trace: z.string().max(12_000).refine(hasNoNul, 'NUL characters are not allowed').optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  retry_after: z.string().min(1).max(128).refine(hasNoNul, 'NUL characters are not allowed').optional(),
  breadcrumbs: breadcrumbsSchema.default([]),
  dom_state: domStateSchema.optional(),
  context: contextSchema.default({})
}).superRefine(enforcePayloadBudget);

const counterSchema = z.number().int().min(0).max(MAX_COUNTER);

export const heartbeatSchema = z.strictObject({
  schema_version: z.literal(1),
  consent: z.literal('telemetry-v1'),
  heartbeat_id: z.uuidv4().toLowerCase(),
  install_id: installIdSchema,
  metric_date: metricDateSchema,
  version: versionSchema,
  browser: browserSchema,
  destination: destinationSchema,
  attempts_count: counterSchema,
  success_count: counterSchema,
  fallback_triggered_count: counterSchema
}).superRefine((value, ctx) => {
  for (const field of ['success_count', 'fallback_triggered_count'] as const) {
    if (value[field] > value.attempts_count) {
      ctx.addIssue({ code: 'custom', message: `${field} cannot exceed attempts_count`, path: [field] });
    }
  }
  enforcePayloadBudget(value, ctx);
});

export type ErrorReportInput = z.input<typeof errorReportSchema>;
export type ErrorReport = z.output<typeof errorReportSchema>;
export type HeartbeatInput = z.input<typeof heartbeatSchema>;
export type Heartbeat = z.output<typeof heartbeatSchema>;
export type Breadcrumb = z.output<typeof breadcrumbSchema>;
```

## diagnostics/examples/send-report.ts

```typescript
import { errorReportSchema, MAX_BODY_BYTES } from '../src/schemas/ingest.ts';
import type { ErrorReportInput } from '../src/schemas/ingest.ts';

export type PreparedReport = Readonly<{ url: string; report_id: string; body: string }>;

type ExampleOptions = {
  relayOrigin: string;
  diagnosticsOptedIn: boolean;
  // A crypto.randomUUID() value persisted in extension-local storage after opt-in.
  // Never use an account ID, email, Nexus API key, or browser fingerprint here.
  anonymousInstallSeed: string;
  version: string;
  browser: ErrorReportInput['browser'];
  browserVersion: string;
  os: ErrorReportInput['os'];
};

export async function prepareExampleReport(options: ExampleOptions): Promise<PreparedReport | null> {
  if (!options.diagnosticsOptedIn) return null;

  const origin = new URL(options.relayOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Use the HTTPS origin of the diagnostics Worker');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.anonymousInstallSeed)) {
    throw new Error('The installation seed must be a locally generated random UUID');
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.anonymousInstallSeed));
  const install_id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const report = errorReportSchema.parse({
    schema_version: 1,
    consent: 'diagnostics-v1',
    report_id: crypto.randomUUID(),
    install_id,
    occurred_at: new Date().toISOString(),
    version: options.version,
    browser: options.browser,
    browser_version: options.browserVersion,
    os: options.os,
    download_mode: 'auto',
    destination: 'vortex',
    severity: 'error',
    error_category: 'HANDOFF',
    error_code: 'NXM_TIMEOUT',
    failure_stage: 'VORTEX_NXM_HANDOFF_FAILED',
    error_message: 'Vortex did not acknowledge the nxm protocol handoff',
    breadcrumbs: [
      { timestamp_offset_ms: 0, stage: 'UI', action: 'UI_CLICK_DOWNLOAD', status: 'ok' },
      { timestamp_offset_ms: 310, stage: 'API', action: 'PRIMARY_API_REQUEST', status: 'warn', http_status: 429, duration_ms: 310, metadata: { retry_after: '60' } },
      { timestamp_offset_ms: 730, stage: 'API', action: 'FALLBACK_API_REQUEST', status: 'ok', http_status: 200, duration_ms: 420 },
      { timestamp_offset_ms: 5730, stage: 'HANDOFF', action: 'VORTEX_NXM_HANDOFF_FAILED', status: 'error', duration_ms: 5000 }
    ],
    context: { online: navigator.onLine }
  } satisfies ErrorReportInput);

  const body = JSON.stringify(report);
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new Error('Report exceeds the request limit');
  }
  return Object.freeze({ url: new URL('/api/ingest', origin).href, report_id: report.report_id, body });
}

// Retain the prepared object for retries. Never regenerate its UUID or counters.
// Read current consent immediately before each attempt, including queued retries.
export async function sendPreparedReport(report: PreparedReport, diagnosticsStillOptedIn: boolean): Promise<boolean> {
  if (!diagnosticsStillOptedIn) return false;
  const response = await fetch(report.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: report.body,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Diagnostics request failed with HTTP ${response.status}`);
  return true;
}
```

## diagnostics/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "examples/**/*.ts"]
}
```

## diagnostics/.gitignore

```gitignore
worker-configuration.d.ts
node_modules/
.wrangler/
.dev.vars*
.env*
```

## Supporting files and verification

The committed dependency lockfile is <a href="../diagnostics/package-lock.json"><kbd>package-lock.json</kbd></a>. Full setup, privacy, database-write, and phase-boundary documentation is in <a href="../diagnostics/README.md"><kbd>README.md</kbd></a>. Executable tests are <a href="../diagnostics/test/ingest.test.mjs"><kbd>ingest.test.mjs</kbd></a>, <a href="../diagnostics/test/example.test.mjs"><kbd>example.test.mjs</kbd></a>, and <a href="../diagnostics/test/schema.test.mjs"><kbd>schema.test.mjs</kbd></a>.

Verified on 2026-10-21: diagnostics type checking and all 40 tests pass; the schema applied to local Cloudflare D1; Wrangler binding type generation passes; the seven approved runtime libraries bundle for Web API execution; existing extension tests and repository lint pass. No remote deployment, resource creation, or message delivery was performed.
