import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReportSchema, heartbeatSchema } from '../src/schemas/ingest.ts';
import { testDatabase } from './helpers/d1.mjs';

const NOW = 1_792_604_800_000;
const uuid = (number) => `12345678-1234-4234-8234-${number.toString(16).padStart(12, '0')}`;
const install = (number) => number.toString(16).padStart(64, '0');
let service;
try {
  service = await import('../src/services/ingestion.ts');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  service = {};
}
const { acceptErrorReport, acceptHeartbeat, IngestionConflict } = service;

function report(overrides = {}) {
  return errorReportSchema.parse({
    schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(1), install_id: install(1),
    occurred_at: new Date(NOW).toISOString(), version: '3.2.0', browser: 'chrome', browser_version: '142.0',
    os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error',
    error_category: 'DOWNLOAD_ERROR', error_code: 'REQUEST_FAILED', failure_stage: 'PRIMARY_API_REQUEST',
    error_message: 'Something unexpected happened', ...overrides,
  });
}

function heartbeat(overrides = {}) {
  return heartbeatSchema.parse({
    schema_version: 1, consent: 'telemetry-v1', heartbeat_id: uuid(1), install_id: install(1),
    metric_date: '2026-10-21', version: '3.2.0', browser: 'chrome', destination: 'browser',
    attempts_count: 10, success_count: 8, fallback_triggered_count: 3, ...overrides,
  });
}

test('persists one report and counts its anonymous installation exactly once', async (t) => {
  assert.equal(typeof acceptErrorReport, 'function', 'report ingestion service must exist');
  const db = testDatabase(t);
  const result = await acceptErrorReport(db, report(), NOW);
  assert.equal(result.accepted, true);
  assert.equal(result.isNewIssue, true);
  assert.equal(result.reportId, uuid(1));
  assert.equal(result.rule.category, 'UNKNOWN_ERROR');
  assert.equal(result.regressionEventId, undefined);
  const issue = db.sqlite.prepare('SELECT * FROM issues').get();
  assert.equal(result.issueId, issue.id);
  assert.equal(issue.total_occurrences, 1);
  assert.equal(issue.affected_installs_count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_receipts').get().n, 1);
});

test('serializes concurrent first reports and replays without duplicate counts or new issue events', async (t) => {
  const db = testDatabase(t);
  const input = report();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => acceptErrorReport(db, input, NOW + index)));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => result.isNewIssue).length, 1);
  const second = await acceptErrorReport(db, report({ report_id: uuid(2), install_id: install(2), version: '3.2.1' }), NOW + 20);
  assert.equal(second.isNewIssue, false);
  const before = db.sqlite.prepare('SELECT * FROM issues').get();
  await acceptErrorReport(db, input, NOW + 30);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').get(), before);
  assert.equal(before.total_occurrences, 2);
  assert.equal(before.affected_installs_count, 2);
  assert.equal(before.last_seen_version, '3.2.1');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
});

test('concurrent distinct reports track counts without confusing issue creation with postinsert totals', async (t) => {
  const db = testDatabase(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => acceptErrorReport(db,
    report({ report_id: uuid(index + 1), install_id: install(index % 4 + 1) }), NOW + index)));
  assert.equal(results.filter((result) => result.isNewIssue).length, 1);
  assert.equal(results.filter((result) => result.accepted).length, 12);
  const issue = db.sqlite.prepare('SELECT * FROM issues').get();
  assert.equal(issue.total_occurrences, 12);
  assert.equal(issue.affected_installs_count, 4);
});

test('retention replays preserve receipts without recreating a body or activity', async (t) => {
  const db = testDatabase(t);
  await acceptErrorReport(db, report(), NOW);
  db.sqlite.prepare('DELETE FROM reports').run();
  const before = db.sqlite.prepare('SELECT * FROM issues').get();
  const replay = await acceptErrorReport(db, report({ error_message: 'Retained body is no longer available' }), NOW + 50);
  assert.equal(replay.accepted, false);
  assert.equal(replay.isNewIssue, false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').get(), before);
});

test('rejects a report UUID belonging to a different installation or fingerprint without leaking its issue', async (t) => {
  const db = testDatabase(t);
  await acceptErrorReport(db, report(), NOW);
  const before = db.sqlite.prepare('SELECT * FROM issues').all();
  for (const overrides of [{ install_id: install(2) }, { destination: 'vortex' }, { error_code: 'DIFFERENT_ERROR' }]) {
    await assert.rejects(acceptErrorReport(db, report(overrides), NOW + 10), (error) => {
      assert.ok(error instanceof IngestionConflict);
      assert.equal(typeof error.code, 'string');
      assert.equal('issueId' in error, false);
      assert.equal(error.message.includes(install(1)), false);
      return true;
    });
  }
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').all(), before);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
});

test('rejects altered retained report bodies but accepts semantically identical metadata order', async (t) => {
  const db = testDatabase(t);
  const breadcrumbs = [{ timestamp_offset_ms: 0, stage: 'API', action: 'REQUEST', status: 'error', metadata: { a: 1, b: 2 } }];
  await acceptErrorReport(db, report({ breadcrumbs }), NOW);
  await assert.rejects(acceptErrorReport(db, report({ breadcrumbs, error_message: 'Changed body' }), NOW + 1), IngestionConflict);
  const replay = await acceptErrorReport(db, report({ breadcrumbs: [{ ...breadcrumbs[0], metadata: { b: 2, a: 1 } }] }), NOW + 2);
  assert.equal(replay.accepted, false);
});

test('one conflicting concurrent UUID wins and leaves no orphan issue', async (t) => {
  const db = testDatabase(t);
  const results = await Promise.allSettled([
    acceptErrorReport(db, report(), NOW),
    acceptErrorReport(db, report({ install_id: install(2), destination: 'mo2' }), NOW),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.ok(failure.reason instanceof IngestionConflict);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_receipts').get().n, 1);
});

test('database failures roll back the issue, report, receipt and trigger totals together', async (t) => {
  const db = testDatabase(t);
  db.sqlite.exec("CREATE TRIGGER reject_reports BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'injected report failure'); END;");
  await assert.rejects(acceptErrorReport(db, report(), NOW), /injected report failure/);
  for (const table of ['issues', 'reports', 'report_receipts', 'issue_installs']) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('sanitizes every free-form persisted report field and normalizes raw Firefox stacks for grouping', async (t) => {
  const db = testDatabase(t);
  const result = await acceptErrorReport(db, report({
    error_message: 'Failure Authorization: Bearer private-secret',
    stack_trace: 'download@chrome-extension://private-extension-id/background.js?token=private-token:7:8',
    os_version: '192.168.1.10', collection_id: 'api-key-private-secret',
    breadcrumbs: [{ timestamp_offset_ms: 0, stage: 'API', action: 'REQUEST', status: 'error', metadata: { authorization: 'private-secret', path: 'C:\\Users\\Alice\\game.zip', url: 'https://example.test/api?token=private-token' } }],
    dom_state: { document_ready_state: 'complete', page_kind: 'mod', selectors: [{ selector: 'alice@example.com', matched: false }] },
  }), NOW);
  assert.equal(result.accepted, true);
  const persisted = JSON.stringify({ issue: db.sqlite.prepare('SELECT * FROM issues').get(), report: db.sqlite.prepare('SELECT * FROM reports').get() });
  for (const secret of ['private-secret', 'private-token', 'private-extension-id', 'alice@example.com', 'Alice']) assert.equal(persisted.includes(secret), false, secret);
  assert.equal(db.sqlite.prepare('SELECT normalized_top_frame FROM issues').get().normalized_top_frame, 'download@extension:///background.js');
  assert.ok(persisted.includes('REDACTED'));
});

test('stores immutable base classifications while updating current canary classification using receipt time', async (t) => {
  const db = testDatabase(t);
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host', occurred_at: '1970-01-01T00:00:00.000Z' };
  let result;
  for (let index = 1; index <= 3; index++) result = await acceptErrorReport(db, report({ ...common, report_id: uuid(index), install_id: install(index) }), NOW + index);
  assert.equal(result.rule.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
  assert.deepEqual(db.sqlite.prepare('SELECT DISTINCT category, fault_origin FROM reports').all().map((row) => ({ ...row })), [{ category: 'DOM_SELECTOR_MISSING', fault_origin: 'client_env' }]);
  const later = await acceptErrorReport(db, report({ ...common, report_id: uuid(4), install_id: install(4) }), NOW + 16 * 60 * 1000);
  assert.equal(later.rule.category, 'DOM_SELECTOR_MISSING');
});

test('groups reports independently of versions while separating target destinations', async (t) => {
  const db = testDatabase(t);
  const first = await acceptErrorReport(db, report(), NOW);
  const version = await acceptErrorReport(db, report({ report_id: uuid(2), version: '4.0.0' }), NOW + 1);
  const target = await acceptErrorReport(db, report({ report_id: uuid(3), destination: 'vortex' }), NOW + 2);
  assert.equal(first.issueId, version.issueId);
  assert.notEqual(first.issueId, target.issueId);
});

test('regresses only newly accepted versions above the fixed SemVer baseline with one transition event', async (t) => {
  const db = testDatabase(t);
  const original = await acceptErrorReport(db, report({ version: '3.1.0' }), NOW);
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '3.2.0' WHERE id = ?").run(original.issueId);
  for (const [index, version] of ['3.1.9', '3.2.0-alpha.2', '3.2.0', '3.2.0+build.4'].entries()) {
    const result = await acceptErrorReport(db, report({ report_id: uuid(index + 2), version }), NOW + index + 1);
    assert.equal(result.regressionEventId, undefined);
  }
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'fixed');
  const newer = await Promise.all(Array.from({ length: 4 }, (_, index) => acceptErrorReport(db,
    report({ report_id: uuid(index + 10), version: '3.2.1' }), NOW + index + 10)));
  assert.equal(newer.filter((result) => result.regressionEventId !== undefined).length, 1);
  const transition = newer.find((result) => result.regressionEventId !== undefined);
  assert.equal(transition.regressionEventId, transition.reportId);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'regressed');
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '3.1.0'").run();
  const replay = await acceptErrorReport(db, report({ report_id: uuid(10), version: '3.2.1' }), NOW + 50);
  assert.equal(replay.regressionEventId, undefined);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'fixed');
});

test('heartbeat receipts aggregate immutable deltas per version/date/browser/destination and exact replays do nothing', async (t) => {
  const db = testDatabase(t);
  const input = heartbeat();
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => acceptHeartbeat(db, input, NOW + index)));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results[0].heartbeatId, input.heartbeat_id);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2), install_id: install(2), attempts_count: 5, success_count: 5, fallback_triggered_count: 1 }), NOW + 10);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(3), destination: 'vortex' }), NOW + 11);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(4), version: '3.3.0' }), NOW + 12);
  const metrics = db.sqlite.prepare("SELECT * FROM release_metrics WHERE version = '3.2.0' AND destination = 'browser'").get();
  assert.equal(metrics.attempts_count, 15);
  assert.equal(metrics.success_count, 13);
  assert.equal(metrics.fallback_triggered_count, 4);
  assert.equal(metrics.heartbeat_count, 2);
  const before = db.sqlite.prepare('SELECT * FROM release_metrics').all();
  assert.equal((await acceptHeartbeat(db, input, NOW + 100)).accepted, false);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM release_metrics').all(), before);
  assert.equal(before.length, 3);
});

test('changed heartbeat identities conflict including concurrent inserts without inflating metrics', async (t) => {
  const db = testDatabase(t);
  await acceptHeartbeat(db, heartbeat(), NOW);
  for (const change of [{ metric_date: '2026-10-20' }, { version: '3.2.1' }, { browser: 'firefox' }, { destination: 'mo2' }, { attempts_count: 12 }, { success_count: 7 }, { fallback_triggered_count: 4 }]) {
    await assert.rejects(acceptHeartbeat(db, heartbeat(change), NOW + 1), IngestionConflict);
  }
  const race = await Promise.allSettled([
    acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2) }), NOW + 2),
    acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2), success_count: 7 }), NOW + 2),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(race.find((result) => result.status === 'rejected').reason instanceof IngestionConflict);
  assert.equal(db.sqlite.prepare('SELECT heartbeat_count FROM release_metrics').get().heartbeat_count, 2);
  assert.equal((await acceptHeartbeat(db, heartbeat({ install_id: install(2) }), NOW + 3)).accepted, true);
});

test('an older same-millisecond rule evaluation cannot replace a newer canary result', async (t) => {
  const db = testDatabase(t);
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  await acceptErrorReport(db, report(common), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const reachedQuery = new Promise((resolve) => { ready = resolve; });
  const pausedDb = {
    ...db,
    prepare(sql) {
      function wrap(statement) {
        return {
          ...statement,
          bind(...values) { return wrap(statement.bind(...values)); },
          async first(...args) {
            const result = await statement.first(...args);
            if (sql.includes('COUNT(DISTINCT NULLIF(install_id,')) { ready(); await gate; }
            return result;
          },
        };
      }
      return wrap(db.prepare(sql));
    },
  };
  const second = acceptErrorReport(pausedDb, report({ ...common, report_id: uuid(2), install_id: install(2) }), NOW);
  await reachedQuery;
  const third = await acceptErrorReport(db, report({ ...common, report_id: uuid(3), install_id: install(3) }), NOW);
  assert.equal(third.rule.category, 'UPSTREAM_BREAKING_CHANGE');
  resume();
  await second;
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
});

test('out-of-order batch completions refresh the current issue at its newest receipt window', async (t) => {
  const db = testDatabase(t);
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  await acceptErrorReport(db, report(common), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const committed = new Promise((resolve) => { ready = resolve; });
  const delayedDb = {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      ready();
      await gate;
      return result;
    },
  };
  const latest = acceptErrorReport(delayedDb, report({ ...common, report_id: uuid(3), install_id: install(3) }), NOW + 2);
  await committed;
  const older = await acceptErrorReport(db, report({ ...common, report_id: uuid(2), install_id: install(2) }), NOW + 1);
  assert.equal(older.rule.category, 'DOM_SELECTOR_MISSING');
  resume();
  assert.equal((await latest).rule.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
});

test('refreshes use the newest retained report classification instead of an older report sharing its fingerprint', async (t) => {
  const db = testDatabase(t);
  await acceptErrorReport(db, report(), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const committed = new Promise((resolve) => { ready = resolve; });
  const delayedDb = {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      ready();
      await gate;
      return result;
    },
  };
  const latest = acceptErrorReport(delayedDb, report({ report_id: uuid(3), install_id: install(3), error_message: 'Failed to fetch' }), NOW + 2);
  await committed;
  const older = await acceptErrorReport(db, report({ report_id: uuid(2), install_id: install(2), error_message: 'Missing collection host' }), NOW + 1);
  assert.equal(older.rule.category, 'DOM_SELECTOR_MISSING');
  const intermediate = db.sqlite.prepare('SELECT category, fault_origin FROM issues').get();
  resume();
  await latest;
  assert.equal(intermediate.category, 'NETWORK_UNREACHABLE');
  assert.equal(intermediate.fault_origin, 'client_env');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'NETWORK_UNREACHABLE');
});

test('accepted reports survive postcommit classification faults with their base delivery context', async (t) => {
  const db = testDatabase(t);
  const input = report({ error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' });
  const faultyDb = {
    ...db,
    prepare(sql) {
      if (sql.includes('COUNT(DISTINCT NULLIF(install_id,')) throw new Error('injected postcommit classification failure');
      return db.prepare(sql);
    },
  };
  const result = await acceptErrorReport(faultyDb, input, NOW);
  assert.equal(result.accepted, true);
  assert.equal(result.rule.category, 'DOM_SELECTOR_MISSING');
  assert.equal(result.report.report_id, input.report_id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
});

test('a fixed baseline changed during ingestion is compared again before regression', async (t) => {
  const db = testDatabase(t);
  await acceptErrorReport(db, report(), NOW);
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '4.0.0'").run();
  const changingDb = {
    ...db,
    async batch(statements) {
      db.sqlite.prepare("UPDATE issues SET fixed_in_version = '3.1.0'").run();
      return db.batch(statements);
    },
  };
  const result = await acceptErrorReport(changingDb, report({ report_id: uuid(2), version: '3.2.1' }), NOW + 1);
  assert.equal(result.accepted, true);
  assert.equal(result.regressionEventId, uuid(2));
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'regressed');
});

test('heartbeat failures roll back receipts and release totals together', async (t) => {
  const db = testDatabase(t);
  db.sqlite.exec("CREATE TRIGGER reject_metrics BEFORE INSERT ON release_metrics BEGIN SELECT RAISE(ABORT, 'injected metrics failure'); END;");
  await assert.rejects(acceptHeartbeat(db, heartbeat(), NOW), /injected metrics failure/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM heartbeat_receipts').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM release_metrics').get().n, 0);
});
