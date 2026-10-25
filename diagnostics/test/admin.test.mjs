import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import adminRoutes from '../src/routes/admin.ts';
import { testDatabase } from './helpers/d1.mjs';

const NOW = Date.UTC(2026, 9, 21, 12);
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;

function fixture(t) {
  const db = testDatabase(t);
  const env = { DB: db, MAX_BODY_BYTES: '65536', VAPID_PUBLIC_KEY: 'public-only', VAPID_PRIVATE_KEY: 'never-disclose', VAPID_SUBJECT: 'mailto:owner@example.org',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', PUSH_COOLDOWN_SECONDS: '1800', DETECTION_WINDOW_SECONDS: '900', SPIKE_REPORT_THRESHOLD: '10', DISTINCT_INSTALL_THRESHOLD: '3' };
  const app = new Hono();
  // Authentication is a production parent responsibility. This parent supplies
  // only the trusted server clock; it never introduces a runtime auth bypass.
  app.use('*', async (c, next) => { c.set('serverNow', NOW); await next(); });
  app.route('/api/admin', adminRoutes);
  const request = (path, options = {}) => app.request(`https://diagnostics.example.org/api/admin${path}`, options, env);
  const json = (path, body, method = 'PATCH', headers = {}) => request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { db, env, request, json };
}

function issue(db, overrides = {}) {
  const values = { fingerprint: 'a'.repeat(64), error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', normalized_top_frame: 'fetchFile@main.js', destination: 'browser', category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check connection.', first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.2.0', last_seen_version: '3.2.0', created_at: NOW, updated_at: NOW, ...overrides };
  const columns = Object.keys(values);
  return Number(db.sqlite.prepare(`INSERT INTO issues (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

function report(db, id, n, overrides = {}) {
  const values = { id: uuid(n), issue_id: id, install_id: (n % 10).toString().repeat(64), version: '3.2.0', browser: 'chrome', browser_version: '144', os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error', error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', error_name: 'TypeError', error_message: 'Failed to fetch', category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check connection.', occurred_at: NOW, created_at: NOW, ...overrides };
  const columns = Object.keys(values);
  db.sqlite.prepare(`INSERT INTO reports (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}

async function subscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint: 'https://web.push.apple.com/a-private-subscription-token', expirationTime: null, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url'), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } };
}

test('empty overview and release comparison use null percentages instead of NaN', async (t) => {
  const { request } = fixture(t);
  const overview = await (await request('/overview')).json();
  assert.equal(overview.issues.total, 0);
  assert.equal(overview.releases.success_rate_percent, null);
  const response = await request('/releases/compare?before=3.1.0&after=3.2.0');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.before.attempts_count, 0);
  assert.equal(value.before.success_rate_percent, null);
  assert.equal(value.success_rate_delta_pp, null);
});

test('issue report dimensions must match the same report and never multiply issue counts', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db);
  report(db, id, 1, { version: '3.1.0', browser: 'chrome' });
  report(db, id, 2, { version: '3.2.0', browser: 'firefox', error_message: 'Firefox unique failure' });
  assert.equal((await (await request('/issues?version=3.1.0&browser=firefox')).json()).total, 0);
  assert.equal((await (await request('/issues?browser=chrome&q=Firefox')).json()).total, 0);
  assert.equal((await (await request('/issues?browser=firefox&q=Firefox')).json()).total, 1);
  const value = await (await request('/issues?browser=chrome')).json();
  assert.equal(value.total, 1);
  assert.equal(value.items[0].total_occurrences, 2);
  assert.equal(typeof value.items[0].id, 'number');
});

test('overview applies report dimensions consistently to issues, reports and release metrics', async (t) => {
  const { db, request } = fixture(t);
  const first = issue(db); report(db, first, 1, { browser: 'chrome' });
  const second = issue(db, { fingerprint: 'b'.repeat(64), destination: 'vortex' });
  report(db, second, 2, { browser: 'firefox', destination: 'vortex' });
  const overview = await (await request('/overview?browser=firefox&destination=vortex')).json();
  assert.equal(overview.issues.total, 1);
  assert.equal(overview.reports.total, 1);
});

test('overview live spike banners require actual recent report and distinct-install thresholds', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db);
  for (let n = 1; n <= 10; n++) report(db, id, n, { install_id: String((n % 3) + 1).repeat(64) });
  const stale = issue(db, { fingerprint: 'b'.repeat(64) });
  for (let n = 11; n <= 20; n++) report(db, stale, n, { install_id: String((n % 3) + 1).repeat(64), created_at: NOW - 900_001 });
  const muted = issue(db, { fingerprint: 'c'.repeat(64), muted: 1 });
  for (let n = 21; n <= 30; n++) report(db, muted, n, { install_id: String((n % 3) + 1).repeat(64) });
  const overview = await (await request('/overview')).json();
  assert.equal(overview.alerts.window_seconds, 900);
  assert.equal(overview.alerts.spikes.length, 1);
  assert.equal(overview.alerts.spikes[0].issue_id, id);
  assert.equal(overview.alerts.spikes[0].report_count, 10);
  assert.equal(overview.alerts.spikes[0].distinct_installs, 3);
  assert.equal((await (await request('/overview?browser=firefox')).json()).alerts.spikes.length, 0);
});

test('issue queries reject duplicate, unknown, oversized and invalid date parameters and bind SQL search', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db); report(db, id, 1);
  for (const query of ['page=10001', 'limit=101', 'page=0', 'browser=chrome&browser=firefox', 'sort=anything', 'from=2026-02-30', 'from=2024-01-01&to=2026-01-01', 'from=2026-10-22&to=2026-10-21']) {
    assert.equal((await request(`/issues?${query}`)).status, 400, query);
  }
  const result = await (await request(`/issues?q=${encodeURIComponent("' OR 1=1 --")}`)).json();
  assert.equal(result.total, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
});

test('detail and report pagination expose parsed diagnostic JSON and handle missing numeric IDs', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db);
  report(db, id, 1, { breadcrumbs_json: '[{"stage":"FETCH","action":"GET","status":"error","timestamp_offset_ms":0}]', dom_state_json: '{"document_ready_state":"complete"}' });
  const detail = await (await request(`/issues/${id}`)).json();
  assert.equal(detail.issue.id, id);
  assert.equal(detail.latest_report.breadcrumbs[0].action, 'GET');
  assert.equal(detail.latest_report.dom_state.document_ready_state, 'complete');
  assert.equal('breadcrumbs_json' in detail.latest_report, false);
  const reports = await (await request(`/issues/${id}/reports?page=2&limit=1`)).json();
  assert.deepEqual(reports, { items: [], total: 1, page: 2, limit: 1 });
  assert.equal((await request('/issues/9999')).status, 404);
  assert.equal((await request('/issues/abc')).status, 400);
});

test('issue lifecycle enforces fixed versions and actual GitHub issue URLs', async (t) => {
  const { db, request, json } = fixture(t);
  const id = issue(db); report(db, id, 1);
  for (const body of [{}, { status: 'fixed' }, { status: 'regressed', fixed_in_version: null }, { fixed_in_version: '3.01.0' }, { extra: true }, { github_issue_url: 'https://github.com.evil.test/owner/repo/issues/1' }, { github_issue_url: 'https://github.com/owner/issues/1' }, { github_issue_url: 'https://github.com/owner/repo/issues/not-a-number' }, { github_issue_url: 'https://github.com/owner/repo/issues/1?token=secret' }]) {
    assert.equal((await json(`/issues/${id}`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await json(`/issues/${id}`, { status: 'investigating' })).status, 200);
  const response = await json(`/issues/${id}`, { status: 'fixed', fixed_in_version: '3.2.0', muted: true, github_issue_url: 'https://github.com/owner/repo/issues/42' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.issue.status, 'fixed');
  assert.equal(result.issue.muted, true);
  assert.equal(result.issue.fixed_in_version, '3.2.0');
  assert.equal((await json(`/issues/${id}`, { fixed_in_version: null })).status, 400);
  assert.equal((await request(`/issues/${id}`)).status, 200);
});

test('concurrent lifecycle changes cannot silently overwrite each other', async (t) => {
  const { db, json } = fixture(t);
  const id = issue(db); report(db, id, 1);
  const responses = await Promise.all([
    json(`/issues/${id}`, { status: 'fixed', fixed_in_version: '3.2.0' }),
    json(`/issues/${id}`, { status: 'ignored' })
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
});

test('a stale dashboard lifecycle snapshot cannot overwrite a newer automatic regression', async (t) => {
  const { db, request, json } = fixture(t);
  const id = issue(db, { status: 'fixed', fixed_in_version: '3.2.0' });
  const shown = (await (await request(`/issues/${id}`)).json()).issue;
  db.sqlite.prepare("UPDATE issues SET status='regressed' WHERE id=?").run(id);
  const expected = Object.fromEntries(['status', 'fixed_in_version', 'github_issue_url', 'muted', 'updated_at'].map((key) => [key, shown[key]]));
  const stale = await json(`/issues/${id}`, { status: 'fixed', muted: true, expected });
  assert.equal(stale.status, 409);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues WHERE id=?').get(id).status, 'regressed');
  assert.equal(db.sqlite.prepare('SELECT muted FROM issues WHERE id=?').get(id).muted, 0);
  const current = (await (await request(`/issues/${id}`)).json()).issue;
  const refreshed = Object.fromEntries(['status', 'fixed_in_version', 'github_issue_url', 'muted', 'updated_at'].map((key) => [key, current[key]]));
  assert.equal((await json(`/issues/${id}`, { muted: true, expected: refreshed })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues WHERE id=?').get(id).status, 'regressed');
  assert.equal((await json(`/issues/${id}`, { expected: refreshed })).status, 400);
});

test('releases aggregate each version and compare independent filtered percentages', async (t) => {
  const { db, request } = fixture(t);
  const insert = db.sqlite.prepare('INSERT INTO release_metrics (version,metric_date,browser,destination,attempts_count,success_count,fallback_triggered_count,heartbeat_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run('3.1.0', '2026-10-20', 'chrome', 'browser', 100, 80, 20, 1, NOW, NOW);
  insert.run('3.2.0', '2026-10-21', 'chrome', 'browser', 200, 190, 10, 2, NOW, NOW);
  insert.run('3.2.0', '2026-10-21', 'firefox', 'vortex', 10, 0, 0, 1, NOW, NOW);
  const releases = await (await request('/releases?browser=chrome&destination=browser')).json();
  assert.equal(releases.total, 2);
  assert.equal(releases.items.find((item) => item.version === '3.2.0').attempts_count, 200);
  const comparison = await (await request('/releases/compare?before=3.1.0&after=3.2.0&browser=chrome&destination=browser')).json();
  assert.equal(comparison.before.success_rate_percent, 80);
  assert.equal(comparison.after.success_rate_percent, 95);
  assert.equal(comparison.success_rate_delta_pp, 15);
  assert.equal(comparison.fallback_rate_delta_pp, -15);
});

test('push registration validates provider and actual P-256 curve points before writing', async (t) => {
  const { db, json } = fixture(t);
  const input = await subscription();
  for (const invalid of [
    { ...input, endpoint: 'https://push.apple.com.evil.test/key' },
    { ...input, endpoint: 'https://127.0.0.1/key' },
    { ...input, keys: { ...input.keys, p256dh: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url') } },
    { ...input, keys: { ...input.keys, auth: input.keys.auth + '=' } },
    { ...input, expirationTime: NOW - 1 },
    { ...input, unexpected: true }
  ]) assert.equal((await json('/push/subscriptions', invalid, 'POST')).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('push registration upserts and lists only non-secret metadata and public VAPID key', async (t) => {
  const { db, request, json } = fixture(t);
  const input = await subscription();
  const response = await json('/push/subscriptions', input, 'POST', { 'user-agent': 'Browser Authorization=secret owner@example.org C:\\Users\\Thomas\\private' });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(typeof result.subscription.id, 'number');
  assert.equal(result.subscription.provider, 'apple');
  assert.equal((await json('/push/subscriptions', input, 'POST')).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  const listingResponse = await request('/push/subscriptions');
  const listing = await listingResponse.text();
  for (const secret of [input.endpoint, input.keys.auth, input.keys.p256dh, 'Thomas', 'owner@example.org', 'never-disclose']) assert.equal(listing.includes(secret), false, secret);
  assert.deepEqual(await (await request('/push/config')).json(), { public_key: 'public-only' });
  assert.equal((await request(`/push/subscriptions/${result.subscription.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`/push/subscriptions/${result.subscription.id}`, { method: 'DELETE' })).status, 404);
});

test('subscription capacity is atomic and existing endpoints may rotate at capacity', async (t) => {
  const { db, json } = fixture(t);
  const input = await subscription();
  const insert = db.sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)');
  for (let n = 0; n < 99; n++) insert.run(`https://web.push.apple.com/${n}`, input.keys.p256dh, input.keys.auth, NOW, NOW);
  const results = await Promise.all([json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/100' }, 'POST'), json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/101' }, 'POST')]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 100);
  assert.equal((await json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/1' }, 'POST')).status, 200);
});

test('test notification reports delivery results through the real encryption and sender', async (t) => {
  const { env, json } = fixture(t);
  const input = await subscription();
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url');
  env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  assert.equal((await json('/push/subscriptions', input, 'POST')).status, 201);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const response = await json('/push/test', {}, 'POST');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, 'delivered');
  assert.equal(result.delivered, 1);
  assert.equal(result.attempted, 1);
});
