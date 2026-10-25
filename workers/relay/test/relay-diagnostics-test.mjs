// Everything the relay sends the diagnostics Worker through its DIAGNOSTICS service binding: the opt-in
// diagnostics bridge and the dashboard copy of automatic reports. All requests stay in memory: the
// binding and Discord are local fakes, and no device push or Cloudflare resource is contacted.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import worker, { MAX_BODY_BYTES, DIAGNOSTICS_TIMEOUT_MS, dashboardReport } from '../worker.js';
import { reports } from '../../../tests/unit/helpers/report-contract.mjs';

// The opt-in diagnostics transport uses the existing relay origin and a fixed service binding.
async function bridgeTests() {
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const firefox = 'moz-extension://12ab3456-7890-4123-8abc-123456789abc';
  const reportId = '12345678-abcd-4123-8abc-123456789abc';
  const heartbeatId = 'abcdef12-3456-4123-8abc-123456789abc';
  const report = { schema_version: 1, consent: 'diagnostics-v1', report_id: reportId };
  const heartbeat = { schema_version: 1, consent: 'telemetry-v1', heartbeat_id: heartbeatId };
  const incoming = (path = '/v1/diagnostics', options = {}) => {
    const headers = new Headers({ origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.42', ...options.headers });
    for (const key of options.omitHeaders || []) headers.delete(key);
    const method = options.method || 'POST';
    return new Request(`https://relay.test${path}`, { method, headers,
      ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: options.body ?? JSON.stringify(report), duplex: 'half' }) });
  };
  const call = (env, path, options) => worker.fetch(incoming(path, options), env, {});
  const success = (key = 'report_id', id = reportId, extra = {}) => Response.json({ ok: true, [key]: id, duplicate: false, ...extra }, { status: 202 });
  const requested = [];
  const env = { DIAGNOSTICS: { async fetch(request) {
    requested.push(request);
    const path = new URL(request.url).pathname;
    return path === '/api/heartbeat' ? success('heartbeat_id', heartbeatId) : success();
  } } };
  const externalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error('No external transport is allowed in bridge tests'); };
  try {
    let result = await call(env, '/v1/diagnostics', { headers: { authorization: 'Bearer PRIVATE', cookie: 'CF_Authorization=PRIVATE',
      'cf-access-jwt-assertion': 'PRIVATE', 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.9' } });
    assert.equal(result.status, 202);
    assert.deepEqual(await result.json(), { ok: true, report_id: reportId, duplicate: false });
    assert.equal(result.headers.get('access-control-allow-origin'), origin);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(requested[0].url, 'https://diagnostics.thomast.uk/api/ingest');
    assert.equal(requested[0].method, 'POST');
    assert.equal(requested[0].redirect, 'manual');
    assert.deepEqual(Object.fromEntries(requested[0].headers), { 'cf-connecting-ip': '203.0.113.42', 'content-type': 'application/json', origin });
    assert.deepEqual(await requested[0].json(), report);

    result = await call(env, '/v1/heartbeat', { body: JSON.stringify(heartbeat), headers: { origin: firefox, 'cf-connecting-ip': '2001:0db8:0000::1' } });
    assert.equal(result.status, 202);
    assert.deepEqual(await result.json(), { ok: true, heartbeat_id: heartbeatId, duplicate: false });
    assert.equal(requested[1].url, 'https://diagnostics.thomast.uk/api/heartbeat');
    assert.equal(requested[1].headers.get('origin'), firefox);
    assert.equal(requested[1].headers.get('cf-connecting-ip'), '2001:db8::1');

    const before = requested.length;
    for (const path of ['/v1/diagnostics/admin', '/v1/diagnostics/', '/api/ingest', '/api/admin/issues', '/v1/heartbeat/admin', '/v1/diagnostics?next=/api/admin/issues']) {
      assert.equal((await call(env, path)).status, 404, `${path} is never forwarded`);
    }
    assert.equal((await call(env, '/v1/report', { body: '{}' })).status, 422, 'legacy reports keep their own validation and transport');
    assert.equal(requested.length, before, 'the binding only receives the two exact bridge routes');
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await call(env, '/v1/diagnostics', { method })).status, 405);

    for (const invalid of ['', 'https://evil.example', 'chrome-extension://abc', `chrome-extension://${'a'.repeat(32)}/`, 'moz-extension://not-a-uuid']) {
      result = await call(env, '/v1/diagnostics', { headers: { origin: invalid } });
      assert.equal(result.status, 403);
      assert.equal(result.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await call({ ...env, ALLOWED_ORIGINS: 'moz-extension://' })).status, 403, 'deployment CORS restrictions are also respected');
    assert.equal(requested.length, before);

    result = await call(env, '/v1/diagnostics', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' }, omitHeaders: ['cf-connecting-ip'] });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    for (const headers of [{ 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
      { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' }, {}]) {
      assert.equal((await call(env, '/v1/diagnostics', { method: 'OPTIONS', headers })).status, 403);
    }
    for (const ip of ['', '999.2.3.4', '1.2.3.4,5.6.7.8', '2001:not-ip::1']) {
      assert.equal((await call(env, '/v1/diagnostics', { headers: { 'cf-connecting-ip': ip } })).status, 403);
    }
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=latin1' }, { 'content-encoding': 'gzip' }]) {
      assert.equal((await call(env, '/v1/diagnostics', { headers })).status, 415);
    }
    assert.equal((await call(env, '/v1/diagnostics', { body: '{broken' })).status, 400);
    assert.equal((await call(env, '/v1/diagnostics', { body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]) })).status, 400, 'invalid UTF-8 is not repaired into a different report');
    assert.equal((await call(env, '/v1/diagnostics', { body: ' '.repeat(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await call(env, '/v1/diagnostics', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })).status, 413);
    let cancelled = false;
    const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); },
      cancel() { cancelled = true; return new Promise(() => {}); } });
    assert.equal((await call(env, '/v1/diagnostics', { body: oversized })).status, 413, 'chunked oversized bodies stop without waiting for cancellation');
    assert.equal(cancelled, true);
    assert.equal(requested.length, before, 'rejected input does not reach the diagnostics service');

    result = await call({});
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('retry-after'), '60');
    for (const status of [400, 401, 403, 409, 413, 415, 422, 429, 500, 302]) {
      result = await call({ DIAGNOSTICS: { async fetch() { return new Response('PRIVATE upstream detail', { status,
        headers: { 'set-cookie': 'PRIVATE', location: 'https://evil.example', 'retry-after': '999999999', 'content-type': 'text/plain' } }); } } });
      assert.equal(result.status, status === 500 || status === 302 ? 503 : status);
      assert.equal(result.headers.get('set-cookie'), null);
      assert.equal(result.headers.get('location'), null);
      assert.doesNotMatch(await result.text(), /PRIVATE|evil/);
      if (status === 429) assert.equal(result.headers.get('retry-after'), '86400');
    }
    for (const response of [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
      success('report_id', heartbeatId), Response.json({ ok: true, report_id: reportId, duplicate: 'yes' }),
      new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } })]) {
      assert.equal((await call({ DIAGNOSTICS: { async fetch() { return response; } } })).status, 503, 'malformed or oversized upstream acknowledgements are rejected');
    }
    result = await call({ DIAGNOSTICS: { async fetch() { return success('report_id', reportId, { private: 'PRIVATE', duplicate: true }); } } });
    assert.deepEqual(await result.json(), { ok: true, report_id: reportId, duplicate: true }, 'only the public acknowledgement fields are returned');
    assert.equal((await call({ DIAGNOSTICS: { async fetch() { return success(); } } }, '/v1/diagnostics',
      { body: JSON.stringify({ ...report, report_id: reportId.toUpperCase() }) })).status, 202, 'the API normalizes UUID casing before acknowledging a request');
    assert.equal((await call({ DIAGNOSTICS: { async fetch() { throw new Error('PRIVATE service failure'); } } })).status, 503);

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let resolveStarted;
      const started = new Promise((resolve) => { resolveStarted = resolve; });
      let forwarded;
      const pending = call({ DIAGNOSTICS: { fetch(request) { forwarded = request; resolveStarted(); return new Promise(() => {}); } } });
      await started;
      mock.timers.tick(DIAGNOSTICS_TIMEOUT_MS + 1);
      assert.equal((await pending).status, 503, 'a stalled service cannot hold the extension request forever');
      assert.equal(forwarded.signal.aborted, true);
    } finally { mock.timers.reset(); }
    assert.equal(externalCalls, 0, 'the diagnostics path never sends a duplicate legacy Discord report or public-network fetch');
    const config = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.match(config, /\[\[services\]\]\s+binding = "DIAGNOSTICS"\s+service = "nexusmods-diagnostics"/);
  } finally {
    globalThis.fetch = externalFetch;
  }
  console.log('relay diagnostics bridge OK');
}

// The relay's copy of automatic reports for the private dashboard.
async function dashboardCopyTests() {
  const origin = `chrome-extension://${'b'.repeat(32)}`;
  const webhook = 'https://discord.com/api/webhooks/123456789012345678/fixture-webhook-token-0123456789';
  let sequence = 0;
  // Each report has its own fault, so the relay's Discord dedupe and per-address limits stay out of the way.
  const automatic = (overrides = {}) => ({ ...reports.automatic, browser: 'Opera 124', firstAt: '2026-10-23T12:00:00.000Z',
    error: { ...reports.automatic.error, context: `dashboard copy ${sequence++}`, message: 'Private cause text' }, ...overrides });
  let address = 0;
  function send(env, payload, { headers = {} } = {}) {
    const pending = [];
    const request = new Request('https://relay.test/v1/report', { method: 'POST', body: JSON.stringify(payload),
      headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${address++ % 250}`, ...headers } });
    return worker.fetch(request, env, { waitUntil(promise) { pending.push(promise); } })
      .then(async (response) => { await Promise.all(pending); return response; });
  }
  const copies = [];
  const service = (respond = () => Response.json({ ok: true }, { status: 202 })) => ({
    async fetch(request) { copies.push({ request, body: await request.clone().json() }); return respond(request); }
  });
  const discord = [];
  const externalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { discord.push(String(url)); return new Response(null, { status: 204 }); };
  const incidents = [];
  const env = (overrides = {}) => ({ DISCORD_WEBHOOK_URL: webhook, INCIDENT_LOG: (line) => incidents.push(JSON.parse(line)),
    DIAGNOSTICS: service(), ...overrides });

  try {
    // An automatic report from an extension page is answered as before and copied once.
    const payload = automatic();
    let response = await send(env(), payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(discord.length, 1);
    assert.equal(copies.length, 1);
    const [{ request, body }] = copies;
    assert.equal(request.url, 'https://diagnostics.thomast.uk/api/ingest/automatic');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.get('origin'), origin);
    assert.match(request.headers.get('cf-connecting-ip'), /^198\.51\.100\.\d+$/);
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.deepEqual(body, await dashboardReport(payload), 'the copy is the dashboard form of the same report');
    assert.equal(body.consent, 'automatic-v1');
    for (const key of ['install_id', 'os', 'os_version', 'reference', 'page', 'occurrences', 'kind', 'schema']) {
      assert.equal(Object.hasOwn(body, key), false, `${key} is not copied`);
    }

    // Discord sends one message per fault and window; the dashboard still receives the repeat, under the
    // same id, so it stores the report once. The relay does not know or care which.
    copies.length = 0; discord.length = 0;
    const repeat = automatic();
    await send(env(), repeat);
    response = await send(env(), repeat);
    assert.equal((await response.json()).duplicate, true);
    assert.equal(discord.length, 1);
    assert.equal(copies.length, 2);
    assert.equal(copies[0].body.report_id, copies[1].body.report_id, 'a retry carries the same report id');

    // Not copied: manual reports, other origins, invalid or rate-limited requests, or no service binding.
    copies.length = 0;
    await send(env(), { schema: 1, kind: 'manual', version: '3.3.1', summary: 'A bug', note: 'Steps' });
    await send(env(), automatic(), { headers: { origin: 'https://hostile.test' } });
    await send(env(), automatic(), { headers: { origin: 'moz-extension://not-a-uuid' } });
    await send(env(), { ...automatic(), version: 'x' });
    await send(env({ DIAGNOSTICS: undefined }), automatic());
    const limited = env();
    const ip = '192.0.2.200';
    for (let attempt = 0; attempt < 11; attempt++) await send(limited, automatic(), { headers: { 'cf-connecting-ip': ip } });
    assert.equal(copies.length, 10, 'only the ten automatic reports the hourly limit admits are copied');
    copies.length = 0;
    await send(env(), automatic(), { headers: { 'cf-connecting-ip': 'not-an-address' } });
    assert.equal(copies.length, 0, 'a copy needs a valid client address for the dashboard limit');

    // A copy that fails never changes the answer, and its incident line carries no report text.
    incidents.length = 0;
    for (const DIAGNOSTICS of [service(() => new Response('PRIVATE upstream body', { status: 503 })),
      { async fetch() { throw new Error('PRIVATE service failure'); } }]) {
      response = await send(env({ DIAGNOSTICS }), automatic());
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    const failed = incidents.filter((line) => line.event === 'dashboard_copy_failed');
    assert.equal(failed.length, 2);
    assert.equal(failed[0].status, 503);
    assert.equal(JSON.stringify(failed).includes('Private cause text'), false);
    assert.equal(JSON.stringify(failed).includes('PRIVATE upstream body'), false);

    // The response does not wait for the dashboard.
    let release;
    let finished = false;
    const stalled = new Promise((resolve) => { release = resolve; });
    const slow = { async fetch() { await stalled; finished = true; return Response.json({ ok: true }, { status: 202 }); } };
    const pending = [];
    const answer = await worker.fetch(new Request('https://relay.test/v1/report', { method: 'POST', body: JSON.stringify(automatic()),
      headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.200' } }),
    env({ DIAGNOSTICS: slow }), { waitUntil(promise) { pending.push(promise); } });
    assert.equal(answer.status, 200);
    assert.equal(finished, false, 'answered while the copy is still in flight');
    release();
    await Promise.all(pending);
    assert.equal(finished, true, 'the copy runs under waitUntil');
  } finally {
    globalThis.fetch = externalFetch;
  }
  console.log('relay dashboard copy OK');
}

await bridgeTests();
await dashboardCopyTests();
