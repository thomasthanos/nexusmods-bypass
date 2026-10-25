import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReportSchema, heartbeatSchema } from '../src/schemas/ingest.ts';

const report = () => ({
  schema_version: 1,
  consent: 'diagnostics-v1',
  report_id: '3761cb55-49b3-4f63-bbad-74c5cc586528',
  install_id: 'a'.repeat(64),
  occurred_at: '2026-10-21T10:00:00.000Z',
  version: '3.2.0',
  browser: 'firefox',
  browser_version: '144.0',
  os: 'windows',
  download_mode: 'auto',
  destination: 'vortex',
  severity: 'error',
  error_category: 'HANDOFF',
  error_code: 'NXM_TIMEOUT',
  failure_stage: 'VORTEX_NXM_HANDOFF_FAILED',
  error_message: 'Protocol handler timed out',
  breadcrumbs: [
    { timestamp_offset_ms: 0, stage: 'UI', action: 'UI_CLICK_DOWNLOAD', status: 'ok' },
    { timestamp_offset_ms: 310, stage: 'API', action: 'PRIMARY_API_REQUEST', status: 'warn', http_status: 429, duration_ms: 310, metadata: { retry_after: '60' } },
    { timestamp_offset_ms: 5310, stage: 'HANDOFF', action: 'NXM_OPEN', status: 'error', duration_ms: 5000 }
  ],
  dom_state: { document_ready_state: 'complete', page_kind: 'collection', selectors: [{ selector: '[data-collection-host]', matched: false, match_count: 0 }] }
});

const heartbeat = () => ({
  schema_version: 1,
  consent: 'telemetry-v1',
  heartbeat_id: '91447c93-8a23-4823-aa1f-1fd8575218bc',
  install_id: 'b'.repeat(64),
  metric_date: '2026-10-21',
  version: '3.2.0',
  browser: 'chrome',
  destination: 'browser',
  attempts_count: 10,
  success_count: 9,
  fallback_triggered_count: 3
});

test('accepts a complete report and defaults only optional diagnostic containers', () => {
  const parsed = errorReportSchema.parse(report());
  assert.equal(parsed.breadcrumbs[1].http_status, 429);
  assert.deepEqual(parsed.context, {});
  assert.deepEqual(parsed.breadcrumbs[0].metadata, {});
});

test('rejects unknown fields, missing consent, and raw installation identities', () => {
  for (const update of [{ unexpected: true }, { consent: false }, { consent: undefined }, { install_id: 'random-install-uuid' }, { install_id: 'A'.repeat(64) }]) {
    assert.equal(errorReportSchema.safeParse({ ...report(), ...update }).success, false);
  }
  const payload = report();
  payload.breadcrumbs[0].headers = { Authorization: 'secret' };
  assert.equal(errorReportSchema.safeParse(payload).success, false);
});

test('rejects invalid dates and versions while accepting release prereleases', () => {
  for (const occurred_at of ['2026-02-30T10:00:00.000Z', '2026-10-21', '2026-10-21T10:00:00+00:00', '1969-12-31T23:59:59.999Z']) {
    assert.equal(errorReportSchema.safeParse({ ...report(), occurred_at }).success, false);
  }
  for (const version of ['3.2', 'v3.2.0', '03.2.0', '3.2.0-01', '3.2.0 trailing']) {
    assert.equal(errorReportSchema.safeParse({ ...report(), version }).success, false);
  }
  assert.equal(errorReportSchema.safeParse({ ...report(), version: '3.2.1-rc.1+build.12' }).success, true);
});

test('bounds breadcrumbs and rejects backwards timelines and unsafe HTTP statuses', () => {
  const payload = report();
  payload.breadcrumbs[2].timestamp_offset_ms = 1;
  assert.equal(errorReportSchema.safeParse(payload).success, false);
  assert.equal(errorReportSchema.safeParse({ ...report(), http_status: 700 }).success, false);
  assert.equal(errorReportSchema.safeParse({ ...report(), breadcrumbs: Array.from({ length: 81 }, () => report().breadcrumbs[0]) }).success, false);
});

test('rejects hostile metadata depth, width, prototype keys and non-JSON numbers', () => {
  for (const metadata of [
    { nested: { nested: { nested: { value: 1 } } } },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])),
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { constructor: 'unsafe' },
    { elapsed: Infinity },
    { values: Array.from({ length: 17 }, () => 1) }
  ]) {
    const payload = report();
    payload.breadcrumbs[0].metadata = metadata;
    assert.equal(errorReportSchema.safeParse(payload).success, false);
  }
});

test('enforces UTF-8 payload bytes even when individual field limits pass', () => {
  const payload = report();
  payload.stack_trace = 'α'.repeat(12000);
  payload.breadcrumbs = Array.from({ length: 30 }, (_, i) => ({
    timestamp_offset_ms: i, stage: 'API', action: 'REQUEST', status: 'error', metadata: { detail: 'α'.repeat(1024) }
  }));
  assert.equal(errorReportSchema.safeParse(payload).success, false);
});

test('keeps DOM snapshots structured and rejects credentials in explicit endpoint URLs', () => {
  assert.equal(errorReportSchema.safeParse({ ...report(), dom_state: { innerHTML: '<body>private</body>' } }).success, false);
  for (const api_endpoint of ['https://api.nexusmods.com/v1?key=private', 'https://user:pass@api.nexusmods.com/v1', 'http://api.nexusmods.com/v1', 'https://api.nexusmods.com/v1#private']) {
    assert.equal(errorReportSchema.safeParse({ ...report(), context: { api_endpoint } }).success, false);
  }
});

test('malformed endpoint text returns a validation failure instead of throwing', () => {
  assert.equal(errorReportSchema.safeParse({ ...report(), context: { api_endpoint: 'not a URL' } }).success, false);
});

test('normalizes UUID case so SQL request identity stays stable across retries', () => {
  const payload = report();
  assert.equal(errorReportSchema.parse({ ...payload, report_id: payload.report_id.toUpperCase() }).report_id, payload.report_id);
  const metric = heartbeat();
  assert.equal(heartbeatSchema.parse({ ...metric, heartbeat_id: metric.heartbeat_id.toUpperCase() }).heartbeat_id, metric.heartbeat_id);
});

test('rejects NUL characters in text stored directly in SQL columns', () => {
  for (const field of ['error_name', 'error_message', 'stack_trace', 'retry_after']) {
    assert.equal(errorReportSchema.safeParse({ ...report(), [field]: 'invalid\u0000text' }).success, false);
  }
});

test('accepts immutable heartbeat deltas with overlapping successes and fallbacks', () => {
  assert.equal(heartbeatSchema.safeParse(heartbeat()).success, true);
  assert.equal(heartbeatSchema.safeParse({ ...heartbeat(), attempts_count: 0, success_count: 0, fallback_triggered_count: 0 }).success, true);
});

test('rejects heartbeat consent, calendar, dimension and counter inconsistencies', () => {
  for (const update of [
    { consent: 'diagnostics-v1' }, { metric_date: '2026-02-30' }, { success_count: 11 },
    { fallback_triggered_count: 11 }, { attempts_count: -1 }, { attempts_count: 1.5 },
    { attempts_count: 1_000_001 }, { success_count: '9' }, { destination: 'unknown' },
    { browser: 'full private user agent' }, { heartbeat_id: 'new-id' }, { extra: true }
  ]) {
    assert.equal(heartbeatSchema.safeParse({ ...heartbeat(), ...update }).success, false);
  }
});
