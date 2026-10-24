import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { startPreviewServer } from '../helpers/preview-server.mjs';

let preview;
let browser;
const engineName = process.env.NXTK_DIAGNOSTICS_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engineName), 'Choose a supported diagnostics browser');
const screenshots = new URL(`../../.wrangler/browser-qa/${engineName}/`, import.meta.url);
before(async () => {
  preview = await startPreviewServer();
  browser = await ({ chromium, webkit })[engineName].launch({ headless: true });
  await mkdir(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); await preview?.close(); });
async function session(t, width = 390, blockCdn = true) {
  // Headless WebKit exposes PushManager.getSubscription but its native
  // implementation freezes the page on both Windows and Linux CI. UI tests disable that emulator
  // capability; push lifecycle and service-worker behavior have dedicated tests.
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1,
    ...(engineName === 'webkit' ? { serviceWorkers: 'block' } : {}) });
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

for (const width of [320, 375, 390, 430]) {
  test(`phone filters and navigation fit ${width}px screens with readable controls`, { timeout: 30_000 }, async (t) => {
    const { page } = await session(t, width);
    await openOverview(page);
    for (const view of ['overview', 'issues', 'settings']) {
      if (view !== 'overview') {
        await page.locator(`[data-view="${view}"]`).click();
        await expect(page.locator(`#view-${view} h1`)).toHaveText(view === 'issues' ? 'Issues' : 'Settings');
      }
      if (view === 'issues') await page.locator('[data-form="issues"] summary').click();
      await noOverflow(page);
      const clipped = await page.locator(`#view-${view} input, #view-${view} select`).evaluateAll((controls) => controls.filter((control) => {
        const bounds = control.getBoundingClientRect();
        if (!bounds.width || !bounds.height || control.type === 'checkbox') return false;
        return bounds.right > innerWidth + 1 || bounds.left < -1 || Number.parseFloat(getComputedStyle(control).fontSize) < 16;
      }).map((control) => control.name));
      assert.deepEqual(clipped, [], `${view} controls must fit and stay readable at ${width}px`);
      const navigationHeights = await page.locator('[data-view]').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
      assert.equal(navigationHeights.length, 3);
      assert.ok(navigationHeights.every((height) => height >= 44), 'Mobile navigation keeps usable touch targets');
    }
  });
}

test('390px overview and release comparison use the real protected Worker API with CDN unavailable', async (t) => {
  const { page, errors } = await session(t);
  await openOverview(page);
  await expect(page.locator('#view-overview')).toContainText('98.2%');
  await expect(page.locator('#view-overview')).toContainText('13 reports across 5 installs');
  await page.locator('summary').filter({ hasText: 'Compare releases' }).click();
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
  await page.locator('#issue-detail summary').filter({ hasText: 'Execution timeline' }).click();
  await expect(page.locator('#issue-detail .timeline')).toBeVisible();
  await expect(page.locator('#issue-detail')).toContainText('UI_CLICK_DOWNLOAD');
  await expect(page.locator('#issue-detail')).toContainText('429');
  await page.getByRole('button', { name: 'Copy debug context', exact: true }).click();
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
  await expect(page.locator('[data-diagnostic-issues] .issue-list .issue-row')).toHaveCount(1);
  await expect(page.locator('[data-diagnostic-issues] .issue-list')).toContainText('Download handoff');
  await expect(page.locator('[data-diagnostic-issues] .issue-count span').filter({ hasText: 'Discord' })).toHaveText('2 via Discord');
  await page.screenshot({ path: new URL('issues-desktop.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  await page.goto(`${preview.origin}/?issue=${preview.ids.network}`);
  await expect(page.locator('#issue-detail')).toContainText('<img src=x');
  assert.equal(await page.locator('#issue-detail img').count(), 0);
  assert.equal(await page.evaluate(() => window.__diagnosticsXss), undefined);
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.handoff}`);
  // The newest report is a relay copy: its source is named and its OS is not guessed.
  await expect(page.locator('#issue-detail')).toContainText('and 2 reports via Discord without an installation ID');
  await page.locator('#issue-detail summary').filter({ hasText: 'Report metadata' }).click();
  await expect(page.locator('#issue-detail').getByText('Automatic report via the Discord relay', { exact: true })).toBeVisible();
  await expect(page.locator('#issue-detail')).toContainText('OS not reported');
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
  // The overview loads its sources beside the issue deep link. Complete that
  // initial load and close the sheet before expiring the next real API request.
  await expect(page.locator('[data-growth-analytics]')).toContainText('not configured');
  await expect(page.locator('[data-growth-store]')).toContainText('4,321');
  await expect(page.locator('[data-overview-diagnostics]')).toContainText('98.2%');
  await page.getByRole('button', { name: 'Close issue details' }).click();
  await expect(page.locator('#issue-dialog')).not.toBeVisible();
  // Chromium keeps manual redirect responses opaque, while WebKit exposes the
  // 302 to Playwright. Observe the real request and the resulting auth state in
  // both engines; the preview server sends its genuine Access redirect.
  const refreshRequest = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith('/api/admin/'));
  preview.setAccessRedirect(true);
  t.after(() => preview.setAccessRedirect(false));
  await page.getByRole('button', { name: 'Refresh diagnostics' }).click();
  assert.equal((await refreshRequest).method(), 'GET');
  await expect(page.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(page.locator('#issue-detail')).toBeEmpty();
  await expect(page.locator('#view-overview')).toBeEmpty();
  assert.equal(await page.locator('#refresh-button').isDisabled(), true);
});

test('mobile session recovery reloads real logs after Access is renewed', async (t) => {
  const { page, errors } = await session(t);
  await openOverview(page);
  preview.setAuthenticated(false);
  t.after(() => preview.setAuthenticated(true));
  await page.locator('[data-view="settings"]').click();
  await expect(page.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(page.locator('#view-settings')).toBeEmpty();
  preview.setAuthenticated(true);
  await page.getByRole('button', { name: 'Check session', exact: true }).click();
  await expect(page.locator('#view-settings h1')).toHaveText('Settings');
  await expect(page.locator('#app-message')).toBeHidden();
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('#view-issues .issue-list .issue-row').first()).toBeVisible();
  await noOverflow(page);
  assert.deepEqual(errors, []);
});

test('restoring a mobile page refreshes its current reports from the Worker', async (t) => {
  const { page, errors } = await session(t);
  await openOverview(page);
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('#view-issues h1')).toHaveText('Issues');
  const loaded = page.waitForResponse((response) => response.url().includes('/api/admin/issues?') && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await loaded;
  await expect(page.locator('#view-issues .issue-list .issue-row').first()).toBeVisible();
  assert.equal(await page.locator('[data-view="issues"]').getAttribute('aria-current'), 'page');
  assert.deepEqual(errors, []);
});

test('phone Issues shows public GitHub issues and discussions independently of diagnostic filters', async (t) => {
  const { page, errors } = await session(t, 390);
  await openOverview(page);
  await page.locator('[data-view="issues"]').click();
  const github = page.locator('[data-github-issues]');
  const discussions = page.locator('[data-github-discussions]');
  await expect(github.getByRole('link', { name: /Changing the download folder/ })).toHaveAttribute('href', 'https://github.com/thomasthanos/nexusmods-bypass/issues/34');
  await expect(discussions.getByRole('link', { name: /Collection troubleshooting/ })).toHaveAttribute('href', 'https://github.com/thomasthanos/nexusmods-bypass/discussions/35');
  await expect(github).toContainText('GitHub');
  await page.locator('[data-form="issues"] [name="status"]').selectOption('ignored');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('[data-diagnostic-issues]')).toContainText('No matching issues');
  await expect(github.getByRole('link', { name: /Changing the download folder/ })).toBeVisible();
  await expect(discussions.getByRole('link', { name: /Collection troubleshooting/ })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: new URL('issues-mobile.png', screenshots).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('320px GitHub source cards fit hostile long text and reject foreign discussion links', async (t) => {
  const { page, errors } = await session(t, 320);
  const title = '<img src=x onerror=window.__githubXss=true>' + 'x'.repeat(512);
  const fetched_at = new Date().toISOString();
  await page.route('**/api/admin/github-issues', (route) => route.fulfill({ json: {
    items: [{ number: 34, title, url: 'https://github.com/thomasthanos/nexusmods-bypass/issues/34', state: 'open',
      labels: ['<script>bad</script>', 'y'.repeat(100)], updated_at: fetched_at, comments: 1 }],
    total: 1, truncated: false, fetched_at, stale: false
  } }));
  await page.route('**/api/admin/github-discussions', (route) => route.fulfill({ json: {
    items: [{ number: 35, title, url: 'https://github.com/thomasthanos/nexusmods-bypass/discussions/35', updated_at: fetched_at },
      { number: 36, title: 'Foreign discussion', url: 'https://github.com/other/repo/discussions/36', updated_at: fetched_at }],
    total: 2, fetched_at, stale: false
  } }));
  await openOverview(page);
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('[data-github-issues]')).toContainText(title);
  await expect(page.locator('[data-github-discussions]')).toContainText(title);
  assert.equal(await page.locator('[data-github-issues] img, [data-github-issues] script, [data-github-discussions] img, [data-github-discussions] script').count(), 0);
  assert.equal(await page.locator('[data-github-discussions] a[href*="other/repo"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__githubXss), undefined);
  await noOverflow(page);
  assert.deepEqual(errors, []);
});

test('mobile Refresh advances the default UTC window after midnight and loads newly arrived issues', async (t) => {
  const { page, context, errors } = await session(t);
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  await context.addInitScript(({ day }) => { let current = day - 60_000; Date.now = () => current; window.advanceDiagnosticsClock = () => { current = day + 60_000; }; }, { day });
  await openOverview(page);
  await page.locator('[data-view="issues"]').click();
  await expect(page.locator('[data-diagnostic-issues]')).toContainText('No matching issues');
  await page.evaluate(() => window.advanceDiagnosticsClock());
  const updated = page.waitForResponse((response) => response.url().includes('/api/admin/issues?') && response.status() === 200);
  await page.getByRole('button', { name: 'Refresh diagnostics' }).click();
  await updated;
  await expect(page.locator('[data-diagnostic-issues] .issue-row').first()).toBeVisible();
  await expect(page.locator('[data-form="issues"] [name="to"]')).toHaveValue(new Date(day).toISOString().slice(0, 10));
  assert.deepEqual(errors, []);
});

test('stale mobile sheet preserves a new regression and shows copy feedback inside the native modal', async (t) => {
  const { page, context } = await session(t);
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() {} } }));
  preview.db.sqlite.prepare("UPDATE issues SET status='fixed',fixed_in_version='3.2.0',muted=0 WHERE id=?").run(preview.ids.handoff);
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-title')).toHaveText(`Issue #${preview.ids.handoff}`);
  await page.getByRole('button', { name: 'Copy debug context', exact: true }).click();
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
  // A relay copy as the newest report: its source, OS and installation lines fit as well.
  await page.goto(`${preview.origin}/?issue=${preview.ids.handoff}`);
  await expect(page.locator('#issue-detail')).toContainText('and 2 reports via Discord without an installation ID');
  await expect(page.locator('#issue-detail')).toContainText('OS not reported');
  assert.equal(await page.locator('#issue-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
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
