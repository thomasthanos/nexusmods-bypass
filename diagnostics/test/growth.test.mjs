import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountGrowth } from '../public/growth.js';

const now = Date.UTC(2026, 9, 23, 12);
const reviewId = '8c9ccade-d3a1-4fae-92d5-a7cd21419875';
const extensionId = 'nfgcgpjdecjmiakjhhhnkghooefplfnl';
const analytics = (patch = {}) => ({ property_id: '547084285', source: 'ga4_store_listing', state: 'ready', fetched_at: now, online_30m: 12, weekly_active: 580, previous_weekly_active: 500, weekly_change_percent: 16, history_total_users: 21000, history_start_date: '2024-01-02', time_zone: 'Europe/Athens', quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null, ...patch });
const review = (patch = {}) => ({ id: reviewId, author: 'Mod user', rating: 5, body: 'Quick downloads.', created_at: now - 86400000, updated_at: now, version: '3.3.1', language: 'en', is_new: true, ...patch });
const store = (patch = {}) => ({ state: 'ready', snapshot: { extension_id: extensionId, store_url: `https://chromewebstore.google.com/detail/nexusmods-bypass/${extensionId}`, version: '3.3.1', users: 60000, rating_average: 4.84444, rating_count: 45, written_review_count: 30, latest_release_version: '3.3.2', latest_release_url: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/v3.3.2', version_status: 'store_behind', fetched_at: now, reviews_complete: true }, reviews: [review()], new_review_count: 1, last_checked_at: now, sync_interval_seconds: 900, stale: false, message: null, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(t, handler = () => undefined, url = 'https://diagnostics.test/') {
  const dom = new JSDOM('<div id="growth"></div>', { url });
  const container = dom.window.document.getElementById('growth');
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const calls = []; const intervals = new Map(); let intervalId = 0;
  dom.window.setInterval = (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; };
  dom.window.clearInterval = (id) => intervals.delete(id);
  const manager = mountGrowth(container, { document: dom.window.document, window: dom.window, request: async (path, options = {}) => {
    calls.push({ path, options });
    const value = handler(path, options);
    if (value !== undefined) return value;
    if (path === '/analytics') return analytics();
    if (path === '/store') return store();
    if (path === '/store/reviews/ack') return { ok: true };
    throw new Error(`Unexpected path ${path}`);
  } });
  t.after(() => { manager.dispose(); dom.window.close(); });
  return { dom, container, manager, calls, intervals, advance: (milliseconds) => { clock += milliseconds; } };
}

test('listing metrics distinguish visitors, store users, ratings and written reviews', async (t) => {
  const { container } = setup(t); await tick();
  assert.match(container.textContent, /Listing active users · last 30 min/);
  assert.match(container.textContent, /Weekly listing users/);
  assert.match(container.textContent, /Last 7 complete days/);
  assert.match(container.textContent, /\+16\.0%/);
  assert.match(container.textContent, /Listing unique visitors/);
  assert.match(container.textContent, /2024-01-02/);
  assert.match(container.textContent, /Store users/);
  assert.match(container.textContent, /60,000/);
  assert.match(container.textContent, /4\.84/);
  assert.match(container.textContent, /45 ratings/);
  assert.match(container.textContent, /Written reviews/);
  assert.match(container.textContent, /30/);
  assert.match(container.textContent, /Store 3\.3\.1/);
  assert.match(container.textContent, /Latest release 3\.3\.2/);
  assert.match(container.textContent, /Store update pending/);
  assert.equal(container.querySelector('[data-live="true"]')?.textContent, 'Live');
  assert.doesNotMatch(container.textContent, /All installs|cumulative installs|runtime active/i);
});

test('null analytics and zero previous periods never invent totals or infinite trends', async (t) => {
  const { container } = setup(t, (path) => path === '/analytics' ? analytics({ online_30m: null, weekly_active: 0, previous_weekly_active: 0, weekly_change_percent: null, history_total_users: null }) : undefined); await tick();
  const panel = container.querySelector('[data-growth-analytics]');
  assert.match(panel.textContent, /No previous-week baseline/);
  assert.doesNotMatch(panel.textContent, /NaN|Infinity|\+0\.0%/);
  assert.equal(panel.querySelector('[data-metric="online"] .growth-value').textContent, '—');
  assert.equal(panel.querySelector('[data-metric="history"] .growth-value').textContent, '—');
  assert.equal(panel.querySelector('[data-live="true"]'), null);
});

test('unavailable analytics leaves store and reviews usable without exposing upstream errors', async (t) => {
  const { container } = setup(t, (path) => path === '/analytics' ? Promise.reject(new Error('private upstream credential response')) : undefined); await tick();
  assert.match(container.querySelector('[data-growth-analytics]').textContent, /unavailable/i);
  assert.match(container.querySelector('[data-growth-store]').textContent, /60,000/);
  assert.match(container.querySelector('[data-growth-reviews]').textContent, /Quick downloads/);
  assert.doesNotMatch(container.textContent, /private upstream credential response/);
});

test('stale, unconfigured and quality-limited analytics explain their source state', async (t) => {
  let result = analytics({ stale: true, quality: { subject_to_thresholding: true, sampled: true, data_loss: true } });
  const { container, intervals } = setup(t, (path) => path === '/analytics' ? result : undefined); await tick();
  const panel = container.querySelector('[data-growth-analytics]');
  assert.match(panel.textContent, /Saved|cached|stale/i);
  assert.match(panel.textContent, /threshold/i); assert.match(panel.textContent, /sampled/i); assert.match(panel.textContent, /data loss/i);
  assert.equal(panel.querySelector('[data-live="true"]'), null);
  result = analytics({ state: 'not_configured', fetched_at: null, online_30m: null, weekly_active: null, history_total_users: null });
  [...intervals.values()][0].callback(); await tick();
  assert.match(panel.textContent, /not configured/i); assert.match(panel.textContent, /Chrome Web Store listing/i);
  assert.equal(panel.querySelector('[data-live="true"]'), null);
});

test('partial source messages remain bounded text beside the available metrics', async (t) => {
  const { container } = setup(t, (path) => path === '/analytics' ? analytics({ message: 'Historical visitor totals unavailable. <img src=x onerror=alert(1)>'.repeat(50), history_total_users: null }) : path === '/store' ? store({ message: 'The latest store review check is incomplete.' }) : undefined); await tick();
  const panel = container.querySelector('[data-growth-analytics]');
  assert.match(panel.textContent, /Historical visitor totals unavailable/); assert.match(panel.textContent, /580/);
  assert.equal(panel.querySelector('img,[onerror]'), null);
  assert.ok(panel.textContent.length < 1700);
  assert.match(container.querySelector('[data-growth-store]').textContent, /The latest store review check is incomplete/);
});

test('old store snapshots are stale and reviews show the fetched time separately from the last check', async (t) => {
  const value = store(); value.snapshot.fetched_at = now - 3600000;
  const { container } = setup(t, (path) => path === '/store' ? value : undefined); await tick();
  const panel = container.querySelector('[data-growth-store]'); const reviews = container.querySelector('[data-growth-reviews]');
  assert.match(panel.textContent, /Saved store data/); assert.match(reviews.textContent, /Saved reviews/);
  assert.equal(panel.querySelector('.growth-source time').dateTime, '2026-10-23T11:00:00.000Z');
  assert.equal(reviews.querySelector('.growth-source time').dateTime, '2026-10-23T11:00:00.000Z');
  assert.equal(reviews.querySelector('[data-last-check] time').dateTime, '2026-10-23T12:00:00.000Z');
});

test('store polling refreshes every fifteen minutes while visible and resumes due work after backgrounding', async (t) => {
  const { dom, calls, intervals, advance, manager } = setup(t); await tick();
  const timer = [...intervals.values()][0];
  advance(840000); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 1);
  advance(60000); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 2);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
  advance(900000); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 2);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 3);
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
  advance(900000); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 3);
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: true });
  dom.window.dispatchEvent(new dom.window.Event('online')); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 4);
  manager.dispose(); advance(900000); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/store').length, 4);
});

test('review text stays bounded and inert and untrusted external links are rejected', async (t) => {
  const data = store(); data.reviews = [review({ author: '<img src=x onerror=alert(1)>'.repeat(100), body: '<script>bad</script>'.repeat(1000) })];
  data.snapshot.store_url = 'https://evil.test/store'; data.snapshot.latest_release_url = 'https://github.com/other/repo/releases/tag/v3.3.2';
  const { container } = setup(t, (path) => path === '/store' ? data : undefined); await tick();
  const card = container.querySelector('[data-review-id]');
  assert.match(card.textContent, /<img src=x/); assert.match(card.textContent, /<script>bad/);
  assert.equal(container.querySelector('img, script, [onerror]'), null);
  assert.ok(card.textContent.length < 12000);
  assert.equal(container.querySelector('a[href*="evil.test"],a[href*="other/repo"]'), null);
  for (const link of container.querySelectorAll('a')) { assert.equal(link.target, '_blank'); assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/); }
});

test('new reviews are acknowledged only by an explicit button click', async (t) => {
  const { container, calls } = setup(t); await tick();
  assert.equal(calls.filter(({ path }) => path.endsWith('/ack')).length, 0);
  const card = container.querySelector(`[data-review-id="${reviewId}"]`);
  assert.equal(card.dataset.new, 'true');
  card.querySelector('[data-action="ack-review"]').click(); await tick();
  const ack = calls.find(({ path }) => path === '/store/reviews/ack');
  assert.equal(ack.options.method, 'POST'); assert.deepEqual(ack.options.body, { ids: [reviewId] });
  assert.equal(container.querySelector(`[data-review-id="${reviewId}"]`).dataset.new, 'false');
  assert.equal(container.querySelector('[data-action="ack-review"]'), null);
  assert.equal(container.ownerDocument.activeElement, container.querySelector(`[data-review-id="${reviewId}"]`));
});

test('a failed review acknowledgement keeps the new card available for retry', async (t) => {
  const { container } = setup(t, (path) => path === '/store/reviews/ack' ? Promise.reject(new Error('private mutation response')) : undefined); await tick();
  container.querySelector('[data-action="ack-review"]').click(); await tick();
  const card = container.querySelector(`[data-review-id="${reviewId}"]`);
  assert.equal(card.dataset.new, 'true'); assert.equal(card.querySelector('button').disabled, false);
  assert.match(card.querySelector('button').textContent, /Mark as read/); assert.doesNotMatch(container.textContent, /private mutation response/);
});

test('a valid review deep link focuses the matching card without acknowledging it', async (t) => {
  const { container, dom, calls } = setup(t, undefined, `https://diagnostics.test/?review=${reviewId}`); await tick();
  assert.equal(dom.window.document.activeElement, container.querySelector(`[data-review-id="${reviewId}"]`));
  assert.equal(calls.filter(({ path }) => path.endsWith('/ack')).length, 0);
});

test('analytics polling pauses when hidden or offline and disposal aborts late responses', async (t) => {
  const pending = Promise.withResolvers(); let pendingNext = false;
  const { container, dom, manager, calls, intervals, advance } = setup(t, (path) => path === '/analytics' && pendingNext ? pending.promise : undefined); await tick();
  const timer = [...intervals.values()][0]; assert.equal(timer.delay, 60000);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' }); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/analytics').length, 1);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false }); timer.callback(); await tick();
  assert.equal(calls.filter(({ path }) => path === '/analytics').length, 1);
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: true });
  advance(180000); pendingNext = true; timer.callback(); await tick();
  assert.equal(container.querySelector('[data-live="true"]'), null, 'old data stops claiming to be live before the next result');
  const lastRequest = calls.filter(({ path }) => path === '/analytics').at(-1); const before = container.textContent;
  manager.dispose(); assert.equal(lastRequest.options.signal.aborted, true); assert.equal(intervals.size, 0);
  pending.resolve(analytics({ online_30m: 999 })); await tick();
  assert.equal(container.textContent, before);
});

test('an abandoned retry cannot mark a newer analytics result stale', async (t) => {
  const older = Promise.withResolvers(); const newer = Promise.withResolvers(); let attempt = 0;
  const { container } = setup(t, (path) => {
    if (path !== '/analytics') return undefined;
    attempt++;
    if (attempt === 1) return analytics({ state: 'unavailable' });
    return attempt === 2 ? older.promise : newer.promise;
  }); await tick();
  const retry = [...container.querySelectorAll('button')].find((control) => control.textContent === 'Retry analytics');
  retry.click(); retry.click();
  newer.resolve(analytics()); await tick();
  assert.equal(container.querySelector('[data-live="true"]')?.textContent, 'Live');
  older.reject(new Error('old provider error')); await tick();
  assert.equal(container.querySelector('[data-live="true"]')?.textContent, 'Live');
  assert.doesNotMatch(container.querySelector('[data-growth-analytics]').textContent, /Saved listing data/);
});
