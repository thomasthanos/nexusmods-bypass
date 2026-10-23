// The relay's copy of automatic reports for the private dashboard. Everything stays in memory: Discord
// and the diagnostics service binding are local fakes, and no Cloudflare resource is contacted.
import assert from 'node:assert/strict';
import worker, { dashboardReport } from '../relay/worker.js';

const origin = `chrome-extension://${'b'.repeat(32)}`;
const webhook = 'https://discord.com/api/webhooks/123456789012345678/fixture-webhook-token-0123456789';
let sequence = 0;
// Each report has its own fault, so the relay's Discord dedupe and per-address limits stay out of the way.
const automatic = (overrides = {}) => ({ schema: 1, kind: 'auto', version: '3.3.1', browser: 'Opera 124',
  firstAt: '2026-10-23T12:00:00.000Z', error: { code: 'request_failed', context: `dashboard copy ${sequence++}`,
    message: 'Private cause text' }, ...overrides });
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
