import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import { ENVIRONMENT_CATEGORIES, classifyReport } from '../src/services/ruleEngine.ts';
import { testDatabase } from './helpers/d1.mjs';

// migrations/0003_environment_issues.sql names, for issues already stored, what the rule engine now names
// in a new report, and reopens as new the ones the Worker had marked fixed that no release can fix.
const MIGRATION = readFileSync(new URL('../migrations/0003_environment_issues.sql', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 24 * 60 * 60 * 1000;
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;
const network = 'Έλεγχος διαδρομής/σύνδεσης ή DNS/Firewall χρήστη· η αιτία παραμένει άγνωστη χωρίς επιπλέον στοιχεία δικτύου.';

// The newest report of production issues on 13 November 2026, with the rule output stored then.
const PRODUCTION = [
  [2, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['timeout', 'timeout', 'timeout'], 'signal is aborted without reason | request timed out after 30995ms: POST Nexus request; no readable HTTP response; not known to be offline; page hidden'],
  [4, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['no_nmm_link', 'no_nmm_link', 'no_nmm_link'], 'steps: page HTTP 200: HTML page; file-safety notice; no link in it'],
  [5, 'regressed', '4.0.0', 'UNKNOWN_ERROR', 'unknown', ['no_download_url', 'no_download_url', 'no_download_url'], 'steps: generator HTTP 200: empty JSON list; no link in it | page HTTP 200: HTML page; file-safety notice; no link in it'],
  [6, 'fixed', '3.3.6', 'SECURITY_BLOCK', 'client_env', ['queue_item_failed', 'FILE_VIRUS_INFECTED', 'queue_item_failed'], 'FILE_VIRUS_INFECTED [blocked] | file [id] | game [id] | selection'],
  [7, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'no_download_url', 'queue_item_failed'], 'no_download_url | generator HTTP 200: JSON {url}; a usable link was in it (Nexus page) | page HTTP 200: HTML page; a usable link was in it (download route)'],
  [10, 'regressed', '4.0.2', 'DOM_SELECTOR_MISSING', 'client_env', ['DOM_SELECTOR_MISSING', 'nexus_page_changed', 'DOM_SELECTOR_MISSING'], 'missing: mount point for download panel (no supported content root after mount retries)'],
  [12, 'regressed', '3.3.6', 'NETWORK_UNREACHABLE', 'client_env', ['network_error', 'network_error', 'network_error'], 'Failed to fetch | fetch failed after 4338ms: GET Nexus download page; no readable HTTP response; not known to be offline | steps: page network_error'],
  [13, 'regressed', '3.3.6', 'UNKNOWN_ERROR', 'unknown', ['background_error', 'background_error', 'background_error'], 'unknown-settings-key:[redacted]'],
  [14, 'regressed', '4.1.0', 'NETWORK_UNREACHABLE', 'client_env', ['network_error', 'network_error', 'network_error'], 'NetworkError when attempting to fetch resource. | fetch failed after 38ms: POST Nexus request; no readable HTTP response; not known to be offline'],
  [15, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['timeout', 'timeout', 'timeout'], 'signal is aborted without reason | request timed out after 15016ms: GET Nexus download page; no readable HTTP response; not known to be offline | steps: page timeout'],
  [20, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'CRASH', 'queue_item_failed'], 'CRASH [transient] | file [id] | game [id] | all'],
  [21, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'NETWORK_FAILED', 'queue_item_failed'], 'NETWORK_FAILED [transient] | file [id] | game [id] | all'],
  [22, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['server_error', 'server_error', 'server_error'], 'HTTP 525 | resp HTTP 525, 363877B, no nxm-link, final=[link] | steps: page server_error HTTP 525', 525],
  [23, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'page_request_failed', 'queue_item_failed'], 'page_request_failed | HTTP 500 | file [id] | game [id] | all'],
  [26, 'new', null, 'NETWORK_UNREACHABLE', 'client_env', ['network_error', 'network_error', 'network_error'], 'The operation was aborted.  | reading response: GET Nexus download page; HTTP 200; not known to be offline | steps: page network_error HTTP 200', 200],
  // Earlier rows matter only for which one is newest.
  [30, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'request_failed', 'queue_item_failed'], 'request_failed | HTTP 404 | file [id] | game [id] | all', null, 'request_failed | HTTP 503 | file [id] | game [id] | all'],
  [31, 'new', null, 'UNKNOWN_ERROR', 'unknown', ['queue_item_failed', 'request_failed', 'queue_item_failed'], 'request_failed | HTTP 502 | file [id] | game [id] | all', null, 'request_failed | HTTP 404 | file [id] | game [id] | all'],
];

function insert(db, table, values) {
  const keys = Object.keys(values);
  return db.sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(values));
}
let reportNumber = 0;
function storedReport(db, id, [error_category, error_code, failure_stage], error_message, http_status, category, fault_origin, createdAt) {
  reportNumber += 1;
  insert(db, 'reports', {
    id: uuid(reportNumber), issue_id: id, install_id: '0'.repeat(64), version: '4.1.1', browser: 'chrome', browser_version: '150', os: 'windows',
    download_mode: 'manual', destination: 'browser', severity: 'error', error_category, error_code, failure_stage,
    error_name: 'ExtensionError', error_message, http_status, category, fault_origin, suggested_action: 'As stored.',
    occurred_at: createdAt, created_at: createdAt
  });
}
function load(db) {
  for (const [id, status, fixed_in_version, category, fault_origin, codes, message, http_status = null, earlier] of PRODUCTION) {
    insert(db, 'issues', {
      id, fingerprint: createHash('sha256').update(String(id)).digest('hex'), error_category: codes[0], error_code: codes[1], failure_stage: codes[2],
      normalized_top_frame: '<unknown>', destination: 'browser', category, fault_origin, suggested_action: 'As stored.', status, fixed_in_version,
      first_seen_at: NOW - 9 * DAY, last_seen_at: NOW - DAY, first_seen_version: '3.3.2', last_seen_version: '4.1.1', created_at: NOW - 9 * DAY, updated_at: NOW - 9 * DAY
    });
    if (earlier) storedReport(db, id, codes, earlier, null, category, fault_origin, NOW - 3 * DAY);
    storedReport(db, id, codes, message, http_status, category, fault_origin, NOW - 2 * DAY);
  }
}
const issues = (db) => Object.fromEntries(db.sqlite.prepare('SELECT id, category, fault_origin, suggested_action, status, fixed_in_version FROM issues ORDER BY id')
  .all().map(({ id, ...row }) => [id, { ...row }]));
// What the rule engine says of the issue's newest report.
function engine(db, id) {
  const row = db.sqlite.prepare(`SELECT * FROM reports WHERE issue_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(id);
  const { category, fault_origin, suggested_action } = classifyReport(errorReportSchema.parse({
    schema_version: 1, consent: 'diagnostics-v1', report_id: row.id, install_id: 'a'.repeat(64), occurred_at: new Date(row.occurred_at).toISOString(),
    version: row.version, browser: row.browser, browser_version: row.browser_version, os: row.os, download_mode: row.download_mode,
    destination: row.destination, severity: row.severity, error_category: row.error_category, error_code: row.error_code,
    failure_stage: row.failure_stage, error_name: row.error_name, error_message: row.error_message,
    ...(row.http_status === null ? {} : { http_status: row.http_status })
  }));
  return { category, fault_origin, suggested_action };
}

test('stored issues take the category the engine now gives their newest report', (t) => {
  const db = testDatabase(t);
  load(db);
  const before = issues(db);
  db.sqlite.exec(MIGRATION);
  const after = issues(db);

  for (const [id] of PRODUCTION) {
    const { category, fault_origin, suggested_action } = after[id];
    assert.deepEqual({ category, fault_origin, suggested_action: category === before[id].category ? engine(db, id).suggested_action : suggested_action },
      engine(db, id), `issue ${id} agrees with the engine`);
  }
  const named = Object.fromEntries(Object.entries(after).filter(([id, row]) => row.category !== before[id].category).map(([id, row]) => [id, row.category]));
  assert.deepEqual(named, {
    2: 'NETWORK_TIMEOUT', 15: 'NETWORK_TIMEOUT', 21: 'NETWORK_UNREACHABLE',
    22: 'UPSTREAM_SERVER_ERROR', 23: 'UPSTREAM_SERVER_ERROR', 31: 'UPSTREAM_SERVER_ERROR'
  }, 'its newest report decides: #30 is a 404 now, #31 a 502');
  assert.equal(after[21].suggested_action, network);
});

test('issues no release can fix are open again instead of regressed; the rest are left as they were', (t) => {
  const db = testDatabase(t);
  load(db);
  const before = issues(db);
  db.sqlite.exec(MIGRATION);
  const after = issues(db);
  for (const id of [12, 14]) {
    assert.deepEqual({ status: after[id].status, fixed_in_version: after[id].fixed_in_version }, { status: 'new', fixed_in_version: null }, `issue ${id}`);
    assert.ok(db.sqlite.prepare('SELECT updated_at FROM issues WHERE id=?').get(id).updated_at > NOW - 9 * DAY, 'a change is a change');
  }
  for (const id of [5, 10, 13]) assert.equal(after[id].status, 'regressed', `issue ${id} is a bug a release can fix`);
  assert.deepEqual({ status: after[6].status, fixed_in_version: after[6].fixed_in_version }, { status: 'fixed', fixed_in_version: '3.3.6' }, 'a fixed one stays fixed');

  // Applied again (or with schema.sql), nothing more changes.
  db.sqlite.exec(MIGRATION);
  assert.deepEqual(issues(db), after);
  assert.notDeepEqual(before, after);
});

test('the categories it reopens are the ones auto-fix leaves alone', () => {
  const list = MIGRATION.slice(MIGRATION.lastIndexOf('category IN ('));
  const named = [...list.slice(0, list.indexOf(')')).matchAll(/'([A-Z_]+)'/g)].map(([, category]) => category);
  assert.deepEqual(named, [...ENVIRONMENT_CATEGORIES]);
});
