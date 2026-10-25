import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import { acceptErrorReport } from '../src/services/ingestion.ts';
import { testDatabase } from './helpers/d1.mjs';

function client({ extended = false, privateConsent = true } = {}) {
  const context = vm.createContext({
    URL, Date, console, setTimeout, clearTimeout, AbortController, structuredClone, TextEncoder,
    crypto: webcrypto,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0' }
  });
  for (const name of ['lib/shared.js', 'lib/auto-reports.js']) {
    vm.runInContext(readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8'), context, { filename: name });
  }
  const kit = context.NXTK;
  const { DiagnosticsReporter, DIAGNOSTICS_KEY, INSTALL_SEED_KEY } = context.NXTKAutoReports;
  let now = Date.now();
  const store = { [kit.SETTINGS_KEY]: { AutoErrorReports: true, PrivateDiagnostics: privateConsent, AutoReportDiagnostics: extended } };
  const sent = [];
  let send = async (body) => Response.json({ ok: true, report_id: body.report_id }, { status: 202 });
  const deps = {
    kit,
    clock: () => now,
    read: async (key, fallback) => structuredClone(store[key] ?? fallback),
    write: async (key, value) => { store[key] = structuredClone(value); },
    api: {
      runtime: { getManifest: () => ({ version: '3.3.1' }) },
      alarms: { async create() {}, async clear() {} }
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body, credentials: init.credentials });
      return send(body);
    }
  };
  let reporter = new DiagnosticsReporter(deps);
  return {
    kit, store, sent, queueKey: DIAGNOSTICS_KEY, seedKey: INSTALL_SEED_KEY,
    get reporter() { return reporter; },
    get now() { return now; },
    advance(ms) { now += ms; },
    restart() { reporter = new DiagnosticsReporter(deps); },
    transport(fn) { send = fn; },
    entry(overrides = {}) {
      return kit.buildErrorEntry({
        at: now,
        code: 'nexus_api_changed',
        context: 'Reading collection metadata during automatic browser download',
        technicalMessage: 'Expected files list was missing',
        url: 'https://www.nexusmods.com/games/skyrimspecialedition/collections/example',
        stack: 'Error: expected files\n    at loadFiles (chrome-extension://abcdefghijklmnopabcdefghijklmnop/content/nexus-api.js:14:8)',
        ...overrides
      });
    }
  };
}

test('real opt-in extension payload satisfies the canonical schema and is stored once after a lost response', async (t) => {
  const f = client();
  const db = testDatabase(t);
  let accepted;
  f.transport(async (body) => {
    const parsed = errorReportSchema.parse(body);
    accepted = await acceptErrorReport(db, parsed, f.now);
    throw new TypeError('Response lost after the server committed');
  });
  await f.reporter.enqueue(f.entry({
    status: 502,
    technicalMessage: 'Expected field missing; jane@example.com token=client-secret https://example.invalid/path?key=query-secret'
  }));
  await f.reporter.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(accepted.accepted, true);
  const original = f.sent[0].body;
  assert.equal(f.sent[0].url, `${f.kit.RELAY_ORIGIN}/v1/diagnostics`);
  assert.equal(f.sent[0].credentials, 'omit');
  assert.equal(original.browser, 'edge');
  assert.equal(original.os, 'windows');
  assert.equal(original.download_mode, 'auto');
  assert.equal(original.destination, 'browser');
  assert.equal(original.http_status, 502);
  assert.equal(original.error_category, 'API_SCHEMA_MISMATCH');
  assert.equal(original.breadcrumbs.length, 0);
  assert.doesNotMatch(JSON.stringify(original), /jane@|client-secret|query-secret|abcdefghijklmnop/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM reports').get().count, 1);
  f.restart(); f.advance(60_000);
  f.transport(async (body) => {
    const result = await acceptErrorReport(db, errorReportSchema.parse(body), f.now);
    assert.equal(result.accepted, false);
    return Response.json({ ok: true, report_id: result.reportId, duplicate: true });
  });
  await f.reporter.flush();
  assert.deepEqual(f.sent[1].body, original, 'restarting retries the immutable report identity and content');
  assert.equal(f.store[f.queueKey].pending.length, 0);
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
  assert.equal(db.sqlite.prepare('SELECT affected_installs_count FROM issues').get().affected_installs_count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM heartbeat_receipts').get().count, 0);
});

test('extra debug consent produces bounded chronological breadcrumbs accepted by the real schema', async () => {
  const f = client({ extended: true });
  f.store[f.kit.DEBUG_LOG_KEY] = [
    { at: f.now - 20, level: 'warn', page: 'collection', text: 'token=debug-secret; retrying metadata' },
    { at: f.now - 10, level: 'error', page: 'collection', text: 'Expected files field missing' }
  ];
  f.transport(async (body) => {
    errorReportSchema.parse(body);
    throw new TypeError('Offline');
  });
  await f.reporter.enqueue(f.entry());
  await f.reporter.flush();
  const body = f.sent[0].body;
  assert.equal(body.breadcrumbs.length, 2);
  assert.deepEqual(body.breadcrumbs.map((line) => line.timestamp_offset_ms), [0, 10]);
  assert.doesNotMatch(JSON.stringify(body), /debug-secret/);
  f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = false;
  f.restart(); f.advance(60_000);
  await f.reporter.flush();
  assert.equal(f.sent.length, 1, 'a frozen report with extra logs cannot be retried after debug consent revocation');
  assert.equal(f.store[f.queueKey].pending.length, 0);
});

test('legacy consent never creates an installation identity and mismatched acknowledgements remain retryable', async () => {
  const f = client({ privateConsent: false, extended: true });
  assert.equal(await f.reporter.enqueue(f.entry()), false);
  assert.equal(Object.hasOwn(f.store, f.seedKey), false);
  assert.equal(f.sent.length, 0);
  f.store[f.kit.SETTINGS_KEY].PrivateDiagnostics = true;
  f.transport(async () => Response.json({ ok: true, report_id: crypto.randomUUID() }));
  await f.reporter.enqueue(f.entry());
  await f.reporter.flush();
  assert.equal(f.store[f.queueKey].pending.length, 1, 'a successful response for another report is not delivery confirmation');
  f.store[f.kit.SETTINGS_KEY].PrivateDiagnostics = false;
  f.restart(); f.advance(60_000);
  await f.reporter.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.store[f.queueKey].pending.length, 0);
});
