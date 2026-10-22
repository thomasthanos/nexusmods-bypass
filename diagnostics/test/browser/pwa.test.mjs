import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { startPreviewServer } from '../helpers/preview-server.mjs';

let preview;
let browser;
const screenshots = new URL('../../.wrangler/browser-qa/', import.meta.url);
before(async () => {
  preview = await startPreviewServer();
  browser = await chromium.launch({ headless: true });
  await mkdir(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); await preview?.close(); });
async function session(t, width = 390, blockCdn = true) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
  t.after(() => context.close());
  const page = await context.newPage();
  if (blockCdn) await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, context, errors };
}
async function noOverflow(page) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].filter((element) => {
      const box = element.getBoundingClientRect(); return box.width && (box.right > innerWidth + 1 || box.left < -1);
    }).slice(0, 12).map((element) => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width })) }));
  assert.ok(geometry.scrollWidth <= geometry.width, `page must fit viewport: ${JSON.stringify(geometry)}`);
}
async function openOverview(page) {
  await page.goto(preview.origin);
  await expect(page.locator('#view-overview h1')).toHaveText('Overview');
}

test('390px overview and release comparison use the real protected Worker API with CDN unavailable', async (t) => {
  const { page, errors } = await session(t);
  await openOverview(page);
  await expect(page.locator('#view-overview')).toContainText('98.2%');
  await expect(page.locator('#view-overview')).toContainText('13 reports across 5 installs');
  await page.locator('[data-form="comparison"] [name="before"]').fill('3.2.0');
  await page.locator('[data-form="comparison"] [name="after"]').fill('3.2.1');
  await page.getByRole('button', { name: 'Compare releases', exact: true }).click();
  await expect(page.locator('[data-comparison-result]')).toContainText('+0.6 pp');
  await noOverflow(page);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: new URL('overview-mobile.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  assert.deepEqual(errors, []);
});

test('mobile issue sheet renders evidence, supports a manual copy fallback and persists lifecycle changes', async (t) => {
  const { page, context, errors } = await session(t);
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw new DOMException('Clipboard blocked', 'NotAllowedError'); } } }));
  await openOverview(page);
  await page.locator('#view-overview .issue-row').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.upstream}`);
  await expect(page.locator('#issue-detail')).toContainText('UI_CLICK_DOWNLOAD');
  await expect(page.locator('#issue-detail')).toContainText('429');
  await page.getByRole('button', { name: 'Copy AI Debug Context', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Complete AI debug context' })).toHaveValue(/FIND_COLLECTION_HOST/);
  await page.getByLabel('Mute this issue', { exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#issue-detail')).toContainText('muted');
  assert.equal(preview.db.sqlite.prepare('SELECT muted FROM issues WHERE id=?').get(preview.ids.upstream).muted, 1);
  await noOverflow(page);
  assert.equal(await page.locator('#issue-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await page.locator('#issue-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL('issue-mobile.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  await page.getByRole('button', { name: 'Close issue details' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal(new URL(page.url()).searchParams.has('issue'), false);
  preview.db.sqlite.prepare('UPDATE issues SET muted=0 WHERE id=?').run(preview.ids.upstream);
  assert.deepEqual(errors, []);
});

test('desktop filters, hostile diagnostic text, deep links and settings work without executable markup', async (t) => {
  const { page, errors } = await session(t, 1440);
  await openOverview(page);
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('#view-issues h1')).toHaveText('Issues');
  await page.locator('[data-form="issues"] details').evaluate((element) => { element.open = true; });
  await page.locator('[name="destination"]').selectOption('vortex');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('#view-issues .issue-list .issue-row')).toHaveCount(1);
  await expect(page.locator('#view-issues .issue-list')).toContainText('HANDOFF_FAILURE');
  await page.screenshot({ path: new URL('issues-desktop.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  await page.goto(`${preview.origin}/?issue=${preview.ids.network}`);
  await expect(page.locator('#issue-detail')).toContainText('<img src=x');
  assert.equal(await page.locator('#issue-detail img').count(), 0);
  assert.equal(await page.evaluate(() => window.__diagnosticsXss), undefined);
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.handoff}`);
  await page.getByRole('button', { name: 'Close issue details' }).click();
  await page.locator('[data-view="settings"]').click();
  await expect(page.locator('#view-settings h1')).toHaveText('Settings');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(page.locator('[data-push-action="refresh"]')).toBeEnabled();
  await page.screenshot({ path: new URL('settings-desktop.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  await noOverflow(page);
  assert.deepEqual(errors, []);
});

test('real browser manual Access redirect clears private detail and stops the session', async (t) => {
  const { page } = await session(t);
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.handoff}`);
  await page.route('**/api/admin/overview?**', (route) => route.fulfill({ status: 302, headers: { location: '/cdn-cgi/access/login' } }));
  await page.getByRole('button', { name: 'Close issue details' }).click();
  await page.getByRole('button', { name: 'Refresh diagnostics' }).click();
  await expect(page.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(page.locator('#issue-detail')).toBeEmpty();
  await expect(page.locator('#view-overview')).toBeEmpty();
  assert.equal(await page.locator('#refresh-button').isDisabled(), true);
});

test('stale mobile sheet preserves a new regression and shows copy feedback inside the native modal', async (t) => {
  const { page, context } = await session(t);
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() {} } }));
  preview.db.sqlite.prepare("UPDATE issues SET status='fixed',fixed_in_version='3.2.0',muted=0 WHERE id=?").run(preview.ids.handoff);
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.handoff}`);
  await page.getByRole('button', { name: 'Copy AI Debug Context', exact: true }).click();
  await expect(page.locator('#issue-detail [data-dialog-status]')).toContainText(/copied/i);
  await expect(page.locator('#issue-detail [data-dialog-status]')).toBeVisible();
  preview.db.sqlite.prepare("UPDATE issues SET status='regressed' WHERE id=?").run(preview.ids.handoff);
  await page.getByLabel('Mute this issue', { exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh details', exact: true })).toBeVisible();
  assert.equal(preview.db.sqlite.prepare('SELECT status FROM issues WHERE id=?').get(preview.ids.handoff).status, 'regressed');
  assert.equal(preview.db.sqlite.prepare('SELECT muted FROM issues WHERE id=?').get(preview.ids.handoff).muted, 0);
});

test('320px overview and issue detail remain usable with reduced motion', async (t) => {
  const { page } = await session(t, 320);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openOverview(page);
  await noOverflow(page);
  await page.locator('#view-overview .issue-row').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  assert.equal(await page.locator('#issue-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await expect(page.getByRole('button', { name: 'Close issue details' })).toBeVisible();
});

test('pinned Tailwind CDN can load under production CSP without breaking the dashboard', async (t) => {
  const { page, errors } = await session(t, 1440, false);
  const downloaded = page.waitForResponse((response) => response.url().includes('/@tailwindcss/browser@4.3.3/dist/index.global.js'));
  await openOverview(page);
  assert.equal((await downloaded).status(), 200);
  await page.waitForFunction(() => [...document.querySelectorAll('style')].some((style) => style.textContent.includes('tailwindcss')));
  await expect(page.locator('#view-overview')).toContainText('98.2%');
  await noOverflow(page);
  await page.screenshot({ path: new URL('overview-desktop.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  assert.deepEqual(errors, []);
});
