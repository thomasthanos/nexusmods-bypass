import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { startPreviewServer } from '../helpers/preview-server.mjs';

let preview; let browser;
const engineName = process.env.NXTK_DIAGNOSTICS_BROWSER ?? 'chromium';
const reviewId = '8c9ccade-d3a1-4fae-92d5-a7cd21419875';
const screenshots = new URL(`../../.wrangler/browser-qa/${engineName}/growth/`, import.meta.url);
before(async () => { preview = await startPreviewServer(); browser = await ({ chromium, webkit })[engineName].launch({ headless: true }); await mkdir(screenshots, { recursive: true }); });
after(async () => { await browser?.close(); await preview?.close(); });

function listing() {
  return { property_id: '547084285', source: 'ga4_store_listing', state: 'ready', fetched_at: Date.now(), online_30m: 12, weekly_active: 580, previous_weekly_active: 500, weekly_change_percent: 16, history_total_users: 21000, history_start_date: '2024-01-02', time_zone: 'Europe/Athens', quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null };
}
function store() {
  return { state: 'ready', snapshot: { extension_id: 'chfghiknjhpcncpcjopglefnckckdlpj', store_url: 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj', version: '3.3.1', users: 60000, rating_average: 4.84444, rating_count: 45, written_review_count: 30, latest_release_version: '3.3.2', latest_release_url: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/v3.3.2', version_status: 'store_behind', fetched_at: Date.now(), reviews_complete: true }, reviews: [{ id: reviewId, author: '<img src=x onerror=alert(1)> Mod user', rating: 5, body: 'Quick downloads and easy to use. <script>bad</script>', created_at: Date.now() - 86400000, updated_at: Date.now(), version: '3.3.1', language: 'en', is_new: true }], new_review_count: 1, last_checked_at: Date.now(), sync_interval_seconds: 900, stale: false, message: null };
}
async function session(t, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1 }); t.after(() => context.close());
  const page = await context.newPage(); const errors = []; const analyticsCalls = []; const acknowledgements = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('**/api/admin/analytics', (route) => { analyticsCalls.push(route.request().url()); return route.fulfill({ json: listing() }); });
  await page.route('**/api/admin/store', (route) => route.fulfill({ json: store() }));
  await page.route('**/api/admin/store/reviews/ack', (route) => { acknowledgements.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
  return { page, errors, analyticsCalls, acknowledgements };
}
async function fit(page) {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, small: [...document.querySelectorAll('[data-growth] button,[data-growth] a,[data-growth] summary')].filter((item) => item.getClientRects().length && item.getBoundingClientRect().height < 44).map((item) => item.textContent) }));
  assert.ok(bounds.scroll <= bounds.viewport, JSON.stringify(bounds)); assert.deepEqual(bounds.small, []);
}

for (const width of [320, 390, 430, 1280]) test(`listing audience, store metrics and new reviews fit ${width}px`, async (t) => {
  const { page, errors } = await session(t, width); await page.goto(preview.origin);
  await expect(page.locator('[data-growth-analytics] [data-metric="weekly"]')).toContainText('Last 7 days');
  await expect(page.locator('[data-growth-store]')).toContainText('60,000');
  await expect(page.locator('[data-growth-store]')).toContainText('45 ratings');
  await expect(page.locator('[data-growth-reviews]')).toContainText('<script>bad</script>');
  assert.equal(await page.locator('[data-growth-reviews] img, [data-growth-reviews] script').count(), 0);
  await fit(page);
  await page.screenshot({ path: new URL(`overview-${width}.png`, screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.growth-live').evaluate((node) => getComputedStyle(node, '::before').animationName), 'none');
  assert.deepEqual(errors, []);
});

test('review deep link focuses the card and an explicit read action updates its badge', async (t) => {
  const { page, acknowledgements, errors } = await session(t);
  await page.goto(`${preview.origin}/?review=${reviewId}`);
  const card = page.locator(`[data-review-id="${reviewId}"]`);
  await expect(card).toBeFocused(); assert.deepEqual(acknowledgements, []);
  await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(page.locator(`[data-review-id="${reviewId}"]`)).toHaveAttribute('data-new', 'false');
  assert.deepEqual(acknowledgements, [{ ids: [reviewId] }]); assert.deepEqual(errors, []);
});

test('exactly three reviews show on mobile with hidden unread history accessible and persistent', async (t) => {
  const { page, acknowledgements, errors } = await session(t, 320);
  const value = store();
  value.reviews = Array.from({ length: 6 }, (_, index) => ({ ...value.reviews[0], id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, author: `Reviewer ${index + 1}`, created_at: Date.now() - (index + 1) * 86400000, is_new: index === 0 || index === 5 }));
  value.new_review_count = 2;
  await page.route('**/api/admin/store', (route) => route.fulfill({ json: value }));
  await page.goto(preview.origin);
  const history = page.locator('[data-review-history]'); const summary = history.locator(':scope > summary');
  await expect(page.locator('[data-review-preview] > [data-review-id]')).toHaveCount(3);
  await expect(page.locator('[data-review-id]:visible')).toHaveCount(3);
  await expect(summary).toHaveText('3 older reviews · 1 unread');
  await expect(history).not.toHaveAttribute('open');
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-review-id]:visible')).toHaveCount(6);
  await fit(page);
  await page.locator('#refresh-button').click();
  await expect(page.locator('[data-review-history]')).toHaveAttribute('open', '');
  await expect(page.locator('[data-review-id]:visible')).toHaveCount(6);
  assert.deepEqual(acknowledgements, []); assert.deepEqual(errors, []);
});

test('an old unread review deep link expands native history and supports explicit acknowledgement', async (t) => {
  const { page, acknowledgements, errors } = await session(t);
  const value = store(); const id = '00000000-0000-4000-8000-000000000006';
  value.reviews = Array.from({ length: 6 }, (_, index) => ({ ...value.reviews[0], id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, created_at: Date.now() - (index + 1) * 86400000, is_new: index === 5 }));
  await page.route('**/api/admin/store', (route) => route.fulfill({ json: value }));
  await page.goto(`${preview.origin}/?review=${id}`);
  const card = page.locator(`[data-review-id="${id}"]`);
  await expect(page.locator('[data-review-history]')).toHaveAttribute('open', '');
  await expect(card).toBeFocused(); assert.deepEqual(acknowledgements, []);
  await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(card).toHaveAttribute('data-new', 'false'); await expect(card).toBeFocused();
  await expect(page.locator('[data-review-history] > summary')).toHaveText('3 older reviews');
  assert.deepEqual(acknowledgements, [{ ids: [id] }]); assert.deepEqual(errors, []);
});

test('source definitions and long feedback expand on demand without adding mobile overflow', async (t) => {
  const { page, errors } = await session(t, 320);
  const value = store(); const body = `Useful extension. ${'Long written feedback. '.repeat(40)}The final sentence.`;
  value.reviews[0].body = body;
  await page.route('**/api/admin/store', (route) => route.fulfill({ json: value }));
  await page.goto(preview.origin);
  const source = page.locator('[data-growth-analytics] .growth-details');
  await expect(source.locator('.growth-details-body')).not.toBeVisible();
  await source.locator('summary').click();
  await expect(source.locator('.growth-details-body')).toBeVisible();
  await expect(source).toContainText('store listing visitors');
  const review = page.locator('[data-review-id] .growth-review-text');
  await expect(review.locator('.growth-review-body')).not.toBeVisible();
  await review.locator('summary').click();
  await expect(review.locator('.growth-review-expand')).toHaveText('Show less');
  await expect(review.locator('.growth-review-body')).toHaveText(body);
  await expect(review.locator('.growth-review-body')).toBeVisible();
  await fit(page); assert.deepEqual(errors, []);
});

test('analytics failures leave store feedback and private diagnostics visible', async (t) => {
  const { page, errors } = await session(t);
  await page.route('**/api/admin/analytics', (route) => route.fulfill({ status: 503, json: { error: 'private provider response' } }));
  await page.goto(preview.origin);
  await expect(page.locator('[data-growth-analytics]')).toContainText('temporarily unavailable');
  await expect(page.locator('[data-growth-store]')).toContainText('60,000');
  await expect(page.locator('[data-overview-diagnostics]')).toContainText('98.2%');
  await expect(page.locator('[data-growth-reviews]')).toContainText('Quick downloads');
  await expect(page.locator('body')).not.toContainText('private provider response'); assert.deepEqual(errors, []);
});

test('listing polling stops when navigating away and global refresh reloads both sources', async (t) => {
  const { page, analyticsCalls, errors } = await session(t);
  await page.clock.install(); await page.goto(preview.origin);
  await expect(page.locator('[data-growth-store]')).toContainText('60,000');
  assert.equal(analyticsCalls.length, 1);
  await page.clock.fastForward(60000); await expect.poll(() => analyticsCalls.length).toBe(2);
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('#view-issues h1')).toHaveText('Issues');
  await page.clock.fastForward(120000); assert.equal(analyticsCalls.length, 2);
  await page.locator('[data-view="overview"]').click(); await expect.poll(() => analyticsCalls.length).toBe(3);
  await page.locator('#refresh-button').click(); await expect.poll(() => analyticsCalls.length).toBe(4);
  await expect(page.locator('[data-growth-store]')).toContainText('60,000'); assert.deepEqual(errors, []);
});
