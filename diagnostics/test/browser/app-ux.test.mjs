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
    isMobile: width < 600, hasTouch: width < 600,
    ...(engineName === 'webkit' ? { serviceWorkers: 'block' } : {}) });
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.diagnosticsCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.diagnosticsCspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
    });
  });
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
  await page.evaluate((isModal) => {
    document.activeElement?.blur();
    if (!isModal) { document.querySelector('#main-content').scrollTop = 0; window.scrollTo(0, 0); }
  }, modal);
  if (modal) await page.locator('#issue-dialog').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: fileURLToPath(new URL(name, screenshots)), fullPage: !modal });
}

async function noPolicyViolations(page, view) {
  assert.deepEqual(await page.evaluate(() => window.diagnosticsCspViolations), [], `${view} must render under the production content security policy`);
}

async function mobileScrollLayout(page, view) {
  const initial = await page.evaluate(() => {
    const main = document.querySelector('#main-content'); const nav = document.querySelector('.app-nav');
    const header = document.querySelector('.app-header'); const bounds = main.getBoundingClientRect(); const navigation = nav.getBoundingClientRect();
    const safeArea = document.createElement('div'); safeArea.style.paddingBottom = 'env(safe-area-inset-bottom)'; document.body.append(safeArea);
    const safeBottom = Number.parseFloat(getComputedStyle(safeArea).paddingBottom); safeArea.remove();
    return { main: { top: bounds.top, bottom: bounds.bottom }, nav: { top: navigation.top, bottom: navigation.bottom },
      viewport: visualViewport?.height ?? innerHeight, safeBottom, overflow: getComputedStyle(main).overflowY,
      headerFilter: getComputedStyle(header).backdropFilter || getComputedStyle(header).webkitBackdropFilter,
      maxScroll: Math.max(document.documentElement.scrollHeight - innerHeight, main.scrollHeight - main.clientHeight) };
  });
  assert.ok(initial.nav.top > 0, `${view} navigation stays within viewport`);
  assert.ok(initial.nav.bottom <= initial.viewport - initial.safeBottom, `${view} navigation remains inside the safe viewport: ${JSON.stringify(initial)}`);
  assert.ok(initial.viewport - initial.safeBottom - initial.nav.bottom <= 14, `${view} navigation stays near the safe bottom edge: ${JSON.stringify(initial)}`);
  assert.equal(initial.headerFilter, 'none', 'The mobile header stays sharp without backdrop blur');
  assert.ok(initial.maxScroll > 0, `${view} fixture exercises a scrollable view`);
  for (const progress of [0, 0.5, 1]) {
    await page.evaluate((fraction) => {
      const main = document.querySelector('#main-content');
      const maxDoc = document.documentElement.scrollHeight - window.innerHeight;
      const maxMain = main.scrollHeight - main.clientHeight;
      if (maxDoc > 0) window.scrollTo(0, maxDoc * fraction);
      if (maxMain > 0) main.scrollTop = maxMain * fraction;
    }, progress);
    const current = await page.evaluate(() => {
      const main = document.querySelector('#main-content'); const nav = document.querySelector('.app-nav'); const bounds = nav.getBoundingClientRect();
      const navHit = document.elementFromPoint(innerWidth / 2, bounds.top + bounds.height / 2);
      const viewEl = main.querySelector('.view:not([hidden])');
      const lastChild = viewEl?.lastElementChild?.getBoundingClientRect() ?? { bottom: 0 };
      return { top: bounds.top, bottom: bounds.bottom, windowScroll: scrollY,
        navHit: nav.contains(navHit),
        lastChildBottom: lastChild.bottom,
        contentBottom: viewEl?.getBoundingClientRect().bottom ?? 0, mainBottom: main.getBoundingClientRect().bottom };
    });
    assert.deepEqual({ top: current.top, bottom: current.bottom }, initial.nav, `${view} navigation does not move when content scrolls`);
    assert.equal(current.navHit, true, `${view} navigation stays reachable at every scroll position`);
    if (progress === 1) assert.ok(current.lastChildBottom <= current.top + 30, `${view} final content remains above the navigation when scrolled to the end`);
    if (page.viewportSize().width === 390 && progress > 0) await page.screenshot({ path: fileURLToPath(new URL(`${view}-390-${progress === 1 ? 'bottom' : 'middle'}.png`, screenshots)), fullPage: false });
  }
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
      if (width < 600) {
        assert.ok(await page.evaluate(() => window.scrollY <= 1 && (document.querySelector('#main-content')?.scrollTop ?? 0) <= 1), `${view} opens at the top of its content`);
        await expect(page.locator(`#view-${view} h1`)).toBeInViewport();
      }
      assert.equal(await page.locator('.view:visible').count(), 1, 'Only the selected view is shown');
      await expect(page.locator(`#view-${view} [aria-busy="true"]`)).toHaveCount(0);
      if (view === 'settings') await expect(page.locator('[data-push-action="refresh"]')).toBeEnabled();
      await fitsViewport(page, '#view-' + view, width < 600);
      await fitsViewport(page, '.app-nav', width < 600);
      await screenshot(page, `${view}-${width}.png`);
      await exerciseDisclosures(page, '#view-' + view);
      await fitsViewport(page, '#view-' + view, width < 600);
      await noPolicyViolations(page, view);
      if (width < 600) await mobileScrollLayout(page, view);
    }
    await page.locator('[data-view="issues"]').press('Enter');
    const launcher = page.locator('[data-diagnostic-issues] .issue-row').filter({ hasText: 'COLLECTION_HOST_MISSING' });
    await launcher.scrollIntoViewIfNeeded(); await launcher.focus(); await expect(launcher).toBeInViewport();
    const scrollBeforeIssue = await page.evaluate(() => Math.max(window.scrollY, document.querySelector('#main-content')?.scrollTop ?? 0));
    await launcher.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#issue-detail')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-form="lifecycle"]')).toHaveCount(1);
    await expect(page.locator('#issue-detail [aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('#issue-title')).toHaveText(/Issue #\d+/);
    await fitsViewport(page, '#issue-dialog', width < 600);
    await screenshot(page, `issue-${width}.png`, true);
    await noPolicyViolations(page, 'issue sheet');
    await exerciseDisclosures(page, '#issue-dialog');
    await fitsViewport(page, '#issue-dialog', width < 600);
    await expect(page.locator('#issue-dialog .timeline')).toBeVisible();
    await page.locator('#issue-dialog .timeline').scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL(`issue-evidence-${width}.png`, screenshots)), fullPage: false });
    await noPolicyViolations(page, 'expanded issue evidence');
    const close = page.getByRole('button', { name: 'Close issue details' });
    await close.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#issue-dialog').contains(document.activeElement)), true, 'Keyboard focus stays inside the modal');
    await page.keyboard.press('Tab'); await expect(close).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await expect(launcher).toBeFocused();
    await expect(launcher).toBeInViewport();
    const scrollAfterIssue = await page.evaluate(() => Math.max(window.scrollY, document.querySelector('#main-content')?.scrollTop ?? 0));
    assert.equal(scrollAfterIssue, scrollBeforeIssue, 'Closing issue details preserves the underlying reading position');
    assert.equal(new URL(page.url()).searchParams.has('issue'), false);
    assert.deepEqual(errors, []);
  });
}

for (const width of [320, 402]) test(`phone tab bar clears content and every release value stays visible at ${width}px`, async (t) => {
  const { page, errors } = await session(t, width);
  await page.goto(preview.origin);
  const rows = page.locator('[data-release-list] .release-row');
  await expect(rows).toHaveCount(3);
  // Each release keeps its version plus attempts, success, fallback and heartbeats, unclipped.
  const clipped = await rows.evaluateAll((items) => items.flatMap((row) => [row.querySelector('.release-version'), ...row.querySelectorAll('dd')].map((cell) => {
    const rect = cell.getBoundingClientRect();
    return { text: cell.textContent, ok: rect.width > 0 && cell.scrollWidth <= cell.clientWidth + 1 && rect.right <= innerWidth };
  })));
  assert.equal(clipped.length, 15);
  assert.deepEqual(clipped.filter((cell) => !cell.ok), []);
  const nav = page.locator('.app-nav');
  const geometry = await nav.evaluate((element) => ({ position: getComputedStyle(element).position, bottom: element.getBoundingClientRect().bottom, height: element.getBoundingClientRect().height, viewport: innerHeight }));
  assert.equal(geometry.position, 'fixed');
  assert.ok(geometry.bottom <= geometry.viewport - 10 && geometry.height <= 60, JSON.stringify(geometry));
  // At the end of the page the last card sits fully above the floating tab bar.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const overlap = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#view-overview .panel')];
    return cards.at(-1).getBoundingClientRect().bottom - document.querySelector('.app-nav').getBoundingClientRect().top;
  });
  assert.ok(overlap <= 0, `last card overlaps the tab bar by ${overlap}px`);
  assert.deepEqual(errors, []);
});
