import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import relay, { dashboardReport, validateReport } from '../../relay/worker.js';
import { RELAYED_INSTALL_ID, relayedReportSchema } from '../src/schemas/ingest.ts';
import { EXTENSION, workerFixture } from './helpers/worker.mjs';

// The relay copies automatic reports from the extension's Discord path into this service. Both sides
// are tested together here, against the extension's own reporters loaded as the browser runs them.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fixture-webhook-token-0123456789';

async function extension() {
  const context = vm.createContext({ URL, Date, console, setTimeout, clearTimeout, AbortController, structuredClone,
    crypto: webcrypto, TextEncoder, navigator: { userAgent: USER_AGENT } });
  for (const name of ['lib/shared.js', 'lib/auto-reports.js']) {
    vm.runInContext(await readFile(new URL(`../../src/${name}`, import.meta.url), 'utf8'), context);
  }
  const kit = context.NXTK;
  const { Reporter, DiagnosticsReporter } = context.NXTKAutoReports;
  // What one browser sends: the legacy payload for the relay, and the private-dashboard body.
  return async function reports(error, { extended = false, log = [] } = {}) {
    const store = { [kit.SETTINGS_KEY]: { AutoErrorReports: true, AutoReportDiagnostics: extended }, [kit.DEBUG_LOG_KEY]: log };
    const sent = [];
    const deps = {
      kit, read: async (key, fallback) => structuredClone(store[key] ?? fallback), write: async (key, value) => { store[key] = structuredClone(value); },
      api: { runtime: { getManifest: () => ({ version: '3.3.1' }) }, alarms: { create: async () => {}, clear: async () => {} } },
      fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    };
    const legacy = new Reporter(deps);
    await legacy.enqueue(kit.buildErrorEntry(error));
    await legacy.flush();
    assert.equal(sent.length, 1, 'the extension sent its legacy automatic report');
    const payload = sent[0];
    const privatePath = await new DiagnosticsReporter(deps).prepareDelivery({ payload: structuredClone(payload) });
    return { payload, privatePath: JSON.parse(JSON.stringify(privatePath)) };
  };
}

test('the relay copy matches what the extension sends the dashboard itself, minus installation and OS', async () => {
  const reports = await extension();
  const at = Date.now() - 30_000;
  const cases = [
    { code: 'nexus_api_changed', context: 'Reading collection response', action: 'collection run · browser', status: 503,
      technicalMessage: 'No collectionRevision in response', stack: 'Error\n    at read (ext://content/ndc.js:42:5)', at },
    { code: 'request_failed', causeCode: 'NETWORK_FAILED', context: 'Vortex handoff', action: 'Send to Vortex (nxm:)', at },
    { code: 'nexus_page_changed', context: 'Mod files tab', technicalMessage: 'No download button', at },
    { code: 'background_error', context: 'Queue tick', technicalMessage: 'Cannot read properties of undefined', at }
  ];
  for (const [index, error] of cases.entries()) {
    const extended = index === 3;
    const log = extended ? [{ at: at - 2000, level: 'warn', page: 'extension', text: 'Retrying the queue' },
      { at: at - 1000, level: 'error', page: 'extension', text: 'Queue item failed' }] : [];
    const { payload, privatePath } = await reports(error, { extended, log });
    assert.equal(validateReport(payload), '', 'the relay accepts the legacy payload');
    const copy = await dashboardReport(payload);
    relayedReportSchema.parse(copy);
    const { report_id, consent, ...fields } = copy;
    assert.equal(consent, 'automatic-v1');
    assert.match(report_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const { report_id: _private, consent: _consent, install_id, os, ...privateFields } = privatePath;
    assert.match(install_id, /^[0-9a-f]{64}$/);
    assert.equal(os, 'windows');
    assert.deepEqual(fields, privateFields, `${error.code}: the same fields, so the fault groups into the same issue`);
    if (extended) assert.equal(fields.breadcrumbs.length, 2, 'extra diagnostics travel only with their own consent');
  }
});

test('every payload the relay accepts becomes a report the dashboard accepts, with a stable id', async () => {
  const base = { schema: 1, kind: 'auto', version: '3.3.1', browser: 'Chrome 155', firstAt: '2026-10-23T12:00:00.000Z',
    error: { code: 'request_failed', context: 'x' } };
  const variants = [
    base,
    { ...base, error: { code: '' } },
    { ...base, browser: 'Unknown browser', firstAt: undefined },
    { ...base, firstAt: '2026-10-23T12:00:00Z', error: { code: 'x', message: 'a\u0000b', context: '\u0000' } },
    { ...base, severity: 'critical', error: { code: '9starts-with-digit', causeCode: 'NETWORK_TIMEOUT', status: null, frame: '' } },
    { ...base, diagnostics: { consent: 'extended-v1', logs: [
      { at: '2026-10-23T12:00:05.000Z', level: 'info', page: 'mod', text: 'later' },
      { at: '2026-10-23T11:59:59.000Z', level: 'debug', page: 'mod', text: 'earlier' }] } }
  ];
  for (const variant of variants) {
    assert.equal(validateReport(variant), '', JSON.stringify(variant));
    const copy = await dashboardReport(variant, Date.parse('2026-10-23T12:00:30.000Z'));
    const parsed = relayedReportSchema.safeParse(copy);
    assert.ok(parsed.success, `${JSON.stringify(variant)} -> ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal((await dashboardReport(variant, Date.parse('2026-10-23T12:00:30.000Z'))).report_id, copy.report_id, 'a retry reaches the same report');
  }
  assert.notEqual((await dashboardReport(base)).report_id, (await dashboardReport({ ...base, firstAt: '2026-10-23T12:00:01.000Z' })).report_id);
  assert.equal((await dashboardReport(variants[3])).error_message, 'ab');
  assert.deepEqual((await dashboardReport(variants[5])).breadcrumbs.map((crumb) => crumb.metadata.detail), ['earlier', 'later']);
});

test('an automatic report sent to the relay is stored once by the dashboard, without an installation or OS', async (t) => {
  // One report through both Workers. Each side's own rules (Discord dedupe, which origins are copied, no
  // second Discord post) are pinned in tests/unit/relay-diagnostics-test.mjs and relayed.test.mjs.
  const dashboard = workerFixture(t, { DISCORD_WEBHOOK_URL: WEBHOOK });
  const { db, pending, context } = dashboard;
  const env = { DISCORD_WEBHOOK_URL: WEBHOOK, RELAY_EXTENSION_VERSION: '3.3.1', DIAGNOSTICS: { fetch: dashboard.fetch } };
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const payload = { schema: 1, kind: 'auto', version: '3.3.1', browser: 'Firefox 144', reference: 'E-0contra', occurrences: 2,
    firstAt: new Date(Date.now() - 60_000).toISOString(), lastAt: new Date().toISOString(),
    error: { code: 'nexus_api_changed', context: 'Contract test response', message: 'Missing field' } };
  const send = () => relay.fetch(new Request('https://relay.test/v1/report', { method: 'POST',
    headers: { origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77' }, body: JSON.stringify(payload) }), env, context);
  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).ok, true);
  await send();
  await Promise.all(pending); await Promise.all(pending);
  const stored = db.sqlite.prepare('SELECT install_id, os, browser, error_category FROM reports').all().map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ install_id: RELAYED_INSTALL_ID, os: 'other', browser: 'firefox', error_category: 'API_SCHEMA_MISMATCH' }],
    'the identical retry is one dashboard report');
});
