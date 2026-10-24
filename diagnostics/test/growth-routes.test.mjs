import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const origin = 'https://diagnostics.example';
const reviewId = 'b1fd5094-3ecb-48d1-9540-fb21b9e40b66';

test('growth endpoints require Access and preserve private no-store responses', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  for (const path of ['/analytics', '/store', '/store/reviews/ack']) {
    const response = await worker.fetch(new Request(origin + '/api/admin' + path), bindings(db), context);
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('GA4 reports not configured without fabricated counts or external requests', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close()); const access = await createAccessFixture(t);
  const response = await worker.fetch(new Request(origin + '/api/admin/analytics', { headers: await access.headers() }), bindings(db), context);
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.state, 'not_configured'); assert.equal(data.online_30m, null); assert.equal(data.history_total_users, null);
  assert.ok(access.requests.every((url) => url.includes('/cdn-cgi/access/certs')));
});

test('review acknowledgement rejects cross-origin and invalid bodies; only explicit IDs change', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close()); const access = await createAccessFixture(t); const env = bindings(db);
  const now = Date.now();
  db.sqlite.prepare(`INSERT INTO store_reviews (id,author,rating,body,created_at,updated_at,first_seen_at,last_seen_at,first_seen_run_token)
    VALUES (?,'Reviewer',5,'Thanks',?,?,?,?, 'seed')`).run(reviewId,now,now,now,now);
  const request = async (body, requestOrigin = origin) => worker.fetch(new Request(origin + '/api/admin/store/reviews/ack', {
    method: 'POST', headers: await access.headers({ Origin: requestOrigin, 'Content-Type': 'application/json' }), body: JSON.stringify(body)
  }), env, context);
  assert.equal((await request({ids:[reviewId]}, 'https://evil.example')).status, 403);
  for (const body of [{ids:['bad']},{ids:[]},{ids:Array(101).fill(reviewId)},{ids:[reviewId],extra:true}]) assert.equal((await request(body)).status,400);
  assert.equal(db.sqlite.prepare('SELECT acknowledged_at FROM store_reviews').get().acknowledged_at, null);
  const response = await request({ids:[reviewId]}); assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
  assert.ok(db.sqlite.prepare('SELECT acknowledged_at FROM store_reviews').get().acknowledged_at >= now);
});

test('Store API serves bounded public snapshot without delivery credentials or internal fields', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close()); const access = await createAccessFixture(t); const now = Date.now();
  const snapshot = { extension_id:'chfghiknjhpcncpcjopglefnckckdlpj',store_url:'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj',
    version:'3.3.1',users:60000,rating_average:4.84,rating_count:45,written_review_count:30,fetched_at:now,reviews_complete:true,
    latest_release_version:'3.3.1',latest_release_url:'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/3.3.1',version_status:'up_to_date' };
  db.sqlite.prepare('INSERT INTO store_monitor_state (id,snapshot_json,last_checked_at,last_success_at,baseline_at) VALUES (1,?,?,?,?)').run(JSON.stringify(snapshot),now,now,now);
  const response = await worker.fetch(new Request(origin+'/api/admin/store',{headers:await access.headers()}),bindings(db),context);
  assert.equal(response.status,200); const data = await response.json(); assert.equal(data.snapshot.users,60000);
  assert.equal(data.new_review_count,0); assert.doesNotMatch(JSON.stringify(data), /lease_token|p256dh|first_seen_run_token|auth"/);
});

test('retrying an unavailable first Store scan does not wait through the successful-snapshot cache interval', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close()); const access = await createAccessFixture(t); const now = Date.now();
  db.sqlite.prepare('INSERT INTO store_monitor_state (id,last_checked_at,last_error_at) VALUES (1,?,?)').run(now,now);
  const response = await worker.fetch(new Request(origin+'/api/admin/store',{headers:await access.headers()}),bindings(db),context);
  assert.equal(response.status,200); assert.equal((await response.json()).snapshot,null);
  // The Access fixture refuses all other network traffic, but records the retry.
  assert.ok(access.requests.some((url) => url.startsWith('https://chromewebstore.google.com/')));
});
