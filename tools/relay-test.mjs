// Offline tests for relay/worker.js: validation, size limit, rate limit, Discord formatting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { dashboardReport, validateReport, discordMessage, LIMIT_PER_HOUR, GLOBAL_LIMIT_PER_HOUR, severityOf, SEVERITY_COLORS, fitEmbed, fingerprintOf, incidentLogger, DEDUPE_WINDOW_MS, NETWORK_WINDOW_MS, MENTION_WINDOW_MS } from '../relay/worker.js';

const auto = { schema: 1, kind: 'auto', version: '3.1.5', browser: 'Chrome 140', error: { code: 'request_failed', context: 'x' } };
assert.equal(validateReport(auto), '');
const detailed = { ...auto, reference: 'E-001abcd', occurrences: 12, severity: 'critical', page: 'collection',
  firstAt: '2026-10-14T12:00:00.000Z', lastAt: '2026-10-14T12:10:00.000Z',
  error: { ...auto.error, action: 'collection run · browser', message: 'No collectionRevision in response', frame: 'content/ndc.js:42:5' } };
assert.equal(validateReport(detailed), '');
assert.equal(validateReport({ ...detailed, occurrences: -1 }), 'bad occurrences');
assert.equal(validateReport({ ...detailed, reference: '@everyone' }), 'bad reference');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, frame: 'https://private.example/user' } }), 'bad error frame');
// A frame names its function when the stack does ("function@script:line:column"), so the dashboard can tell
// two faults in one script apart. Only a plain identifier is accepted before the @.
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, frame: 'readRevisionMods@content/ndc.js:42:5' } }), '');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, frame: '$_init9@background.js:1:2' } }), '');
for (const frame of ['<script>@content/ndc.js:1:2', 'a b@content/ndc.js:1:2', '@content/ndc.js:1:2', 'x@https://private.example/a.js:1:2']) {
  assert.equal(validateReport({ ...detailed, error: { ...detailed.error, frame } }), 'bad error frame', `${frame} is refused`);
}
assert.equal((await dashboardReport({ ...detailed, error: { ...detailed.error, frame: 'readRevisionMods@content/ndc.js:42:5' } })).stack_trace,
  'readRevisionMods@ext://content/ndc.js:42:5', 'the dashboard copy is a stack line its parser reads');
assert.equal((await dashboardReport(detailed)).stack_trace, 'ext://content/ndc.js:42:5', 'a frame without a function keeps its old form');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, status: '503' } }), 'bad error status');
assert.equal(validateReport({ ...detailed, error: { ...detailed.error, causeCode: '<@123>' } }), 'bad cause code');
assert.equal(validateReport({ ...detailed, firstAt: 'yesterday' }), 'bad timestamp');
const detailedEmbed = discordMessage(detailed, 'id').embeds[0];
assert.match(detailedEmbed.footer.text, /E-001abcd/);
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Diagnostics' && field.value.includes('Occurrences: 12')));
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Technical cause' && field.value.includes('collectionRevision')));
assert.ok(detailedEmbed.fields.some((field) => field.name === 'Diagnostics' && field.value.includes('content/ndc.js:42:5')));
assert.ok(detailedEmbed.fields.length <= 3 && detailedEmbed.fields.every((field) => !field.inline), 'automatic diagnostics remain compact and stacked');
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
  assert.equal(alert.embeds[0].color, 0xed4245, 'automatic download failures and manual bug reports are red');
  assert.match(alert.embeds[0].title, report.kind === 'auto' ? /^Automatic error · / : /^Bug report · /);
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
// Incident lines go to this list instead of the console, so failures below can be asserted on.
const incidents = [];
const env = { DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook', REPORT_MENTION_USER_ID: ownerId, RELAY_EXTENSION_VERSION: '3.1.5', INCIDENT_LOG: (line) => incidents.push(JSON.parse(line)) };
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
assert.ok(sent[0].attachment, 'automatic reports retain their technical diagnostics as JSON');
assert.match(sent[0].attachment.name, /^SPOILER_nexusmods-auto-report-/,
  'the attachment preview is hidden so it does not duplicate the compact embed');
assert.equal(sent[0].body.attachments?.[0]?.is_spoiler, true, 'the attachment is explicitly marked as a spoiler, including non-image JSON');
assert.equal(JSON.parse(await sent[0].attachment.text()).error.code, 'request_failed');
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

// The extended automatic attachment is opt-in, bounded and allowlisted; a manual report remains exact.
const extended = { ...fresh(), version: '3.1.5', diagnostics: { consent: 'extended-v1',
  file: { expectedId: '7318625091714', receivedId: '819330' },
  logs: [{ at: '2026-10-16T12:00:00.000Z', level: 'info', page: 'mod', text: 'Generating Vortex link' }] },
  settings: { shouldNotLeave: 'PRIVATE' }, contact: 'private@example.com' };
assert.equal(validateReport(extended), '');
assert.equal(validateReport({ ...extended, diagnostics: { ...extended.diagnostics, consent: false } }), 'bad diagnostics consent');
assert.equal(validateReport({ ...extended, diagnostics: { ...extended.diagnostics, logs: Array(21).fill(extended.diagnostics.logs[0]) } }), 'bad diagnostics logs');
assert.equal(validateReport({ ...extended, diagnostics: { ...extended.diagnostics, file: { expectedId: 'key=SECRET' } } }), 'bad diagnostics file');
await post(extended, '8.8.8.7');
const extendedJson = JSON.parse(await sent.at(-1).attachment.text());
assert.equal(extendedJson.diagnostics.file.receivedId, '819330');
assert.equal(extendedJson.diagnostics.logs.length, 1);
assert.doesNotMatch(JSON.stringify(extendedJson), /PRIVATE|private@example/);
assert.equal(discordMessage({ ...auto, error: { code: 'nexus_page_changed' } }, 'warning').embeds[0].color, 0xe8b339);
assert.match(discordMessage({ ...auto, error: { code: 'nexus_page_changed' } }, 'warning').embeds[0].title, /warning/i);
for (const causeCode of ['NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN']) {
  const embed = discordMessage({ ...auto, error: { code: 'queue_item_failed', causeCode } }, 'network').embeds[0];
  assert.equal(embed.color, 0xe8b339, `${causeCode} is a network warning, not an extension error`);
  assert.match(embed.title, /warning/i);
}
assert.equal(discordMessage({ ...auto, error: { code: 'no_nmm_link' } }, 'error').embeds[0].color, 0xed4245);
assert.match(discordMessage({ ...auto, version: '0.0.1' }, 'old', '', '3.1.5').embeds[0].footer.text, /older client/i);
assert.doesNotMatch(discordMessage({ ...auto, version: '3.1.50' }, 'new', '', '3.1.5').embeds[0].footer.text, /older client/i);
assert.doesNotMatch(discordMessage(auto, 'unknown').embeds[0].footer.text, /older client/i, 'no guessed age without a trusted relay baseline');

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
assert.deepEqual(incidents.at(-1) && { event: incidents.at(-1).event, status: incidents.at(-1).status, attempts: incidents.at(-1).attempts },
  { event: 'discord_delivery_failed', status: 0, attempts: 3 }, 'a lost report is logged, after bounded retries');
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
assert.ok(discordMessage({ ...auto, page: '/games/x' }, 'i').embeds[0].fields.some((f) => f.name === 'Context' && f.value.includes('/games/x')));
// The screenshot's empty error message still gets a useful explanation, not a raw code title.
const edgeUa = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const login = discordMessage({ ...auto, version: '3.1.0', browser: edgeUa, page: '/games/skyrimspecialedition/collections/xk05aw', error: { code: 'requires_login', context: 'Starting collection download', message: '' } }, 'abc').embeds[0];
assert.match(login.title, /sign in/i);
assert.match(login.description, /Nexus Mods/);
assert.match(login.description, /retry/i);
assert.ok(login.description.length < 400 && !login.description.includes('```'), 'short explanation, no repeated JSON/log block');
assert.deepEqual(login.fields.map((f) => f.name), ['Context'], 'page and action share one short context field');
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
// Every error the extension can send automatically has a title of its own: the generic "Action could
// not complete" is for codes this relay has not seen yet (Vortex link failures used to land there).
{
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const errors = read('src/content/errors.js');
  const definitions = errors.slice(errors.indexOf('const DEFINITIONS'), errors.indexOf('\n  };', errors.indexOf('const DEFINITIONS')));
  const localOnly = new Set(read('src/auto-reports.js').match(/LOCAL_ONLY = new Set\(\[([\s\S]*?)\]\)/)[1].match(/'([^']+)'/g).map((code) => code.slice(1, -1)));
  const reportable = [...definitions.matchAll(/^\s{4}(\w+):\s*\{/gm)].map((match) => match[1])
    .concat(['queue_item_failed', 'background_error', 'uncaught_exception', 'unhandled_rejection', 'popup_error'])
    .filter((code) => !localOnly.has(code));
  for (const code of reportable) {
    const { title } = discordMessage({ ...auto, error: { code, message: '' } }, 'copy').embeds[0];
    assert.doesNotMatch(title, /Action could not complete/, `${code} has its own title`);
  }
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
assert.equal(sent.at(-1).body.content, `<@${ownerId}>`, 'a failed delivery also leaves the mention eligible');

// The maintainer is pinged for a user's bug report and for an automatic error from a current client.
// Warnings and older clients' reports still arrive, without a ping (Discord, 2026-10-17: every network
// warning and every 3.1.2 report pinged once a day).
{
  const quietFor = [
    [{ ...auto, reference: 'E-oldclnt', version: '3.1.2', error: { code: 'no_nmm_link' } }, 'an older client'],
    [{ ...auto, reference: 'E-oldcrsh', version: '3.1.2', severity: 'critical', error: { code: 'uncaught_exception' } }, 'an older client\'s crash'],
    [{ ...auto, reference: 'E-warning', error: { code: 'nexus_page_changed' } }, 'a warning'],
    [{ ...auto, reference: 'E-netwarn', error: { code: 'queue_item_failed', causeCode: 'NETWORK_FAILED' } }, 'a transient download warning']
  ];
  for (const [quietReport, what] of quietFor) {
    assert.equal((await post(quietReport, '7.0.0.1')).status, 200);
    assert.equal(sent.at(-1).body.content, undefined, `${what} is posted without a ping`);
    assert.deepEqual(sent.at(-1).body.allowed_mentions, { parse: [] });
  }
  assert.equal((await post({ ...auto, reference: 'E-newerr1', error: { code: 'no_nmm_link' } }, '7.0.0.2')).status, 200);
  assert.equal(sent.at(-1).body.content, `<@${ownerId}>`, 'a current client\'s error pings');
  assert.equal((await post({ ...auto, reference: 'E-newer01', version: '3.1.7', error: { code: 'no_nmm_link' } }, '7.0.0.3')).status, 200);
  assert.equal(sent.at(-1).body.content, `<@${ownerId}>`, 'so does a newer client\'s');
}

// New summaries do not create a new mention each time; manually submitted reports still notify the
// maintainer normally.
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  const before = sent.length;
  const repeated = { ...auto, reference: 'E-repeat1', error: { code: 'no_nmm_link' } };
  assert.equal((await post(repeated, '6.1.0.1')).status, 200);
  now += 10 * 60 * 1000;
  assert.equal((await (await post(repeated, '6.1.0.2')).json()).duplicate, true, 'old ten-minute clients are suppressed');
  assert.equal(sent.length, before + 1);
  now += DEDUPE_WINDOW_MS;
  await post(repeated, '6.1.0.3');
  assert.equal(sent.length, before + 2, 'the next summary is forwarded');
  assert.equal(sent.at(-1).body.content, undefined, 'the summary does not ping');
  assert.deepEqual(sent.at(-1).body.allowed_mentions, { parse: [] });
  now += MENTION_WINDOW_MS;
  await post(repeated, '6.1.0.4');
  assert.equal(sent.at(-1).body.content, `<@${ownerId}>`, 'a daily alert can notify again');
  const network = { ...auto, reference: 'E-network', error: { code: 'network_error' } };
  await post(network, '6.2.0.1');
  now += DEDUPE_WINDOW_MS;
  assert.equal((await (await post(network, '6.2.0.2')).json()).duplicate, true);
  now += NETWORK_WINDOW_MS;
  await post(network, '6.2.0.3');
  assert.equal(sent.at(-1).body.content, undefined, 'network summaries also stay quiet');
  const blocked = discordMessage({ ...auto, error: { code: 'queue_item_failed', causeCode: 'FILE_VIRUS_INFECTED' } }, 'blocked').embeds[0];
  assert.match(blocked.title, /blocked by security software/);
  assert.match(blocked.description, /Keep the protection enabled/);
  assert.match(discordMessage({ ...auto, error: { code: 'queue_item_failed', message: 'FILE_VIRUS_INFECTED [blocked]' } }, 'old').embeds[0].title, /blocked by security software/, 'old clients also get the correct explanation');
} finally {
  Date.now = actualNow;
}

// KV persistence uses different TTLs for delivery and mentions, so edge-isolate restarts cannot
// turn hourly summaries into hourly pings. No real Cloudflare or Discord service is contacted.
const written = new Map();
const expiry = new Map();
let kvNow = actualNow();
const persistedEnv = { ...env, RATE_LIMIT: {
  get: async key => (expiry.get(key) || 0) > kvNow ? written.get(key) : null,
  put: async (key, value, options) => {
    written.set(key, value);
    expiry.set(key, kvNow + options.expirationTtl * 1000);
  }
} };
const persistentPost = (body) => worker.fetch(new Request('https://relay.test/v1/report', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
  body: JSON.stringify(body)
}), persistedEnv, {});
Date.now = () => kvNow;
try {
  const networkReport = { ...auto, reference: 'E-persist', error: { code: 'network_error' } };
  await persistentPost(networkReport);
  const networkFp = fingerprintOf(networkReport);
  assert.equal(expiry.get(`fp:${networkFp}`) - kvNow, NETWORK_WINDOW_MS);
  assert.equal(written.has(`ping:${networkFp}`), false, 'a warning that pings nobody keeps no mention cooldown');

  const errorReport = { ...auto, reference: 'E-persis2', error: { code: 'no_nmm_link' } };
  await persistentPost(errorReport);
  const fp = fingerprintOf(errorReport);
  assert.equal(expiry.get(`fp:${fp}`) - kvNow, DEDUPE_WINDOW_MS);
  assert.equal(expiry.get(`ping:${fp}`) - kvNow, MENTION_WINDOW_MS);
  kvNow += DEDUPE_WINDOW_MS + 1;
  await persistentPost(errorReport);
  assert.equal(sent.at(-1).body.content, undefined, 'persisted mention cooldown outlasts the delivery cooldown');
  kvNow += MENTION_WINDOW_MS;
  await persistentPost(errorReport);
  assert.equal(sent.at(-1).body.content, `<@${ownerId}>`);
} finally { Date.now = actualNow; }

// ---- Resilience: Discord throttling, failing KV, unexpected throws, secret-free logs ----------
const report = (ip, body, targetEnv = env, ctx = {}) => worker.fetch(new Request('https://relay.test/v1/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, origin: 'chrome-extension://abc' },
  body: JSON.stringify(body)
}), targetEnv, ctx);
{
  // A short Discord limit is waited out inside the request; the report arrives on the next try.
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }), { status: 429 });
    }
    return realFetch(url, init);
  };
  const before = sent.length;
  assert.equal((await report('11.0.0.1', fresh())).status, 200, 'a short Discord limit is waited out');
  assert.equal(calls, 2);
  assert.equal(sent.length, before + 1);

  // A long one goes back to the client with Discord's own wait, and nothing is marked delivered.
  globalThis.fetch = async () => new Response(JSON.stringify({ retry_after: 42.5 }), { status: 429 });
  const throttledReport = { ...auto, reference: 'E-throttl', error: { code: 'throttle_test' } };
  const throttled = await report('11.0.0.2', throttledReport);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '43', 'the client is told how long Discord asked for');
  assert.equal((await throttled.json()).error, 'upstream rate limited');
  assert.equal(throttled.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
  globalThis.fetch = realFetch;
  assert.equal((await (await report('11.0.0.3', throttledReport)).json()).duplicate, undefined, 'a throttled report stays deliverable');
}
{
  // The relay's own rate limit points at the end of the current hour, not a fixed hour from now.
  let limited = null;
  for (let i = 0; i <= LIMIT_PER_HOUR; i += 1) limited = await report('11.1.0.1', fresh());
  const wait = Number(limited.headers.get('retry-after'));
  assert.equal(limited.status, 429);
  assert.ok(wait >= 1 && wait <= 3600, 'Retry-After ends with the counting hour');
}
{
  // KV failing on every call (daily write cap, one write per key per second): reports still go
  // through, the failure is logged, and this isolate's memory keeps the cooldowns.
  const kvDown = { ...env, RATE_LIMIT: {
    get: async () => { throw new Error('KV GET failed: 503 Service Unavailable'); },
    put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); }
  } };
  const kvReport = { ...auto, reference: 'E-kvdown1', error: { code: 'kv_test' } };
  const first = incidents.length;
  assert.equal((await report('12.0.0.1', kvReport, kvDown)).status, 200, 'a KV outage does not refuse reports');
  const events = incidents.slice(first).map((entry) => entry.event);
  assert.ok(events.includes('kv_read_failed') && events.includes('kv_write_failed'), 'KV failures are logged');
  assert.ok(incidents.slice(first).every((entry) => !('key' in entry) && entry.scope), 'logs name the counter type, not the client IP');
  assert.equal((await (await report('12.0.0.2', kvReport, kvDown)).json()).duplicate, true, 'dedupe falls back to memory');
  let last = null;
  for (let i = 0; i <= LIMIT_PER_HOUR; i += 1) last = await report('12.0.0.9', fresh(), kvDown);
  assert.equal(last.status, 429, 'the rate limit falls back to memory too');
}
{
  // Anything else that throws still answers with CORS headers and a status the client understands.
  const poisoned = { ...env, RATE_LIMIT: { get: async () => ({ valueOf() { throw new Error('poisoned counter'); } }), put: async () => {} } };
  const crashed = await report('12.1.0.1', fresh(), poisoned);
  assert.equal(crashed.status, 500);
  assert.equal(crashed.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
  assert.equal((await crashed.json()).error, 'internal error');
  assert.equal(incidents.at(-1).event, 'unhandled_error');
  assert.match(incidents.at(-1).cause, /poisoned counter/);
}
{
  // An oversized body without a Content-Length is cut off while streaming.
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 80; i += 1) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      controller.close();
    }
  });
  const res = await worker.fetch(new Request('https://relay.test/v1/report', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '13.0.0.1' }, body: stream, duplex: 'half'
  }), env, {});
  assert.equal(res.status, 413);
}
{
  // E-mail is the fallback copy when Discord refuses the message, and the refusal is logged.
  const emailed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      emailed.push(JSON.parse(init.body));
      return new Response('{"id":"mail"}', { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'Invalid Form Body', code: 50035 }), { status: 400 });
  };
  const waits = [];
  const mailEnv = { ...env, RESEND_API_KEY: 're_test_key_123', REPORT_EMAIL_TO: 'owner@example.com', REPORT_EMAIL_FROM: 'relay@example.com' };
  const refused = await report('14.0.0.1', { schema: 1, kind: 'manual', version: '3.1.3', summary: 'Refused' }, mailEnv, { waitUntil: (task) => waits.push(task) });
  await Promise.all(waits);
  globalThis.fetch = realFetch;
  assert.equal(refused.status, 502);
  assert.equal(emailed.length, 1, 'the report still reaches the e-mail destination');
  const failure = incidents.findLast((entry) => entry.event === 'discord_delivery_failed');
  assert.equal(failure.status, 400);
  assert.equal(failure.attempts, 1, 'an invalid payload is not retried');
  assert.match(failure.detail, /50035: Invalid Form Body/);
}
{
  // Secrets never reach the log, even inside an error message that repeats them.
  const secretEnv = { DISCORD_WEBHOOK_URL: 'https://discord.invalid/api/webhooks/123/TOPSECRET', RESEND_API_KEY: 're_SECRETKEY123' };
  const lines = [];
  const log = incidentLogger({ ...secretEnv, INCIDENT_LOG: (line) => lines.push(line) });
  log('probe', { cause: new Error(`Invalid URL: ${secretEnv.DISCORD_WEBHOOK_URL} with ${secretEnv.RESEND_API_KEY}`), detail: 'see https://discord.com/api/webhooks/9/other-token' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /TOPSECRET|SECRETKEY|other-token/);
  // A malformed webhook secret fails closed, without echoing it.
  const badEnv = { ...env, DISCORD_WEBHOOK_URL: 'not a url TOPSECRET' };
  const bad = await report('15.0.0.1', fresh(), badEnv);
  assert.equal(bad.status, 502);
  assert.doesNotMatch(JSON.stringify(incidents), /TOPSECRET/);
}
{
  // Lone surrogates from a client become U+FFFD, so Discord cannot reject the message as invalid UTF-8.
  const embed = discordMessage({ schema: 1, kind: 'manual', version: '3.1.3', summary: 'half \ud83d', note: 'broken \udc00 note' }, 'u').embeds[0];
  for (const text of [embed.title, embed.description]) assert.equal(text, text.toWellFormed());
  // A report's own code fences cannot close the code block it is shown in.
  const fenced = discordMessage({ schema: 1, kind: 'manual', version: '3.1.3', report: 'a\n```\n@everyone' }, 'f').embeds[0];
  assert.equal(fenced.description.split('```').length - 1, 2, 'only the wrapping fences remain');
}

{
  // Many clients, each under its own IP limit, still reach the shared ceiling for the hour.
  let refused = null;
  for (let i = 0; i <= GLOBAL_LIMIT_PER_HOUR && !refused; i += 1) {
    const res = await post(fresh(), `20.0.${Math.floor(i / 200)}.${i % 200}`);
    if (res.status === 429) refused = res;
  }
  assert.ok(refused, 'the relay refuses once every client together reaches the hourly ceiling');
}
{
  // The "older client" label compares against this baseline, so a release the relay was not updated for is caught here.
  const toml = fs.readFileSync(new URL('../relay/wrangler.toml', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
  assert.equal(toml.match(/^RELAY_EXTENSION_VERSION = "([^"]+)"/m)?.[1], manifest.version, 'relay baseline matches the released version');
}

console.log('relay worker behavior OK');
