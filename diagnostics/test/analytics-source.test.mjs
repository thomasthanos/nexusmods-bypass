import assert from 'node:assert/strict';
import { test } from 'node:test';

const service = () => import('../src/services/analytics-source.ts');
const NOW = Date.UTC(2026, 9, 23, 12);
const TOKEN = 'https://oauth2.googleapis.com/token';
const PROPERTY = 'https://analyticsadmin.googleapis.com/v1beta/properties/547084285';
const DATA = 'https://analyticsdata.googleapis.com/v1beta/properties/547084285';
const CREDENTIALS = JSON.stringify({ client_id: 'diagnostics.apps.googleusercontent.com', client_secret: 'private-client-secret', refresh_token: 'private-refresh-token' });
const count = (value) => ({ metricValues: [{ value: String(value) }] });
const report = (metric, value, metadata = {}) => ({ metricHeaders: [{ name: metric, type: 'TYPE_INTEGER' }], dimensionHeaders: [], rows: [count(value)], rowCount: 1, metadata });
const weekly = (current = 120, previous = 100, metadata = {}) => ({
  metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }], dimensionHeaders: [{ name: 'dateRange' }],
  rows: [
    { dimensionValues: [{ value: 'previous_week' }], ...count(previous) },
    { dimensionValues: [{ value: 'current_week' }], ...count(current) }
  ], rowCount: 2, metadata: { timeZone: 'Europe/Athens', ...metadata }
});
function upstream(overrides = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body && String(init.body);
    calls.push({ url, init, body });
    if (Object.hasOwn(overrides, url)) return overrides[url]({ url, init, body });
    if (url === TOKEN) return Response.json({ access_token: 'private-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/analytics.readonly' });
    if (url === PROPERTY) return Response.json({ name: 'properties/547084285', createTime: '2026-10-01T23:30:00Z', timeZone: 'Europe/Athens' });
    if (url === `${DATA}:runRealtimeReport`) return Response.json(report('activeUsers', 8));
    if (url === `${DATA}:runReport`) return Response.json(JSON.parse(body).metrics[0].name === 'activeUsers' ? weekly() : report('totalUsers', 1100));
    throw new Error(`Unexpected analytics URL: ${url}`);
  };
  return { calls, fetch };
}

test('unconfigured analytics never fetches or invents zero user counts', async () => {
  const { getAnalyticsSnapshot } = await service();
  let calls = 0;
  const result = await getAnalyticsSnapshot({ fetch: async () => { calls++; throw new Error('must not fetch'); }, now: () => NOW });
  assert.equal(result.state, 'not_configured');
  assert.equal(result.property_id, '547084285');
  assert.equal(result.source, 'ga4_store_listing');
  for (const key of ['online_30m', 'weekly_active', 'previous_weekly_active', 'history_total_users', 'fetched_at']) assert.equal(result[key], null);
  assert.equal(calls, 0);
});

test('Google user OAuth reads fixed property reports and keeps every credential server side', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream();
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.deepEqual(result, { property_id: '547084285', source: 'ga4_store_listing', state: 'ready', fetched_at: NOW,
    online_30m: 8, weekly_active: 120, previous_weekly_active: 100, weekly_change_percent: 20,
    history_total_users: 1100, history_start_date: '2026-10-02', time_zone: 'Europe/Athens',
    quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null });
  const token = provider.calls.find(({ url }) => url === TOKEN);
  assert.equal(token.init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), { grant_type: 'refresh_token', client_id: 'diagnostics.apps.googleusercontent.com', client_secret: 'private-client-secret', refresh_token: 'private-refresh-token' });
  const realtime = provider.calls.find(({ url }) => url.endsWith(':runRealtimeReport'));
  assert.deepEqual(JSON.parse(realtime.body), { metrics: [{ name: 'activeUsers' }], minuteRanges: [{ name: 'last_30_minutes', startMinutesAgo: 29, endMinutesAgo: 0 }], returnPropertyQuota: true });
  const weeks = provider.calls.find(({ url, body }) => url.endsWith(':runReport') && body.includes('current_week'));
  assert.deepEqual(JSON.parse(weeks.body), { metrics: [{ name: 'activeUsers' }], dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday', name: 'current_week' }, { startDate: '14daysAgo', endDate: '8daysAgo', name: 'previous_week' }], returnPropertyQuota: true });
  const history = provider.calls.find(({ url, body }) => url.endsWith(':runReport') && body.includes('totalUsers'));
  assert.deepEqual(JSON.parse(history.body), { metrics: [{ name: 'totalUsers' }], dateRanges: [{ startDate: '2026-10-02', endDate: 'today' }], returnPropertyQuota: true });
  for (const call of provider.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.ok(call.init.signal instanceof AbortSignal);
    if (call.url !== TOKEN) assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer private-access-token');
  }
  assert.doesNotMatch(JSON.stringify(result), /private-|client_secret|refresh_token|access_token/);
});

test('legitimate empty reports return zeros and an undefined percentage for a zero baseline', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({
    [`${DATA}:runRealtimeReport`]: () => Response.json({ ...report('activeUsers', 0), rows: [], rowCount: 0 }),
    [`${DATA}:runReport`]: ({ body }) => Response.json(JSON.parse(body).metrics[0].name === 'activeUsers'
      ? { ...weekly(), rows: [], rowCount: 0 } : { ...report('totalUsers', 0), rows: [], rowCount: 0 })
  });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'ready');
  assert.equal(result.online_30m, 0);
  assert.equal(result.weekly_active, 0);
  assert.equal(result.previous_weekly_active, 0);
  assert.equal(result.history_total_users, 0);
  assert.equal(result.weekly_change_percent, null);
});

test('a missing zero-valued date range does not turn weekly percentage into Infinity', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({ [`${DATA}:runReport`]: ({ body }) => Response.json(JSON.parse(body).metrics[0].name === 'activeUsers'
    ? { ...weekly(), rows: [{ dimensionValues: [{ value: 'current_week' }], ...count(12) }], rowCount: 1 } : report('totalUsers', 1100)) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'ready');
  assert.equal(result.weekly_active, 12);
  assert.equal(result.previous_weekly_active, 0);
  assert.equal(result.weekly_change_percent, null);
});

test('denied property metadata preserves realtime and weekly users with an honest history limitation', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({ [PROPERTY]: () => Response.json({ error: { message: 'private-provider-message' } }, { status: 403 }) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'ready');
  assert.equal(result.online_30m, 8);
  assert.equal(result.weekly_active, 120);
  assert.equal(result.history_total_users, null);
  assert.equal(result.history_start_date, null);
  assert.equal(result.time_zone, 'Europe/Athens');
  assert.match(result.message, /history|historical|creation/i);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-message/);
  assert.equal(provider.calls.filter(({ body }) => body?.includes('totalUsers')).length, 0);
});

test('a failed history report never erases valid recent metrics or fabricates a history zero', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({ [`${DATA}:runReport`]: ({ body }) => JSON.parse(body).metrics[0].name === 'activeUsers'
    ? Response.json(weekly()) : Response.json({ error: 'private-provider-message' }, { status: 429 }) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'ready');
  assert.equal(result.weekly_active, 120);
  assert.equal(result.history_total_users, null);
  assert.equal(result.history_start_date, '2026-10-02');
  assert.ok(result.message);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-message/);
});

test('quality warnings include thresholding, sampling, aggregation loss and truncation', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({ [`${DATA}:runReport`]: ({ body }) => Response.json(JSON.parse(body).metrics[0].name === 'activeUsers'
    ? weekly(90, 100, { subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: '20', samplingSpaceSize: '100' }] })
    : report('totalUsers', 1100, { dataTruncationReasons: [{ reason: 'REASON_UNSPECIFIED' }] })) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.weekly_change_percent, -10);
  assert.deepEqual(result.quality, { subject_to_thresholding: true, sampled: true, data_loss: true });
});

test('invalid credentials and OAuth errors cannot leak secrets or produce report zeros', async () => {
  const { getAnalyticsSnapshot } = await service();
  for (const credentials of ['broken-json', '{}', JSON.stringify({ client_id: 'id', client_secret: 'secret' })]) {
    let calls = 0;
    const result = await getAnalyticsSnapshot({ credentials, now: () => NOW, fetch: async () => { calls++; throw new Error('unexpected'); } });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.online_30m, null);
    assert.equal(calls, 0);
  }
  const provider = upstream({ [TOKEN]: () => Response.json({ error: 'invalid_grant', error_description: 'private-refresh-token' }, { status: 400 }) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.fetched_at, null);
  assert.equal(result.weekly_active, null);
  assert.doesNotMatch(JSON.stringify(result), /private-|invalid_grant/);
  assert.equal(provider.calls.length, 1);
});

test('provider redirects are rejected without forwarding OAuth credentials elsewhere', async () => {
  const { getAnalyticsSnapshot } = await service();
  const provider = upstream({ [TOKEN]: () => new Response('', { status: 302, headers: { location: 'https://foreign.example/token' } }) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'unavailable');
  assert.equal(provider.calls.length, 1);
});

test('malformed required reports remain unavailable rather than becoming plausible counts', async () => {
  const { getAnalyticsSnapshot } = await service();
  const invalid = [
    {}, { ...report('activeUsers', 1), metricHeaders: [{ name: 'totalUsers', type: 'TYPE_INTEGER' }] },
    report('activeUsers', '-1'), report('activeUsers', '1.5'), report('activeUsers', '9007199254740992'),
    { ...report('activeUsers', 1), rows: [count(1), count(2)], rowCount: 2 },
    { ...report('activeUsers', 1), rows: undefined, rowCount: 1 },
    { ...report('activeUsers', 1), metadata: { emptyReason: 'private-provider-error' } }
  ];
  for (const payload of invalid) {
    const provider = upstream({ [`${DATA}:runRealtimeReport`]: () => Response.json(payload) });
    const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.online_30m, null);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-error/);
  }
  for (const payload of [
    { ...weekly(), dimensionHeaders: [] },
    { ...weekly(), rows: [{ dimensionValues: [{ value: 'unexpected_range' }], ...count(1) }] },
    { ...weekly(), rows: [{ dimensionValues: [{ value: 'current_week' }], ...count(1) }, { dimensionValues: [{ value: 'current_week' }], ...count(2) }] }
  ]) {
    const provider = upstream({ [`${DATA}:runReport`]: ({ body }) => Response.json(JSON.parse(body).metrics[0].name === 'activeUsers' ? payload : report('totalUsers', 1)) });
    const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
    assert.equal(result.state, 'unavailable');
  }
});

test('invalid creation dates, timezones and mismatched property IDs never fabricate history ranges', async () => {
  const { getAnalyticsSnapshot } = await service();
  for (const metadata of [
    { name: 'properties/999', createTime: '2026-10-01T00:00:00Z', timeZone: 'UTC' },
    { name: 'properties/547084285', createTime: '2026-02-30T00:00:00Z', timeZone: 'UTC' },
    { name: 'properties/547084285', createTime: '2027-01-01T00:00:00Z', timeZone: 'UTC' },
    { name: 'properties/547084285', createTime: '2026-10-01T00:00:00Z', timeZone: 'not-a-zone' }
  ]) {
    const provider = upstream({ [PROPERTY]: () => Response.json(metadata) });
    const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
    assert.equal(result.state, 'ready');
    assert.equal(result.history_start_date, null);
    assert.equal(result.history_total_users, null);
    assert.ok(result.message);
  }
});

test('oversized streamed provider responses are bounded even without Content-Length', async () => {
  const { getAnalyticsSnapshot } = await service();
  let canceled = false;
  const provider = upstream({ [TOKEN]: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(70_000))); },
    cancel() { canceled = true; }
  })) });
  const result = await getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: provider.fetch, now: () => NOW });
  assert.equal(result.state, 'unavailable');
  assert.equal(canceled, true);
});

test('a stalled provider request has a deadline and aborts before returning unavailable', async (t) => {
  const { getAnalyticsSnapshot } = await service();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = getAnalyticsSnapshot({ credentials: CREDENTIALS, now: () => NOW, fetch: async (_input, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  t.mock.timers.tick(10_000);
  const result = await pending;
  assert.equal(result.state, 'unavailable');
  assert.equal(signal.aborted, true);
});

test('independent requests refresh their own tokens without sharing provider I/O', async () => {
  const { getAnalyticsSnapshot } = await service();
  const first = upstream({ [TOKEN]: () => Response.json({ access_token: 'token-one', token_type: 'Bearer', expires_in: 3600 }) });
  const second = upstream({ [TOKEN]: () => Response.json({ access_token: 'token-two', token_type: 'Bearer', expires_in: 3600 }) });
  await Promise.all([
    getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: first.fetch, now: () => NOW }),
    getAnalyticsSnapshot({ credentials: CREDENTIALS, fetch: second.fetch, now: () => NOW })
  ]);
  assert.equal(first.calls.filter(({ url }) => url === TOKEN).length, 1);
  assert.equal(second.calls.filter(({ url }) => url === TOKEN).length, 1);
  assert.ok(first.calls.filter(({ url }) => url !== TOKEN).every(({ init }) => new Headers(init.headers).get('authorization') === 'Bearer token-one'));
  assert.ok(second.calls.filter(({ url }) => url !== TOKEN).every(({ init }) => new Headers(init.headers).get('authorization') === 'Bearer token-two'));
});
