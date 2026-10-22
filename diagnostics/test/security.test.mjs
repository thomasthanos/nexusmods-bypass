import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { publicCors, requireAccess, requireSameOrigin, boundedJson, limitPublicIp, limitPublicInstall, limitAdminPushTest } from '../src/http/security.ts';
import { notificationConfiguration, ingestionOptions } from '../src/http/config.ts';
import { createTestDatabase } from './helpers/d1.mjs';
import { bindings, createAccessFixture } from './helpers/access.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const INSTALL = 'a'.repeat(64);
const NOW = 1_792_604_800_000;
function appWith(...middleware) {
  const app = new Hono();
  app.use('*', (c, next) => { c.set('serverNow', NOW); return next(); });
  app.use('*', ...middleware);
  app.all('*', async (c) => c.json({ accepted: true, body: c.get('rawJson') }));
  return app;
}
function request(path = '/api/ingest', options = {}) {
  return new Request(`https://diagnostics.example.com${path}`, { method: 'POST', ...options,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8', ...options.headers } });
}
function database(t) { const db = createTestDatabase(); t.after(() => db.close()); return db; }

test('CORS accepts exact extension origins and retains headers on downstream failures', async () => {
  const app = appWith(publicCors, boundedJson);
  for (const origin of [ORIGIN, 'moz-extension://3761cb55-49b3-4f63-bbad-74c5cc586528']) {
    const response = await app.fetch(request('/api/ingest', { headers: { Origin: origin }, body: '{' }), bindings());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  for (const origin of ['', 'null', 'https://example.com', `${ORIGIN}/`, `${ORIGIN}:80`, 'chrome-extension://abc', 'moz-extension://bad']) {
    const response = await app.fetch(request('/api/heartbeat', { headers: { Origin: origin }, body: '{}' }), bindings());
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const response = await app.fetch(request('/api/admin/issues', { body: '{}' }), bindings());
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('CORS restricts preflight to POST and content-type and rejects unsupported methods', async () => {
  const app = appWith(publicCors);
  const preflight = { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } };
  const valid = await app.fetch(request('/api/ingest', preflight), bindings());
  assert.equal(valid.status, 204);
  assert.equal(valid.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(valid.headers.get('access-control-allow-headers'), 'Content-Type');
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }, {}]) {
    assert.equal((await app.fetch(request('/api/ingest', { method: 'OPTIONS', headers }), bindings())).status, 403);
  }
  assert.equal((await app.fetch(request('/api/ingest', { method: 'GET' }), bindings())).status, 405);
});

test('body limit counts actual streamed UTF-8 bytes despite absent or false Content-Length', async () => {
  const app = appWith(publicCors, boundedJson);
  const large = `${' '.repeat(65_537)}{}`;
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const response = await app.fetch(request('/api/ingest', { body: large, headers }), bindings());
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16_384)); }, cancel() { cancelled = true; } });
  assert.equal((await app.fetch(request('/api/ingest', { body: stream, duplex: 'half' }), bindings())).status, 413);
  assert.equal(cancelled, true);
  assert.equal((await app.fetch(request('/api/ingest', { body: JSON.stringify({ value: 'é'.repeat(33_000) }) }), bindings())).status, 413);
});

test('oversized stream returns 413 even when its cancellation never settles', async () => {
  const app = appWith(boundedJson);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  });
  let timeout;
  try {
    const response = await Promise.race([
      app.fetch(request('/api/ingest', { body: stream, duplex: 'half' }), bindings()),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Body rejection waited for cancellation')), 500); })
    ]);
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  } finally { clearTimeout(timeout); }
});

test('bounded JSON rejects compressed/non-JSON/invalid UTF-8 and caches bounded text for Zod', async () => {
  const app = appWith(boundedJson);
  for (const [body, headers, status] of [['{}', { 'Content-Type': 'text/plain' }, 415], ['{}', { 'Content-Encoding': 'gzip' }, 415], ['secret-invalid-input', {}, 400], [new Uint8Array([0xff, 0x22]), {}, 400]]) {
    const response = await app.fetch(request('/api/ingest', { body, headers }), bindings());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /secret-invalid-input|SyntaxError|Unexpected/);
  }
  const validated = new Hono();
  validated.post('/api/ingest', boundedJson, zValidator('json', z.object({ value: z.string() })), (c) => c.json(c.req.valid('json')));
  const response = await validated.fetch(request('/api/ingest', { body: '{"value":"works"}' }), bindings());
  assert.deepEqual(await response.json(), { value: 'works' });
  assert.equal((await app.fetch(request('/api/ingest', { body: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8' } }), bindings())).status, 200);
});

test('same-origin middleware allows safe methods and rejects missing or foreign mutation Origin', async () => {
  const app = appWith(requireSameOrigin);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal((await app.fetch(request('/', { method }), bindings())).status, 200);
  for (const origin of ['', 'null', 'https://evil.example', 'https://diagnostics.example.com/', 'https://diagnostics.example.com.evil.example']) {
    assert.equal((await app.fetch(request('/', { headers: { Origin: origin } }), bindings())).status, 403);
  }
  assert.equal((await app.fetch(request('/', { headers: { Origin: 'https://diagnostics.example.com' } }), bindings())).status, 200);
});

test('IP and installation limits are atomic, independent per route, HMAC hashed and reset per window', async (t) => {
  const db = database(t);
  const env = bindings(db, { INGEST_IP_LIMIT: '3', INGEST_INSTALL_LIMIT: '2' });
  const app = appWith(publicCors, limitPublicIp, boundedJson, limitPublicInstall);
  const send = (path = '/api/ingest', install = INSTALL) => app.fetch(request(path, { body: JSON.stringify({ install_id: install }) }), env);
  const responses = await Promise.all([send(), send(), send(), send()]);
  assert.equal(responses.filter((response) => response.status === 200).length, 2);
  assert.equal(responses.filter((response) => response.status === 429).length, 2);
  assert.ok(responses.find((response) => response.status === 429).headers.get('retry-after'));
  assert.equal((await send('/api/heartbeat')).status, 200);
  const rows = db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all();
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key_hash)));
  assert.ok(rows.every((row) => row.request_count <= (row.scope === 'ip' ? 3 : 2)));
  assert.doesNotMatch(JSON.stringify(rows), /203\.0\.113\.8/);
  assert.ok(!rows.some((row) => row.key_hash === INSTALL));
  const expectedKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_HASH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expectedHash = Buffer.from(await crypto.subtle.sign('HMAC', expectedKey, new TextEncoder().encode(JSON.stringify(['/api/ingest', 'ip', '203.0.113.8'])))).toString('hex');
  assert.ok(rows.some((row) => row.key_hash === expectedHash));
  const nextWindow = new Hono();
  nextWindow.use('*', (c, next) => { c.set('serverNow', NOW + 60_000); return next(); });
  nextWindow.use('*', limitPublicIp, boundedJson, limitPublicInstall);
  nextWindow.post('*', (c) => c.json({ accepted: true }));
  assert.equal((await nextWindow.fetch(request('/api/ingest', { body: JSON.stringify({ install_id: INSTALL }) }), env)).status, 200);
});

test('trusted IP validation, invalid installs and unavailable rate storage fail closed before processing', async (t) => {
  const db = database(t);
  const app = appWith(limitPublicIp, boundedJson, limitPublicInstall);
  for (const ip of ['', 'garbage', '1.2.3.999', '1.2.3.4, 5.6.7.8', '[::1]', 'fe80::1%eth0', '1.2.3.04']) {
    assert.equal((await app.fetch(request('/api/ingest', { headers: { 'CF-Connecting-IP': ip }, body: '{}' }), bindings(db))).status, 403, ip);
  }
  for (const ip of ['::1', '2001:db8::1', '::ffff:192.0.2.1']) {
    assert.equal((await app.fetch(request('/api/ingest', { headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify({ install_id: INSTALL }) }), bindings(db))).status, 200, ip);
  }
  assert.equal((await app.fetch(request('/api/ingest', { body: '{"install_id":"bad"}' }), bindings(db))).status, 400);
  assert.equal((await app.fetch(request('/api/ingest', { body: '{}' }), bindings(db, { RATE_LIMIT_HASH_SECRET: 'short' }))).status, 503);
  const broken = { prepare() { throw new Error('database-secret-error'); } };
  const response = await app.fetch(request('/api/ingest', { body: '{}' }), bindings(broken));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /database-secret-error/);
});

test('new buckets purge at most 100 expired rows while preserving active buckets', async (t) => {
  const db = database(t);
  const insert = db.sqlite.prepare(`INSERT INTO rate_limit_buckets
    (scope,key_hash,window_started_at,window_duration_ms,request_count,expires_at) VALUES ('ip',?,0,60000,1,120000)`);
  for (let index = 0; index < 140; index++) insert.run(index.toString(16).padStart(64, '0'));
  const app = appWith(limitPublicIp);
  assert.equal((await app.fetch(request(), bindings(db))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at<=?').get(NOW).total, 40);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at>?').get(NOW).total, 1);
  assert.equal((await app.fetch(request(), bindings(db))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at<=?').get(NOW).total, 40);
});

test('admin push-test rate is one per minute per verified identity with no raw identity in storage', async (t) => {
  const db = database(t);
  const env = bindings(db, { RATE_LIMIT_WINDOW_SECONDS: '1', INGEST_INSTALL_LIMIT: '1000' });
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('serverNow', Number(c.req.header('X-Test-Time') ?? NOW));
    c.set('accessPayload', { sub: c.req.header('X-Test-Sub') ?? 'verified-subject', email: 'owner@example.com' });
    return next();
  });
  app.post('/api/admin/push/test', limitAdminPushTest, (c) => c.json({ accepted: true }));
  const send = (headers = {}) => app.fetch(request('/api/admin/push/test', { body: '{}', headers }), env);
  const responses = await Promise.all([send(), send()]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  assert.ok(Number(responses.find((response) => response.status === 429).headers.get('retry-after')) > 0);
  assert.equal((await send({ 'X-Test-Time': String(NOW + 2000) })).status, 429);
  assert.equal((await send({ 'X-Test-Sub': 'another-verified-subject' })).status, 200);
  assert.equal((await send({ 'X-Test-Time': String(NOW + 60_000) })).status, 200);
  const rows = db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all();
  assert.ok(rows.every((row) => row.window_duration_ms === 60_000 && row.request_count === 1));
  assert.doesNotMatch(JSON.stringify(rows), /verified-subject|owner@example\.com/);
  const missingIdentity = appWith(limitAdminPushTest);
  assert.equal((await missingIdentity.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 401);
  const fallback = new Hono();
  fallback.use('*', (c, next) => { c.set('serverNow', NOW); c.set('accessPayload', { email: 'owner@example.com' }); return next(); });
  fallback.post('*', limitAdminPushTest, (c) => c.json({ accepted: true }));
  assert.equal((await fallback.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 200);
  assert.equal((await fallback.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 429);
});

test('Access requires a genuine RSA signature and exact issuer/audience in the assertion header', async (t) => {
  const fixture = await createAccessFixture(t);
  const app = appWith(requireAccess);
  const env = bindings(undefined, { CF_ACCESS_TEAM_DOMAIN: fixture.teamDomain, CF_ACCESS_AUD: fixture.audience });
  const good = await fixture.token();
  assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': good } }), env)).status, 200);
  assert.equal((await app.fetch(request('/', { headers: { Cookie: `CF_Authorization=${good}` } }), env)).status, 401);
  for (const overrides of [{ aud: ['wrong'] }, { iss: 'https://attacker.cloudflareaccess.com' }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 120 }, { iat: Math.floor(Date.now() / 1000) + 120 }, { exp: null }, { iat: null }, { nbf: null }, { exp: undefined }, { iat: undefined }, { nbf: undefined }, { aud: undefined }, { iss: undefined }, { exp: 1e300 }, { aud: [] }]) {
    const response = await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': await fixture.token(overrides) } }), env);
    assert.equal(response.status, 401, JSON.stringify(overrides));
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  const pieces = good.split('.');
  pieces[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pieces[1], 'base64url')), email: 'tampered@example.com' })).toString('base64url');
  assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': pieces.join('.') } }), env)).status, 401);
  for (const overrides of [{ CF_ACCESS_TEAM_DOMAIN: 'https://fixture.cloudflareaccess.com/path' }, { CF_ACCESS_TEAM_DOMAIN: 'fixture.evil.example' }, { CF_ACCESS_AUD: '' }]) {
    assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': good } }), { ...env, ...overrides })).status, 503);
  }
});

test('configuration parses bounded integer settings and refuses invalid deployment values', () => {
  const env = bindings();
  assert.deepEqual(ingestionOptions(env), { windowMs: 900_000, distinctInstallThreshold: 3 });
  const config = notificationConfiguration(env, 'https://diagnostics.example.com');
  assert.equal(config.cooldownMs, 1_800_000);
  assert.equal(config.spikeReportThreshold, 10);
  for (const value of ['', '1e3', '-1', '1.2', '99999999999999999999']) assert.throws(() => ingestionOptions({ ...env, DETECTION_WINDOW_SECONDS: value }));
});
