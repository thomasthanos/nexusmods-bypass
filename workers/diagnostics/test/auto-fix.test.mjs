import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { AUTO_FIX_MIN_EVIDENCE, AUTO_FIX_SETTLE_MS, autoFixIssues } from '../src/services/auto-fix.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { testDatabase } from './helpers/d1.mjs';
import { ORIGIN, workerFixture } from './helpers/worker.mjs';

// Issues are marked fixed once the browsers they happened on run a newer version that never reports them,
// so copies that have not updated (a Firefox add-on can take days) no longer keep a fixed issue looking new.
const NOW = Date.UTC(2026, 10, 2, 12);
const DAY = 24 * 60 * 60 * 1000;
let reportNumber = 0;
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;

function insert(db, table, values) {
  const keys = Object.keys(values);
  return db.sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(values));
}
function issue(db, code, overrides = {}) {
  return Number(insert(db, 'issues', {
    fingerprint: createHash('sha256').update(code).digest('hex'), error_category: code, error_code: code, failure_stage: code,
    normalized_top_frame: '<unknown>', destination: 'browser', category: 'UNKNOWN_ERROR', fault_origin: 'unknown',
    suggested_action: 'Inspect the report.', first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.3.2',
    last_seen_version: '3.3.2', created_at: NOW - 10 * DAY, updated_at: NOW - 10 * DAY, ...overrides
  }).lastInsertRowid);
}
// Reports arrive in order of created_at, like ingestion's, so the issue's own counters stay consistent.
function report(db, issueId, version, browser, createdAt, count = 1) {
  for (let i = 0; i < count; i += 1) {
    reportNumber += 1;
    insert(db, 'reports', {
      id: uuid(reportNumber), issue_id: issueId, install_id: '0'.repeat(64), version, browser, browser_version: '150', os: 'other',
      download_mode: 'manual', destination: 'browser', severity: 'error', error_category: 'X', error_code: 'X', failure_stage: 'X',
      error_name: 'ExtensionError', error_message: 'Reported', category: 'UNKNOWN_ERROR', fault_origin: 'unknown',
      suggested_action: 'Inspect the report.', occurred_at: createdAt, created_at: createdAt + i
    });
  }
}
const state = (db, id) => ({ ...db.sqlite.prepare('SELECT status, fixed_in_version FROM issues WHERE id=?').get(id) });
const record = (db, id) => {
  const row = db.sqlite.prepare('SELECT fixed_in_version, previous_status, previous_fixed_in_version, browsers_json FROM issue_auto_fixes WHERE issue_id=?').get(id);
  return row ? { ...row } : null;
};

test('an issue newer copies never reported is marked fixed in the first newer version, once its browsers have run it for two days', async (t) => {
  const db = testDatabase(t);
  const crash = issue(db, 'request_failed');
  report(db, crash, '3.3.2', 'firefox', NOW - 9 * DAY, 2);
  // Something else, reported from the newer version: evidence that Firefox runs it.
  const other = issue(db, 'timeout');
  report(db, other, '3.3.6', 'firefox', NOW, AUTO_FIX_MIN_EVIDENCE);

  assert.deepEqual(await autoFixIssues(db, NOW + AUTO_FIX_SETTLE_MS - 1), { fixed: [], reopened: [] }, 'not before the newer version has run for two days');
  assert.deepEqual(state(db, crash), { status: 'new', fixed_in_version: null });

  const result = await autoFixIssues(db, NOW + AUTO_FIX_SETTLE_MS);
  assert.deepEqual(result, { fixed: [{ id: crash, fixed_in_version: '3.3.6' }], reopened: [] });
  assert.deepEqual(state(db, crash), { status: 'fixed', fixed_in_version: '3.3.6' });
  assert.deepEqual(record(db, crash), { fixed_in_version: '3.3.6', previous_status: 'new', previous_fixed_in_version: null, browsers_json: '["firefox"]' });
  assert.deepEqual(state(db, other), { status: 'new', fixed_in_version: null }, 'the newest version still reports the other one');
  assert.deepEqual(await autoFixIssues(db, NOW + AUTO_FIX_SETTLE_MS + DAY), { fixed: [], reopened: [] }, 'nothing is done twice');
});

test('every browser it happened on needs enough newer evidence of its own', async (t) => {
  const db = testDatabase(t);
  const issueId = issue(db, 'no_download_url');
  report(db, issueId, '3.3.2', 'chrome', NOW - 9 * DAY);
  report(db, issueId, '3.3.3', 'edge', NOW - 8 * DAY);
  const other = issue(db, 'timeout');
  report(db, other, '4.0.0', 'chrome', NOW - 5 * DAY, 5);
  assert.deepEqual((await autoFixIssues(db, NOW)).fixed, [], 'Edge has run nothing newer');

  report(db, other, '3.3.6', 'edge', NOW - 3 * DAY, AUTO_FIX_MIN_EVIDENCE - 1);
  assert.deepEqual((await autoFixIssues(db, NOW)).fixed, [], 'too little from Edge');
  report(db, other, '3.3.7', 'edge', NOW - 3 * DAY + 10);
  assert.deepEqual((await autoFixIssues(db, NOW)).fixed, [{ id: issueId, fixed_in_version: '3.3.6' }],
    'fixed in the earliest newer version either browser ran');
  assert.deepEqual(JSON.parse(record(db, issueId).browsers_json), ['chrome', 'edge']);
});

test('heartbeats are evidence, and an issue without reports or with a version it cannot read is left alone', async (t) => {
  const db = testDatabase(t);
  const issueId = issue(db, 'background_error');
  report(db, issueId, '3.3.6', 'firefox', NOW - 9 * DAY);
  for (let n = 0; n < AUTO_FIX_MIN_EVIDENCE; n += 1) {
    insert(db, 'heartbeat_receipts', { heartbeat_id: uuid(9000 + n), install_id: 'b'.repeat(64), metric_date: '2026-10-29', version: '4.0.0',
      browser: 'firefox', destination: 'browser', attempts_count: 1, success_count: 1, fallback_triggered_count: 0, created_at: NOW - 3 * DAY + n });
  }
  const unreported = issue(db, 'no_reports');
  assert.deepEqual((await autoFixIssues(db, NOW)).fixed, [{ id: issueId, fixed_in_version: '4.0.0' }]);
  assert.deepEqual(state(db, unreported), { status: 'new', fixed_in_version: null }, 'no reports: no browsers to watch');
});

test('a report from the version it named puts the issue back as it was; newer ones regress it as for any fix', async (t) => {
  const db = testDatabase(t);
  const crash = issue(db, 'request_failed');
  report(db, crash, '3.3.2', 'firefox', NOW - 9 * DAY);
  const regressed = issue(db, 'nexus_page_changed', { status: 'regressed', fixed_in_version: '3.0.0' });
  report(db, regressed, '3.3.2', 'firefox', NOW - 9 * DAY + 1);
  const other = issue(db, 'timeout');
  report(db, other, '3.3.6', 'firefox', NOW - 5 * DAY, AUTO_FIX_MIN_EVIDENCE);
  assert.equal((await autoFixIssues(db, NOW)).fixed.length, 2);
  assert.deepEqual(record(db, regressed).previous_status, 'regressed');

  // The version it named still has it: back to new, and to regressed with its own baseline.
  report(db, crash, '3.3.6', 'firefox', NOW + 1);
  report(db, regressed, '3.3.6', 'firefox', NOW + 2);
  const result = await autoFixIssues(db, NOW + 3);
  assert.deepEqual(result.reopened.sort(), [crash, regressed].sort());
  assert.deepEqual(state(db, crash), { status: 'new', fixed_in_version: null });
  assert.deepEqual(state(db, regressed), { status: 'regressed', fixed_in_version: '3.0.0' });
  assert.equal(record(db, crash), null);
  assert.deepEqual(result.fixed, [], 'and it is not fixed again while nothing newer has run without it');

  // 4.0.0 reaches Firefox and runs two days without it: fixed again, in 4.0.0.
  report(db, other, '4.0.0', 'firefox', NOW + 4, AUTO_FIX_MIN_EVIDENCE);
  assert.deepEqual((await autoFixIssues(db, NOW + DAY)).fixed, []);
  assert.deepEqual((await autoFixIssues(db, NOW + 4 + AUTO_FIX_SETTLE_MS)).fixed.map(({ fixed_in_version }) => fixed_in_version), ['4.0.0', '4.0.0']);
  // An old copy still reporting it changes nothing; that is what this is for.
  report(db, crash, '3.3.2', 'firefox', NOW + 3 * DAY);
  assert.deepEqual(await autoFixIssues(db, NOW + 3 * DAY + 1), { fixed: [], reopened: [] });
  assert.equal(state(db, crash).status, 'fixed');
});

test('a change by hand, a regression and ignored issues are never touched', async (t) => {
  const db = testDatabase(t);
  const byHand = issue(db, 'by_hand');
  const regressedLater = issue(db, 'regressed_later');
  const ignored = issue(db, 'ignored', { status: 'ignored' });
  for (const id of [byHand, regressedLater, ignored]) report(db, id, '3.3.2', 'chrome', NOW - 9 * DAY + id);
  const other = issue(db, 'timeout');
  report(db, other, '4.0.0', 'chrome', NOW - 5 * DAY, AUTO_FIX_MIN_EVIDENCE);
  assert.deepEqual((await autoFixIssues(db, NOW)).fixed.map(({ id }) => id).sort(), [byHand, regressedLater].sort());
  assert.equal(state(db, ignored).status, 'ignored');

  db.sqlite.prepare("UPDATE issues SET fixed_in_version='3.3.4' WHERE id=?").run(byHand);
  // As ingestion regresses it: a report from a version after the one it was fixed in.
  report(db, regressedLater, '4.0.1', 'chrome', NOW + 1);
  db.sqlite.prepare("UPDATE issues SET status='regressed' WHERE id=?").run(regressedLater);
  report(db, byHand, '4.0.0', 'chrome', NOW + 1);
  assert.deepEqual(await autoFixIssues(db, NOW + 2), { fixed: [], reopened: [] });
  assert.deepEqual(state(db, byHand), { status: 'fixed', fixed_in_version: '3.3.4' }, 'a fix someone set stays as they set it');
  assert.equal(state(db, regressedLater).status, 'regressed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_auto_fixes').get().n, 0, 'records that no longer apply are dropped');
});

test('the dashboard shows an automatic fix until someone changes the issue', async (t) => {
  const access = await createAccessFixture(t);
  const { db, request } = workerFixture(t);
  const crash = issue(db, 'request_failed');
  report(db, crash, '3.3.2', 'firefox', NOW - 9 * DAY);
  report(db, issue(db, 'timeout'), '3.3.6', 'firefox', NOW - 5 * DAY, AUTO_FIX_MIN_EVIDENCE);
  await autoFixIssues(db, NOW);
  const detail = await (await request(`/api/admin/issues/${crash}`, { headers: await access.headers() })).json();
  assert.deepEqual(detail.issue.auto_fix, { fixed_in_version: '3.3.6', fixed_at: NOW, browsers: ['firefox'] });

  const patched = await request(`/api/admin/issues/${crash}`, { method: 'PATCH',
    headers: { ...await access.headers({ 'content-type': 'application/json' }), origin: ORIGIN }, body: JSON.stringify({ fixed_in_version: '3.3.4' }) });
  assert.equal(patched.status, 200);
  const after = await (await request(`/api/admin/issues/${crash}`, { headers: await access.headers() })).json();
  assert.equal(after.issue.auto_fix, null, 'a fix set by hand is not shown as automatic');
});

test('the cron runs it at the first quarter of each hour', async (t) => {
  const db = testDatabase(t);
  const crash = issue(db, 'request_failed');
  report(db, crash, '3.3.2', 'firefox', Date.now() - 9 * DAY);
  report(db, issue(db, 'timeout'), '3.3.6', 'firefox', Date.now() - 5 * DAY, AUTO_FIX_MIN_EVIDENCE);
  // The Store check that shares the cron cannot reach anything here.
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  const run = async (minute) => {
    const pending = [];
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.UTC(2026, 10, 2, 12, minute) }, bindings(db), { waitUntil(promise) { pending.push(promise); } });
    await Promise.allSettled(pending);
  };
  await run(30);
  assert.equal(state(db, crash).status, 'new', 'not at half past');
  await run(0);
  assert.deepEqual(state(db, crash), { status: 'fixed', fixed_in_version: '3.3.6' });
});

test('an issue no release can fix is never marked fixed, so the next outage cannot regress it', async (t) => {
  const db = testDatabase(t);
  // Issues #12, #14 and #16 went fixed -> regressed this way: quiet after the network recovered, then the
  // next Nexus outage came from a newer version.
  const categories = ['NETWORK_UNREACHABLE', 'NETWORK_TIMEOUT', 'UPSTREAM_SERVER_ERROR', 'API_RATE_LIMIT', 'SECURITY_BLOCK', 'EXTENSION_CONFLICT', 'HANDOFF_FAILURE'];
  const environment = categories.map((category) => {
    const id = issue(db, `environment-${category}`, { category, fault_origin: 'client_env' });
    report(db, id, '3.3.2', 'chrome', NOW - 9 * DAY);
    return id;
  });
  const bug = issue(db, 'no_download_url');
  report(db, bug, '3.3.2', 'chrome', NOW - 9 * DAY);
  const regressedOutage = issue(db, 'server_error', { category: 'UPSTREAM_SERVER_ERROR', fault_origin: 'upstream_site', status: 'regressed', fixed_in_version: '3.3.1' });
  report(db, regressedOutage, '3.3.2', 'chrome', NOW - 9 * DAY);
  const other = issue(db, 'timeout');
  report(db, other, '3.3.6', 'chrome', NOW - 3 * DAY, AUTO_FIX_MIN_EVIDENCE);

  const result = await autoFixIssues(db, NOW);
  assert.deepEqual(result, { fixed: [{ id: bug, fixed_in_version: '3.3.6' }], reopened: [] }, 'the bug alone');
  for (const id of environment) assert.deepEqual(state(db, id), { status: 'new', fixed_in_version: null });
  assert.deepEqual(state(db, regressedOutage), { status: 'regressed', fixed_in_version: '3.3.1' }, 'a person decides');
  for (const id of [...environment, regressedOutage]) assert.equal(record(db, id), null);
});
