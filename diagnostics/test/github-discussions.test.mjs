import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { testDatabase } from './helpers/d1.mjs';

const NOW = Date.UTC(2026, 9, 23, 12);
const REPOSITORY = 'https://github.com/thomasthanos/nexusmods-bypass/discussions';
const ATOM_URL = `${REPOSITORY}.atom`;
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const service = () => import('../src/services/github-discussions.ts');
const entry = (number = 35, { title = 'Help &amp; feedback', url = `${REPOSITORY}/${number}`, updated = '2026-10-23T13:30:00+03:00', extra = '' } = {}) =>
  `<entry><title>${title}</title><link rel="alternate" href="${url}"/><updated>${updated}</updated><content type="html">&lt;img src="https://private.example/pixel"&gt;provider-private-body</content>${extra}</entry>`;
const atom = (...entries) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="${ATOM_NS}"><title>Repository discussions</title>${entries.join('')}</feed>`;
const xmlResponse = (body, init = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', ...init.headers } });
function memoryCache() {
  const stored = new Map();
  const key = (input) => input instanceof Request ? input.url : String(input);
  return { stored, async match(input) { return stored.get(key(input))?.clone(); }, async put(input, response) { stored.set(key(input), response.clone()); } };
}

test('Discussions route requires genuine Access and leaves automatic diagnostics empty', async (t) => {
  const db = testDatabase(t);
  const access = await createAccessFixture(t);
  const accessFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input) !== ATOM_URL) return accessFetch(input, init);
    calls++;
    return xmlResponse(atom(entry()));
  });
  const request = (suffix = '', headers = {}) => worker.fetch(new Request(`https://diagnostics.test/api/admin/github-discussions${suffix}`, { headers }), bindings(db));
  assert.equal((await request()).status, 401);
  assert.equal(calls, 0);
  const headers = await access.headers();
  const response = await request('', headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).items[0].number, 35);
  assert.equal((await request('?repository=other/repo', headers)).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('fixed public Atom source yields only normalized recent discussion metadata and an isolated cache', async () => {
  const { getGithubDiscussions } = await service();
  const cache = memoryCache();
  const calls = [];
  const value = await getGithubDiscussions({ now: () => NOW, cache, fetch: async (url, init) => { calls.push([url, init]); return xmlResponse(atom(entry())); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ATOM_URL);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'manual', 'Workers throw for redirect "error"; a manual 3xx is not ok');
  assert.equal(new Headers(calls[0][1].headers).has('authorization'), false);
  assert.match(new Headers(calls[0][1].headers).get('accept'), /application\/atom\+xml/);
  assert.deepEqual(value, { items: [{ number: 35, title: 'Help & feedback', url: `${REPOSITORY}/35`, updated_at: '2026-10-23T10:30:00.000Z' }],
    total: 1, repository_url: REPOSITORY, fetched_at: new Date(NOW).toISOString(), stale: false });
  assert.equal(cache.stored.size, 1);
  const [[key, cached]] = cache.stored;
  assert.match(key, /discussions/);
  assert.match(cached.headers.get('cache-control'), /max-age=86400/);
  assert.doesNotMatch(await cached.text(), /provider-private-body|private\.example|<content|<feed/);
});

test('Atom parser supports empty feeds, namespace prefixes, escaped entities, CDATA and offset dates', async () => {
  const { parseDiscussionAtom } = await service();
  assert.deepEqual(parseDiscussionAtom(atom()), []);
  assert.deepEqual(parseDiscussionAtom(`<a:feed xmlns:a="${ATOM_NS}"><a:entry><a:title><![CDATA[<script>alert(1)</script> ]]>&amp; &#x1F600;</a:title>
    <a:link href="${REPOSITORY}/35"/><a:updated>2026-10-23T07:30:00.125-03:00</a:updated></a:entry></a:feed>`),
  [{ number: 35, title: '<script>alert(1)</script> & 😀', url: `${REPOSITORY}/35`, updated_at: '2026-10-23T10:30:00.125Z' }]);
});

test('parser rejects DTD/entities, malformed XML, excessive nesting and prototype property tags', async () => {
  const { parseDiscussionAtom } = await service();
  for (const xml of ['<!DOCTYPE feed SYSTEM "https://evil.test/internal">' + atom(),
    '<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + atom(entry(35, { title: '&xxe;' })),
    '<!ENTITY injected "x">' + atom(), atom(entry()).replace('</entry>', ''),
    `<feed xmlns="${ATOM_NS}">${'<nested>'.repeat(40)}${'</nested>'.repeat(40)}</feed>`,
    atom(entry(35, { extra: '<__proto__><polluted>yes</polluted></__proto__>' })),
    atom(entry(35, { extra: '<constructor><prototype><polluted>yes</polluted></prototype></constructor>' }))]) {
    assert.throws(() => parseDiscussionAtom(xml), { message: 'GitHub discussions unavailable' });
  }
  assert.equal({}.polluted, undefined);
});

test('parser filters foreign or malformed URLs and dates and keeps titles plain bounded text', async () => {
  const { parseDiscussionAtom } = await service();
  const invalid = ['https://evil.test/35', `${REPOSITORY}/0`, `${REPOSITORY}/01`, `${REPOSITORY}/35?token=private`, `${REPOSITORY}/abc`,
    'https://github.com/thomasthanos/another/discussions/35', `${REPOSITORY}/9007199254740992`];
  const result = parseDiscussionAtom(atom(...invalid.map((url) => entry(35, { url })),
    entry(36, { updated: '2026-02-30T10:00:00Z' }), entry(37, { updated: '2026-10-23T10:00:00+99:00' }),
    entry(38, { title: '<b>Nested HTML</b>' }), entry(39, { title: '' }), entry(35, { title: `Safe\u202e ${'a'.repeat(700)}` })));
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 35);
  assert.equal(result[0].title.length, 512);
  assert.doesNotMatch(result[0].title, /\u202e/);
  assert.throws(() => parseDiscussionAtom('<feed xmlns="https://evil.test/atom"/>'));
});

test('fresh metadata cache lasts five minutes and failed refresh uses explicitly stale metadata at most 24 hours', async () => {
  const { getGithubDiscussions } = await service();
  const cache = memoryCache();
  const initial = await getGithubDiscussions({ now: () => NOW, cache, fetch: async () => xmlResponse(atom(entry())) });
  const cached = await getGithubDiscussions({ now: () => NOW + 299_999, cache, fetch: async () => { throw new Error('Must use fresh cache'); } });
  assert.deepEqual(cached, initial);
  const stale = await getGithubDiscussions({ now: () => NOW + 300_001, cache, fetch: async () => new Response('provider-private-error', { status: 429 }) });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetched_at, initial.fetched_at);
  assert.equal(stale.items[0].number, 35);
  await assert.rejects(getGithubDiscussions({ now: () => NOW + 86_400_001, cache, fetch: async () => new Response('provider-private-error', { status: 500 }) }),
    { message: 'GitHub discussions unavailable' });
});

test('valid empty upstream and unavailable cache remain usable without exposing errors', async () => {
  const { getGithubDiscussions } = await service();
  const cache = { async match() { throw new Error('Private cache error'); }, async put() { throw new Error('Private cache error'); } };
  const value = await getGithubDiscussions({ now: () => NOW, cache, fetch: async () => xmlResponse(atom()) });
  assert.deepEqual(value.items, []);
  assert.equal(value.total, 0);
  assert.equal(value.stale, false);
});

test('upstream redirects, HTML, malformed UTF-8 and oversized bodies cannot become a feed', async () => {
  const { getGithubDiscussions } = await service();
  for (const response of [new Response('provider-private-error', { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('<html>Login required</html>', { headers: { 'Content-Type': 'text/html' } }),
    xmlResponse('<html>Not Atom</html>'), xmlResponse(new Uint8Array([0xff])), xmlResponse(' '.repeat(2_097_153), { headers: { 'Content-Length': '1' } })]) {
    await assert.rejects(getGithubDiscussions({ now: () => NOW, cache: null, fetch: async () => response }), { message: 'GitHub discussions unavailable' });
  }
});

test('slow fetch and response streams time out and oversized streams cancel without awaiting cancellation', async () => {
  const { getGithubDiscussions } = await service();
  let signal;
  await assert.rejects(getGithubDiscussions({ now: () => NOW, cache: null, timeoutMs: 10, fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } }),
    { message: 'GitHub discussions unavailable' });
  assert.equal(signal.aborted, true);
  for (const oversized of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { if (oversized) controller.enqueue(new Uint8Array(2_097_153)); else return new Promise(() => {}); },
      cancel() { cancelled = true; return new Promise(() => {}); } });
    await assert.rejects(getGithubDiscussions({ now: () => NOW, cache: null, timeoutMs: 10, fetch: async () => xmlResponse(body) }), { message: 'GitHub discussions unavailable' });
    assert.equal(cancelled, true);
  }
});

test('protected route reports only stable 503 on upstream failure', async (t) => {
  const db = testDatabase(t);
  const access = await createAccessFixture(t);
  const accessFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init) => String(input) === ATOM_URL ? new Response('provider-private-error', { status: 500 }) : accessFetch(input, init));
  const response = await worker.fetch(new Request('https://diagnostics.test/api/admin/github-discussions', { headers: await access.headers() }), bindings(db));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'GitHub discussions unavailable' });
});

// GitHub's own feed: namespaced media thumbnails, authors, offset timestamps and every discussion body
// as escaped HTML. About twenty bodies used to exceed the parser's 10,000-expansion limit.
const githubEntry = (number) => `<entry><id>tag:github.com,2008:Discussion/${9000 + number}</id>
  <link type="text/html" rel="alternate" href="${REPOSITORY}/${number}"/><title>Idea ${number}: dark mode &amp; settings</title>
  <published>2026-10-22T10:00:00+00:00</published><updated>2026-10-23T${String(number % 24).padStart(2, '0')}:00:00+00:00</updated>
  <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/1?s=30&amp;v=4"/>
  <author><name>someone</name><uri>https://github.com/someone</uri></author>
  <content type="html">${'&lt;p&gt;A &quot;quoted&quot; idea &amp;amp; details&lt;/p&gt;'.repeat(80)}</content></entry>`;
const githubFeed = (count) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${ATOM_NS}" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:/thomasthanos/nexusmods-bypass/discussions</id>
  <link type="text/html" rel="alternate" href="${REPOSITORY}"/><link type="application/atom+xml" rel="self" href="${ATOM_URL}"/>
  <title>Recent discussions in thomasthanos/nexusmods-bypass</title><updated>2026-10-23T10:03:10-07:00</updated>
  ${Array.from({ length: count }, (_, index) => githubEntry(index + 1)).join('\n')}
</feed>`;

test('GitHub-shaped feeds parse at every size the body limit allows, and an empty feed is no error', async () => {
  const { getGithubDiscussions } = await service();
  const workersFetch = (body) => async (_url, init = {}) => {
    if (!['follow', 'manual', undefined].includes(init.redirect)) throw new TypeError(`Invalid redirect value: ${init.redirect}`);
    return xmlResponse(body);
  };
  const empty = await getGithubDiscussions({ now: () => NOW, cache: null, fetch: workersFetch(githubFeed(0)) });
  assert.deepEqual(empty.items, [], 'a repository without discussions yet has an empty, available feed');
  assert.equal(empty.stale, false);
  for (const count of [1, 25, 100]) {
    const value = await getGithubDiscussions({ now: () => NOW, cache: null, fetch: workersFetch(githubFeed(count)) });
    assert.equal(value.items.length, count, `${count} discussions`);
    assert.ok(value.items.every((item) => item.url === `${REPOSITORY}/${item.number}` && item.title.startsWith(`Idea ${item.number}: dark mode & settings`)));
  }
});
