import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELAYED_INSTALL_ID } from '../src/schemas/ingest.ts';
import { createAccessFixture } from './helpers/access.mjs';
import { EXTENSION, workerFixture } from './helpers/worker.mjs';

// Automatic reports the relay copies from the extension's Discord path: no installation identifier,
// no OS, and Discord already has them.
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fixture-webhook-token-0123456789';
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;
const identity = { error_category: 'nexus_api_changed', error_code: 'nexus_api_changed', failure_stage: 'nexus_api_changed',
  destination: 'browser', stack_trace: 'ext://content/main.js:10:4' };
function relayed(n, overrides = {}) {
  return { schema_version: 1, consent: 'automatic-v1', report_id: uuid(n), occurred_at: '2026-10-23T12:00:00.000Z',
    version: '3.3.1', browser: 'edge', browser_version: '155', download_mode: 'manual', severity: 'error',
    error_name: 'ExtensionError', error_message: 'Reading collection response', breadcrumbs: [], context: {}, ...identity, ...overrides };
}
function extension(n, install, overrides = {}) {
  const { consent, ...fields } = relayed(n);
  return { ...fields, consent: 'diagnostics-v1', install_id: install, os: 'windows', ...overrides };
}

async function fixture(t, overrides = {}) {
  const access = await createAccessFixture(t);
  const discord = [];
  const accessFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://discord.com/')) { discord.push(url); return new Response(null, { status: 204 }); }
    return accessFetch(input, init);
  });
  const dashboard = workerFixture(t, { DISCORD_WEBHOOK_URL: WEBHOOK, ...overrides });
  const admin = async (path) => (await dashboard.request(`/api/admin${path}`, { headers: await access.headers() })).json();
  return { ...dashboard, discord, admin };
}

test('a relayed automatic report is stored without an installation or OS, once, and is not posted to Discord again', async (t) => {
  const { db, pending, discord, post } = await fixture(t);
  const accepted = await post('/api/ingest/automatic', relayed(1));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, report_id: uuid(1), duplicate: false });
  assert.equal(accepted.headers.get('access-control-allow-origin'), EXTENSION);
  await Promise.all(pending);
  assert.deepEqual(discord, [], 'the relay has already posted it to Discord');
  const stored = db.sqlite.prepare('SELECT install_id, os, os_version FROM reports').get();
  assert.deepEqual({ ...stored }, { install_id: RELAYED_INSTALL_ID, os: 'other', os_version: null });
  const retry = await post('/api/ingest/automatic', relayed(1));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true, 'an identical retry is the same report');
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);

  // The private-dashboard path still posts to Discord for its own reports.
  assert.equal((await post('/api/ingest', extension(2, 'b'.repeat(64)))).status, 202);
  await Promise.all(pending);
  assert.equal(discord.length, 1);
});

test('only the relay contract is accepted: no installation, OS or foreign origin, and the placeholder stays reserved', async (t) => {
  const { db, post, request } = await fixture(t);
  for (const extra of [{ install_id: 'b'.repeat(64) }, { os: 'windows' }, { consent: 'diagnostics-v1' }, { dom_state: { document_ready_state: 'complete', page_kind: 'mod' } }]) {
    assert.equal((await post('/api/ingest/automatic', relayed(3, extra))).status, 400, JSON.stringify(extra));
  }
  assert.equal((await post('/api/ingest/automatic', relayed(3), { origin: 'https://hostile.test' })).status, 403);
  const preflight = await request('/api/ingest/automatic', { method: 'OPTIONS', headers: { origin: EXTENSION,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  const reserved = await post('/api/ingest', extension(4, RELAYED_INSTALL_ID));
  assert.equal(reserved.status, 400, 'the public path cannot pass a report off as relayed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('relayed reports group with the same fault from the private path and never count as an installation', async (t) => {
  const { post, admin } = await fixture(t);
  assert.equal((await post('/api/ingest', extension(1, 'b'.repeat(64)))).status, 202);
  for (const n of [2, 3]) assert.equal((await post('/api/ingest/automatic', relayed(n))).status, 202);
  const list = await admin('/issues?from=2026-10-01&to=2026-10-31');
  assert.equal(list.items.length, 1, 'one fault, one issue, whichever path reported it');
  const [issue] = list.items;
  assert.equal(issue.total_occurrences, 3);
  assert.equal(issue.affected_installs_count, 1);
  assert.equal(issue.relayed_report_count, 2);
  const detail = await admin(`/issues/${issue.id}`);
  assert.equal(detail.issue.affected_installs_count, 1);
  assert.equal(detail.report_summary.retained_distinct_installs, 1);
  assert.deepEqual(detail.report_summary.operating_systems, ['windows']);
  const reports = await admin(`/issues/${issue.id}/reports`);
  const sources = reports.items.map((item) => [item.source, item.install_id, item.os]).sort();
  assert.deepEqual(sources, [['extension', 'b'.repeat(64), 'windows'], ['relay', null, null], ['relay', null, null]]);
  const filtered = await admin('/issues?from=2026-10-01&to=2026-10-31&os=other');
  assert.equal(filtered.items.length, 0, 'an OS that was not reported does not match an OS filter');

  // A fault seen only through the relay has reports, but no known installation.
  assert.equal((await post('/api/ingest/automatic', relayed(4, { error_code: 'timeout', error_category: 'timeout', failure_stage: 'timeout' }))).status, 202);
  const relayOnly = (await admin('/issues?from=2026-10-01&to=2026-10-31')).items.find((item) => item.error_code === 'timeout');
  assert.equal(relayOnly.affected_installs_count, 0);
  assert.equal(relayOnly.relayed_report_count, 1);
});

test('report spikes need distinct real installations; relayed reports add reports, never installations', async (t) => {
  const { post, admin } = await fixture(t);
  const now = new Date(Date.now() - 60_000).toISOString();
  for (let n = 1; n <= 10; n++) assert.equal((await post('/api/ingest/automatic', relayed(n, { occurred_at: now }))).status, 202);
  for (const [n, install] of [[11, 'b'], [12, 'c']]) assert.equal((await post('/api/ingest', extension(n, install.repeat(64), { occurred_at: now }))).status, 202);
  let overview = await admin('/overview');
  assert.deepEqual(overview.alerts.spikes, [], 'two installations are below the threshold of three');
  assert.equal(overview.reports.distinct_installs, 2);
  assert.equal((await post('/api/ingest', extension(13, 'd'.repeat(64), { occurred_at: now }))).status, 202);
  overview = await admin('/overview');
  assert.equal(overview.alerts.spikes.length, 1);
  assert.equal(overview.alerts.spikes[0].report_count, 13);
  assert.equal(overview.alerts.spikes[0].distinct_installs, 3);
});
