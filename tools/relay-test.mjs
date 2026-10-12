// Offline tests for relay/worker.js: validation, size limit, rate limit, Discord formatting.
import assert from 'node:assert/strict';
import worker, { validateReport, discordMessage, LIMIT_PER_HOUR } from '../relay/worker.js';

const auto = { schema: 1, kind: 'auto', version: '2.9.0', browser: 'Chrome 140', error: { code: 'request_failed', context: 'x' } };
assert.equal(validateReport(auto), '');
assert.equal(validateReport({ ...auto, schema: 2 }), 'unsupported schema');
assert.equal(validateReport({ ...auto, version: 'x' }), 'bad version');
assert.equal(validateReport({ ...auto, error: {} }), 'bad error');
assert.equal(validateReport({ schema: 1, kind: 'manual', version: '2.9.0', note: 'n'.repeat(2001) }), 'bad note');
assert.equal(validateReport({ schema: 1, kind: 'manual', version: '2.9.0', logs: 'nope' }), 'bad logs');
assert.equal(validateReport([]), 'not an object');

const msg = discordMessage({ ...auto, error: { code: '@everyone', context: '<@123>' } }, 'abc');
assert.deepEqual(msg.allowed_mentions, { parse: [] }, 'mentions are disabled');
assert.ok(!JSON.stringify(msg).includes('@everyone'), 'user text cannot ping');
assert.equal(msg.embeds[0].footer.text, 'id abc');

const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
const env = { DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook' };
const post = (body, ip = '1.1.1.1', extra = {}) => worker.fetch(new Request('https://relay.test/v1/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, origin: 'chrome-extension://abc', ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}), env, { waitUntil() {} });

let res = await post(auto);
assert.equal(res.status, 200);
const out = await res.json();
assert.ok(out.ok && out.id);
assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
assert.equal(sent.length, 1, 'forwarded to Discord once');

assert.equal((await post('{bad', '2.2.2.2')).status, 400);
assert.equal((await post({ ...auto, schema: 9 }, '2.2.2.3')).status, 422);
assert.equal((await post('x'.repeat(70 * 1024), '2.2.2.4')).status, 413, 'oversized body refused');
assert.equal((await worker.fetch(new Request('https://relay.test/v1/report'), env)).status, 405);
assert.equal((await worker.fetch(new Request('https://relay.test/other'), env)).status, 404);

for (let i = 1; i < LIMIT_PER_HOUR; i += 1) await post(auto, '9.9.9.9');
assert.equal((await post(auto, '9.9.9.9')).status, 200, `request ${LIMIT_PER_HOUR} still allowed`);
res = await post(auto, '9.9.9.9');
assert.equal(res.status, 429, 'the next one is rate limited');

// KV-backed limiter.
const kv = new Map();
const kvEnv = { ...env, RATE_LIMIT: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
for (let i = 0; i < LIMIT_PER_HOUR; i += 1) {
  const r = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7' }, body: JSON.stringify(auto) }), kvEnv, {});
  assert.equal(r.status, 200);
}
const limited = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7' }, body: JSON.stringify(auto) }), kvEnv, {});
assert.equal(limited.status, 429, 'KV limiter enforces the same limit');

assert.equal((await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5' }, body: JSON.stringify(auto) }), {}, {})).status, 503, 'unconfigured relay says so');

console.log('relay worker behavior OK');
