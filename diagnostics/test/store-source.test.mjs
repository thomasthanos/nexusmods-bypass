import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const service = () => import('../src/services/store-source.ts').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const fixture = JSON.parse(readFileSync(new URL('./fixtures/store-public.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const ID = 'chfghiknjhpcncpcjopglefnckckdlpj';
const ORIGIN = 'https://chromewebstore.google.com';
const RELEASE_API = 'https://api.github.com/repos/thomasthanos/nexusmods-bypass/releases/latest';
const RELEASE_URL = 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/v3.3.1';
const NOW = Date.UTC(2026, 9, 23, 12);
const clone = (value) => structuredClone(value);
const rpcResponse = (rpc, value) => new Response(`)]}'\n\n${JSON.stringify([['wrb.fr', rpc, JSON.stringify(value), null, null, null, 'generic'], ['di', 4]])}`, { headers: { 'content-type': 'application/json' } });
function requestOf(input, init) {
  const url = new URL(input);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/_/ChromeWebStoreConsumerFeUi/data/batchexecute');
  assert.equal(url.searchParams.get('hl'), 'en');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual', 'Workers support manual redirects; every 3xx must fail');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('cookie'), 'SOCS=CAI');
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded;charset=UTF-8');
  const [[call]] = JSON.parse(new URLSearchParams(init.body).get('f.req'));
  assert.equal(url.searchParams.get('rpcids'), call[0]);
  assert.equal(call[2], null);
  assert.equal(call[3], 'generic');
  const payload = JSON.parse(call[1]);
  assert.equal(payload[0], ID);
  return { rpc: call[0], payload };
}
function sourceFetch(detail = fixture.detail, reviews = fixture.reviews, calls = []) {
  return async (input, init) => {
    if (String(input) === RELEASE_API) return new Response(null, { status: 404 });
    const request = requestOf(input, init);
    calls.push(request);
    return rpcResponse(request.rpc, request.rpc === 'xY2Ddd' ? detail : reviews);
  };
}

test('exports the isolated public store source', async () => {
  assert.equal(typeof (await service()).fetchStoreSnapshot, 'function');
});

test('normalizes the observed public metadata and all-language written reviews without invented installs', async () => {
  const { fetchStoreSnapshot } = await service();
  const calls = [];
  const result = await fetchStoreSnapshot({ now: () => NOW, fetch: sourceFetch(fixture.detail, fixture.reviews, calls) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { rpc: 'xY2Ddd', payload: [ID] });
  assert.deepEqual(calls[1], { rpc: 'x1DgCd', payload: [ID, [100], 2, null, null, ['all'], 0] });
  assert.deepEqual({ ...result, reviews: undefined }, { extension_id: ID,
    store_url: `${ORIGIN}/detail/nexusmods-bypass/${ID}`, version: '3.3.1', users: 60000,
    rating_average: 4.844444444444444, rating_count: 45, written_review_count: 30,
    fetched_at: NOW, reviews_complete: true, reviews: undefined,
    latest_release_version: null, latest_release_url: null, version_status: 'unknown' });
  assert.equal(result.reviews.length, 30);
  assert.deepEqual(result.reviews[0], { id: 'b1fd5094-3ecb-48d1-9540-fb21b9e40b66', author: 'Олег Олд', rating: 5,
    body: 'Замечательное расширение, уже опробовал различные коллекции для BG3 и DA:O',
    created_at: 1792503491795, updated_at: 1792503491795, version: '3.1.8', language: 'ru' });
  const edited = result.reviews.find((review) => review.id === '7db95e5f-d748-4a0f-a794-1a5cbcacedb0');
  assert.ok(edited.updated_at > edited.created_at);
  const skewed = result.reviews.find((review) => review.id === '5248b639-7949-45b1-bbec-2338f4018454');
  assert.equal(skewed.updated_at, 1776281710753, 'preserves an observed same-second upstream clock skew');
  assert.deepEqual([...new Set(result.reviews.map((review) => review.language))].sort(), ['en', 'es', 'ru']);
  assert.doesNotMatch(JSON.stringify(result), /avatar|googleusercontent|developer|install_count/);
});

test('uses only observed continuation tokens on fixed read RPCs and deduplicates overlaps by stable ID', async () => {
  const { fetchStoreSnapshot } = await service();
  const calls = [];
  const fetch = async (input, init) => {
    if (String(input) === RELEASE_API) return new Response(null, { status: 404 });
    const request = requestOf(input, init); calls.push(request);
    if (request.rpc === 'xY2Ddd') return rpcResponse(request.rpc, fixture.detail);
    const token = request.payload[1][1];
    return rpcResponse(request.rpc, token ? [[], fixture.reviews[1].slice(9), 30]
      : [['opaque+/token='], fixture.reviews[1].slice(0, 10), 30]);
  };
  const result = await fetchStoreSnapshot({ fetch, now: () => NOW });
  assert.equal(result.reviews.length, 30);
  assert.equal(result.reviews_complete, true);
  assert.deepEqual(calls[2].payload[1], [100, 'opaque+/token=']);
});

test('bounds pagination at five pages and exposes incomplete snapshots and changing totals', async () => {
  const { fetchStoreSnapshot } = await service();
  let page = 0;
  const result = await fetchStoreSnapshot({ now: () => NOW, fetch: async (input, init) => {
    if (String(input) === RELEASE_API) return new Response(null, { status: 404 });
    const request = requestOf(input, init);
    return rpcResponse(request.rpc, request.rpc === 'xY2Ddd' ? fixture.detail
      : [[`next-${++page}`], [fixture.reviews[1][page - 1]], 30]);
  } });
  assert.equal(page, 5);
  assert.equal(result.reviews.length, 5);
  assert.equal(result.reviews_complete, false);
  const missing = await fetchStoreSnapshot({ now: () => NOW, fetch: sourceFetch(fixture.detail, [[], fixture.reviews[1].slice(0, 1), 30]) });
  assert.equal(missing.reviews_complete, false);
});

test('compares only the fixed public GitHub latest release and keeps failures isolated from store data', async () => {
  const { fetchStoreSnapshot } = await service();
  for (const [tag, status] of [['v3.3.1', 'up_to_date'], ['v3.4.0', 'store_behind'], ['3.2.0', 'store_ahead']]) {
    let githubCalls = 0;
    const result = await fetchStoreSnapshot({ now: () => NOW, fetch: async (input, init) => {
      if (String(input) !== RELEASE_API) return sourceFetch()(input, init);
      githubCalls++;
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.equal(new Headers(init.headers).has('cookie'), false);
      assert.ok(new Headers(init.headers).get('user-agent'));
      return Response.json({ tag_name: tag, html_url: `${RELEASE_URL.slice(0, RELEASE_URL.lastIndexOf('/') + 1)}${tag}`,
        draft: false, prerelease: false });
    } });
    assert.equal(githubCalls, 1);
    assert.equal(result.version_status, status);
    assert.equal(result.latest_release_version, tag.replace(/^v/, ''));
  }
  for (const release of [{ tag_name: 'v3.4.0', html_url: 'https://evil.test/releases/v3.4.0' },
    { tag_name: 'v3.x.0', html_url: RELEASE_URL }, { tag_name: 'v3.4.0', html_url: `${RELEASE_URL}?token=bad` }]) {
    const result = await fetchStoreSnapshot({ now: () => NOW, fetch: async (input, init) => String(input) === RELEASE_API
      ? Response.json(release) : sourceFetch()(input, init) });
    assert.equal(result.version_status, 'unknown');
    assert.equal(result.latest_release_url, null);
    assert.equal(result.reviews.length, 30);
  }
});

test('rejects looping continuation tokens instead of silently claiming a complete review baseline', async () => {
  const { fetchStoreSnapshot } = await service();
  const result = await fetchStoreSnapshot({ now: () => NOW,
    fetch: sourceFetch(fixture.detail, [['same-token'], [fixture.reviews[1][0]], 30]) });
  assert.equal(result.reviews_complete, false);
});

test('normalizes hostile text to bounded plain strings and accepts absent reviewed version/language', async () => {
  const { fetchStoreSnapshot } = await service();
  const reviews = clone(fixture.reviews);
  reviews[1][0][1][0] = ' Public\u0000 author\u202e  ' + 'x'.repeat(400);
  reviews[1][0][3] = ' <script>text only</script>\u0000\u202e ' + '😀'.repeat(5000);
  reviews[1][0][11] = null; reviews[1][0][13] = null;
  const value = await fetchStoreSnapshot({ now: () => NOW, fetch: sourceFetch(fixture.detail, reviews) });
  assert.ok(value.reviews[0].author.startsWith('Public author '));
  assert.ok(Array.from(value.reviews[0].author).length <= 200);
  assert.ok(Array.from(value.reviews[0].body).length <= 4096);
  assert.doesNotMatch(value.reviews[0].body, /\u0000|\u202e/);
  assert.equal(value.reviews[0].version, null);
  assert.equal(value.reviews[0].language, null);
});

test('fails closed on upstream shape changes, identity mismatches, impossible ratings and dates', async () => {
  const { fetchStoreSnapshot } = await service();
  for (const mutate of [
    (d) => { d[0][0] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }, (d) => { d[13] = '3.x'; },
    (d) => { d[0][3] = 6; }, (d) => { d[0][4] = -1; }, (d) => { d[0][14] = '60,000'; }
  ]) {
    const detail = clone(fixture.detail); mutate(detail);
    await assert.rejects(fetchStoreSnapshot({ now: () => NOW, fetch: sourceFetch(detail) }), { message: 'Chrome Web Store unavailable' });
  }
  for (const mutate of [
    (r) => { r[0] = '<uuid>'; }, (r) => { r[14] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; },
    (r) => { r[2] = 0; }, (r) => { r[4] = [Infinity, 0]; }, (r) => { r[5] = [1, -1]; },
    (r) => { r[5] = [1, 0]; }, (r) => { r[3] = { html: 'unsafe' }; }, (r) => { r[13] = '../en'; }
  ]) {
    const reviews = clone(fixture.reviews); mutate(reviews[1][0]);
    await assert.rejects(fetchStoreSnapshot({ now: () => NOW, fetch: sourceFetch(fixture.detail, reviews) }), { message: 'Chrome Web Store unavailable' });
  }
});

test('provider errors, redirects, wrong RPC responses and consent HTML surface a safe unavailable error', async () => {
  const { fetchStoreSnapshot } = await service();
  for (const response of [new Response('provider-secret', { status: 429 }), new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('<html>Before you continue provider-secret</html>'), rpcResponse('wrong-rpc', fixture.detail), rpcResponse('xY2Ddd', {}),
    new Response(`)]}'\n[1,provider-secret]`)]) {
    await assert.rejects(fetchStoreSnapshot({ now: () => NOW, fetch: async () => response }), { message: 'Chrome Web Store unavailable' });
  }
});

test('caps streamed bytes even with a false content length and cancels oversized responses', async () => {
  const { fetchStoreSnapshot } = await service();
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(2_097_153)); },
    cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(fetchStoreSnapshot({ now: () => NOW, fetch: async () => new Response(stream, { headers: { 'content-length': '10' } }) }),
    { message: 'Chrome Web Store unavailable' });
  assert.equal(cancelled, true);
});

test('bounds fetch and streamed-body timeouts without leaking provider errors', async () => {
  const { fetchStoreSnapshot } = await service();
  let signal;
  await assert.rejects(fetchStoreSnapshot({ now: () => NOW, timeoutMs: 10, fetch: async (_input, init) => {
    signal = init.signal; return new Promise(() => {});
  } }), { message: 'Chrome Web Store unavailable' });
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchStoreSnapshot({ now: () => NOW, timeoutMs: 10, fetch: async () => new Response(body) }), { message: 'Chrome Web Store unavailable' });
  assert.equal(cancelled, true);
});
