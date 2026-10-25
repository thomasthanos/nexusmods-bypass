import worker from '../../src/index.ts';
import { bindings } from './access.mjs';
import { createTestDatabase } from './d1.mjs';

export const ORIGIN = 'https://diagnostics.test';
export const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;

// The whole Worker over a test database. Work it hands to waitUntil is kept in `pending` and settles
// before the database closes, so nothing runs against a closed database after the test.
export function workerFixture(t, overrides = {}) {
  const db = createTestDatabase();
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {}, props: {} };
  t.after(async () => { await Promise.allSettled(pending); db.close(); });
  const env = bindings(db, overrides);
  const fetch = (request) => worker.fetch(request, env, context);
  const request = (path, init = {}) => fetch(new Request(`${ORIGIN}${path}`, init));
  // A JSON body posted from an extension page.
  const post = (path, value, headers = {}) => request(path, { method: 'POST', headers: {
    origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10', ...headers
  }, body: JSON.stringify(value) });
  return { db, env, context, pending, fetch, request, post };
}
