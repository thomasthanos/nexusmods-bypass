import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessage, sendDiscordReport, sendWebPush } from '../src/services/delivery.ts';
import { errorReportSchema } from '../src/schemas/ingest.ts';

const NOW = 1_792_604_800_000;
const fingerprint = 'ab'.repeat(32);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const text = (value) => new TextEncoder().encode(value);
const concat = (...parts) => new Uint8Array(parts.flatMap((part) => [...part]));

async function keys() {
  const recipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  return {
    recipient,
    target: { endpoint: 'https://web.push.apple.com/push/device-secret', p256dh: b64(await crypto.subtle.exportKey('raw', recipient.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) },
    vapid: { publicKey: b64(await crypto.subtle.exportKey('raw', vapid.publicKey)), privateKey: jwk.d, subject: 'mailto:admin@example.com' },
    verificationKey: vapid.publicKey,
  };
}

const material = await keys();
const payload = () => ({ title: 'Regression', body: 'Download handoff failed', tag: fingerprint, data: { url: 'https://diagnostics.example.com/?issue=42', issue_id: 42, fingerprint, trigger: 'REGRESSION' }, badge_count: 2 });
const context = () => ({ issueId: 42, fingerprint, dashboardOrigin: 'https://diagnostics.example.com', category: 'HANDOFF_FAILURE', faultOrigin: 'client_env', suggestedAction: 'Check the protocol handler.' });
const report = () => errorReportSchema.parse({ schema_version: 1, consent: 'diagnostics-v1', report_id: '3761cb55-49b3-4f63-bbad-74c5cc586528', install_id: 'e'.repeat(64), occurred_at: '2026-10-21T10:00:00.000Z', version: '3.2.0', browser: 'firefox', browser_version: '144.0', os: 'windows', download_mode: 'auto', destination: 'vortex', severity: 'error', error_category: 'HANDOFF', error_code: 'NXM_TIMEOUT', failure_stage: 'VORTEX_NXM_HANDOFF_FAILED', error_message: 'Protocol handler timed out', stack_trace: 'Error: timeout\n at handoff (scripts/download.js:50:4)', breadcrumbs: [{ timestamp_offset_ms: 0, stage: 'UI', action: 'CLICK', status: 'ok' }, { timestamp_offset_ms: 5000, stage: 'HANDOFF', action: 'NXM_OPEN', status: 'error', duration_ms: 5000 }] });

function network(t, handler = () => new Response(null, { status: 201 })) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return handler(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

async function hkdf(input, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

async function decrypt(body) {
  const wire = new Uint8Array(body);
  assert.equal(wire[20], 65);
  const ephemeral = await crypto.subtle.importKey('raw', wire.slice(21, 86), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, material.recipient.privateKey, 256);
  const keyInfo = concat(text('WebPush: info\0'), bytes(material.target.p256dh), wire.slice(21, 86));
  const ikm = await hkdf(shared, bytes(material.target.auth), keyInfo, 256);
  const salt = wire.slice(0, 16);
  const cek = await hkdf(ikm, salt, text('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, text('Content-Encoding: nonce\0'), 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, wire.slice(86)));
  let end = clear.length - 1;
  while (clear[end] === 0) end--;
  assert.equal(clear[end], 2, 'The final RFC 8188 record delimiter is present');
  return JSON.parse(new TextDecoder().decode(clear.slice(0, end)));
}

test('sends actual encrypted Web Push with valid VAPID signature, grouping, TTL and urgency', async (t) => {
  const requests = network(t);
  assert.deepEqual(await sendWebPush(material.target, payload(), material.vapid, { now: NOW }), { ok: true, status: 201, retryable: false, expired: false, retry_after_ms: null, reason: 'delivered' });
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, material.target.endpoint);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.method.toLowerCase(), 'post');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('content-encoding'), 'aes128gcm');
  assert.equal(headers.get('ttl'), '300');
  assert.equal(headers.get('topic'), fingerprint.slice(0, 32));
  assert.equal(headers.get('urgency'), 'high');
  assert.ok(init.body.byteLength <= 4096);
  const auth = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get('authorization'));
  assert.equal(auth[2], material.vapid.publicKey);
  const [header, claims, signature] = auth[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, material.verificationKey, bytes(signature), text(`${header}.${claims}`)), true);
  const token = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(token.aud, 'https://web.push.apple.com');
  assert.equal(token.sub, 'mailto:admin@example.com');
  assert.ok(token.exp > Date.now() / 1000 && token.exp <= Date.now() / 1000 + 86400);
  assert.deepEqual(await decrypt(init.body), payload());
});

test('uses normal urgency for noncritical push and keeps full fingerprint as notification tag', async (t) => {
  const requests = network(t);
  const value = payload();
  value.data.trigger = 'SPIKE_DETECTED';
  value.tag = 'incorrect-short-tag';
  await sendWebPush(material.target, value, material.vapid);
  assert.equal(new Headers(requests[0].init.headers).get('urgency'), 'normal');
  assert.equal((await decrypt(requests[0].init.body)).tag, fingerprint);
});

test('rejects arbitrary, private, credentialed, fragmented and non-HTTPS push destinations before fetch', async (t) => {
  const requests = network(t);
  for (const endpoint of ['https://127.0.0.1/send', 'https://[::1]/send', 'https://example.com/push', 'http://web.push.apple.com/send', 'https://web.push.apple.com.evil.test/send', 'https://web.push.apple.com@evil.test/send', 'https://user:pass@fcm.googleapis.com/send', 'https://@fcm.googleapis.com/send', 'https:fcm.googleapis.com/send', 'https://fcm.googleapis.com:444/send', 'https://fcm.googleapis.com/send#fragment', 'https://fcm.googleapis.com/send#', 'https://fcm.googleapis.com./send']) {
    const result = await sendWebPush({ ...material.target, endpoint }, payload(), material.vapid);
    assert.equal(result.reason, 'invalid_subscription', endpoint);
    assert.equal(result.retryable, false);
  }
  assert.equal(requests.length, 0);
});

test('accepts supported Apple, Google, Mozilla and Microsoft push hosts', async (t) => {
  const requests = network(t);
  for (const endpoint of ['https://web.push.apple.com/send', 'https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token', 'https://wns2-pn1p.notify.windows.com/w/?token=secret']) {
    assert.equal((await sendWebPush({ ...material.target, endpoint }, payload(), material.vapid)).ok, true, endpoint);
  }
  assert.equal(requests.length, 4);
});

test('rejects malformed subscription secrets and invalid curve points without sending', async (t) => {
  const requests = network(t);
  for (const change of [{ auth: 'bad' }, { auth: `${material.target.auth}=` }, { auth: b64(new Uint8Array(17)) }, { p256dh: `${material.target.p256dh}=` }, { p256dh: b64(new Uint8Array(65).fill(4)) }, { p256dh: b64(new Uint8Array(65)) }]) {
    assert.equal((await sendWebPush({ ...material.target, ...change }, payload(), material.vapid)).reason, 'invalid_subscription');
  }
  assert.equal(requests.length, 0);
});

test('rejects invalid and mismatched VAPID keys or contact subjects without sending', async (t) => {
  const requests = network(t);
  const other = await keys();
  for (const change of [{ publicKey: 'bad' }, { privateKey: 'bad' }, { privateKey: other.vapid.privateKey }, { subject: 'invalid' }, { subject: 'http://example.com' }, { subject: 'mailto:' }, { subject: 'mailto:admin@example.com?subject=unsafe' }, { subject: 'https://user:secret@example.com' }]) {
    assert.equal((await sendWebPush(material.target, payload(), { ...material.vapid, ...change })).reason, 'invalid_config');
  }
  assert.equal(requests.length, 0);
});

test('expired subscriptions never send and HTTP 404/410 identify expired subscriptions', async (t) => {
  const requests = network(t, () => new Response(null, { status: 410 }));
  assert.deepEqual(await sendWebPush({ ...material.target, expiration_time: NOW }, payload(), material.vapid, { now: NOW }), { ok: false, status: null, retryable: false, expired: true, retry_after_ms: null, reason: 'invalid_subscription' });
  assert.equal(requests.length, 0);
  assert.deepEqual(await sendWebPush(material.target, payload(), material.vapid), { ok: false, status: 410, retryable: false, expired: true, retry_after_ms: null, reason: 'http_error' });
});

test('oversized push payloads fail before encryption or network delivery', async (t) => {
  const requests = network(t);
  assert.equal((await sendWebPush(material.target, { ...payload(), body: '😀'.repeat(2000) }, material.vapid)).reason, 'payload_too_large');
  assert.equal(requests.length, 0);
});

test('returns bounded Retry-After for retryable push statuses and cancels response streams', async (t) => {
  let canceled = 0;
  const requests = network(t, () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 429, headers: { 'Retry-After': '999999999' } }));
  const result = await sendWebPush(material.target, payload(), material.vapid, { now: NOW });
  assert.deepEqual(result, { ok: false, status: 429, retryable: true, expired: false, retry_after_ms: 86_400_000, reason: 'http_error' });
  assert.equal(requests.length, 1);
  assert.equal(canceled, 1);
});

test('network failure and timeout are structured retryable errors without exposing secrets', async (t) => {
  network(t, () => { throw new Error(material.target.endpoint + material.vapid.privateKey); });
  assert.deepEqual(await sendWebPush(material.target, payload(), material.vapid), { ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error' });
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  assert.equal((await sendWebPush(material.target, payload(), material.vapid, { timeoutMs: 5 })).reason, 'network_error');
});

test('Discord embeds include bounded useful diagnostics and dashboard deep link', () => {
  const body = buildDiscordMessage(report(), context());
  assert.deepEqual(body.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.ok(body.embeds.length >= 1 && body.embeds.length <= 10);
  assert.equal(body.embeds[0].url, 'https://diagnostics.example.com/?issue=42');
  const output = JSON.stringify(body);
  for (const expected of ['HANDOFF_FAILURE', 'client_env', 'Check the protocol handler.', 'firefox', 'windows', 'vortex', 'NXM_TIMEOUT', 'NXM_OPEN', '5000', 'scripts/download.js']) assert.ok(output.includes(expected), expected);
  assert.ok(!output.includes(report().install_id));
  assert.ok(!output.includes(report().report_id));
});

test('Discord sanitizes report and rule strings, suppresses mentions, and clips Unicode safely to Discord limits', () => {
  const unsafe = report();
  unsafe.error_message = `Authorization: Bearer my-secret-token\nhello person@example.com @everyone <@123> ${unsafe.install_id} C:\\Users\\Alice\\secret.txt https://example.com/path?token=leak ${'😀'.repeat(4000)}`;
  unsafe.stack_trace = `Cookie: session=stack-secret\n${'😀'.repeat(12000)}`;
  unsafe.breadcrumbs = Array.from({ length: 80 }, (_, i) => ({ timestamp_offset_ms: i, stage: 'API', action: 'FETCH', status: 'error', metadata: { token: 'metadata-secret' } }));
  const rule = context();
  rule.suggestedAction = `Authorization: Bearer rule-secret\n${'😀'.repeat(3000)}`;
  const body = buildDiscordMessage(unsafe, rule);
  const output = JSON.stringify(body);
  for (const secret of ['my-secret-token', 'stack-secret', 'rule-secret', 'metadata-secret', 'person@example.com', unsafe.install_id, 'Alice', '?token=leak']) assert.ok(!output.includes(secret), secret);
  let units = 0;
  for (const embed of body.embeds) {
    assert.ok((embed.title?.length ?? 0) <= 256);
    assert.ok((embed.description?.length ?? 0) <= 4096);
    units += (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
    for (const field of embed.fields ?? []) {
      assert.ok(field.name.length <= 256);
      assert.ok(field.value.length <= 1024);
      assert.ok(!/[\uD800-\uDBFF]$/.test(field.value));
      units += field.name.length + field.value.length;
    }
  }
  assert.ok(units <= 6000, `${units} embed units`);
});

test('Discord only sends validated webhook URLs with wait=true and redirect prevention', async (t) => {
  const requests = network(t, () => new Response(null, { status: 200 }));
  for (const host of ['discord.com', 'discordapp.com', 'canary.discord.com']) {
    assert.equal((await sendDiscordReport(`https://${host}/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789`, report(), context())).ok, true);
  }
  for (const request of requests) {
    assert.equal(new URL(request.url).search, '?wait=true');
    assert.equal(request.init.redirect, 'manual');
    assert.equal(new Headers(request.init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(request.init.body).allowed_mentions.parse, []);
  }
});

test('Discord rejects SSRF URLs and malformed webhook paths before network calls', async (t) => {
  const requests = network(t);
  for (const webhook of ['https://example.com/api/webhooks/123/token', 'https://discord.com.evil.test/api/webhooks/123/token', 'http://discord.com/api/webhooks/123/token', 'https://user:pass@discord.com/api/webhooks/123/token', 'https://discord.com:444/api/webhooks/123/token', 'https://discord.com/api/webhooks/id/token', 'https://discord.com/api/webhooks/123/token/extra', 'https://discord.com/api/webhooks/123/token#secret', 'https://discord.com/api/webhooks/123/token?thread_id=1']) {
    assert.equal((await sendDiscordReport(webhook, report(), context())).reason, 'invalid_config', webhook);
  }
  assert.equal(requests.length, 0);
});

test('Discord handles HTTP-date Retry-After, HTTP failures and response body cancellation', async (t) => {
  let canceled = 0;
  network(t, () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503, headers: { 'Retry-After': new Date(NOW + 30_000).toUTCString() } }));
  assert.deepEqual(await sendDiscordReport('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789', report(), context(), { now: NOW }), { ok: false, status: 503, retryable: true, expired: false, retry_after_ms: 30_000, reason: 'http_error' });
  assert.equal(canceled, 1);
});

test('Discord returns config errors for invalid dashboard origins and network errors without secrets', async (t) => {
  const requests = network(t, () => { throw new Error('webhook credential secret'); });
  const webhook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789';
  assert.equal((await sendDiscordReport(webhook, report(), { ...context(), dashboardOrigin: 'javascript:alert(1)' })).reason, 'invalid_config');
  assert.equal(requests.length, 0);
  assert.deepEqual(await sendDiscordReport(webhook, report(), context()), { ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error' });
});

test('ignores malformed Retry-After dates instead of treating loose date strings as valid headers', async (t) => {
  network(t, () => new Response(null, { status: 429, headers: { 'Retry-After': '-1' } }));
  assert.equal((await sendWebPush(material.target, payload(), material.vapid, { now: NOW })).retry_after_ms, null);
});

test('does not follow provider redirects and treats client errors as final failures', async (t) => {
  let status = 302;
  const requests = network(t, () => new Response(null, { status, headers: { location: 'https://127.0.0.1/private' } }));
  for (status of [302, 400, 401, 403, 404, 410]) {
    const result = await sendWebPush(material.target, payload(), material.vapid);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.retryable, false);
    assert.equal(result.expired, status === 404 || status === 410);
    assert.equal(requests.at(-1).init.redirect, 'manual');
  }
  assert.equal(requests.length, 6);
});

test('accepts the complete RFC8291 payload budget and rejects the next UTF-8 byte', async (t) => {
  const requests = network(t);
  const value = { ...payload(), body: '' };
  const overhead = Buffer.byteLength(JSON.stringify(value));
  value.body = 'x'.repeat(3993 - overhead);
  assert.equal((await sendWebPush(material.target, value, material.vapid)).ok, true);
  assert.equal(requests[0].init.body.byteLength, 4096);
  assert.deepEqual(await decrypt(requests[0].init.body), value);
  value.body += 'x';
  assert.equal((await sendWebPush(material.target, value, material.vapid)).reason, 'payload_too_large');
  assert.equal(requests.length, 1);
});

test('sanitizes push display text before it reaches the encrypted notification', async (t) => {
  const requests = network(t);
  await sendWebPush(material.target, { ...payload(), title: 'Contact owner@example.com', body: 'Authorization: Bearer plaintext-secret' }, material.vapid);
  const clear = await decrypt(requests[0].init.body);
  assert.ok(!JSON.stringify(clear).includes('owner@example.com'));
  assert.ok(!JSON.stringify(clear).includes('plaintext-secret'));
});
