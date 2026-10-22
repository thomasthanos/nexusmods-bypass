import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareExampleReport, sendPreparedReport } from '../examples/send-report.ts';
import { errorReportSchema } from '../src/schemas/ingest.ts';

const options = {
  relayOrigin: 'https://diagnostics.invalid',
  diagnosticsOptedIn: true,
  anonymousInstallSeed: 'e2f586fd-5191-4014-bbe0-9c7d015a04f3',
  version: '3.2.0',
  browser: 'chrome',
  browserVersion: '144.0',
  os: 'windows'
};

test('example sends nothing and creates no report after consent is denied or revoked', async () => {
  assert.equal(await prepareExampleReport({ ...options, diagnosticsOptedIn: false }), null);
  assert.equal(await sendPreparedReport({ url: 'https://diagnostics.invalid', report_id: 'unused', body: '{}' }, false), false);
});

test('example creates a valid payload with stable anonymous install identity and unique reports', async () => {
  const first = await prepareExampleReport(options);
  const second = await prepareExampleReport(options);
  const parsed = errorReportSchema.parse(JSON.parse(first.body));
  assert.equal(first.url, 'https://diagnostics.invalid/api/ingest');
  assert.equal(parsed.install_id, '53228f51aa78ab42032c7e031b111cddd9421e6bced4c680af8590d2d33349d6');
  assert.equal(parsed.install_id, JSON.parse(second.body).install_id);
  assert.notEqual(first.report_id, second.report_id);
  assert.equal(first.body.includes(options.anonymousInstallSeed), false);
});

test('example rejects an unsafe relay URL or an identity that is not a random UUID', async () => {
  for (const relayOrigin of ['http://diagnostics.invalid', 'https://user:pass@diagnostics.invalid', 'https://diagnostics.invalid/path', 'https://diagnostics.invalid?token=private']) {
    await assert.rejects(prepareExampleReport({ ...options, relayOrigin }));
  }
  await assert.rejects(prepareExampleReport({ ...options, anonymousInstallSeed: 'account@example.com' }));
});

test('retries preserve the request identity and omit cookies and authorization', async (t) => {
  const prepared = await prepareExampleReport(options);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(new Request(url, init));
    return new Response(null, { status: 202 });
  });
  await sendPreparedReport(prepared, true);
  await sendPreparedReport(prepared, true);
  assert.equal(await requests[0].text(), prepared.body);
  assert.equal(await requests[1].text(), prepared.body);
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].headers.has('Authorization'), false);
  assert.equal(requests[0].headers.has('Cookie'), false);
});
