import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountGrowth } from '../public/growth.js';

const now = Date.UTC(2026, 9, 23, 12);
const reviewId = '8c9ccade-d3a1-4fae-92d5-a7cd21419875';
const extensionId = 'nfgcgpjdecjmiakjhhhnkghooefplfnl';
const analytics = (patch = {}) => ({ property_id: '547084285', source: 'ga4_store_listing', state: 'ready', fetched_at: now, online_30m: 12, weekly_active: 580, previous_weekly_active: 500, weekly_change_percent: 16, history_total_users: 21000, history_start_date: '2024-01-02', time_zone: 'Europe/Athens', quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null, ...patch });
const review = (patch = {}) => ({ id: reviewId, author: 'Mod user', rating: 5, body: 'Quick downloads.', created_at: now - 86400000, updated_at: now, version: '3.3.1', language: 'en', is_new: true, ...patch });
const reviewHistory = () => Array.from({ length: 6 }, (_, index) => review({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, author: `Reviewer ${index + 1}`, created_at: now - (index + 1) * 86400000, is_new: false }));
const store = (patch = {}) => ({ state: 'ready', snapshot: { extension_id: extensionId, store_url: `https://chromewebstore.google.com/detail/nexusmods-bypass/${extensionId}`, version: '3.3.1', users: 60000, rating_average: 4.84444, rating_count: 45, written_review_count: 30, latest_release_version: '3.3.2', latest_release_url: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/v3.3.2', version_status: 'store_behind', fetched_at: now, reviews_complete: true }, reviews: [review()], new_review_count: 1, last_checked_at: now, sync_interval_seconds: 900, stale: false, message: null, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(t, handler = () => undefined, url = 'https://diagnostics.test/', uiState = {}) {
  const dom = new JSDOM('<div id="growth"></div>', { url });
  const container = dom.window.document.getElementById('growth');
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const calls = []; const intervals = new Map(); let intervalId = 0;
  dom.window.setInterval = (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; };
  dom.window.clearInterval = (id) => intervals.delete(id);
  const manager = mountGrowth(container, { document: dom.window.document, window: dom.window, uiState, request: async (path, options = {}) => {
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
  assert.match(container.textContent, /Listing visitors/);
  assert.match(container.textContent, /Chrome Web Store listing/);
  assert.match(container.textContent, /Online · 30 min/);
  assert.match(container.textContent, /Last 7 days/);
  assert.match(container.textContent, /last 7 complete days/i);
  assert.match(container.textContent, /\+16\.0%/);
  assert.match(container.textContent, /Unique visitors/);
  assert.match(container.textContent, /2024-01-02/);
  assert.match(container.textContent, /Store users/);
  assert.match(container.textContent, /60,000/);
  assert.match(container.textContent, /4\.84/);
  assert.match(container.textContent, /45 ratings/);
  assert.match(container.textContent, /Written reviews/);
  assert.match(container.textContent, /30/);
  assert.match(container.textContent, /Store 3\.3\.1/);
  assert.match(container.textContent, /Release 3\.3\.2/);
  assert.match(container.textContent, /Update pending/);
  assert.equal(container.querySelector('[data-live="true"]')?.textContent, 'Live');
  assert.doesNotMatch(container.textContent, /All installs|cumulative installs|runtime active/i);
});

test('growth headings and metric labels pair readable text with decorative line icons', async (t) => {
  const { container } = setup(t); await tick();
  for (const [panel, icon] of [['analytics', 'audience'], ['store', 'store'], ['reviews', 'reviews']]) {
    const heading = container.querySelector(`[data-growth-${panel}] .panel-heading`);
    const graphic = heading.querySelector('.section-icon > svg.ui-icon');
    assert.ok(graphic, `${panel} has a section icon`);
    assert.equal(graphic.dataset.icon, icon);
    assert.equal(graphic.getAttribute('aria-hidden'), 'true');
    assert.equal(graphic.getAttribute('focusable'), 'false');
    assert.ok(heading.querySelector('h2').textContent.trim().length > 0);
  }
  for (const [metric, icon] of [['online', 'clock'], ['weekly', 'audience'], ['history', 'users'], ['users', 'users'], ['rating', 'rating'], ['reviews', 'reviews']]) {
    const label = container.querySelector(`[data-metric="${metric}"] .growth-label`);
    assert.equal(label.querySelector('svg.ui-icon')?.dataset.icon, icon);
    assert.ok(label.textContent.trim().length > 0);
  }
  assert.equal(container.querySelector('svg script,svg foreignObject,svg image,svg use,svg [href]'), null);
});

test('aggregate listing data never invents chart samples or unsupported time-range controls', async (t) => {
  const { container } = setup(t); await tick();
  const panel = container.querySelector('[data-growth-analytics]');
  assert.equal(panel.querySelector('.visitor-chart,.visitor-segments'), null);
  assert.equal([...panel.querySelectorAll('button')].some((control) => /28 days/.test(control.textContent)), false);
  assert.equal(panel.querySelector('[data-metric="online"] .growth-value').textContent, '12');
  assert.equal(panel.querySelector('[data-metric="weekly"] .growth-value').textContent, '580');
  assert.equal(panel.querySelector('[data-metric="history"] .growth-value').textContent, '21,000');
  assert.match(panel.querySelector('[data-metric="online"] .growth-label').textContent, /30 min/);
  assert.equal(panel.querySelector('[data-metric="online"] .growth-trend-pill'), null, 'weekly growth must not be presented as realtime growth');
});

test('source explanations are collapsed while quality warnings stay visible', async (t) => {
  const { container } = setup(t, (path) => path === '/analytics' ? analytics({ quality: { subject_to_thresholding: true, sampled: false, data_loss: false } }) : undefined); await tick();
  const analyticsPanel = container.querySelector('[data-growth-analytics]');
  const storePanel = container.querySelector('[data-growth-store]');
  assert.equal(analyticsPanel.querySelector('details[data-growth-details]').open, false);
  assert.match(analyticsPanel.querySelector('details[data-growth-details]').textContent, /Google Analytics.*store listing visitors/);
  assert.match(storePanel.querySelector('details[data-growth-details]').textContent, /Ratings include scores without text/);
  assert.equal([...analyticsPanel.querySelectorAll('.growth-state')].some((node) => !node.closest('details') && /threshold/i.test(node.textContent)), true);
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

test('store freshness follows its fifteen-minute cadence instead of the realtime analytics window', async (t) => {
  const value = store(); value.snapshot.fetched_at = now - 180000;
  const { container } = setup(t, (path) => path === '/store' ? value : undefined); await tick();
  assert.doesNotMatch(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.doesNotMatch(container.querySelector('[data-growth-reviews]').textContent, /Saved reviews/);
  assert.match(container.querySelector('[data-growth-store] .growth-source').textContent, /Fetched/);
});

test('store age changes update status without replacing focused review controls while a refresh is pending', async (t) => {
  const pending = Promise.withResolvers(); let storeCalls = 0;
  const { container, intervals, advance } = setup(t, (path) => path === '/store' && ++storeCalls > 1 ? pending.promise : undefined); await tick();
  const timer = [...intervals.values()][0];
  const control = container.querySelector('[data-action="ack-review"]'); control.focus();
  advance(1740000); timer.callback(); await tick();
  assert.doesNotMatch(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.equal(container.ownerDocument.activeElement, control);
  advance(120000); timer.callback(); await tick();
  assert.match(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.match(container.querySelector('[data-growth-reviews]').textContent, /Saved reviews/);
  assert.match(container.querySelector('[data-growth-store] .growth-source').textContent, /Saved data from/);
  assert.equal(container.ownerDocument.activeElement, control);
  timer.callback(); await tick();
  assert.equal(container.querySelector('[data-action="ack-review"]'), control);
});

test('offline and foreground events recalculate store freshness without replacing review controls', async (t) => {
  const pending = Promise.withResolvers(); let storeCalls = 0;
  const { container, dom, advance } = setup(t, (path) => path === '/store' && ++storeCalls > 1 ? pending.promise : undefined); await tick();
  const control = container.querySelector('[data-action="ack-review"]'); control.focus();
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
  dom.window.dispatchEvent(new dom.window.Event('offline'));
  assert.match(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.match(container.querySelector('[data-growth-reviews]').textContent, /Saved reviews/);
  assert.equal(container.ownerDocument.activeElement, control);
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: true });
  dom.window.dispatchEvent(new dom.window.Event('online')); await tick();
  assert.doesNotMatch(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.equal(container.ownerDocument.activeElement, control);
  advance(1800001); dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
  assert.match(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.equal(container.ownerDocument.activeElement, control);
});

test('store freshness rejects a future snapshot regardless of the cadence', async (t) => {
  const value = store(); value.snapshot.fetched_at = now + 61000;
  const { container } = setup(t, (path) => path === '/store' ? value : undefined); await tick();
  assert.match(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.match(container.querySelector('[data-growth-reviews]').textContent, /Saved reviews/);
});

test('store freshness respects a server-stale response even when the snapshot was just fetched', async (t) => {
  const { container } = setup(t, (path) => path === '/store' ? store({ stale: true }) : undefined); await tick();
  assert.match(container.querySelector('[data-growth-store]').textContent, /Saved store data/);
  assert.match(container.querySelector('[data-growth-reviews]').textContent, /Saved reviews/);
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

test('review preview contains exactly the latest three while history counts hidden unread reviews', async (t) => {
  const reviews = reviewHistory(); reviews[0].is_new = true; reviews[5].is_new = true;
  const { container } = setup(t, (path) => path === '/store' ? store({ reviews: [...reviews].reverse().concat(reviews[0]), new_review_count: 2 }) : undefined); await tick();
  const panel = container.querySelector('[data-growth-reviews]');
  const preview = panel.querySelector('[data-review-preview]');
  assert.deepEqual([...preview.children].map((card) => card.dataset.reviewId), [reviews[0].id, reviews[1].id, reviews[2].id]);
  const history = panel.querySelector('details[data-review-history]');
  assert.equal(history.open, false);
  assert.equal(history.querySelector('summary').textContent, '3 older reviews · 1 unread');
  assert.equal(history.querySelectorAll('[data-review-id]').length, 3);
  assert.equal(panel.querySelectorAll('[data-review-id]').length, 6);
});

test('an older unread review deep link opens its history before focusing, without acknowledging it', async (t) => {
  const reviews = reviewHistory(); reviews[5].is_new = true; const id = reviews[5].id;
  const { container, calls } = setup(t, (path) => path === '/store' ? store({ reviews, new_review_count: 1 }) : undefined, `https://diagnostics.test/?review=${id}`); await tick();
  const card = container.querySelector(`[data-review-id="${id}"]`);
  assert.equal(card.closest('details[data-review-history]').open, true);
  assert.equal(container.querySelector('[data-review-preview]').children.length, 3);
  assert.equal(container.ownerDocument.activeElement, card);
  assert.equal(calls.filter(({ path }) => path.endsWith('/ack')).length, 0);
});

test('acknowledging an older new review opens its destination history and preserves focus', async (t) => {
  const reviews = reviewHistory(); reviews[5].is_new = true; const id = reviews[5].id;
  const { container, calls } = setup(t, (path) => path === '/store' ? store({ reviews, new_review_count: 1 }) : undefined); await tick();
  container.querySelector('details[data-review-history]').open = true;
  container.querySelector(`[data-review-id="${id}"] [data-action="ack-review"]`).click(); await tick();
  const card = container.querySelector(`[data-review-id="${id}"]`);
  assert.equal(card.dataset.new, 'false');
  assert.equal(card.closest('details[data-review-history]').open, true);
  assert.equal(container.ownerDocument.activeElement, card);
  assert.equal(container.querySelector('[data-review-preview]').children.length, 3);
  assert.equal(container.querySelector('[data-review-history] > summary').textContent, '3 older reviews');
  assert.equal(calls.filter(({ path }) => path.endsWith('/ack')).length, 1);
});

test('opened disclosures persist across a mount replacement using only boolean UI state', async (t) => {
  const uiState = {}; const reviews = reviewHistory();
  const { container, manager } = setup(t, (path) => path === '/store' ? store({ reviews, new_review_count: 0 }) : undefined, 'https://diagnostics.test/', uiState); await tick();
  container.querySelector('details[data-review-history]').open = true;
  container.querySelector('[data-growth-analytics] details[data-growth-details]').open = true;
  manager.dispose();
  const replacement = mountGrowth(container, { uiState, request: async (path) => path === '/store' ? store({ reviews, new_review_count: 0 }) : analytics() });
  t.after(() => replacement.dispose()); await tick();
  assert.equal(container.querySelector('details[data-review-history]').open, true);
  assert.equal(container.querySelector('[data-growth-analytics] details[data-growth-details]').open, true);
  assert.ok(Object.values(uiState).every((value) => typeof value === 'boolean'));
});

test('long written feedback keeps its full inert text in a collapsed disclosure', async (t) => {
  const body = `Useful extension. ${'<script>bad</script> '.repeat(40)}The final sentence.`;
  const { container } = setup(t, (path) => path === '/store' ? store({ reviews: [review({ body })] }) : undefined); await tick();
  const card = container.querySelector('[data-review-id]'); const content = card.querySelector('details.growth-review-text');
  assert.equal(content.open, false);
  assert.equal(content.querySelector('.growth-review-body').textContent, body);
  assert.match(content.querySelector('summary').textContent, /Read full review/);
  assert.ok(content.querySelector('.growth-review-excerpt').textContent.length < 250);
  assert.equal(card.querySelector('script'), null);
  content.open = true; await tick();
  assert.equal(content.querySelector('.growth-review-expand').textContent, 'Show less');
  content.open = false; await tick();
  assert.equal(content.querySelector('.growth-review-expand').textContent, 'Read full review');
});

test('expanded review history survives freshness status updates and a store refresh', async (t) => {
  const reviews = reviewHistory();
  const { container, dom, intervals, advance } = setup(t, (path) => path === '/store' ? store({ reviews, new_review_count: 0 }) : undefined); await tick();
  const history = container.querySelector('details[data-review-history]'); history.open = true;
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
  dom.window.dispatchEvent(new dom.window.Event('offline'));
  assert.equal(container.querySelector('details[data-review-history]'), history);
  assert.equal(history.open, true);
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: true });
  advance(900000); [...intervals.values()][0].callback(); await tick();
  assert.equal(container.querySelector('details[data-review-history]').open, true);
});

test('a Store poll started before a confirmed acknowledgement cannot resurrect its unread review', async (t) => {
  const oldPoll = Promise.withResolvers(); const freshPoll = Promise.withResolvers(); let storeCalls = 0;
  const reviews = reviewHistory(); reviews[5].is_new = true; const id = reviews[5].id;
  const unread = store({ reviews, new_review_count: 1 });
  const { container, intervals, advance } = setup(t, (path) => {
    if (path !== '/store') return undefined;
    storeCalls++;
    return storeCalls === 1 ? unread : storeCalls === 2 ? oldPoll.promise : freshPoll.promise;
  }); await tick();
  advance(900000); [...intervals.values()][0].callback(); await tick();
  assert.equal(storeCalls, 2);
  container.querySelector(`[data-review-id="${id}"] [data-action="ack-review"]`).click(); await tick();
  assert.equal(container.querySelector(`[data-review-id="${id}"]`).dataset.new, 'false');
  oldPoll.resolve(unread); await tick();
  assert.equal(storeCalls, 3, 'an outdated poll triggers a fresh read after the confirmed acknowledgement');
  assert.equal(container.querySelector(`[data-review-id="${id}"]`).dataset.new, 'false');
  assert.equal(container.querySelector(`[data-review-id="${id}"] [data-action="ack-review"]`), null);
  freshPoll.resolve(store({ reviews: reviews.map((item) => ({ ...item, is_new: false })), new_review_count: 0 })); await tick();
  assert.equal(container.querySelector(`[data-review-id="${id}"]`).dataset.new, 'false');
  assert.equal(container.querySelector('details[data-review-history]').open, true);
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
