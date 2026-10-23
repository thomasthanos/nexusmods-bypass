import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

const NOW = Date.UTC(2026, 9, 23, 12);
const REPOSITORY = 'https://github.com/thomasthanos/nexusmods-bypass/issues';
const API = 'https://api.github.com/repos/thomasthanos/nexusmods-bypass/issues';
const service = () => import('../src/services/github.ts');
const issue = (number = 34, overrides = {}) => ({ number, title: 'Download fails on iPhone', html_url: `${REPOSITORY}/${number}`,
  state: 'open', labels: [{ name: 'bug' }], created_at: '2026-10-22T12:00:00Z', updated_at: '2026-10-23T10:00:00Z',
  comments: 2, body: 'This issue body must never reach the dashboard cache.', user: { login: 'private-person' }, ...overrides });
function memoryCache() {
  const stored = new Map();
  const key = (request) => request instanceof Request ? request.url : String(request);
  return { stored, async match(request) { return stored.get(key(request))?.clone(); }, async put(request, response) { stored.set(key(request), response.clone()); } };
}

test('GitHub issues route requires Access and returns public issues without inserting diagnostic reports', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const access = await createAccessFixture(t);
  const accessFetch = globalThis.fetch;
  let githubCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(API)) return accessFetch(input, init);
    githubCalls++;
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return Response.json([issue()]);
  });
  const request = (suffix = '', headers = {}) => worker.fetch(new Request(`https://diagnostics.test/api/admin/github-issues${suffix}`, { headers }), bindings(db));
  assert.equal((await request()).status, 401);
  assert.equal(githubCalls, 0);
  const headers = await access.headers();
  const response = await request('', headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const feed = await response.json();
  assert.equal(feed.items[0].number, 34);
  assert.equal(feed.repository_url, REPOSITORY);
  assert.equal(feed.total, 1);
  assert.equal(feed.stale, false);
  assert.equal((await request('?repo=somewhere/else', headers)).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('feed uses a fixed unauthenticated read URL, excludes pull requests, and returns only normalized metadata', async () => {
  const { getGithubIssues } = await service();
  const calls = [];
  const cache = memoryCache();
  const result = await getGithubIssues({ now: () => NOW, cache, fetch: async (input, init) => {
    calls.push([String(input), init]);
    return Response.json([issue(40, { pull_request: {} }), issue(34, { title: 'Download\u0000 fails\u202e on iPhone', labels: [{ name: 'bug' }, 'help wanted', { name: '\u0000' }] })]);
  } });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, API);
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: '1' });
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).has('authorization'), false);
  assert.equal(new Headers(init.headers).get('accept'), 'application/vnd.github+json');
  assert.deepEqual(result, { items: [{ number: 34, title: 'Download fails on iPhone', url: `${REPOSITORY}/34`, state: 'open',
    labels: ['bug', 'help wanted'], created_at: '2026-10-22T12:00:00.000Z', updated_at: '2026-10-23T10:00:00.000Z', comments: 2 }],
    total: 1, truncated: false, repository_url: REPOSITORY, fetched_at: new Date(NOW).toISOString(), stale: false });
  assert.equal(cache.stored.size, 1);
  const cached = [...cache.stored.values()][0];
  assert.match(cached.headers.get('cache-control'), /max-age=86400/);
  assert.doesNotMatch(await cached.text(), /issue body|private-person|html_url|pull_request/);
});

test('invalid upstream metadata cannot introduce foreign URLs, closed issues, invalid IDs or dates', async () => {
  const { getGithubIssues } = await service();
  const invalid = [issue(1, { html_url: 'https://evil.test/issues/1' }), issue(2, { state: 'closed' }), issue(3, { number: -1 }),
    issue(4, { created_at: '2026-02-30T00:00:00Z' }), issue(5, { updated_at: 'not-a-date' }), issue(6, { comments: -1 }),
    issue(7, { html_url: `${REPOSITORY}/7?token=secret` }), issue(8, { title: '' }), null];
  const result = await getGithubIssues({ now: () => NOW, cache: null, fetch: async () => Response.json([...invalid, issue()]) });
  assert.deepEqual(result.items.map((entry) => entry.number), [34]);
});

test('pagination remains on the fixed repository and is bounded with a visible truncated flag', async () => {
  const { getGithubIssues } = await service();
  const pages = [];
  const result = await getGithubIssues({ now: () => NOW, cache: null, fetch: async (input) => {
    const url = new URL(input); pages.push(url);
    const page = Number(url.searchParams.get('page'));
    return Response.json(Array.from({ length: 100 }, (_, index) => issue((page - 1) * 100 + index + 1)), {
      headers: { link: '<https://evil.test/private>; rel="next"' }
    });
  } });
  assert.equal(pages.length, 3);
  assert.ok(pages.every((url) => `${url.origin}${url.pathname}` === API));
  assert.deepEqual(pages.map((url) => url.searchParams.get('page')), ['1', '2', '3']);
  assert.equal(result.items.length, 300);
  assert.equal(result.total, 300);
  assert.equal(result.truncated, true);
});

test('fresh normalized cache avoids upstream calls and stale cache refreshes after five minutes', async () => {
  const { getGithubIssues } = await service();
  const cache = memoryCache();
  const initial = await getGithubIssues({ now: () => NOW, cache, fetch: async () => Response.json([issue()]) });
  const fresh = await getGithubIssues({ now: () => NOW + 299_999, cache, fetch: async () => { throw new Error('Fresh cache must prevent fetch'); } });
  assert.deepEqual(fresh, initial);
  let called = false;
  const refreshed = await getGithubIssues({ now: () => NOW + 300_001, cache, fetch: async () => { called = true; return Response.json([issue(35)]); } });
  assert.equal(called, true);
  assert.equal(refreshed.items[0].number, 35);
  assert.equal(refreshed.stale, false);
});

test('upstream failures return cached public metadata as explicitly stale for at most 24 hours', async () => {
  const { getGithubIssues } = await service();
  const cache = memoryCache();
  await getGithubIssues({ now: () => NOW, cache, fetch: async () => Response.json([issue()]) });
  for (const fetch of [async () => Response.json({ message: 'provider-private-token' }, { status: 403 }), async () => { throw new Error('provider-private-token'); }]) {
    const value = await getGithubIssues({ now: () => NOW + 3_600_000, cache, fetch });
    assert.equal(value.stale, true);
    assert.equal(value.fetched_at, new Date(NOW).toISOString());
    assert.equal(value.items[0].number, 34);
    assert.doesNotMatch(JSON.stringify(value), /provider-private-token/);
  }
  await assert.rejects(getGithubIssues({ now: () => NOW + 86_400_001, cache, fetch: async () => new Response('provider-private-token', { status: 429 }) }),
    { message: 'GitHub issues unavailable' });
});

test('cache unavailability never prevents a successful public GitHub fetch', async () => {
  const { getGithubIssues } = await service();
  const broken = { async match() { throw new Error('Unavailable cache'); }, async put() { throw new Error('Unavailable cache'); } };
  const value = await getGithubIssues({ now: () => NOW, cache: broken, fetch: async () => Response.json([issue()]) });
  assert.equal(value.items[0].number, 34);
});

test('provider errors, malformed JSON and unexpectedly large bodies surface only a stable unavailable message', async () => {
  const { getGithubIssues } = await service();
  for (const response of [new Response('provider-private-token', { status: 500 }), new Response('provider-private-token'),
    Response.json({ message: 'provider-private-token' }), new Response(' '.repeat(2_097_153))]) {
    await assert.rejects(getGithubIssues({ now: () => NOW, cache: null, fetch: async () => response }), { message: 'GitHub issues unavailable' });
  }
});

test('oversized streaming bodies are cancelled without waiting for cancellation to settle', async () => {
  const { getGithubIssues } = await service();
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(2_097_153)); },
    cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(getGithubIssues({ now: () => NOW, cache: null, timeoutMs: 100, fetch: async () => new Response(body) }), { message: 'GitHub issues unavailable' });
  assert.equal(cancelled, true);
});

test('fetch and streamed response timeouts are bounded and do not leak provider messages', async () => {
  const { getGithubIssues } = await service();
  let signal;
  await assert.rejects(getGithubIssues({ now: () => NOW, cache: null, timeoutMs: 10, fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } }),
    { message: 'GitHub issues unavailable' });
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  await assert.rejects(getGithubIssues({ now: () => NOW, cache: null, timeoutMs: 10, fetch: async () => new Response(body) }), { message: 'GitHub issues unavailable' });
  assert.equal(cancelled, true);
});

test('protected route maps upstream failure to safe 503 without touching diagnostics storage', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const access = await createAccessFixture(t);
  const accessFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init) => String(input).startsWith(API)
    ? new Response('provider-private-token', { status: 429 }) : accessFetch(input, init));
  const response = await worker.fetch(new Request('https://diagnostics.test/api/admin/github-issues', { headers: await access.headers() }), bindings(db));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'GitHub issues unavailable' });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
});
