import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

const ORIGIN = 'https://diagnostics.test';
const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;
function report(overrides = {}) {
  return { schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(1), install_id: 'a'.repeat(64),
    occurred_at: '2026-10-21T12:00:00.000Z', version: '3.2.0', browser: 'chrome', browser_version: '144',
    os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error',
    error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST',
    error_message: 'Failed to fetch', ...overrides };
}
function heartbeat(overrides = {}) {
  return { schema_version: 1, consent: 'telemetry-v1', heartbeat_id: uuid(1), install_id: 'a'.repeat(64),
    metric_date: '2026-10-21', version: '3.2.0', browser: 'chrome', destination: 'browser',
    attempts_count: 10, success_count: 8, fallback_triggered_count: 3, ...overrides };
}
function fixture(t, overrides = {}) {
  const db = createTestDatabase();
  const pending = [];
  let assetCalls = 0;
  const env = bindings(db, { ASSETS: { async fetch() { assetCalls++; return new Response('private asset', { headers: { 'cache-control': 'public, max-age=3600' } }); } }, ...overrides });
  const context = { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {}, props: {} };
  t.after(async () => { await Promise.allSettled(pending); db.close(); });
  const request = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, context);
  const post = (path, value, headers = {}) => request(path, { method: 'POST', headers: {
    origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10', ...headers
  }, body: JSON.stringify(value) });
  return { db, env, pending, request, post, assetCalls: () => assetCalls };
}

test('public ingest sanitizes before storage and schedules delivery exactly once for retries', async (t) => {
  const { db, pending, post } = fixture(t);
  const input = report({ error_message: 'Failed to fetch Authorization: Bearer private-token',
    stack_trace: 'download@chrome-extension://private-extension/background.js?key=secret:10:20' });
  const accepted = await post('/api/ingest', input);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, report_id: uuid(1), duplicate: false });
  assert.equal(accepted.headers.get('access-control-allow-origin'), EXTENSION);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  const retry = await post('/api/ingest', input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(pending.length, 1);
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
  const persisted = JSON.stringify(db.sqlite.prepare('SELECT * FROM reports').all());
  assert.equal(persisted.includes('private-token'), false);
  assert.equal(persisted.includes('private-extension'), false);
  assert.equal(persisted.includes('?key=secret'), false);
});

test('heartbeat accepts one immutable delta and conflicts on altered identity without scheduling delivery', async (t) => {
  const { db, pending, post } = fixture(t);
  assert.equal((await post('/api/heartbeat', heartbeat())).status, 202);
  const replay = await post('/api/heartbeat', heartbeat());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, heartbeat_id: uuid(1), duplicate: true });
  assert.equal((await post('/api/heartbeat', heartbeat({ success_count: 7 }))).status, 409);
  assert.equal(db.sqlite.prepare('SELECT attempts_count FROM release_metrics').get().attempts_count, 10);
  assert.equal(pending.length, 0);
});

test('extension origins, preflight and exact route boundaries are enforced before database writes', async (t) => {
  const { db, request, post } = fixture(t);
  for (const origin of ['', 'null', 'https://www.nexusmods.com', `${EXTENSION}.evil.test`]) {
    assert.equal((await post('/api/ingest', report(), { origin })).status, 403, origin);
  }
  const preflight = await request('/api/ingest', { method: 'OPTIONS', headers: { origin: EXTENSION,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } });
  assert.equal(preflight.status, 204);
  assert.equal((await request('/api/ingest', { headers: { origin: EXTENSION } })).status, 405);
  assert.equal((await post('/api/ingest/extra', report())).status, 401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('invalid JSON/schema and raw body overflow return safe readable public errors', async (t) => {
  const { request, post, db } = fixture(t);
  assert.equal((await post('/api/ingest', { ...report(), consent: undefined })).status, 400);
  const headers = { origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' };
  assert.equal((await request('/api/ingest', { method: 'POST', headers, body: '{broken' })).status, 400);
  const large = await request('/api/ingest', { method: 'POST', headers: { ...headers, 'content-length': '2' }, body: `${' '.repeat(65536)}{}` });
  assert.equal(large.status, 413);
  assert.equal(large.headers.get('access-control-allow-origin'), EXTENSION);
  assert.equal((await request('/api/heartbeat', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('public install limits return Retry-After and store HMAC subjects without raw IPs', async (t) => {
  const { post, db } = fixture(t, { INGEST_INSTALL_LIMIT: '1' });
  assert.equal((await post('/api/ingest', report())).status, 202);
  const limited = await post('/api/ingest', report({ report_id: uuid(2) }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const buckets = JSON.stringify(db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all());
  assert.equal(buckets.includes('203.0.113.10'), false);
  assert.equal(buckets.includes('a'.repeat(64)), false);
});

test('all admin, unknown API and static paths require genuine signed Access assertions', async (t) => {
  const access = await createAccessFixture(t);
  const { request, assetCalls } = fixture(t);
  for (const path of ['/', '/app.js', '/sw.js', '/api/admin/overview', '/api/unknown']) {
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal(assetCalls(), 0);
  const headers = await access.headers();
  assert.equal((await request('/api/admin/overview', { headers })).status, 200);
  const asset = await request('/', { headers });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'private asset');
  assert.equal(asset.headers.get('cache-control'), 'no-store');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request('/api/unknown', { headers })).status, 404);
  assert.equal(assetCalls(), 1);
});

test('forged, expired, wrong-audience and cookie-only assertions fail closed', async (t) => {
  const access = await createAccessFixture(t);
  const { request } = fixture(t);
  const signed = await access.token();
  const forgedParts = signed.split('.');
  const claims = JSON.parse(Buffer.from(forgedParts[1], 'base64url').toString());
  forgedParts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'forged-user' })).toString('base64url');
  for (const token of [forgedParts.join('.'), await access.token({ exp: 1 }), await access.token({ aud: ['wrong-audience'] })]) {
    assert.equal((await request('/api/admin/overview', { headers: { 'cf-access-jwt-assertion': token } })).status, 401);
  }
  assert.equal((await request('/', { headers: { cookie: `CF_Authorization=${signed}` } })).status, 401);
});

test('PWA assets keep private caching and enforce script and worker origin boundaries', async (t) => {
  const access = await createAccessFixture(t);
  const { request } = fixture(t);
  const headers = await access.headers();
  const asset = await request('/', { headers });
  const policy = asset.headers.get('content-security-policy');
  assert.ok(policy?.includes("script-src 'self' https://cdn.jsdelivr.net"));
  assert.ok(policy.includes("worker-src 'self'"));
  assert.ok(policy.includes("connect-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.equal(asset.headers.get('cross-origin-resource-policy'), 'same-origin');
  const sw = await request('/sw.js', { headers });
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.equal(sw.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/sw.js')).status, 401);
});

test('protected mutations require same Origin and push tests are capped per verified identity', async (t) => {
  const access = await createAccessFixture(t);
  const { request } = fixture(t);
  const headers = await access.headers({ 'content-type': 'application/json' });
  for (const origin of [undefined, 'https://attacker.test']) {
    const supplied = origin ? { ...headers, origin } : headers;
    assert.equal((await request('/api/admin/push/test', { method: 'POST', headers: supplied, body: '{}' })).status, 403);
  }
  const sameOrigin = { ...headers, origin: ORIGIN };
  assert.equal((await request('/api/admin/push/test', { method: 'POST', headers: sameOrigin, body: '{}' })).status, 200);
  const limited = await request('/api/admin/push/test', { method: 'POST', headers: sameOrigin, body: '{}' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('accepted response does not await Discord HTTP and provider failure cannot undo persistence', async (t) => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  t.after(() => finish());
  t.mock.method(globalThis, 'fetch', async () => { await blocked; return new Response(null, { status: 503 }); });
  const { post, pending, db } = fixture(t, { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx' });
  const response = await post('/api/ingest', report());
  assert.equal(response.status, 202);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  assert.equal(pending.length, 1);
  finish();
  await Promise.all(pending);
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
});

test('persistence failure returns generic service error without logging SQL or unsanitized report text', async (t) => {
  const { post, db, pending } = fixture(t);
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  db.sqlite.exec("CREATE TRIGGER reject_api_report BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'private-SQL-failure'); END;");
  const response = await post('/api/ingest', report({ error_message: 'Authorization: Bearer private-report-secret' }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes('private-'), false);
  assert.equal(JSON.stringify(logs).includes('private-'), false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(pending.length, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
