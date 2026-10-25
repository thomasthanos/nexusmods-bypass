import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './helpers/d1.mjs';
import { cachedAnalytics } from '../src/services/analytics-cache.ts';

const now = 1792771200000;
const ready = { property_id: '547084285', source: 'ga4_store_listing', state: 'ready', fetched_at: now,
  online_30m: 4, weekly_active: 1200, previous_weekly_active: 1100, weekly_change_percent: 9.09,
  history_total_users: 12345, history_start_date: '2026-01-01', time_zone: 'UTC',
  quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null };
const unavailable = { ...ready, state: 'unavailable', fetched_at: null, online_30m: null, weekly_active: null,
  previous_weekly_active: null, weekly_change_percent: null, history_total_users: null,
  history_start_date: null, time_zone: null, message: 'Analytics temporarily unavailable.' };

test('aggregate cache avoids repeated OAuth requests and never persists credentials', async (t) => {
  const db = testDatabase(t); let requests = 0;
  const fetchSnapshot = async () => { requests++; return ready; };
  const a = await cachedAnalytics(db, { credentials: 'private-credential', now, fetchSnapshot });
  const b = await cachedAnalytics(db, { credentials: 'private-credential', now: now + 30000, fetchSnapshot });
  assert.equal(a.online_30m, 4); assert.equal(b.stale, false); assert.equal(requests, 1);
  assert.doesNotMatch(db.sqlite.prepare('SELECT snapshot_json FROM analytics_cache').get().snapshot_json, /private-credential|refresh_token|client_secret/);
});

test('upstream failures retain previous aggregates with explicit stale state and original time', async (t) => {
  const db = testDatabase(t);
  await cachedAnalytics(db, { credentials: 'configured', now, fetchSnapshot: async () => ready });
  const failed = await cachedAnalytics(db, { credentials: 'configured', now: now + 61000, fetchSnapshot: async () => unavailable });
  assert.equal(failed.stale, true); assert.equal(failed.online_30m, 4); assert.equal(failed.fetched_at, now);
  assert.match(failed.message, /temporarily unavailable/i);
});

test('missing configuration never reuses previously connected Analytics data', async (t) => {
  const db = testDatabase(t);
  await cachedAnalytics(db, { credentials: 'configured', now, fetchSnapshot: async () => ready });
  const result = await cachedAnalytics(db, { now: now + 1 });
  assert.equal(result.state, 'not_configured'); assert.equal(result.online_30m, null);
});

test('parallel refreshes share a database lease and abandoned work cannot overwrite its successor', async (t) => {
  const db = testDatabase(t); let resolve; let started;
  const gate = new Promise((r) => { started = r; });
  const first = cachedAnalytics(db, { credentials: 'configured', now, fetchSnapshot: () => { started(); return new Promise((r) => { resolve = r; }); } });
  await gate;
  const busy = await cachedAnalytics(db, { credentials: 'configured', now: now + 1, fetchSnapshot: async () => { throw Error('must not run'); } });
  assert.equal(busy.state, 'unavailable');
  const next = await cachedAnalytics(db, { credentials: 'configured', now: now + 31000, fetchSnapshot: async () => ({ ...ready, online_30m: 9, fetched_at: now + 31000 }) });
  resolve(ready); await first;
  assert.equal(next.online_30m, 9);
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT snapshot_json FROM analytics_cache').get().snapshot_json).online_30m, 9);
});
