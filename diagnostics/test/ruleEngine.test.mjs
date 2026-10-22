import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import { classifyReport, evaluateRules } from '../src/services/ruleEngine.ts';
import { createTestDatabase } from './helpers/d1.mjs';

const NOW = 1_792_604_800_000;
const WINDOW = 15 * 60 * 1000;
const uuid = (number) => `12345678-1234-4234-8234-${number.toString(16).padStart(12, '0')}`;

function report(overrides = {}) {
  return errorReportSchema.parse({
    schema_version: 1,
    consent: 'diagnostics-v1',
    report_id: uuid(1),
    install_id: 'a'.repeat(64),
    occurred_at: new Date(NOW).toISOString(),
    version: '3.2.0',
    browser: 'chrome',
    browser_version: '142.0',
    os: 'windows',
    download_mode: 'manual',
    destination: 'browser',
    severity: 'error',
    error_category: 'DOWNLOAD_ERROR',
    error_code: 'REQUEST_FAILED',
    failure_stage: 'PRIMARY_API_REQUEST',
    error_message: 'Something unexpected happened',
    ...overrides,
  });
}

const actions = {
  network: 'Έλεγχος διαδρομής/σύνδεσης ή DNS/Firewall χρήστη· η αιτία παραμένει άγνωστη χωρίς επιπλέον στοιχεία δικτύου.',
  rate: 'Αναμονή σύμφωνα με το Retry-After header (καταγραφή τιμής Retry-After και endpoint).',
  conflict: 'Καταγραφή ως σύγκρουση επεκτάσεων — άλλη επέκταση ελέγχει το download UI ή το chrome.downloads API.',
  security: 'Καταγραφή ως αποκλεισμός ασφαλείας του browser/antivirus.',
  dom: 'Έλεγχος κατάστασης φόρτωσης (document.readyState) και DOM πριν χαρακτηριστεί ως αλλαγή στη σελίδα του Nexus.',
  handoff: 'Έλεγχος αν το Vortex/MO2 τρέχει και αν το nxm:// protocol είναι δηλωμένο στο OS.',
};

test('classifies the six required failures with their exact actions', () => {
  const cases = [
    [{ error_name: 'TypeError', error_message: 'Failed to fetch' }, 'NETWORK_UNREACHABLE', 'client_env', actions.network, null],
    [{ http_status: 429, retry_after: '60', error_message: 'HTTP 429 Too Many Requests' }, 'API_RATE_LIMIT', 'rate_limit', actions.rate, null],
    [{ error_code: 'DOWNLOAD_UI_CONFLICT' }, 'EXTENSION_CONFLICT', 'client_env', actions.conflict, null],
    [{ error_code: 'FILE_VIRUS_INFECTED' }, 'SECURITY_BLOCK', 'client_env', actions.security, null],
    [{ error_message: 'Missing collection host' }, 'DOM_SELECTOR_MISSING', 'client_env', actions.dom, 'DOM_SELECTOR_MISSING'],
    [{ destination: 'mo2', error_code: 'NXM_TIMEOUT', failure_stage: 'MO2_NXM_HANDOFF_FAILED' }, 'HANDOFF_FAILURE', 'client_env', actions.handoff, null],
  ];
  for (const [input, category, fault_origin, suggested_action, structural_category] of cases) {
    assert.deepEqual(classifyReport(report(input)), {
      category, fault_origin, suggested_action, upstream_breaking_change: false, structural_category,
    });
  }
});

test('recognizes direct browser, protocol and network failure messages', () => {
  for (const [error_message, category] of [
    ['Download blocked by Safe Browsing', 'SECURITY_BLOCK'],
    ['Windows Defender blocked the download', 'SECURITY_BLOCK'],
    ['Another extension controls the download UI', 'EXTENSION_CONFLICT'],
    ['The nxm:// protocol handler failed', 'HANDOFF_FAILURE'],
    ['No protocol handler registered for nxm://', 'HANDOFF_FAILURE'],
    ['NetworkError when attempting to fetch resource.', 'NETWORK_UNREACHABLE'],
    ['TypeError: Failed to fetch', 'NETWORK_UNREACHABLE'],
    ['DOM selector missing: [data-collection-host]', 'DOM_SELECTOR_MISSING'],
  ]) {
    assert.equal(classifyReport(report({ error_message })).category, category, error_message);
  }
});

test('prioritizes terminal handoff and network failures over recovered historical 429s', () => {
  const breadcrumbs = [
    { timestamp_offset_ms: 0, stage: 'PRIMARY_API_REQUEST', action: 'REQUEST', status: 'warn', http_status: 429 },
    { timestamp_offset_ms: 100, stage: 'FALLBACK_API_REQUEST', action: 'REQUEST', status: 'ok', http_status: 200 },
    { timestamp_offset_ms: 200, stage: 'HANDOFF', action: 'NXM_OPEN', status: 'error' },
  ];
  assert.equal(classifyReport(report({
    destination: 'vortex', error_category: 'HANDOFF', error_code: 'NXM_TIMEOUT',
    failure_stage: 'VORTEX_NXM_HANDOFF_FAILED', error_message: 'Protocol handler timed out', breadcrumbs,
  })).category, 'HANDOFF_FAILURE');
  assert.equal(classifyReport(report({ error_message: 'Failed to fetch', breadcrumbs })).category, 'NETWORK_UNREACHABLE');
});

test('uses only a terminal error breadcrumb matching the current failure stage for HTTP status', () => {
  const current = { timestamp_offset_ms: 0, stage: 'PRIMARY_API_REQUEST', action: 'REQUEST', status: 'error', http_status: 429 };
  assert.equal(classifyReport(report({ breadcrumbs: [current] })).category, 'API_RATE_LIMIT');
  assert.equal(classifyReport(report({ breadcrumbs: [{ ...current, status: 'warn' }] })).category, 'UNKNOWN_ERROR');
  assert.equal(classifyReport(report({ breadcrumbs: [{ ...current, stage: 'FALLBACK_API_REQUEST' }] })).category, 'UNKNOWN_ERROR');
  assert.equal(classifyReport(report({ breadcrumbs: [current, { ...current, timestamp_offset_ms: 1, status: 'ok', http_status: 200 }] })).category, 'UNKNOWN_ERROR');
});

test('classifies structured current categories and codes without scanning stack examples', () => {
  for (const [input, category] of [
    [{ error_category: 'SECURITY_BLOCK' }, 'SECURITY_BLOCK'],
    [{ error_category: 'EXTENSION_CONFLICT' }, 'EXTENSION_CONFLICT'],
    [{ failure_stage: 'VORTEX_NXM_HANDOFF_FAILED' }, 'HANDOFF_FAILURE'],
    [{ error_code: 'HTTP_429' }, 'API_RATE_LIMIT'],
    [{ error_category: 'DOM_SELECTOR_MISSING' }, 'DOM_SELECTOR_MISSING'],
    [{ error_code: 'API_SCHEMA_MISMATCH' }, 'API_SCHEMA_MISMATCH'],
    [{ error_code: 'ERR_NETWORK' }, 'NETWORK_UNREACHABLE'],
  ]) assert.equal(classifyReport(report(input)).category, category);

  for (const input of [
    { error_name: 'TypeError', error_message: 'Cannot read properties of undefined' },
    { destination: 'vortex', error_message: 'Something unexpected happened' },
    { stack_trace: 'Error: FILE_VIRUS_INFECTED\n at example (source.js:1:2)\n HTTP 429 Failed to fetch' },
    { error_message: 'Code example: if (status === 429) throw new Error("FILE_VIRUS_INFECTED")' },
  ]) {
    const result = classifyReport(report(input));
    assert.equal(result.category, 'UNKNOWN_ERROR');
    assert.equal(result.fault_origin, 'unknown');
    assert.equal(result.structural_category, null);
  }
});

test('applies security, conflict, handoff, current 429, structural, network priority', () => {
  assert.equal(classifyReport(report({ error_code: 'FILE_VIRUS_INFECTED', error_category: 'EXTENSION_CONFLICT', failure_stage: 'NXM_HANDOFF_FAILED', http_status: 429 })).category, 'SECURITY_BLOCK');
  assert.equal(classifyReport(report({ error_code: 'EXTENSION_CONFLICT', failure_stage: 'NXM_HANDOFF_FAILED', http_status: 429 })).category, 'EXTENSION_CONFLICT');
  assert.equal(classifyReport(report({ failure_stage: 'NXM_HANDOFF_FAILED', http_status: 429 })).category, 'HANDOFF_FAILURE');
  assert.equal(classifyReport(report({ error_code: 'DOM_SELECTOR_MISSING', http_status: 429, error_message: 'Failed to fetch' })).category, 'API_RATE_LIMIT');
  assert.equal(classifyReport(report({ error_code: 'DOM_SELECTOR_MISSING', error_message: 'Failed to fetch' })).category, 'DOM_SELECTOR_MISSING');
});

test('recognizes existing extension diagnostic codes without requiring renamed identifiers', () => {
  for (const [error_code, category] of [
    ['network_error', 'NETWORK_UNREACHABLE'],
    ['offline', 'NETWORK_UNREACHABLE'],
    ['rate_limited', 'API_RATE_LIMIT'],
    ['nexus_page_changed', 'DOM_SELECTOR_MISSING'],
    ['nexus_api_changed', 'API_SCHEMA_MISMATCH'],
    ['FILE_SECURITY_CHECK_FAILED', 'SECURITY_BLOCK'],
  ]) assert.equal(classifyReport(report({ error_code })).category, category, error_code);
});

test('does not mistake unready or unrelated missing selectors for a structural failure', () => {
  for (const document_ready_state of ['loading', 'interactive', 'complete']) {
    const dom_state = { document_ready_state, page_kind: 'collection', collection_host_present: false, selectors: [{ selector: '#host', matched: false, match_count: 0 }] };
    assert.equal(classifyReport(report({ dom_state })).category, 'UNKNOWN_ERROR');
    assert.equal(classifyReport(report({ error_message: 'Failed to fetch', dom_state })).category, 'NETWORK_UNREACHABLE');
    const result = classifyReport(report({ error_category: 'DOM', failure_stage: 'DOM_EXTRACTION_FAILED', dom_state }));
    assert.equal(result.category, 'DOM_SELECTOR_MISSING');
    assert.equal(result.fault_origin, 'client_env');
    assert.equal(result.suggested_action, actions.dom);
  }
});

test('recognizes schema-defined missing API fields and leaves isolated API cause unknown', () => {
  const result = classifyReport(report({ dom_state: {
    document_ready_state: 'complete', page_kind: 'mod', selectors: [],
    api_schema: { expected: 'DownloadLinkV2', received: 'DownloadLinkV1', missing_fields: ['uri'] },
  } }));
  assert.equal(result.category, 'API_SCHEMA_MISMATCH');
  assert.equal(result.fault_origin, 'unknown');
  assert.equal(result.structural_category, 'API_SCHEMA_MISMATCH');
  assert.equal(result.upstream_breaking_change, false);
  assert.match(result.suggested_action, /API/);
});

test('current network failures outrank API schema context retained from an earlier fallback', () => {
  const dom_state = {
    document_ready_state: 'complete', page_kind: 'mod', selectors: [],
    api_schema: { missing_fields: ['uri'] },
  };
  for (const input of [
    { error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'FALLBACK_API_REQUEST', error_message: 'Failed to fetch' },
    { error_category: 'NETWORK' },
    { error_code: 'FETCH_FAILED' },
    { error_message: 'Failed to fetch' },
  ]) assert.deepEqual(classifyReport(report({ ...input, dom_state })), {
    category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: actions.network,
    upstream_breaking_change: false, structural_category: null,
  });
});

test('explicit terminal schema failures retain priority while unrelated terminal failures ignore API context', () => {
  const dom_state = {
    document_ready_state: 'complete', page_kind: 'mod', selectors: [],
    api_schema: { expected: 'DownloadLinkV2', received: 'DownloadLinkV1', missing_fields: ['uri'] },
  };
  for (const input of [
    { error_code: 'API_SCHEMA_MISMATCH', error_message: 'Failed to fetch' },
    { error_code: 'FETCH_FAILED', error_message: 'API schema mismatch: uri is missing' },
    { failure_stage: 'API_SCHEMA_CHECK', error_code: 'RESPONSE_INVALID', error_message: 'Required uri is absent' },
  ]) assert.equal(classifyReport(report({ ...input, dom_state })).category, 'API_SCHEMA_MISMATCH');
  assert.equal(classifyReport(report({ error_code: 'DOM_SELECTOR_MISSING', dom_state })).category, 'DOM_SELECTOR_MISSING');
  assert.equal(classifyReport(report({ error_code: 'FILE_NOT_FOUND', error_message: 'File disappeared', dom_state })).category, 'UNKNOWN_ERROR');
});

test('classification is deterministic, returns independent results and preserves the report', () => {
  const input = report({ error_message: 'Missing collection host' });
  const original = structuredClone(input);
  const first = classifyReport(input);
  first.category = 'MUTATED';
  assert.equal(classifyReport(input).category, 'DOM_SELECTOR_MISSING');
  assert.deepEqual(input, original);
});

function database(t) {
  const db = createTestDatabase();
  t.after(() => db.close());
  return db;
}

function insert(db, table, values) {
  const keys = Object.keys(values);
  return db.sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...Object.values(values));
}

function issue(db, id = 1) {
  insert(db, 'issues', {
    id, fingerprint: id.toString(16).padStart(64, '0'), error_category: 'DOM', error_code: 'DOM_SELECTOR_MISSING',
    failure_stage: 'COLLECTION_HOST', normalized_top_frame: 'download.js:extractHost', destination: 'browser',
    category: 'DOM_SELECTOR_MISSING', fault_origin: 'client_env', suggested_action: actions.dom,
    first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.2.0', last_seen_version: '3.2.0',
    created_at: NOW, updated_at: NOW,
  });
  return id;
}

function storedReport(db, issueId, number, install, created_at = NOW, occurred_at = NOW) {
  insert(db, 'reports', {
    id: uuid(number), issue_id: issueId, install_id: install.repeat(64), version: '3.2.0', browser: 'chrome',
    browser_version: '142.0', os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error',
    error_category: 'DOM', error_code: 'DOM_SELECTOR_MISSING', failure_stage: 'COLLECTION_HOST', error_name: 'Error',
    error_message: 'Missing collection host', category: 'DOM_SELECTOR_MISSING', fault_origin: 'client_env',
    suggested_action: actions.dom, occurred_at, created_at,
  });
}

test('requires three distinct stored installations rather than repeat reports', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  const input = report({ error_message: 'Missing collection host' });
  for (let i = 1; i <= 5; i += 1) storedReport(db, issueId, i, 'a');
  storedReport(db, issueId, 6, 'b');
  assert.deepEqual(await evaluateRules(db, input, { issueId, now: NOW }), {
    category: 'DOM_SELECTOR_MISSING', fault_origin: 'client_env', suggested_action: actions.dom,
    upstream_breaking_change: false, structural_category: 'DOM_SELECTOR_MISSING',
  });
  storedReport(db, issueId, 7, 'c');
  const result = await evaluateRules(db, input, { issueId, now: NOW });
  assert.equal(result.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(result.fault_origin, 'upstream_site');
  assert.equal(result.upstream_breaking_change, true);
  assert.equal(result.structural_category, 'DOM_SELECTOR_MISSING');
  assert.match(result.suggested_action, /hotfix/i);
});

test('counts inclusive server receipt bounds and ignores client time, other issues and lifetime installs', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  issue(db, 2);
  storedReport(db, issueId, 1, 'a', NOW, NOW - WINDOW * 10);
  storedReport(db, issueId, 2, 'b', NOW - WINDOW, NOW + WINDOW * 10);
  storedReport(db, issueId, 3, 'c', NOW - WINDOW - 1, NOW);
  storedReport(db, issueId, 4, 'd', NOW + 1, NOW);
  storedReport(db, 2, 5, 'e', NOW, NOW);
  storedReport(db, 2, 6, 'f', NOW, NOW);
  storedReport(db, 2, 7, '0', NOW, NOW);
  assert.equal(db.sqlite.prepare('SELECT affected_installs_count FROM issues WHERE id = ?').get(issueId).affected_installs_count, 4);
  const input = report({ error_code: 'DOM_SELECTOR_MISSING' });
  assert.equal((await evaluateRules(db, input, { issueId, now: NOW })).upstream_breaking_change, false);
  storedReport(db, issueId, 8, '1', NOW - WINDOW, NOW - WINDOW * 10);
  assert.equal((await evaluateRules(db, input, { issueId, now: NOW })).upstream_breaking_change, true);
});

test('supports explicit detection windows and distinct-install thresholds', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  storedReport(db, issueId, 1, 'a', NOW);
  storedReport(db, issueId, 2, 'b', NOW - 1001);
  const input = report({ error_code: 'API_SCHEMA_MISMATCH' });
  const base = { issueId, now: NOW, distinctInstallThreshold: 2 };
  assert.equal((await evaluateRules(db, input, base)).upstream_breaking_change, true);
  assert.equal((await evaluateRules(db, input, { ...base, windowMs: 1000 })).upstream_breaking_change, false);
  const inclusive = await evaluateRules(db, input, { ...base, windowMs: 1001 });
  assert.equal(inclusive.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(inclusive.structural_category, 'API_SCHEMA_MISMATCH');
});

test('canary evaluation leaves reports, issue classification and server timestamps unchanged', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  for (const [index, install] of ['a', 'b', 'c'].entries()) storedReport(db, issueId, index + 1, install);
  const before = {
    reports: db.sqlite.prepare('SELECT * FROM reports ORDER BY id').all(),
    issues: db.sqlite.prepare('SELECT * FROM issues ORDER BY id').all(),
  };
  const input = report({ error_code: 'API_SCHEMA_MISMATCH' });
  const original = structuredClone(input);
  const result = await evaluateRules(db, input, { issueId, now: NOW });
  assert.equal(result.upstream_breaking_change, true);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM reports ORDER BY id').all(), before.reports);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues ORDER BY id').all(), before.issues);
  assert.deepEqual(input, original);
  assert.deepEqual(await evaluateRules(db, input, { issueId, now: NOW }), result);
});

test('high report volume does not turn network or security failures into upstream canaries', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  for (const [index, install] of ['a', 'b', 'c'].entries()) storedReport(db, issueId, index + 1, install);
  for (const [input, category] of [
    [{ error_message: 'Failed to fetch' }, 'NETWORK_UNREACHABLE'],
    [{ error_code: 'FILE_VIRUS_INFECTED' }, 'SECURITY_BLOCK'],
  ]) {
    const result = await evaluateRules(db, report(input), { issueId, now: NOW });
    assert.equal(result.category, category);
    assert.equal(result.upstream_breaking_change, false);
    assert.equal(result.structural_category, null);
  }
});

test('three installations with a current network failure and earlier API mismatch context never trigger a canary', async (t) => {
  const db = database(t);
  const issueId = issue(db);
  for (const [index, install] of ['a', 'b', 'c'].entries()) storedReport(db, issueId, index + 1, install);
  const input = report({
    error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'FALLBACK_API_REQUEST', error_message: 'Failed to fetch',
    dom_state: { document_ready_state: 'complete', page_kind: 'mod', selectors: [], api_schema: { missing_fields: ['uri'] } },
  });
  assert.deepEqual(await evaluateRules(db, input, { issueId, now: NOW }), {
    category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: actions.network,
    upstream_breaking_change: false, structural_category: null,
  });
});

test('rejects invalid query bounds and thresholds rather than producing misleading canaries', async (t) => {
  const db = database(t);
  const input = report({ error_code: 'DOM_SELECTOR_MISSING' });
  for (const options of [
    { issueId: 0, now: NOW }, { issueId: 1.5, now: NOW },
    { issueId: 1, now: -1 }, { issueId: 1, now: NaN },
    { issueId: 1, now: NOW, windowMs: 0 }, { issueId: 1, now: NOW, windowMs: Infinity },
    { issueId: 1, now: NOW, distinctInstallThreshold: 0 }, { issueId: 1, now: NOW, distinctInstallThreshold: 2.5 },
  ]) await assert.rejects(evaluateRules(db, input, options), RangeError);
});
