import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDatabase } from './helpers/d1.mjs';

const service = () => import('../src/services/store-monitor.ts').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const NOW = Date.UTC(2026, 9, 23, 12);
const ID = 'chfghiknjhpcncpcjopglefnckckdlpj';
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;
const review = (n, patch = {}) => ({ id: uuid(n), author: 'Store reviewer', rating: 5, body: 'Useful extension.',
  created_at: NOW - 100000 + n, updated_at: NOW - 100000 + n, version: '3.3.1', language: 'en', ...patch });
const snapshot = (reviews = [review(1)], patch = {}) => ({ extension_id: ID,
  store_url: `https://chromewebstore.google.com/detail/nexusmods-bypass/${ID}`, version: '3.3.1', users: 60000,
  rating_average: 4.844444444444444, rating_count: 45, written_review_count: reviews.length, reviews,
  fetched_at: NOW, reviews_complete: true, latest_release_version: '3.3.1',
  latest_release_url: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/3.3.1', version_status: 'up_to_date', ...patch });
const config = { vapid: { publicKey: 'test-public', privateKey: 'test-private', subject: 'mailto:owner@example.test' } };
const delivered = { ok: true, status: 201, retryable: false, expired: false, retry_after_ms: null, reason: 'delivered' };
const failed = (patch = {}) => ({ ok: false, status: 503, retryable: true, expired: false, retry_after_ms: null, reason: 'http_error', ...patch });
function database(t) { const db = createTestDatabase(); t.after(() => db.close()); return db; }
function subscription(db, n = 1) {
  return Number(db.sqlite.prepare('INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(`https://web.push.apple.com/test-${n}`, 'A'.repeat(87), 'B'.repeat(22), NOW, NOW).lastInsertRowid);
}
async function sync(db, value, now = NOW) {
  const { syncStore } = await service();
  return syncStore(db, { fetchSnapshot: async () => value, now });
}

test('exports isolated store persistence and delivery operations', async () => {
  const source = await service();
  for (const name of ['syncStore', 'getStoreDashboard', 'acknowledgeReviews', 'dispatchReviewPush']) assert.equal(typeof source[name], 'function');
});

test('complete first sync establishes an acknowledged baseline without historical targets or diagnostics rows', async (t) => {
  const db = database(t); subscription(db);
  const { getStoreDashboard } = await service();
  assert.equal((await getStoreDashboard(db, NOW)).snapshot, null);
  assert.equal((await sync(db, snapshot())).state, 'synced');
  const result = await getStoreDashboard(db, NOW);
  assert.equal(result.state, 'ready'); assert.equal(result.stale, false);
  assert.equal(result.snapshot.users, 60000); assert.equal(result.snapshot.reviews, undefined);
  assert.equal(result.reviews[0].is_new, false); assert.equal(result.new_review_count, 0);
  assert.equal(result.sync_interval_seconds, 900);
  assert.equal(db.sqlite.prepare('SELECT baseline_at FROM store_monitor_state').get().baseline_at, NOW);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_review_deliveries').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('incomplete and failed first syncs cannot establish a baseline or later flood historical reviews', async (t) => {
  const db = database(t); subscription(db);
  const { syncStore, getStoreDashboard } = await service();
  await sync(db, snapshot([review(1)], { reviews_complete: false, written_review_count: 20 }));
  assert.equal(db.sqlite.prepare('SELECT baseline_at FROM store_monitor_state').get().baseline_at, null);
  assert.equal((await getStoreDashboard(db, NOW)).stale, true);
  assert.equal((await syncStore(db, { now: NOW + 1, fetchSnapshot: async () => { throw new Error('private provider secret'); } })).state, 'failed');
  assert.equal(db.sqlite.prepare('SELECT baseline_at FROM store_monitor_state').get().baseline_at, null);
  await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 2 }), NOW + 2);
  const result = await getStoreDashboard(db, NOW + 2);
  assert.equal(result.reviews.length, 2); assert.equal(result.new_review_count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_review_deliveries').get().n, 0);
  assert.doesNotMatch(JSON.stringify(result), /private provider secret/);
});

test('new stable IDs capture current subscriptions once; edits and new subscriptions never replay history', async (t) => {
  const db = database(t); subscription(db);
  await sync(db, snapshot());
  await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { getStoreDashboard, acknowledgeReviews } = await service();
  let result = await getStoreDashboard(db, NOW + 1);
  assert.equal(result.new_review_count, 1); assert.equal(result.reviews.find((r) => r.id === uuid(2)).is_new, true);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_review_deliveries').get().n, 1);
  subscription(db, 2);
  await sync(db, snapshot([review(2, { body: 'Edited feedback.', updated_at: NOW + 2 })], { fetched_at: NOW + 2 }), NOW + 2);
  result = await getStoreDashboard(db, NOW + 2);
  assert.equal(result.reviews.length, 2, 'absent reviews retain stable receipts forever');
  assert.equal(result.reviews.find((r) => r.id === uuid(2)).body, 'Edited feedback.');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_review_deliveries').get().n, 1);
  assert.deepEqual(await acknowledgeReviews(db, [uuid(2)], NOW + 3), { acknowledged: 1 });
  assert.equal((await getStoreDashboard(db, NOW + 3)).new_review_count, 0);
});

test('overlapping syncs admit one fetch and fence an expired owner after a successor commits', async (t) => {
  const db = database(t); const { syncStore, getStoreDashboard } = await service();
  const pending = Promise.withResolvers(); let fetches = 0;
  const first = syncStore(db, { now: NOW, fetchSnapshot: async () => { fetches++; return pending.promise; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await syncStore(db, { now: NOW + 1, fetchSnapshot: async () => { fetches++; return snapshot(); } })).state, 'busy');
  const secondTime = NOW + 120000;
  assert.equal((await sync(db, snapshot([review(2)], { users: 70000, fetched_at: secondTime }), secondTime)).state, 'synced');
  pending.resolve(snapshot());
  assert.equal((await first).state, 'lost_lease'); assert.equal(fetches, 1);
  const value = await getStoreDashboard(db, secondTime);
  assert.equal(value.snapshot.users, 70000); assert.equal(value.reviews.length, 1); assert.equal(value.reviews[0].id, uuid(2));
});

test('failed D1 batches roll back reviews and baseline while preserving last good metadata', async (t) => {
  const db = database(t); await sync(db, snapshot());
  const previous = db.sqlite.prepare('SELECT snapshot_json FROM store_monitor_state').get().snapshot_json;
  const original = db.batch;
  db.batch = async (statements) => original([...statements.slice(0, 2), db.prepare('SELECT private_missing_column'), ...statements.slice(2)]);
  assert.equal((await sync(db, snapshot([review(1), review(2)], { users: 90000, fetched_at: NOW + 1 }), NOW + 1)).state, 'failed');
  db.batch = original;
  assert.equal(db.sqlite.prepare('SELECT snapshot_json FROM store_monitor_state').get().snapshot_json, previous);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_reviews').get().n, 1);
  const { getStoreDashboard } = await service();
  const value = await getStoreDashboard(db, NOW + 1);
  assert.equal(value.stale, true); assert.doesNotMatch(JSON.stringify(value), /private SQL failure/);
});

test('review batches below 2 MiB still respect the stricter D1 value limit and preserve baseline state', async (t) => {
  const db = database(t); await sync(db, snapshot());
  const previous = db.sqlite.prepare('SELECT snapshot_json,baseline_at FROM store_monitor_state').get();
  const reviews = Array.from({ length: 460 }, (_, index) => review(index + 1, { body: 'x'.repeat(4096) }));
  const bytes = new TextEncoder().encode(JSON.stringify(reviews)).byteLength;
  assert.ok(bytes > 1_900_000 && bytes < 2_097_152, `fixture must exercise the D1/2 MiB boundary, got ${bytes}`);
  const large = snapshot(reviews, { users: 90000, fetched_at: NOW + 1 });
  assert.equal((await sync(db, large, NOW + 1)).state, 'failed');
  assert.deepEqual(db.sqlite.prepare('SELECT snapshot_json,baseline_at FROM store_monitor_state').get(), previous);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_reviews').get().n, 1);
  const empty = database(t);
  assert.equal((await sync(empty, large, NOW + 1)).state, 'failed');
  assert.equal(db.sqlite.prepare('SELECT lease_token FROM store_monitor_state').get().lease_token, null);
  assert.equal(empty.sqlite.prepare('SELECT baseline_at FROM store_monitor_state').get().baseline_at, null);
  assert.equal(empty.sqlite.prepare('SELECT COUNT(*) AS n FROM store_reviews').get().n, 0);
});

test('per-subscription claims prevent overlap and successful targets are never replayed on partial retry', async (t) => {
  const db = database(t); const one = subscription(db); const two = subscription(db, 2);
  await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { dispatchReviewPush } = await service();
  const calls = []; let failedOnce = false;
  const send = async (target, payload) => {
    calls.push({ target, payload });
    if (target.endpoint.endsWith('-2') && !failedOnce) { failedOnce = true; return failed({ retry_after_ms: 120000 }); }
    return delivered;
  };
  await Promise.all([dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send }),
    dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send })]);
  assert.equal(calls.length, 2);
  const payload = calls[0].payload;
  assert.equal(payload.data.trigger, 'NEW_REVIEW'); assert.equal(payload.data.review_id, uuid(2));
  assert.equal(payload.data.url, `https://diagnostics.test/?review=${uuid(2)}`); assert.equal(payload.tag, `store-review:${uuid(2)}`);
  assert.equal(payload.data.issue_id, null); assert.equal(payload.data.fingerprint, null);
  assert.equal(db.sqlite.prepare('SELECT delivered_at FROM store_review_deliveries WHERE subscription_id=?').get(one).delivered_at, NOW + 2);
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 1000, send }); assert.equal(calls.length, 2);
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 120003, send }); assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).target.endpoint.endsWith('-2'), true);
  assert.ok(db.sqlite.prepare('SELECT delivered_at FROM store_review_deliveries WHERE subscription_id=?').get(two).delivered_at);
});

test('expired-target cleanup cannot remove a subscription whose keys rotated during delivery', async (t) => {
  const db = database(t); const sub = subscription(db);
  await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { dispatchReviewPush } = await service();
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send: async () => {
    db.sqlite.prepare('UPDATE push_subscriptions SET auth=? WHERE id=?').run('C'.repeat(22), sub);
    return failed({ status: 410, expired: true, retryable: false });
  } });
  assert.equal(db.sqlite.prepare('SELECT auth FROM push_subscriptions WHERE id=?').get(sub).auth, 'C'.repeat(22));
  assert.ok(db.sqlite.prepare('SELECT abandoned_at FROM store_review_deliveries').get().abandoned_at);
});

test('an expired dispatch owner cannot delete a subscription after its successor delivers', async (t) => {
  const db = database(t); const sub = subscription(db);
  await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { dispatchReviewPush } = await service(); const pending = Promise.withResolvers();
  const first = dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send: async () => pending.promise });
  await new Promise((resolve) => setImmediate(resolve));
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 120000, send: async () => delivered });
  pending.resolve(failed({ status: 410, expired: true, retryable: false })); await first;
  assert.ok(db.sqlite.prepare('SELECT id FROM push_subscriptions WHERE id=?').get(sub));
  assert.equal(db.sqlite.prepare('SELECT delivered_at FROM store_review_deliveries').get().delivered_at, NOW + 120000);
});

test('dispatch caps work at twenty targets and four concurrent sends, leaving the rest durable', async (t) => {
  const db = database(t); for (let n = 1; n <= 25; n++) subscription(db, n);
  await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { dispatchReviewPush } = await service(); let inFlight = 0; let maximum = 0; let count = 0;
  const send = async () => { inFlight++; maximum = Math.max(maximum, inFlight); count++;
    await new Promise((resolve) => setImmediate(resolve)); inFlight--; return delivered; };
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send });
  assert.equal(count, 20); assert.equal(maximum, 4);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM store_review_deliveries WHERE delivered_at IS NULL').get().n, 5);
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 3, send });
  assert.equal(count, 25);
});

test('expired matching targets are deleted and terminal failures do not retry', async (t) => {
  const db = database(t); subscription(db); subscription(db, 2);
  await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { dispatchReviewPush } = await service(); let count = 0;
  const send = async (target) => { count++; return target.endpoint.endsWith('-1')
    ? failed({ status: 410, expired: true, retryable: false }) : failed({ status: 400, retryable: false }); };
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 2, send });
  await dispatchReviewPush(db, config, 'https://diagnostics.test', { now: NOW + 86400000, send });
  assert.equal(count, 2); assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
});

test('acknowledgements validate IDs and reading never marks reviews acknowledged', async (t) => {
  const db = database(t); await sync(db, snapshot()); await sync(db, snapshot([review(1), review(2)], { fetched_at: NOW + 1 }), NOW + 1);
  const { getStoreDashboard, acknowledgeReviews } = await service();
  assert.equal((await getStoreDashboard(db, NOW + 2)).new_review_count, 1);
  assert.equal((await getStoreDashboard(db, NOW + 3)).new_review_count, 1);
  await assert.rejects(acknowledgeReviews(db, ['bad-id'], NOW + 4));
  await assert.rejects(acknowledgeReviews(db, Array.from({ length: 101 }, () => uuid(2)), NOW + 4));
  assert.deepEqual(await acknowledgeReviews(db, [uuid(2), uuid(2)], NOW + 4), { acknowledged: 1 });
  assert.deepEqual(await acknowledgeReviews(db, [uuid(2)], NOW + 5), { acknowledged: 0 });
});
