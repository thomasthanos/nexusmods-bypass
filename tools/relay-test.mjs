// Offline tests for relay/worker.js: validation, size limit, rate limit, Discord formatting.
import assert from 'node:assert/strict';
import worker, { validateReport, discordMessage, LIMIT_PER_HOUR, severityOf, SEVERITY_COLORS, fitEmbed, fingerprintOf } from '../relay/worker.js';

const auto = { schema: 1, kind: 'auto', version: '2.9.0', browser: 'Chrome 140', error: { code: 'request_failed', context: 'x' } };
assert.equal(validateReport(auto), '');
const detailed = { ...auto, reference: 'E-001abcd', occurrences: 12, severity: 'critical', page: 'collection',
  firstAt: '2026-10-14T12:00:00.000Z', lastAt: '2026-10-14T12:10:00.000Z',
  error: { ...auto.error, action: 'collection run · browser', message: 'No collectionRevision in response', frame: 'content/ndc.js:42:5' } };
assert.equal(validateReport(detailed), '');
assert.equal(validateReport({ ...detailed, occurrences: -1 }), 'bad occurrences');
assert.equal(validateReport({ ...detailed, reference: '@everyone' }), 'bad reference');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, frame: 'https://private.example/user' } }), 'bad error frame');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, status: '503' } }), 'bad error status');
assert.equal(validateReport({ ...detailed, firstAt: 'yesterday' }), 'bad timestamp');
const detailedEmbed = discordMessage(detailed, 'id').embeds[0];
assert.match(detailedEmbed.footer.text, /E-001abcd/);
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Occurrences in this report' && field.value === '12'));
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Technical cause' && field.value.includes('collectionRevision')));
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Script' && field.value === 'content/ndc.js:42:5'));
assert.equal(fingerprintOf(detailed), fingerprintOf({ ...detailed, error: { ...detailed.error, context: 'another file' } }), 'stable references dedupe across different files');
let seq = 0;
// Each call gets its own fingerprint so the dedupe window does not collapse them.
const fresh = () => ({ ...auto, error: { ...auto.error, context: `x${seq++}` } });
assert.equal(validateReport({ ...auto, schema: 2 }), 'unsupported schema');
assert.equal(validateReport({ ...auto, version: 'x' }), 'bad version');
assert.equal(validateReport({ ...auto, error: {} }), 'bad error');
assert.equal(validateReport({ schema: 1, kind: 'manual', version: '2.9.0', note: 'n'.repeat(2001) }), 'bad note');
assert.equal(validateReport({ schema: 1, kind: 'manual', version: '2.9.0', logs: 'nope' }), 'bad logs');
assert.equal(validateReport([]), 'not an object');

const msg = discordMessage({ ...auto, error: { code: '@everyone', context: '<@123>' } }, 'abc');
assert.deepEqual(msg.allowed_mentions, { parse: [] }, 'mentions are disabled');
const ownerId = '706932839907852389';
for (const report of [auto, { schema: 1, kind: 'manual', version: '3.1.1', summary: 'A bug' }]) {
  const alert = discordMessage({ ...report, mentionUserId: '123456789012345678', note: '@everyone <@123456789012345678>' }, 'owner', ownerId);
  assert.equal(alert.content, `<@${ownerId}>`, 'only the configured owner is mentioned');
  assert.deepEqual(alert.allowed_mentions, { parse: [], users: [ownerId] });
  assert.equal(alert.embeds[0].color, 0xd9433b, 'all user reports are red');
  assert.match(alert.embeds[0].title, report.kind === 'auto' ? /^User error · / : /^Bug report · /);
}
for (const invalidId of ['@everyone', '706932839907852389 <@123>', 42, '']) {
  const alert = discordMessage(auto, 'invalid', invalidId);
  assert.equal(alert.content, undefined, 'invalid configuration cannot create a mention');
  assert.deepEqual(alert.allowed_mentions, { parse: [] });
}
const unknownError = discordMessage({ ...auto, error: { code: 'unknown_fault', message: 'Unique technical cause' } }, 'unknown');
assert.equal(JSON.stringify(unknownError).split('Unique technical cause').length - 1, 1, 'unknown error causes are not duplicated in the description and fields');
assert.ok(!JSON.stringify(msg).includes('@everyone'), 'user text cannot ping');
assert.match(msg.embeds[0].footer.text, /id abc$/);

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body.get('payload_json')), attachment: init.body.get('files[0]') });
  return new Response(null, { status: 204 });
};
const env = { DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook', REPORT_MENTION_USER_ID: ownerId };
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
assert.equal(new URL(sent[0].url).searchParams.get('wait'), 'true', 'the relay waits for Discord to confirm saving the report');
assert.equal(sent[0].attachment, null, 'auto errors have one embed, without a duplicate JSON preview');
assert.equal(sent[0].body.embeds.length, 1);
assert.equal(sent[0].body.content, `<@${ownerId}>`, 'the live handler passes only the trusted configuration');
const manual = { schema: 1, kind: 'manual', version: '2.10.2', summary: 'Vortex does not open', category: 'vortex', steps: 'Click Download', expected: 'Vortex opens', logs: [{ text: 'diagnostic' }] };
assert.equal(validateReport(manual), '');
assert.equal(validateReport({ ...manual, category: 'unknown' }), 'bad category');
assert.equal(validateReport({ ...manual, summary: 'x'.repeat(161) }), 'bad summary');
assert.equal(validateReport({ ...manual, steps: 'x'.repeat(1001) }), 'bad steps');
assert.equal(validateReport({ ...manual, expected: 'x'.repeat(1001) }), 'bad expected result');
await post(manual, '8.8.8.8');
assert.deepEqual(JSON.parse(await sent[1].attachment.text()), manual, 'steps, expected result and logs all reach Discord');
assert.match(sent[1].attachment.name, /^nexusmods-report-[a-z0-9-]+\.json$/);
assert.equal(sent[1].body.embeds[0].title, `Bug report · ${manual.summary}`);

assert.equal((await post('{bad', '2.2.2.2')).status, 400);
assert.equal((await post({ ...auto, schema: 9 }, '2.2.2.3')).status, 422);
assert.equal((await post('x'.repeat(70 * 1024), '2.2.2.4')).status, 413, 'oversized body refused');
assert.equal((await worker.fetch(new Request('https://relay.test/v1/report'), env)).status, 405);
assert.equal((await worker.fetch(new Request('https://relay.test/other'), env)).status, 404);

for (let i = 1; i < LIMIT_PER_HOUR; i += 1) await post(fresh(), '9.9.9.9');
assert.equal((await post(fresh(), '9.9.9.9')).status, 200, `request ${LIMIT_PER_HOUR} still allowed`);
res = await post(fresh(), '9.9.9.9');
assert.equal(res.status, 429, 'the next one is rate limited');

// KV-backed limiter.
const kv = new Map();
const kvEnv = { ...env, RATE_LIMIT: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
for (let i = 0; i < LIMIT_PER_HOUR; i += 1) {
  const r = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7' }, body: JSON.stringify(fresh()) }), kvEnv, {});
  assert.equal(r.status, 200);
}
const limited = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7' }, body: JSON.stringify(fresh()) }), kvEnv, {});
assert.equal(limited.status, 429, 'KV limiter enforces the same limit');

assert.equal((await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5' }, body: JSON.stringify(auto) }), {}, {})).status, 503, 'unconfigured relay says so');

// Preflight from both browsers' extension origins.
for (const origin of ['chrome-extension://abcdef', 'moz-extension://1234-5678']) {
  const pre = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), origin, `${origin} preflight allowed`);
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
}
const evil = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
assert.equal(evil.headers.get('access-control-allow-origin'), null, 'web origins are not allowed');
// Health.
const health = await worker.fetch(new Request('https://relay.test/v1/health', { headers: { origin: 'moz-extension://x' } }), env);
assert.deepEqual({ ...(await health.json()), maxBytes: 0 }, { ok: true, configured: true, maxBytes: 0 });
assert.equal((await (await worker.fetch(new Request('https://relay.test/v1/health'), {})).json()).configured, false);
// Automatic traffic cannot consume the manual reporting allowance for a shared network.
for (let i = 0; i < LIMIT_PER_HOUR; i += 1) assert.equal((await post(fresh(), '4.4.4.4')).status, 200);
assert.equal((await post(fresh(), '4.4.4.4')).status, 429);
assert.equal((await post({ schema: 1, kind: 'manual', version: '3.1.1', note: 'Manual details' }, '4.4.4.4')).status, 200);
// Content type with a charset is fine; a wrong one is refused.
assert.equal((await post(fresh(), '3.3.3.1', { 'content-type': 'application/json; charset=utf-8' })).status, 200);
assert.equal((await post(fresh(), '3.3.3.2', { 'content-type': 'text/plain' })).status, 415);
// Discord unreachable: a 502 that still carries CORS headers.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError('network'); };
res = await post(fresh(), '3.3.3.3');
assert.equal(res.status, 502);
assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
globalThis.fetch = realFetch;
// Worst-case embed stays under Discord's 6000-character limit.
const big = discordMessage({ ...auto, kind: 'manual', note: 'n'.repeat(2000), contact: 'c'.repeat(120), browser: 'b'.repeat(200), currentError: { code: 'x'.repeat(80) } }, 'id');
const e = big.embeds[0];
assert.ok(e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) < 6000);

// Severity colours.
assert.equal(severityOf(auto), 'error');
assert.equal(severityOf({ ...auto, error: { code: 'x', status: 503 } }), 'critical');
assert.equal(severityOf({ ...auto, error: { code: 'uncaught_exception' } }), 'critical');
assert.equal(severityOf(manual), 'report');
assert.equal(discordMessage({ ...auto, error: { code: 'x', status: 500 } }, 'i').embeds[0].color, SEVERITY_COLORS.critical);
// Page field: validated as a path without query or fragment, shown in the embed.
assert.equal(validateReport({ ...auto, page: '/skyrimspecialedition/mods/1?tab=files' }), 'bad page');
assert.equal(validateReport({ ...auto, page: '/skyrimspecialedition/mods/1' }), '');
assert.ok(discordMessage({ ...auto, page: '/games/x' }, 'i').embeds[0].fields.some((f) => f.name === 'Page' && f.value === '/games/x'));
// The screenshot's empty error message still gets a useful explanation, not a raw code title.
const edgeUa = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const login = discordMessage({ ...auto, version: '3.1.0', browser: edgeUa, page: '/games/skyrimspecialedition/collections/xk05aw', error: { code: 'requires_login', context: 'Starting collection download', message: '' } }, 'abc').embeds[0];
assert.match(login.title, /sign in/i);
assert.match(login.description, /Nexus Mods/);
assert.match(login.description, /retry/i);
assert.ok(login.description.length < 400 && !login.description.includes('```'), 'short explanation, no repeated JSON/log block');
assert.deepEqual(login.fields.map((f) => f.name), ['Page', 'Action'], 'only the useful context is shown');
assert.ok(login.fields.every((f) => !f.inline), 'context is readable, not cramped into side-by-side fields');
assert.match(login.footer.text, /v3\.1\.0/);
assert.match(login.footer.text, /Edge 155/);
assert.equal(JSON.stringify(login).split('requires_login').length - 1, 1, 'the technical code appears only once');
assert.ok(!JSON.stringify(login).includes('Mozilla/5.0'), 'raw user agents do not fill the embed');
for (const [browser, expected] of [
  ['Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36', 'Chrome 140'],
  ['Mozilla/5.0 Firefox/144.0', 'Firefox 144'],
  ['Mozilla/5.0 Version/18.5 Safari/605.1.15', 'Safari 18'],
  ['Mozilla/5.0 Chrome/140.0.0.0 OPR/125.0', 'Opera 125'],
  ['Mozilla/5.0 CriOS/140.0 Mobile Safari/604.1', 'Chrome 140'],
  ['Mozilla/5.0 FxiOS/144.0 Mobile Safari/605.1', 'Firefox 144'],
  ['Chrome 140', 'Chrome 140'],
  ['unrecognised browser data', 'Unknown browser']
]) {
  assert.ok(discordMessage({ ...auto, browser }, 'b').embeds[0].footer.text.includes(expected), `${expected} is compact and recognisable`);
}
for (const code of ['cloudflare', 'rate_limited', 'account_suspended', 'constructor', 'new_unknown_error']) {
  const embed = discordMessage({ ...auto, error: { code, message: '' } }, 'c').embeds[0];
  assert.ok(embed.title && embed.description, `${code} has useful copy even with no message`);
  assert.ok(!embed.title.includes(code), 'technical codes stay in the footer');
}
// fitEmbed clamps every Discord limit.
const fat = fitEmbed({ title: 't'.repeat(400), description: 'd'.repeat(5000), footer: { text: 'f' }, fields: Array.from({ length: 30 }, () => ({ name: 'n', value: 'v'.repeat(1500) })) });
assert.ok(fat.title.length <= 256 && fat.description.length <= 4096 && fat.fields.length <= 25 && fat.fields.every((f) => f.value.length <= 1024));
assert.ok(fat.title.length + fat.description.length + 1 + fat.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) <= 6000);
// Dedupe: the same auto error within the window is forwarded once; manual reports never collapse.
assert.equal(fingerprintOf(manual), '');
const before = sent.length;
const dup = { ...auto, error: { code: 'dup_test', context: 'same' } };
assert.equal((await post(dup, '4.4.4.1')).status, 200);
const second = await post(dup, '4.4.4.2');
assert.equal(second.status, 200);
assert.equal((await second.json()).duplicate, true);
assert.equal(sent.length, before + 1, 'duplicate not forwarded');
await post(manual, '4.4.4.3'); await post(manual, '4.4.4.4');
assert.equal(sent.length, before + 3, 'manual reports are always forwarded');
// A failed delivery does not mark the fingerprint, so a retry goes through.
const dup2 = { ...auto, error: { code: 'dup_fail', context: 'z' } };
globalThis.fetch = async () => new Response(null, { status: 500 });
assert.equal((await post(dup2, '4.4.4.5')).status, 502);
globalThis.fetch = realFetch;
assert.equal((await (await post(dup2, '4.4.4.6')).json()).duplicate, undefined, 'retry after failure is not a duplicate');

console.log('relay worker behavior OK');
