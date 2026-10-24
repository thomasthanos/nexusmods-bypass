import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, expect } from '@playwright/test';
import { startPreviewServer } from '../helpers/preview-server.mjs';

const engineName = process.env.NXTK_DIAGNOSTICS_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engineName), 'Choose a supported diagnostics browser');
const screenshots = new URL(`../../.wrangler/browser-qa/${engineName}/ux/`, import.meta.url);
let preview; let browser;

before(async () => {
  preview = await startPreviewServer();
  browser = await ({ chromium, webkit })[engineName].launch({ headless: true });
  await mkdir(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); await preview?.close(); });

async function session(t, width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1,
    ...(engineName === 'webkit' ? { serviceWorkers: 'block' } : {}) });
  t.after(() => context.close());
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { page, errors };
}

async function fitsViewport(page, scope, mobile) {
  const geometry = await page.locator(scope).evaluate((root, checkTouch) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const controls = [...root.querySelectorAll('button, a.button, input, select, textarea, summary')].filter(visible);
    const issues = controls.flatMap((control) => {
      const hitArea = control.matches('input[type="checkbox"], input[type="radio"]') ? control.closest('label') ?? control : control;
      const rect = hitArea.getBoundingClientRect();
      const label = control.getAttribute('aria-label') || control.name || control.textContent.trim().slice(0, 60);
      const problems = [];
      if (rect.left < -1 || rect.right > innerWidth + 1) problems.push('outside viewport');
      if (checkTouch && (rect.width < 44 || rect.height < 44)) problems.push(`touch target ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`);
      if (checkTouch && control.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea') && Number.parseFloat(getComputedStyle(control).fontSize) < 16) problems.push('form text below 16px');
      return problems.map((problem) => `${label}: ${problem}`);
    });
    return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, issues,
      ...(root.matches('dialog') ? { dialogWidth: root.clientWidth, dialogScroll: root.scrollWidth } : {}) };
  }, mobile);
  assert.ok(geometry.scroll <= geometry.viewport, `page must fit: ${JSON.stringify(geometry)}`);
  if ('dialogWidth' in geometry) assert.ok(geometry.dialogScroll <= geometry.dialogWidth, `sheet must fit: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.issues, [], `${scope} controls must be readable and reachable`);
}

async function exerciseDisclosures(page, scope) {
  const summaries = page.locator(`${scope} summary`);
  for (let index = 0; index < await summaries.count(); index++) {
    const summary = summaries.nth(index);
    // Parent disclosures are opened as we walk the document, making nested
    // evidence reachable through the same keyboard interaction a user has.
    if (!await summary.isVisible()) continue;
    await summary.focus();
    const initiallyOpen = await summary.evaluate((element) => element.parentElement.open);
    await summary.press('Space');
    await expect.poll(() => summary.evaluate((element) => element.parentElement.open)).toBe(!initiallyOpen);
    await expect(summary).toBeFocused();
    await summary.press('Enter');
    await expect.poll(() => summary.evaluate((element) => element.parentElement.open)).toBe(initiallyOpen);
    if (!initiallyOpen) await summary.press('Enter');
  }
}

async function screenshot(page, name, modal = false) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (modal) await page.locator('#issue-dialog').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: fileURLToPath(new URL(name, screenshots)), fullPage: !modal });
}

for (const width of [320, 390, 430, 1280]) {
  test(`all views and the issue sheet support keyboard and fit ${width}px`, { timeout: 60_000 }, async (t) => {
    const { page, errors } = await session(t, width);
    await page.goto(preview.origin);
    await expect(page.locator('[data-overview-diagnostics]')).toContainText('98.2%');
    await expect(page.locator('[data-growth-store]')).toContainText('4,321');
    for (const view of ['overview', 'issues', 'settings']) {
      const navigation = page.locator(`[data-view="${view}"]`);
      await navigation.focus(); await navigation.press('Enter');
      await expect(page.locator(`#view-${view} h1`)).toHaveText(view[0].toUpperCase() + view.slice(1));
      await expect(navigation).toHaveAttribute('aria-current', 'page');
      await expect(navigation).toBeFocused();
      assert.equal(await page.locator('.view:visible').count(), 1, 'Only the selected view is shown');
      await expect(page.locator(`#view-${view} [aria-busy="true"]`)).toHaveCount(0);
      if (view === 'settings') await expect(page.locator('[data-push-action="refresh"]')).toBeEnabled();
      await fitsViewport(page, '#view-' + view, width < 600);
      await fitsViewport(page, '.app-nav', width < 600);
      await screenshot(page, `${view}-${width}.png`);
      await exerciseDisclosures(page, '#view-' + view);
      await fitsViewport(page, '#view-' + view, width < 600);
    }
    await page.locator('[data-view="issues"]').press('Enter');
    const launcher = page.locator('[data-diagnostic-issues] .issue-row').filter({ hasText: 'COLLECTION_HOST_MISSING' });
    await launcher.focus(); await launcher.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#issue-detail')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-form="lifecycle"]')).toHaveCount(1);
    await expect(page.locator('#issue-detail [aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('#issue-title')).toHaveText(/Issue #\d+/);
    await fitsViewport(page, '#issue-dialog', width < 600);
    await screenshot(page, `issue-${width}.png`, true);
    await exerciseDisclosures(page, '#issue-dialog');
    await fitsViewport(page, '#issue-dialog', width < 600);
    await expect(page.locator('#issue-dialog .timeline')).toBeVisible();
    await page.locator('#issue-dialog .timeline').scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL(`issue-evidence-${width}.png`, screenshots)), fullPage: false });
    const close = page.getByRole('button', { name: 'Close issue details' });
    await close.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#issue-dialog').contains(document.activeElement)), true, 'Keyboard focus stays inside the modal');
    await page.keyboard.press('Tab'); await expect(close).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await expect(launcher).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.has('issue'), false);
    assert.deepEqual(errors, []);
  });
}
