import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const schemaUrl = new URL('../schema.sql', import.meta.url);
const NOW = 1_792_604_800_000;
const INSTALL_A = 'a'.repeat(64);
const INSTALL_B = 'b'.repeat(64);
const INSTALL_C = 'c'.repeat(64);
const uuid = (number) => `12345678-1234-4234-8234-${number.toString(16).padStart(12, '0')}`;

function database(t) {
  assert.ok(existsSync(schemaUrl), 'The executable D1 schema has not been implemented');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(schemaUrl, 'utf8'));
  return db;
}

function insert(db, table, values, conflict = '') {
  const keys = Object.keys(values);
  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ${conflict}`,
  ).run(...Object.values(values));
}

function issue(db, overrides = {}) {
  return Number(insert(db, 'issues', {
    fingerprint: '1'.repeat(64),
    error_category: 'DOWNLOAD_ERROR',
    error_code: 'REQUEST_FAILED',
    failure_stage: 'PRIMARY_API_REQUEST',
    normalized_top_frame: 'scripts/download.js:fetchFile',
    destination: 'browser',
    category: 'NETWORK_UNREACHABLE',
    fault_origin: 'client_env',
    suggested_action: 'Check the network connection.',
    first_seen_at: NOW,
    last_seen_at: NOW,
    first_seen_version: '3.2.0',
    last_seen_version: '3.2.0',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }).lastInsertRowid);
}

function report(db, issueId, overrides = {}, conflict = '') {
  return insert(db, 'reports', {
    id: uuid(1),
    issue_id: issueId,
    install_id: INSTALL_A,
    version: '3.2.0',
    browser: 'chrome',
    browser_version: '142.0.0.0',
    os: 'windows',
    os_version: '11',
    mod_id: '1234',
    collection_id: 'collection-token',
    download_mode: 'manual',
    destination: 'browser',
    severity: 'error',
    error_category: 'DOWNLOAD_ERROR',
    error_code: 'REQUEST_FAILED',
    failure_stage: 'PRIMARY_API_REQUEST',
    error_name: 'TypeError',
    error_message: 'Failed to fetch',
    stack_trace: 'TypeError: Failed to fetch\n at fetchFile (scripts/download.js:20:4)',
    breadcrumbs_json: '[{"timestamp_offset_ms":0,"stage":"PRIMARY_API_REQUEST","action":"fetch","status":"error"}]',
    dom_state_json: '{"document_ready_state":"complete","page_kind":"mod","selectors":[]}',
    context_json: '{"api_endpoint":"https://api.nexusmods.com/"}',
    http_status: null,
    retry_after: null,
    category: 'NETWORK_UNREACHABLE',
    fault_origin: 'client_env',
    suggested_action: 'Check the network connection.',
    occurred_at: NOW - 50,
    created_at: NOW,
    ...overrides,
  }, conflict);
}

function heartbeat(db, overrides = {}, conflict = '') {
  return insert(db, 'heartbeat_receipts', {
    heartbeat_id: uuid(1),
    install_id: INSTALL_A,
    metric_date: '2026-10-21',
    version: '3.2.0',
    browser: 'chrome',
    destination: 'browser',
    attempts_count: 10,
    success_count: 9,
    fallback_triggered_count: 2,
    created_at: NOW,
    ...overrides,
  }, conflict);
}

function row(db, sql, ...values) {
  return { ...db.prepare(sql).get(...values) };
}

test('D1 creates strict tables and enables relational integrity', (t) => {
  const db = database(t);
  for (const name of [
    'issues', 'reports', 'issue_installs', 'release_metrics', 'push_subscriptions',
    'report_receipts', 'heartbeat_receipts', 'rate_limit_buckets', 'notification_claims',
  ]) {
    assert.equal(db.prepare('PRAGMA table_list').all().find((entry) => entry.name === name)?.strict, 1, name);
  }
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => report(db, 999), /FOREIGN KEY/);
});

test('Store/Analytics migration upgrades existing D1 schema without changing old records and is repeatable', (t) => {
  const canonical = readFileSync(schemaUrl, 'utf8');
  const migration = readFileSync(new URL('../migrations/0001_store_analytics.sql', import.meta.url), 'utf8');
  const boundary = canonical.indexOf('-- Additive: safe to apply');
  assert.ok(boundary > 0); assert.equal(canonical.slice(boundary).trim(), migration.trim());
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(canonical.slice(0, boundary));
  const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  db.exec(migration); db.exec(migration);
  for (const row of before) assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name).sql, row.sql);
  for (const name of ['analytics_cache','store_monitor_state','store_reviews','store_review_deliveries']) {
    assert.equal(db.prepare('PRAGMA table_list').all().find((row) => row.name === name)?.strict,1,name);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('one report creates one occurrence and one lifetime installation membership', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  assert.deepEqual(row(db, 'SELECT total_occurrences, affected_installs_count FROM issues WHERE id = ?', issueId), {
    total_occurrences: 1,
    affected_installs_count: 1,
  });
  assert.deepEqual(row(db, 'SELECT issue_id, install_id, first_seen_at, last_seen_at FROM issue_installs'), {
    issue_id: issueId,
    install_id: INSTALL_A,
    first_seen_at: NOW,
    last_seen_at: NOW,
  });
});

test('targeted report retries do not increment counters or change the immutable report', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  const result = report(db, issueId, { error_message: 'retry body', created_at: NOW + 1_000 }, 'ON CONFLICT(id) DO NOTHING');
  assert.equal(result.changes, 0);
  assert.deepEqual(row(db, 'SELECT total_occurrences, affected_installs_count, last_seen_at FROM issues'), {
    total_occurrences: 1,
    affected_installs_count: 1,
    last_seen_at: NOW,
  });
  assert.equal(db.prepare('SELECT error_message FROM reports').get().error_message, 'Failed to fetch');
});

test('targeted retry handling cannot hide CHECK or foreign key failures', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  assert.throws(() => report(db, issueId, { browser: 'netscape' }, 'ON CONFLICT(id) DO NOTHING'), /CHECK/);
  assert.throws(() => report(db, 999, { id: uuid(2) }, 'ON CONFLICT(id) DO NOTHING'), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
});

test('repeated and distinct installations update lifetime counters exactly once per insert', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  report(db, issueId, { id: uuid(2), version: '3.2.1', created_at: NOW + 1_000 });
  report(db, issueId, { id: uuid(3), install_id: INSTALL_B, version: '3.2.2', created_at: NOW + 2_000 });
  assert.deepEqual(row(db, 'SELECT total_occurrences, affected_installs_count, first_seen_at, last_seen_at, first_seen_version, last_seen_version FROM issues'), {
    total_occurrences: 3,
    affected_installs_count: 2,
    first_seen_at: NOW,
    last_seen_at: NOW + 2_000,
    first_seen_version: '3.2.0',
    last_seen_version: '3.2.2',
  });
  assert.deepEqual(row(db, 'SELECT first_seen_at, last_seen_at FROM issue_installs WHERE install_id = ?', INSTALL_A), {
    first_seen_at: NOW,
    last_seen_at: NOW + 1_000,
  });
});

test('server receipt time controls issue windows even with hostile client occurrence times', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId, { occurred_at: 253_402_300_799_999 });
  report(db, issueId, { id: uuid(2), occurred_at: 0, created_at: NOW + 1_000 });
  assert.deepEqual(row(db, 'SELECT first_seen_at, last_seen_at FROM issues'), {
    first_seen_at: NOW,
    last_seen_at: NOW + 1_000,
  });
});

test('out-of-order receipts preserve the versions at the first and last server receipt', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId, { version: '3.2.2', created_at: NOW + 2_000 });
  report(db, issueId, { id: uuid(2), version: '3.2.0', created_at: NOW });
  report(db, issueId, { id: uuid(3), version: '3.2.1', created_at: NOW + 1_000 });
  assert.deepEqual(row(db, 'SELECT first_seen_at, last_seen_at, first_seen_version, last_seen_version FROM issues'), {
    first_seen_at: NOW,
    last_seen_at: NOW + 2_000,
    first_seen_version: '3.2.0',
    last_seen_version: '3.2.2',
  });
});

test('report details are immutable and report retention preserves lifetime counts and membership', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  assert.throws(() => db.prepare('UPDATE reports SET error_message = ? WHERE id = ?').run('edited', uuid(1)), /immutable/);
  db.prepare('DELETE FROM reports WHERE id = ?').run(uuid(1));
  assert.equal(db.prepare('SELECT count(*) AS count FROM reports').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM issue_installs').get().count, 1);
  assert.deepEqual(row(db, 'SELECT total_occurrences, affected_installs_count FROM issues'), {
    total_occurrences: 1,
    affected_installs_count: 1,
  });
  report(db, issueId, { id: uuid(2) });
  assert.equal(db.prepare('SELECT affected_installs_count FROM issues').get().affected_installs_count, 1);
});

test('durable report receipts prevent retention replays from inflating lifetime counts or spike windows', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  db.prepare('DELETE FROM reports WHERE id = ?').run(uuid(1));
  report(db, issueId, { created_at: NOW + 10_000 });
  assert.equal(db.prepare('SELECT count(*) AS count FROM reports').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM report_receipts').get().count, 1);
  assert.deepEqual(row(db, 'SELECT total_occurrences, affected_installs_count, last_seen_at FROM issues'), {
    total_occurrences: 1, affected_installs_count: 1, last_seen_at: NOW,
  });
  assert.equal(db.prepare('SELECT last_seen_at FROM issue_installs').get().last_seen_at, NOW);
  assert.throws(() => report(db, issueId, { browser: 'netscape' }, 'ON CONFLICT(id) DO NOTHING'), /CHECK/);
  assert.throws(() => db.prepare('UPDATE report_receipts SET created_at = ?').run(NOW + 1), /immutable/);
  assert.throws(() => db.exec('DELETE FROM report_receipts'), /replay|retai|immutable/);
});

test('classification can change while original fingerprint inputs and report snapshots remain independent', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  db.prepare('UPDATE issues SET category = ?, fault_origin = ?, suggested_action = ? WHERE id = ?')
    .run('UPSTREAM_BREAKING_CHANGE', 'upstream_site', 'Review the upstream API.', issueId);
  assert.deepEqual(row(db, 'SELECT error_category, error_code, failure_stage, normalized_top_frame, destination, category FROM issues'), {
    error_category: 'DOWNLOAD_ERROR',
    error_code: 'REQUEST_FAILED',
    failure_stage: 'PRIMARY_API_REQUEST',
    normalized_top_frame: 'scripts/download.js:fetchFile',
    destination: 'browser',
    category: 'UPSTREAM_BREAKING_CHANGE',
  });
  assert.equal(db.prepare('SELECT category FROM reports').get().category, 'NETWORK_UNREACHABLE');
  assert.throws(() => db.prepare('UPDATE issues SET error_code = ? WHERE id = ?').run('OTHER_FAILURE', issueId), /immutable/);
});

test('issue statuses, mute boolean, lifecycle times, and fixed version are constrained', (t) => {
  const db = database(t);
  const issueId = issue(db);
  for (const changes of [
    { status: 'muted' },
    { status: 'resolved' },
    { status: 'fixed' },
    { status: 'regressed' },
    { muted: 2 },
    { first_seen_at: NOW + 1 },
    { last_pushed_at: -1 },
    { total_occurrences: -1 },
    { affected_installs_count: -1 },
    { fault_origin: 'nexus' },
  ]) {
    const keys = Object.keys(changes);
    assert.throws(() => db.prepare(`UPDATE issues SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(changes), issueId), /CHECK/, JSON.stringify(changes));
  }
  db.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '3.2.1', muted = 1 WHERE id = ?").run(issueId);
  db.prepare("UPDATE issues SET status = 'regressed' WHERE id = ?").run(issueId);
  assert.deepEqual(row(db, 'SELECT status, muted, fixed_in_version FROM issues'), {
    status: 'regressed', muted: 1, fixed_in_version: '3.2.1',
  });
});

test('SHA-256 keys reject uppercase, non-hex, incorrect lengths, and embedded NULs', (t) => {
  const db = database(t);
  for (const fingerprint of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\0x']) {
    assert.throws(() => issue(db, { fingerprint }), /CHECK/);
  }
  const issueId = issue(db);
  for (const install_id of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), 'b'.repeat(64) + '\0']) {
    assert.throws(() => report(db, issueId, { install_id }), /CHECK/);
    assert.throws(() => heartbeat(db, { install_id }), /CHECK/);
  }
});

test('report identities, dimensions, strings, counters, JSON shapes, and UTC millisecond times are constrained', (t) => {
  const db = database(t);
  const issueId = issue(db);
  for (const changes of [
    { id: 'report-1' },
    { id: '12345678-1234-1234-8234-000000000001' },
    { id: '12345678-1234-4234-7234-000000000001' },
    { version: '1.2.3+' + 'x'.repeat(59) },
    { install_id: 'raw-installation-id' },
    { browser: 'netscape' },
    { browser_version: 'x'.repeat(41) },
    { os: 'bsd' },
    { os_version: 'x'.repeat(41) },
    { mod_id: '123abc' },
    { mod_id: '1'.repeat(17) },
    { collection_id: 'x'.repeat(65) },
    { download_mode: 'automatic' },
    { destination: 'steam' },
    { severity: 'critical' },
    { error_category: 'x'.repeat(81) },
    { error_code: 'x'.repeat(81) },
    { failure_stage: 'x'.repeat(81) },
    { error_name: 'x'.repeat(121) },
    { error_message: 'x'.repeat(2_049) },
    { stack_trace: 'x'.repeat(12_001) },
    { breadcrumbs_json: '{}' },
    { breadcrumbs_json: '[' },
    { dom_state_json: '[]' },
    { context_json: '[]' },
    { context_json: 'null' },
    { http_status: 99 },
    { http_status: 600 },
    { retry_after: 'x'.repeat(129) },
    { occurred_at: '2026-10-21T00:00:00.000Z' },
    { occurred_at: -1 },
    { created_at: 253_402_300_800_000 },
    { created_at: NOW + 0.5 },
    { fault_origin: 'bad' },
  ]) {
    assert.throws(() => report(db, issueId, changes), undefined, JSON.stringify(changes));
  }
  assert.equal(db.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 0);
  report(db, issueId, { mod_id: null, collection_id: null, stack_trace: null, dom_state_json: null, http_status: 599 });
  assert.equal(db.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
});

test('valid optional OS data and larger bounded breadcrumb payloads can be persisted', (t) => {
  const db = database(t);
  const issueId = issue(db);
  const breadcrumbs_json = JSON.stringify(Array.from({ length: 60 }, () => ({
    timestamp_offset_ms: 0,
    stage: 'PRIMARY_API_REQUEST',
    action: 'fetch',
    status: 'error',
    metadata: { note: 'x'.repeat(600) },
  })));
  assert.ok(new TextEncoder().encode(breadcrumbs_json).byteLength > 32_768);
  report(db, issueId, { os_version: null, breadcrumbs_json });
  assert.deepEqual(row(db, 'SELECT os_version, breadcrumbs_json FROM reports'), {
    os_version: null, breadcrumbs_json,
  });
});

test('heartbeat immutable deltas roll up once per request and installation pair', (t) => {
  const db = database(t);
  heartbeat(db);
  const replay = heartbeat(db, { attempts_count: 999 }, 'ON CONFLICT(heartbeat_id, install_id) DO NOTHING');
  assert.equal(replay.changes, 0);
  heartbeat(db, { heartbeat_id: uuid(2), attempts_count: 5, success_count: 4, fallback_triggered_count: 3, created_at: NOW + 1_000 });
  heartbeat(db, { install_id: INSTALL_B, attempts_count: 1, success_count: 1, fallback_triggered_count: 1 });
  assert.deepEqual(row(db, 'SELECT attempts_count, success_count, fallback_triggered_count, heartbeat_count, created_at, updated_at FROM release_metrics'), {
    attempts_count: 16,
    success_count: 14,
    fallback_triggered_count: 6,
    heartbeat_count: 3,
    created_at: NOW,
    updated_at: NOW + 1_000,
  });
  assert.throws(() => db.prepare('UPDATE heartbeat_receipts SET attempts_count = 100 WHERE heartbeat_id = ?').run(uuid(1)), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM heartbeat_receipts WHERE heartbeat_id = ?').run(uuid(1)), /replay|retai|immutable/);
});

test('release health remains separated by version, date, browser, and destination', (t) => {
  const db = database(t);
  heartbeat(db);
  heartbeat(db, { heartbeat_id: uuid(2), version: '3.2.1' });
  heartbeat(db, { heartbeat_id: uuid(3), metric_date: '2026-10-22' });
  heartbeat(db, { heartbeat_id: uuid(4), browser: 'firefox' });
  heartbeat(db, { heartbeat_id: uuid(5), destination: 'vortex' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM release_metrics').get().count, 5);
  assert.equal(db.prepare('SELECT sum(attempts_count) AS attempts FROM release_metrics').get().attempts, 50);
});

test('heartbeat receipt checks reject impossible dates, invalid identities, and inconsistent deltas', (t) => {
  const db = database(t);
  for (const changes of [
    { heartbeat_id: 'bad' },
    { metric_date: '2026-02-30' },
    { metric_date: '2025-02-29' },
    { metric_date: '2026-2-01' },
    { metric_date: '2026-10-21T00:00:00Z' },
    { attempts_count: -1 },
    { attempts_count: 1_000_001 },
    { success_count: 11 },
    { fallback_triggered_count: 11 },
    { success_count: 1.5 },
    { browser: 'netscape' },
    { destination: 'steam' },
    { created_at: -1 },
  ]) {
    assert.throws(() => heartbeat(db, changes), undefined, JSON.stringify(changes));
  }
  heartbeat(db, { attempts_count: 1, success_count: 1, fallback_triggered_count: 1, metric_date: '2028-02-29' });
  assert.equal(db.prepare('SELECT attempts_count FROM release_metrics').get().attempts_count, 1);
});

test('targeted heartbeat retry handling still rejects inconsistent duplicate deltas', (t) => {
  const db = database(t);
  heartbeat(db);
  assert.throws(() => heartbeat(db, { attempts_count: -1 }, 'ON CONFLICT(heartbeat_id, install_id) DO NOTHING'), /CHECK/);
  assert.equal(db.prepare('SELECT attempts_count FROM release_metrics').get().attempts_count, 10);
});

test('release totals enforce nonnegative safe integer values and per-attempt relationships', (t) => {
  const db = database(t);
  heartbeat(db);
  for (const changes of [
    { attempts_count: -1 },
    { attempts_count: 9_007_199_254_740_992 },
    { success_count: 11 },
    { fallback_triggered_count: 11 },
    { heartbeat_count: -1 },
    { updated_at: NOW - 1 },
  ]) {
    const keys = Object.keys(changes);
    assert.throws(() => db.prepare(`UPDATE release_metrics SET ${keys.map((key) => `${key} = ?`).join(', ')}`)
      .run(...Object.values(changes)), /CHECK/, JSON.stringify(changes));
  }
});

test('deleting an issue cascades reports, lifetime installations, and notification claims', (t) => {
  const db = database(t);
  const issueId = issue(db);
  report(db, issueId);
  insert(db, 'notification_claims', { issue_id: issueId, event_type: 'NEW_CRITICAL', dedupe_key: 'initial', created_at: NOW });
  db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
  for (const table of ['reports', 'report_receipts', 'issue_installs', 'notification_claims']) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('push subscriptions validate HTTPS endpoints, key material, uniqueness, and lifecycle times', (t) => {
  const db = database(t);
  const valid = {
    endpoint: 'https://push.example.test/subscription',
    p256dh: 'B' + 'a'.repeat(86),
    auth: 'a'.repeat(22),
    user_agent: 'iPhone PWA',
    created_at: NOW,
    updated_at: NOW,
    expiration_time: null,
  };
  for (const changes of [
    { endpoint: 'http://push.example.test/subscription' },
    { p256dh: 'not-a-public-key' },
    { auth: 'bad' },
    { user_agent: 'a'.repeat(513) },
    { updated_at: NOW - 1 },
    { expiration_time: -1 },
  ]) {
    assert.throws(() => insert(db, 'push_subscriptions', { ...valid, ...changes }), undefined, JSON.stringify(changes));
  }
  insert(db, 'push_subscriptions', valid);
  assert.throws(() => insert(db, 'push_subscriptions', valid), /UNIQUE/);
});

test('rate limit buckets store only scoped hashes and bound their windows and counters', (t) => {
  const db = database(t);
  const valid = {
    scope: 'ip', key_hash: INSTALL_C, window_started_at: NOW,
    window_duration_ms: 60_000, request_count: 1, expires_at: NOW + 60_000,
  };
  for (const changes of [
    { key_hash: '192.0.2.12' },
    { scope: 'user' },
    { window_duration_ms: 0 },
    { request_count: -1 },
    { expires_at: NOW },
  ]) {
    assert.throws(() => insert(db, 'rate_limit_buckets', { ...valid, ...changes }), undefined, JSON.stringify(changes));
  }
  insert(db, 'rate_limit_buckets', valid);
  assert.throws(() => insert(db, 'rate_limit_buckets', valid), /UNIQUE/);
  insert(db, 'rate_limit_buckets', { ...valid, scope: 'install' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM rate_limit_buckets').get().count, 2);
});

test('notification event claims deduplicate per issue and event and constrain leases', (t) => {
  const db = database(t);
  const issueId = issue(db);
  const valid = { issue_id: issueId, event_type: 'NEW_CRITICAL', dedupe_key: 'initial', created_at: NOW };
  insert(db, 'notification_claims', valid);
  assert.throws(() => insert(db, 'notification_claims', valid), /UNIQUE/);
  assert.equal(insert(db, 'notification_claims', valid, 'ON CONFLICT(issue_id, event_type, dedupe_key) DO NOTHING').changes, 0);
  insert(db, 'notification_claims', { ...valid, event_type: 'REGRESSION' });
  for (const changes of [
    { dedupe_key: 'invalid-event', event_type: 'arbitrary' },
    { dedupe_key: 'lease-no-expiry', lease_token: 'worker-1' },
    { dedupe_key: 'expiry-no-token', lease_expires_at: NOW + 60_000 },
    { dedupe_key: 'old-expiry', lease_token: 'worker-1', lease_expires_at: NOW - 1 },
    { dedupe_key: 'old-delivery', delivered_at: NOW - 1 },
  ]) {
    assert.throws(() => insert(db, 'notification_claims', { ...valid, ...changes }), /CHECK/, JSON.stringify(changes));
  }
});

test('spike, category-window, filter, issue-list, and release queries use supporting indexes', (t) => {
  const db = database(t);
  const queries = [
    ['SELECT install_id FROM reports WHERE issue_id = ? AND created_at >= ?', [1, NOW]],
    ['SELECT install_id FROM reports WHERE category = ? AND created_at >= ?', ['DOM_SELECTOR_MISSING', NOW]],
    ...['version', 'browser', 'os', 'destination', 'download_mode'].map((column) => [
      `SELECT issue_id FROM reports WHERE ${column} = ? ORDER BY created_at DESC`, ['test'],
    ]),
    ['SELECT id FROM issues WHERE status = ? ORDER BY last_seen_at DESC', ['new']],
    ['SELECT id FROM issues WHERE fault_origin = ? ORDER BY last_seen_at DESC', ['client_env']],
    ['SELECT id FROM issues WHERE category = ? ORDER BY last_seen_at DESC', ['NETWORK_UNREACHABLE']],
    ['SELECT attempts_count FROM release_metrics WHERE version = ? AND metric_date >= ?', ['3.2.0', '2026-10-01']],
  ];
  for (const [sql, bindings] of queries) {
    const plans = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
    assert.ok(plans.some((plan) => /USING (?:COVERING )?INDEX/.test(plan.detail)), `${sql}: ${JSON.stringify(plans)}`);
  }
});
