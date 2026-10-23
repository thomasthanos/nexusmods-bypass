import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

// The other tests run in Node, which accepted both mistakes that kept GitHub out of the deployed
// dashboard: Workers reject fetch's redirect 'error', and no request can read a Response that another
// request created. This one runs the feed services in workerd itself.
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const MINUTE = 60_000;
const SOURCES = ['https://api.github.com/repos/thomasthanos/nexusmods-bypass/issues?state=open&sort=updated&direction=desc&per_page=100&page=1',
  'https://github.com/thomasthanos/nexusmods-bypass/discussions.atom'];

test('in workerd the GitHub feeds load, are reused across requests and outlast an outage behind Access', { timeout: 120_000 }, async (t) => {
  const root = new URL('..', import.meta.url);
  const [, date] = (await readFile(new URL('wrangler.toml', root), 'utf8')).match(/^compatibility_date\s*=\s*"([^"]+)"/m);
  const server = createTestHarness({ root: fileURLToPath(root),
    workers: [{ config: { name: 'diagnostics-runtime', main: './test/helpers/runtime-worker.mjs', compatibility_date: date } }] });
  t.after(() => server.close());
  await server.listen();
  const feeds = async (at) => {
    const state = await (await server.fetch(`/feeds?now=${at}`)).json();
    return { ...state, requests: state.requests.map((request) => request.url).sort(), redirects: state.requests.map((request) => request.redirect) };
  };
  const upstream = async (status) => assert.equal((await server.fetch(`/upstream?status=${status}`)).status, 204);
  const loaded = (state, stale) => {
    assert.equal(state.issues.error, undefined);
    assert.equal(state.discussions.error, undefined);
    assert.deepEqual(state.issues.items.map((item) => item.number), [34]);
    assert.equal(state.discussions.items.length, 25);
    assert.equal(state.issues.stale, stale);
    assert.equal(state.discussions.stale, stale);
  };

  // Where the Cache API works, both feeds load and the next refresh comes from the cache.
  let state = await feeds(NOW);
  loaded(state, false);
  assert.deepEqual(state.requests, SOURCES);
  assert.deepEqual(state.redirects, ['manual', 'manual']);
  assert.deepEqual((await feeds(NOW + MINUTE)).requests, []);

  // Behind Access it keeps nothing, and the isolate's memory has to carry the feeds between requests.
  assert.equal((await server.fetch('/access', { method: 'POST' })).status, 204);
  assert.deepEqual((await feeds(NOW)).requests, SOURCES);
  state = await feeds(NOW + MINUTE);
  loaded(state, false);
  assert.deepEqual(state.requests, [], 'a fresh feed is reused by the next request');
  for (const status of [503, 301]) {
    await upstream(status);
    state = await feeds(NOW + 10 * MINUTE);
    loaded(state, true);
    assert.deepEqual(state.requests, SOURCES, `one request per feed on ${status}; a redirect is not followed`);
  }
  await upstream(200);
  state = await feeds(NOW + 11 * MINUTE);
  loaded(state, false);
  assert.deepEqual(state.requests, SOURCES);
});
