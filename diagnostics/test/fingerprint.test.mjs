import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import { fingerprintReport, normalizedTopFrame, normalizeStack } from '../src/utils/fingerprint.ts';
import { sanitizeText } from '../src/utils/sanitize.ts';

const report = (stack_trace) => errorReportSchema.parse({
  schema_version: 1, consent: 'diagnostics-v1', report_id: '3761cb55-49b3-4f63-bbad-74c5cc586528',
  install_id: 'a'.repeat(64), occurred_at: '2026-10-21T10:00:00.000Z', version: '3.2.0',
  browser: 'chrome', browser_version: '144.0', os: 'windows', download_mode: 'auto',
  destination: 'vortex', severity: 'error', error_category: 'HANDOFF', error_code: 'NXM_TIMEOUT',
  failure_stage: 'NXM_OPEN', error_message: 'private error message', stack_trace
});

test('Chrome and Firefox frames normalize to recognizable stable function and file locations', () => {
  const chrome = 'Error: rawsecret\n    at download (chrome-extension://rawsecret/scripts/download.js?token=rawsecret:123:8)\n    at run (https://api.invalid/client.js?key=rawsecret:2:90)';
  const firefox = 'download@moz-extension://rawsecret/scripts/download.js?key=rawsecret:500:66\nrun@https://api.invalid/client.js?token=rawsecret:99:3';
  assert.equal(normalizeStack(chrome), 'download@extension:///scripts/download.js\nrun@https://api.invalid/client.js');
  assert.equal(normalizeStack(firefox), 'download@extension:///scripts/download.js\nrun@https://api.invalid/client.js');
  assert.equal(normalizedTopFrame(chrome), 'download@extension:///scripts/download.js');
});

test('Firefox relative file frames are parsed before email-shaped stack syntax is sanitized', () => {
  assert.equal(normalizeStack('download@content.js:15:3\nrun@background.mjs:20:7'), 'download@content.js\nrun@background.mjs');
  assert.equal(normalizeStack('private@example.js'), '<unknown>');
});

test('line/column, extension IDs, query values and error messages do not split a fingerprint', async () => {
  const first = report('Error: rawsecret\n    at a (chrome-extension://first-private-id/bundle.min.js?token=rawsecret:1:24)');
  const second = report('Error: other-private-message\n    at a (moz-extension://second-private-id/bundle.min.js?token=othersecret:888:908)');
  second.error_message = 'another email private@example.com';
  const a = await fingerprintReport(first);
  const b = await fingerprintReport(second);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.normalized_top_frame, 'a@extension:///bundle.min.js');
  assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(a).includes('rawsecret'), false);
  assert.equal(JSON.stringify(b).includes('othersecret'), false);
});

test('the digest hashes the original five grouping dimensions as an unambiguous JSON tuple', async () => {
  const input = report('Error: private\n    at handoff (https://site.invalid/download.js:15:6)');
  const result = await fingerprintReport(input);
  const expected = createHash('sha256').update('["HANDOFF","NXM_TIMEOUT","NXM_OPEN","handoff@https://site.invalid/download.js","vortex"]').digest('hex');
  assert.equal(result.fingerprint, expected);
  for (const [field, value] of [['error_category', 'NETWORK'], ['error_code', 'OTHER'], ['failure_stage', 'RESOLVE'], ['destination', 'mo2']]) {
    assert.notEqual((await fingerprintReport({ ...input, [field]: value })).fingerprint, result.fingerprint);
  }
  assert.equal((await fingerprintReport({ ...input, http_status: 429, error_message: 'Failed to fetch' })).fingerprint, result.fingerprint);
});

test('credential-bearing grouping dimensions are sanitized before hashing and credential drift is stable', async () => {
  const first = report('Error: private\n    at handoff (https://site.invalid/download.js:15:6)');
  first.error_category = 'token:category-first-secret';
  first.error_code = 'Authorization:code-first-secret';
  first.failure_stage = 'Cookie:stage-first-secret';
  const second = { ...first, error_category: 'token:category-second-secret', error_code: 'Authorization:code-second-secret', failure_stage: 'Cookie:stage-second-secret' };
  errorReportSchema.parse(first);
  errorReportSchema.parse(second);
  const result = await fingerprintReport(first);
  assert.equal(result.fingerprint, createHash('sha256').update('["REDACTED","REDACTED","REDACTED","handoff@https://site.invalid/download.js","vortex"]').digest('hex'));
  assert.equal(result.fingerprint, (await fingerprintReport(second)).fingerprint);
  assert.equal(JSON.stringify(result).includes('-secret'), false);
});

test('missing and unparseable stacks use a stable fallback without incorporating private messages', async () => {
  for (const stack of [undefined, '', 'Error: rawsecret', 'rawsecret private@example.com', 'arbitrary@rawsecret']) {
    assert.equal(normalizeStack(stack), '<unknown>');
    assert.equal(normalizedTopFrame(stack), '<unknown>');
    assert.equal(JSON.stringify(await fingerprintReport(report(stack))).includes('rawsecret'), false);
  }
  assert.equal((await fingerprintReport(report(undefined))).fingerprint, (await fingerprintReport(report('Error: private'))).fingerprint);
});

test('defensive stack sanitization masks credentials and usernames in every exported output', async () => {
  const stack = String.raw`Error: Authorization: Bearer rawsecret
    at download (file:///C:/Users/privateuser/download.js:10:3)
    at fetchFile (https://user:rawsecret@api.invalid/client.js?token=rawsecret:20:4)`;
  const outputs = [normalizeStack(stack), normalizedTopFrame(stack), JSON.stringify(await fingerprintReport(report(stack)))];
  for (const output of outputs) {
    for (const secret of ['rawsecret', 'privateuser', '?token', 'user:']) assert.equal(output.includes(secret), false);
  }
  assert.match(outputs[0], /download\.js/);
});

test('space-containing OS usernames never leak into normalized frames or split fingerprints', async () => {
  const first = 'Error: private\n    at download (file:///C:/Users/John%20Doe/AppData/download.js:10:3)';
  const second = 'Error: private\n    at download (file:///C:/Users/Jane%20Smith/AppData/download.js:20:6)';
  const outputs = [normalizeStack(first), normalizedTopFrame(first), JSON.stringify(await fingerprintReport(report(first)))];
  for (const output of outputs) {
    for (const component of ['John', 'Doe', 'John%20Doe']) assert.equal(output.includes(component), false);
    assert.match(output, /download\.js/);
  }
  assert.equal((await fingerprintReport(report(first))).fingerprint, (await fingerprintReport(report(second))).fingerprint);
  assert.equal(normalizeStack('download@file:///Users/John%20Doe/code.js:1:2'), 'download@file:///Users/[REDACTED]/code.js');
});

// The extension sends one frame, "function@script:line:column". The function is the same in every engine
// once V8's receiver ("NDC.", "Object.") and the async markers ("async ", Firefox's "async*") are gone,
// so a fault groups by the function it happened in, whichever browser reported it.
test('a frame the extension sends and the same raw stack from either engine group as one function', async () => {
  const chrome = 'TypeError: x is undefined\n    at async NDC.readRevisionMods (chrome-extension://abc/content/ndc.js:812:19)\n    at Object.run (chrome-extension://abc/content/ndc.js:900:5)';
  const firefox = 'async*readRevisionMods@moz-extension://1234-5678/content/ndc.js:812:42\nrun@moz-extension://1234-5678/content/ndc.js:900:7';
  const sent = 'readRevisionMods@ext://content/ndc.js:812:19';
  assert.equal(normalizeStack(chrome), 'readRevisionMods@extension:///content/ndc.js\nrun@extension:///content/ndc.js');
  assert.equal(normalizeStack(firefox), normalizeStack(chrome));
  assert.equal(normalizedTopFrame(sent), 'readRevisionMods@extension:///content/ndc.js');
  const fingerprint = async (stack) => (await fingerprintReport(report(stack))).fingerprint;
  assert.equal(await fingerprint(sent), await fingerprint(chrome), 'the frame a client sends matches the raw stack');
  assert.equal(await fingerprint(chrome), await fingerprint(firefox), 'Chrome and Firefox give one fingerprint');
  assert.notEqual(await fingerprint('readRevisionMods@ext://content/ndc.js:812:19'), await fingerprint('applyRevision@ext://content/ndc.js:812:19'),
    'two functions in one script are two issues');
  assert.equal(normalizedTopFrame('ext://content/ndc.js:42:5'), '<anonymous>@extension:///content/ndc.js', 'a frame without a function stays anonymous');
  assert.equal(normalizedTopFrame('outer/<@moz-extension://x/content/ui.js:5:6'), '<anonymous>@extension:///content/ui.js',
    'a nested Firefox closure has no name V8 would give it');
  assert.equal(normalizedTopFrame('    at new Deck (chrome-extension://abc/content/ui.js:5:6)'), 'Deck@extension:///content/ui.js');
});

test('a top-level script frame keeps its script instead of being redacted', () => {
  assert.equal(sanitizeText('ext://background.js:1200:3'), 'ext://background.js:1200:3');
  assert.equal(sanitizeText('fetchJob@ext://background.js:1200:3'), 'fetchJob@ext://background.js:1200:3');
  assert.equal(normalizedTopFrame('fetchJob@ext://background.js:1200:3'), 'fetchJob@extension:///background.js');
  assert.equal(sanitizeText('ext://background.js:1200:3?token=secret'), 'ext://background.js:1200:3', 'only a plain script position is kept as it is');
});
