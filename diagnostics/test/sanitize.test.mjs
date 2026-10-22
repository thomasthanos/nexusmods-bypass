import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import { sanitizeDeep, sanitizeReport, sanitizeText, sanitizeUrl } from '../src/utils/sanitize.ts';

const report = () => errorReportSchema.parse({
  schema_version: 1, consent: 'diagnostics-v1', report_id: '3761cb55-49b3-4f63-bbad-74c5cc586528',
  install_id: 'a'.repeat(64), occurred_at: '2026-10-21T10:00:00.000Z', version: '3.2.0',
  browser: 'firefox', browser_version: '144.0', os: 'windows', download_mode: 'auto',
  destination: 'vortex', severity: 'error', error_category: 'HANDOFF', error_code: 'NXM_TIMEOUT',
  failure_stage: 'VORTEX_NXM_HANDOFF_FAILED', error_message: 'Protocol handler timed out',
  breadcrumbs: [{ timestamp_offset_ms: 0, stage: 'API', action: 'REQUEST', status: 'error', metadata: {} }]
});

test('redacts secrets from quoted JSON, headers, selector attributes and log assignments', () => {
  const inputs = [
    'Authorization: Bearer rawsecret\nCookie: session=rawsecret; other=secondsecret',
    '{"headers":{"Authorization":"Basic rawsecret","Cookie":"a=rawsecret; b=secondsecret"},"apiKey":"rawsecret"}',
    String.raw`headers={\"X-Api-Key\":\"rawsecret\",\"nexus_personal_key\":\"secondsecret\"}`,
    '[data-token="rawsecret"] [data-api-key=secondsecret]',
    "token='rawsecret with spaces'; session_token=secondsecret personalkey=thirdsecret",
    'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJl'
  ];
  for (const input of inputs) {
    const result = sanitizeText(input);
    for (const secret of ['rawsecret', 'secondsecret', 'thirdsecret', 'eyJhbGci', 'eyJzdWIi', 'c2lnbmF0dXJl']) {
      assert.equal(result.includes(secret), false, `${secret} leaked from ${input}`);
    }
    assert.match(result, /REDACTED/);
  }
});

test('removes URL credentials, queries, fragments and extension identities in text and URL exports', () => {
  const fixtures = [
    ['https://rawsecret:secondsecret@api.nexusmods.com/v1/files?key=thirdsecret#fourthsecret', 'https://api.nexusmods.com/v1/files'],
    ['chrome-extension://rawsecret/scripts/download.js?token=secondsecret#thirdsecret', 'chrome-extension://extension/scripts/download.js'],
    ['moz-extension://rawsecret/scripts/download.js?token=secondsecret', 'moz-extension://extension/scripts/download.js']
  ];
  for (const [input, expected] of fixtures) {
    assert.equal(sanitizeUrl(input), expected);
    assert.equal(sanitizeText(`failed ${input}`), `failed ${expected}`);
  }
  for (const input of ['https://api.invalid/token/rawsecret/files', 'https://api.invalid/api_key/rawsecret', '/files?token=rawsecret#secondsecret']) {
    assert.equal(sanitizeUrl(input).includes('rawsecret'), false);
    assert.equal(sanitizeUrl(input).includes('secondsecret'), false);
  }
});

test('masks local usernames, emails and confidently recognized IP addresses', () => {
  const input = String.raw`C:\Users\privateuser\extension\download.js /Users/macuser/extension.js /home/linuxuser/code.js private@example.com 192.168.10.25 [2001:db8::2]`;
  const output = sanitizeText(input);
  for (const secret of ['privateuser', 'macuser', 'linuxuser', 'private@example.com', '192.168.10.25', '2001:db8::2']) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /download\.js/);
  assert.match(output, /extension\.js/);
  assert.equal(sanitizeUrl('https://192.168.10.25/v1/files'), 'https://redacted.invalid/v1/files');
  assert.equal(sanitizeText('HTTP 429; FILE_VIRUS_INFECTED; document.readyState=complete'), 'HTTP 429; FILE_VIRUS_INFECTED; document.readyState=complete');
});

test('masks complete OS username components containing spaces in text, URLs, metadata and reports', () => {
  const fixtures = [
    [String.raw`C:\Users\John Doe\AppData\secret.txt`, String.raw`C:\Users\[REDACTED]\AppData\secret.txt`],
    ['C:/Users/John Doe/AppData/secret.txt', 'C:/Users/[REDACTED]/AppData/secret.txt'],
    ['/Users/John Doe/code.js', '/Users/[REDACTED]/code.js'],
    ['/home/Jane Doe/code.js', '/home/[REDACTED]/code.js'],
    ['file:///C:/Users/John%20Doe/AppData/secret.txt', 'file:///C:/Users/[REDACTED]/AppData/secret.txt'],
    ['file:///Users/John%2520Doe/code.js', 'file:///Users/[REDACTED]/code.js'],
    ['file:///home/Jane%20Doe/code.js', 'file:///home/[REDACTED]/code.js']
  ];
  for (const [input, expected] of fixtures) {
    assert.equal(sanitizeText(input), expected);
    if (input.startsWith('file:')) assert.equal(sanitizeUrl(input), expected);
    assert.deepEqual(sanitizeDeep({ path: input }), { path: expected });
    const output = sanitizeReport({ ...report(), error_message: input });
    assert.equal(output.error_message, expected);
    assert.equal(errorReportSchema.safeParse(output).success, true);
  }
});

test('redacts header tuples, token aliases, raw extension UUID metadata and compressed IPv6', () => {
  const input = {
    headers: [['Authorization', 'rawsecret'], ['Cookie', 'secondsecret']],
    api_token: 'rawsecret', csrf_token: 'rawsecret', secret_key: 'rawsecret',
    extension_uuid: 'private-extension-uuid', security_block: true
  };
  const output = sanitizeDeep(input);
  assert.equal(JSON.stringify(output).includes('rawsecret'), false);
  assert.equal(JSON.stringify(output).includes('secondsecret'), false);
  assert.equal(JSON.stringify(output).includes('private-extension-uuid'), false);
  assert.equal(output.security_block, true);
  assert.equal(sanitizeText('::1 fe80::a1 2001:db8::2').includes('::'), false);
  assert.equal(sanitizeText('headers=[["Authorization","rawsecret"],["Cookie","secondsecret"]]').includes('secret'), false);
});

test('redacts common session aliases in text, serialized headers and nested metadata', () => {
  const fixtures = [
    ['X-Session-Id', 'raw-session-secret'],
    ['JSESSIONID', 'java-session-secret'],
    ['PHPSESSID', 'php-session-secret']
  ];
  for (const [key, credential] of fixtures) {
    assert.equal(sanitizeText(`${key}: ${credential}`).includes(credential), false);
    assert.equal(sanitizeText(`${key}=${credential}`).includes(credential), false);
    assert.equal(sanitizeText(JSON.stringify({ headers: { [key]: credential } })).includes(credential), false);
    assert.equal(JSON.stringify(sanitizeDeep({ headers: { [key]: credential } })).includes(credential), false);
  }
});

test('deep sanitization preserves useful evidence while bounding hostile objects without invoking getters', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"rawsecret","prototype":"rawsecret","security_block":true,"http_status":429,"authorization":"rawsecret"}');
  input.self = input;
  input.nested = { apiKey: 'rawsecret', child: { token: 'rawsecret', tooDeep: { private: 'rawsecret' } } };
  input.values = Array.from({ length: 100 }, () => 'x'.repeat(2000));
  Object.defineProperty(input, 'getter', { enumerable: true, get() { throw new Error('getter executed'); } });
  const output = sanitizeDeep(input);
  assert.equal(output.security_block, true);
  assert.equal(output.http_status, 429);
  assert.equal(output.authorization, '[REDACTED]');
  assert.equal(Object.hasOwn(output, '__proto__'), false);
  assert.equal(Object.hasOwn(output, 'constructor'), false);
  assert.equal(Object.hasOwn(output, 'prototype'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.stringify(output).includes('rawsecret'), false);
  assert.equal(output.values.length, 16);
  assert.ok(output.values.every((value) => value.length <= 1024));
  assert.ok(JSON.stringify(output).length < 30000);
  assert.equal(input.authorization, 'rawsecret');
  assert.equal(Object.keys(sanitizeDeep(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])))).length, 32);
  assert.equal(sanitizeDeep(Infinity), null);
  assert.equal(sanitizeDeep(1n), null);
});

test('report sanitization retains grouping dimensions, schema validity and caller ownership', () => {
  const input = report();
  input.error_message = 'Failed for private@example.com; token=rawsecret';
  input.error_name = 'Error token=rawsecret';
  input.stack_trace = 'Error: token=rawsecret\n at download (chrome-extension://private-extension/download.js?key=rawsecret:1:2)';
  input.breadcrumbs[0].metadata = { security_block: true, api_key: 'rawsecret', detail: '{"Cookie":"rawsecret"}', endpoint: 'https://user:rawsecret@api.invalid/files?key=rawsecret' };
  input.dom_state = { document_ready_state: 'complete', page_kind: 'collection', selectors: [{ selector: '[data-token="rawsecret"] a[href="https://api.invalid/files?key=rawsecret"]', matched: false }], api_schema: { expected: 'token=rawsecret', received: 'Error private@example.com', missing_fields: ['collection_host'] } };
  input.context = { api_endpoint: 'https://api.nexusmods.com/v1/files', online: true };
  const before = structuredClone(input);
  const output = sanitizeReport(input);
  assert.equal(errorReportSchema.safeParse(output).success, true);
  assert.deepEqual(input, before);
  assert.notEqual(output.breadcrumbs, input.breadcrumbs);
  assert.notEqual(output.context, input.context);
  for (const field of ['install_id', 'version', 'error_category', 'error_code', 'failure_stage', 'destination']) assert.equal(output[field], input[field]);
  assert.equal(output.breadcrumbs[0].metadata.security_block, true);
  assert.equal(JSON.stringify(output).includes('rawsecret'), false);
  assert.equal(JSON.stringify(output).includes('private-extension'), false);
  assert.equal(JSON.stringify(output).includes('private@example.com'), false);
});

test('sanitizes credentials in every mutable schema-valid version and identifier field', () => {
  const input = report();
  input.browser_version = 'Bearer browser-secret';
  input.os_version = 'Basic os-secret';
  input.error_category = 'token:category-secret';
  input.error_code = 'Authorization:code-secret';
  input.failure_stage = 'session_token:stage-secret';
  input.collection_id = 'Bearer_collection-secret';
  input.breadcrumbs[0].stage = 'Cookie:breadcrumb-secret';
  input.breadcrumbs[0].action = 'api_key:action-secret';
  input.breadcrumbs[0].metadata = { 'Authorization:metadata-secret': 'safe-value', security_block: true };
  input.dom_state = { document_ready_state: 'complete', page_kind: 'collection', selectors: [], api_schema: { missing_fields: ['Authorization:field-secret'] } };
  errorReportSchema.parse(input);
  const output = sanitizeReport(input);
  assert.equal(errorReportSchema.safeParse(output).success, true);
  for (const field of ['browser_version', 'os_version', 'error_category', 'error_code', 'failure_stage', 'collection_id']) {
    assert.equal(output[field], 'REDACTED');
  }
  assert.equal(output.breadcrumbs[0].stage, 'REDACTED');
  assert.equal(output.breadcrumbs[0].action, 'REDACTED');
  assert.deepEqual(output.dom_state.api_schema.missing_fields, ['REDACTED']);
  assert.equal(output.breadcrumbs[0].metadata.security_block, true);
  assert.equal(JSON.stringify(output).includes('-secret'), false);
  for (const field of ['report_id', 'install_id', 'occurred_at', 'version', 'browser', 'os', 'destination', 'severity', 'consent']) {
    assert.equal(output[field], input[field]);
  }
});

test('preserves safe legitimate versions, collection tokens and namespaced diagnostic identifiers', () => {
  const input = report();
  input.browser_version = '144.0 Stable';
  input.os_version = 'Windows 11';
  input.collection_id = 'token_dictionary-42';
  input.mod_id = '123456';
  input.error_category = 'NEXUS:HTTP';
  input.error_code = 'HTTP_429';
  input.failure_stage = 'PRIMARY_API_REQUEST';
  input.breadcrumbs[0].metadata = { 'network:retry_after': 60, security_block: false };
  input.dom_state = { document_ready_state: 'complete', page_kind: 'collection', selectors: [], api_schema: { missing_fields: ['download:files'] } };
  errorReportSchema.parse(input);
  assert.deepEqual(sanitizeReport(input), input);
});

test('redaction cannot expand a valid near-limit report beyond the ingest budget or field limits', () => {
  const input = report();
  input.error_name = 'key=x '.repeat(20);
  input.error_message = 'token=x '.repeat(250);
  input.breadcrumbs = Array.from({ length: 20 }, (_, index) => ({ timestamp_offset_ms: index, stage: 'API', action: 'REQUEST', status: 'error', metadata: { a: 'token=x '.repeat(128), b: 'token=x '.repeat(128) } }));
  errorReportSchema.parse(input);
  const output = sanitizeReport(input);
  assert.equal(errorReportSchema.safeParse(output).success, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(output)).length <= 65536);
  assert.ok(sanitizeText('x'.repeat(100000)).length <= 12000);
});
