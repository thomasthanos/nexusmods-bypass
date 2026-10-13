/* global window, getComputedStyle */
// Layout checks for every piece of UI the extension draws, at four screen sizes and three browser zoom
// levels. Browser zoom Z on a W×H screen is emulated as a W/Z × H/Z CSS viewport at device scale Z,
// which is what the page actually sees. Pages are local fixtures served for www.nexusmods.com, so the
// real content scripts run; the collection API answer is canned. Screenshots go to test-results/visual.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.join(root, 'src');
const fixture = (name) => fs.readFileSync(path.join(root, 'tools/fixtures', name), 'utf8');
const shotDir = path.join(root, 'test-results', 'visual');
fs.mkdirSync(shotDir, { recursive: true });

const SCREENS = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720]];
const ZOOMS = [1, 1.25, 1.5];

function collectionAnswer() {
  const modFiles = Array.from({ length: 40 }, (_, i) => ({
    fileId: 1000 + i,
    optional: i % 5 === 0,
    file: {
      fileId: 1000 + i, name: `Example file with a fairly long name number ${i + 1}.7z`, uri: `f${i}.7z`,
      size: 1024 * (i + 1) * 37, version: '1.0', date: 1700000000,
      mod: { adult: false, modId: 500 + i, name: `Example Mod ${i + 1} — Extended Edition`, version: '1.0', game: { domainName: 'skyrimspecialedition', id: 1704 } }
    },
    updatePolicy: i % 3 === 0 ? 'latest' : 'exact',
    version: '1.0'
  }));
  return { data: { collectionRevision: { revisionNumber: 3, revisionStatus: 'published', latest: false, externalResources: [], modFiles } } };
}

// The official v2 API (src/content/nexus-api.js), answered per operation.
function officialAnswer(body) {
  const op = body?.operationName;
  if (op === 'CollectionRevisionMods') return collectionAnswer();
  if (op === 'CollectionRevisions') {
    return { data: { collection: { revisions: [3, 4].map((n) => ({ revisionNumber: n, revisionStatus: 'published', latest: n === 4, totalSize: 1, modCount: 40, createdAt: '2026-01-01T00:00:00Z' })) } } };
  }
  if (op === 'ModsByDomain') {
    return { data: { legacyModsByDomain: { nodes: (body.variables.ids || []).map(({ modId }) => ({
      uid: String(7000000 + modId), modId, name: 'x', version: '2.0', viewerEndorsed: modId % 2 === 0, viewerTracked: false,
      game: { domainName: 'skyrimspecialedition', id: 1704 }
    })) } } };
  }
  if (op === 'GameId') return { data: { game: { id: 1704, domainName: 'skyrimspecialedition' } } };
  if (op === 'ModFiles') return { data: { modFiles: [] } };
  return { data: null, errors: [{ message: `unexpected ${op}` }] };
}

async function launchContext({ dir = extensionDir, userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-visual-')) } = {}) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.NXTK_PLAYWRIGHT_CHANNEL || 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
  });
  await ctx.route('https://www.nexusmods.com/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
    const html = url.pathname.includes('/collections/') ? fixture('visual-collection-page.html') : fixture('visual-mod-page.html');
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await ctx.route('https://api-router.nexusmods.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(collectionAnswer()),
    headers: { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true' }
  }));
  await ctx.route('https://api.nexusmods.com/v2/graphql', (route) => {
    const cors = { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = null; }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(officialAnswer(body)) });
  });
  await ctx.route(/^(?!https:\/\/(www|api-router|api)\.nexusmods\.com)https?:\/\//, (route) => route.abort());
  // Skip the onboarding tab opened on install.
  await new Promise((r) => setTimeout(r, 1000));
  for (const page of ctx.pages()) if (page.url().includes('onboarding')) await page.close();
  return ctx;
}

let context;
test.beforeAll(async () => {
  context = await launchContext();
});
test.afterAll(async () => { await context?.close(); });

async function openPage(url, width, height, zoom) {
  const page = await context.newPage();
  await page.setViewportSize({ width: Math.round(width / zoom), height: Math.round(height / zoom) });
  await page.goto(url);
  return page;
}

// No horizontal scrollbar, and every box of the given selector sits fully inside the viewport.
async function assertFits(page, selector, label) {
  const result = await page.evaluate((sel) => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const overflowX = document.documentElement.scrollWidth - vw;
    const boxes = Array.from(document.querySelectorAll(sel)).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    });
    return { vw, vh, overflowX, boxes };
  }, selector);
  expect(result.overflowX, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(1);
  expect(result.boxes.length, `${label}: ${selector} not found`).toBeGreaterThan(0);
  for (const b of result.boxes) {
    expect(b.left, `${label}: left edge clipped`).toBeGreaterThanOrEqual(-1);
    expect(b.right, `${label}: right edge clipped`).toBeLessThanOrEqual(result.vw + 1);
    if (selector !== '.nxtk-deck') {
      expect(b.top, `${label}: top clipped`).toBeGreaterThanOrEqual(-1);
      expect(b.bottom, `${label}: bottom clipped`).toBeLessThanOrEqual(result.vh + 1);
    }
  }
  return result;
}

for (const [w, h] of SCREENS) {
  for (const zoom of ZOOMS) {
    const tag = `${w}x${h}@${Math.round(zoom * 100)}`;

    test(`settings button and modal fit at ${tag}`, async () => {
      const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', w, h, zoom);
      const fab = page.locator('#nxtk-settings-fab');
      await expect(fab).toBeVisible({ timeout: 20000 });
      await assertFits(page, '#nxtk-settings-fab', `${tag} FAB`);
      const fabBox = await fab.boundingBox();
      expect(Math.min(fabBox.width, fabBox.height), 'FAB is a usable touch target').toBeGreaterThanOrEqual(36);
      await fab.click();
      const modal = page.locator('.nxtk-modal').first();
      await expect(modal).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(600);
      await assertFits(page, '.nxtk-modal', `${tag} settings modal`);
      // The modal's content must be reachable: it scrolls inside itself, not the page.
      const scrolls = await modal.evaluate((el) => {
        const inner = el.querySelector('.nxtk-modal-scroll') || el;
        return inner.scrollHeight <= inner.clientHeight + 1 || ['auto', 'scroll'].includes(getComputedStyle(inner).overflowY);
      });
      expect(scrolls, `${tag}: settings content is not reachable`).toBe(true);
      await page.screenshot({ path: path.join(shotDir, `settings-${tag}.png`) });
      await page.close();
    });

    test(`collection deck and mod picker fit at ${tag}`, async () => {
      const page = await openPage('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123', w, h, zoom);
      const deck = page.locator('#nxtk-control-deck');
      await expect(deck).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(800);
      await assertFits(page, '.nxtk-deck', `${tag} deck`);
      // Official API: newer published revision badge.
      await expect(deck.locator('.nxtk-badge-new')).toBeVisible({ timeout: 10000 });
      await assertFits(page, '.nxtk-badge-new', `${tag} new-revision badge`);
      await page.screenshot({ path: path.join(shotDir, `deck-${tag}.png`), fullPage: true });
      // The mod picker: split-button menu → "Select mods".
      await deck.locator('#nxtk-menu-toggle').click();
      await page.locator('#nxtk-select-mods').click({ timeout: 10000 });
      const modal = page.locator('.nxtk-modal').first();
      await expect(modal).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(600);
      await assertFits(page, '.nxtk-modal', `${tag} mod picker`);
      // Update badges and endorse/track buttons from the batched details, inside each row.
      await expect(modal.locator('.nxtk-tag-update').first()).toBeVisible({ timeout: 10000 });
      await expect(modal.locator('[data-mod-action="endorse"]').first()).toBeVisible();
      const rowsFit = await modal.evaluate((el) => Array.from(el.querySelectorAll('.nxtk-mod-item')).slice(0, 10).every((row) => {
        const r = row.getBoundingClientRect();
        return Array.from(row.querySelectorAll('.nxtk-mini-btn, .nxtk-tag-update')).every((b) => {
          const q = b.getBoundingClientRect();
          return q.left >= r.left - 1 && q.right <= r.right + 1;
        });
      }));
      expect(rowsFit, `${tag}: row extras overflow their row`).toBe(true);
      // A click on a row button must not toggle the row's selection.
      const firstRow = modal.locator('.nxtk-mod-item').filter({ has: page.locator('[data-mod-action]') }).first();
      const selectedBefore = await firstRow.evaluate((row) => row.classList.contains('nxtk-selected'));
      await page.route('https://api.nexusmods.com/v2/graphql', (route) => route.fulfill({
        status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ data: { createModEndorsement: { success: true }, abstainFromModEndorsement: { success: true }, trackMod: { success: true } } })
      }));
      await firstRow.locator('[data-mod-action^="track"]').click();
      await expect(firstRow.locator('[data-mod-action="untrack"]')).toBeVisible({ timeout: 5000 });
      expect(await firstRow.evaluate((row) => row.classList.contains('nxtk-selected'))).toBe(selectedBefore);
      await page.screenshot({ path: path.join(shotDir, `picker-${tag}.png`) });
      await page.close();
    });
  }
}

test('popup and onboarding pages do not overflow', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  for (const [name, file, vw, vh] of [
    ['popup', 'popup/popup.html', 380, 600],
    ['onboarding-720p-150', 'onboarding/welcome.html', 853, 480],
    ['onboarding-4k', 'onboarding/welcome.html', 3840, 2160]
  ]) {
    const page = await context.newPage();
    await page.setViewportSize({ width: vw, height: vh });
    await page.goto(`chrome-extension://${id}/${file}`);
    await page.waitForTimeout(500);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX, `${name} scrolls horizontally`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
    await page.close();
  }
});

test('page-change notice fits at 1280x720@150 and 3840x2160', async () => {
  for (const [w, h, zoom] of [[1280, 720, 1.5], [3840, 2160, 1]]) {
    // A file page with no download control makes the page check raise its notice.
    const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1?tab=files&file_id=42', w, h, zoom);
    await expect(page.locator('.nxtk-notice-toast')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500);
    await assertFits(page, '.nxtk-notice-toast', `notice ${w}x${h}@${zoom * 100}`);
    await page.screenshot({ path: path.join(shotDir, `notice-${w}x${h}@${Math.round(zoom * 100)}.png`) });
    await page.close();
  }
});

test('report page: connection failures keep the description and show a retry and GitHub fallback', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${id}/report-page/report.html`);
  await page.waitForTimeout(500);
  const configured = await page.evaluate(() => globalThis.NXTK.RELAY_CONFIGURED);
  if (!configured) {
    await expect(page.locator('#rpSend')).toBeDisabled();
    await expect(page.locator('#rpStatus')).toContainText(/not set up/i);
    await expect(page.locator('#rpGithub')).toHaveClass(/rp-primary/);
  }
  // A send that fails shows the cause, the fallback and (when it can help) a retry.
  await page.evaluate(() => {
    globalThis.NXTK.RELAY_CONFIGURED = true;
    globalThis.NXTK.checkRelayHealth = async () => ({ ok: false, reason: 'unreachable' });
    globalThis.chrome.permissions.contains = async () => true;
    globalThis.chrome.permissions.request = async () => true;
    document.getElementById('rpSend').disabled = false;
  });
  await page.locator('#rpSummary').fill('Download never starts');
  await page.click('#rpSend');
  await expect(page.locator('#rpStatus')).toContainText(/could not be reached/i);
  await expect(page.locator('#rpFallback')).toBeVisible();
  await expect(page.locator('#rpRetry')).toBeVisible();
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowX).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(shotDir, 'report-fallback.png'), fullPage: true });
  await page.close();
});

test('report workspace: preview, validation, redaction, one send and JSON export', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`chrome-extension://${id}/report-page/report.html`);
  await page.waitForFunction(() => document.getElementById('rpPreview').textContent.includes('schema'));
  await page.click('#rpSend');
  await expect(page.locator('#rpStatus')).toContainText(/summary or describe/i);
  await expect(page.locator('#rpSummary')).toBeFocused();
  await page.locator('#rpSummary').fill('Vortex does not open');
  await page.locator('#rpNote').fill('The download button says ready, but Vortex does not open. My token=private is redacted.');
  await page.locator('input[value="vortex"]').check({ force: true });
  await page.locator('.rp-reproduction summary').click();
  await page.locator('#rpSteps').fill('1. Open a mod\n2. Click Mod manager download');
  await page.locator('#rpExpected').fill('Vortex opens the selected file.');
  await page.locator('#rpContact').fill('bad-email');
  await page.click('#rpSend');
  await expect(page.locator('#rpStatus')).toContainText(/valid e-mail/i);
  await page.locator('#rpContact').fill('reply@example.com');
  await page.click('#rpJsonTab');
  await expect(page.locator('#rpPreview')).toContainText('Vortex opens the selected file.');
  const preview = JSON.parse(await page.locator('#rpPreview').textContent());
  expect(preview.category).toBe('vortex');
  expect(preview.note).not.toContain('private');
  expect(preview.contact).toBe('reply@example.com');
  await page.locator('#rpJsonTab').press('ArrowLeft');
  await expect(page.locator('#rpSummaryTab')).toBeFocused();
  await expect(page.locator('#rpOverview')).toBeVisible();
  await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(shotDir, 'report-workspace.png'), fullPage: true });
  await page.evaluate(() => {
    window.reportTestCalls = [];
    globalThis.NXTK.checkRelayHealth = async () => ({ ok: true });
    globalThis.chrome.permissions.contains = async () => true;
    globalThis.chrome.permissions.request = async () => true;
    globalThis.NXTK.sendReportPayload = async (payload) => {
      window.reportTestCalls.push(payload);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ok: true, id: 'test-reference' };
    };
  });
  await page.click('#rpSend');
  await expect(page.locator('#rpSuccess')).toBeVisible();
  await expect(page.locator('#rpReference')).toHaveText('test-reference');
  await expect(page.locator('#rpSend')).toBeDisabled();
  const sent = await page.evaluate(() => window.reportTestCalls);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual(preview);
  await page.screenshot({ path: path.join(shotDir, 'report-success.png'), fullPage: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#rpSave')]);
  const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(saved.summary).toBe(preview.summary);
  expect(saved.steps).toBe(preview.steps);
  await page.close();
});

test('report workspace: responsive layout and Greek text fit without overflow', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/report-page/report.html`);
  await page.locator('#rpSummary').fill('Download stops after the Nexus verification');
  for (const [width, height] of [[1920, 1080], [853, 480], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}: report workspace overflows`).toBeLessThanOrEqual(1);
    await expect(page.locator('#rpSend')).toBeVisible();
    await page.screenshot({ path: path.join(shotDir, `report-${width}.png`), fullPage: true });
  }
  const greek = JSON.parse(fs.readFileSync(path.join(extensionDir, '_locales/el/messages.json'), 'utf8'));
  await page.evaluate((messages) => {
    globalThis.chrome.i18n.getMessage = key => messages[key]?.message || '';
    globalThis.NXTK.setForceEnglish(false);
    globalThis.NXTK.applyI18nTo(document);
    document.documentElement.lang = 'el';
  }, greek);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect(page.locator('#rpDetailsTitle')).toHaveText('Περιγραφή προβλήματος');
  await page.screenshot({ path: path.join(shotDir, 'report-greek.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.close();
});

test('debug log page: live view, level filter, safe text, clear and no overflow', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`chrome-extension://${id}/debug-page/debug.html`);
  await page.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.set({ nxtk_debug_log: [
    { at: Date.now(), level: 'info', page: 'mod', text: 'hello <img src=x onerror=alert(1)>' },
    { at: Date.now(), level: 'error', page: 'worker', text: 'request_failed 503' }
  ] }, r)));
  await expect(page.locator('.db-row')).toHaveCount(2);
  await expect(page.locator('.db-log img')).toHaveCount(0);
  await page.selectOption('#dbLevelFilter', 'error');
  await expect(page.locator('.db-row')).toHaveCount(1);
  await page.selectOption('#dbLevelFilter', 'all');
  // Live: a new entry written by the background appears without reloading.
  await page.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_debug_log', (o) => globalThis.chrome.storage.local.set({ nxtk_debug_log: [...o.nxtk_debug_log, { at: Date.now(), level: 'warn', page: 'mod', text: 'later' }] }, r))));
  await expect(page.locator('.db-row')).toHaveCount(3);
  await page.fill('#dbSearch', 'later');
  await expect(page.locator('.db-row')).toHaveCount(1);
  await page.fill('#dbSearch', '');
  const download = page.waitForEvent('download');
  await page.click('#dbExportJson');
  expect((await download).suggestedFilename()).toMatch(/^nexusmods-bypass-debug-.*\.json$/);
  for (const [w, h] of [[720, 1280], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width: w, height: h });
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX, `debug page ${w}x${h} scrolls horizontally`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(shotDir, `debug-${w}x${h}.png`) });
  }
  page.once('dialog', (d) => d.accept());
  await page.click('#dbClear');
  await expect(page.locator('.db-row')).toHaveCount(0);
  await expect(page.locator('#dbEmpty')).toBeVisible();
  await page.close();
});

test('report send requests the relay permission synchronously inside the click, once', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/report-page/report.html`);
  await page.waitForFunction(() => document.getElementById('rpPreview').textContent.includes('schema'));
  const expected = await page.evaluate(async () => {
    const manifest = globalThis.chrome.runtime.getManifest();
    window.permCalls = [];
    window.sends = 0;
    let grant = false;
    // True only for the rest of the click's task: an await on a browser API before request() ends it,
    // and that is exactly what loses the extension user-gesture token in Chrome.
    document.addEventListener('click', () => { window.inClick = true; setTimeout(() => { window.inClick = false; }, 0); }, true);
    globalThis.chrome.permissions.request = (perm) => {
      // userActivation.isActive is only true while the click's gesture is still usable.
      window.permCalls.push({ origins: perm.origins, active: navigator.userActivation.isActive, sameTask: window.inClick === true, frozen: Object.isFrozen(perm.origins) });
      grant = window.permCalls.length > 1;
      return Promise.resolve(grant);
    };
    globalThis.NXTK.checkRelayHealth = async () => ({ ok: true });
    globalThis.NXTK.sendReportPayload = async () => { window.sends += 1; return { ok: false, reason: 'server_error' }; };
    return manifest.optional_host_permissions;
  });
  await page.locator('#rpSummary').fill('Permission test');
  await page.click('#rpSend');
  await expect(page.locator('#rpStatus, #rpFailure').first()).toBeVisible();
  let calls = await page.evaluate(() => window.permCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].active, 'request() ran while the user gesture was active').toBe(true);
  expect(calls[0].sameTask, 'request() ran in the same task as the click (no await before it)').toBe(true);
  expect(calls[0].origins).toEqual(expected);
  expect(calls[0].frozen).toBe(false);
  expect(await page.evaluate(() => window.sends)).toBe(0);
  // Granted on the second try: it sends; a third click after the grant skips the prompt.
  await page.click('#rpSend');
  await expect.poll(() => page.evaluate(() => window.sends)).toBe(1);
  await page.click('#rpSend');
  await expect.poll(() => page.evaluate(() => window.sends)).toBe(2);
  calls = await page.evaluate(() => window.permCalls);
  expect(calls).toHaveLength(2);
  await page.close();
});

test('every page shows the manifest version, and the debug page can turn logging on', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  for (const [file, sel] of [['popup/popup.html', '.popup-version'], ['report-page/report.html', '#rpVersion'], ['debug-page/debug.html', '#dbVersion']]) {
    await page.goto(`chrome-extension://${id}/${file}`);
    const version = await page.evaluate(() => globalThis.chrome.runtime.getManifest().version);
    await expect(page.locator(sel)).toHaveText(`v${version}`);
  }
  await page.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_settings', (o) => globalThis.chrome.storage.local.set({ nxtk_settings: { ...(o.nxtk_settings || {}), DebugLogs: false } }, r))));
  await page.reload();
  await expect(page.locator('#dbOff')).toBeVisible();
  await page.click('#dbEnable');
  await expect(page.locator('#dbOff')).toBeHidden();
  expect(await page.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_settings', (o) => r(o.nxtk_settings.DebugLogs))))).toBe(true);
  await page.close();
});

test('popup controls and help: raised actions, compact layout, sentence case, tooltips', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  for (const width of [380]) { // the popup body is a fixed 380px
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`chrome-extension://${id}/popup/popup.html`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#openSettings')).toBeVisible();
    await page.screenshot({ path: path.join(shotDir, `popup-controls-${width}.png`) });
    for (const sel of ['#openSettings', '#goToNexus']) {
      const surface = await page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { background: cs.backgroundImage, shadow: cs.boxShadow };
      });
      expect(surface.background, `${sel} has a lit surface`).toContain('linear-gradient');
      expect(surface.shadow, `${sel} has depth`).not.toBe('none');
    }
    await page.click('#tabHelp');
    const primary = page.locator('#sendReport');
    await expect(primary).toBeVisible();
    const style = await primary.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, transform: cs.textTransform, color: cs.color, h: el.getBoundingClientRect().height };
    });
    expect(style.opacity).toBe('1');
    expect(style.transform).toBe('none');
    expect(style.color).toBe('rgb(29, 20, 9)');
    const boxes = await Promise.all(['#reportBug', '#openDebugLog'].map((sel) => page.locator(sel).boundingBox()));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(1);
    expect(Math.abs(boxes[0].height - style.h)).toBeLessThan(1);
    expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
    for (const sel of ['#sendReport', '#reportBug', '#openDebugLog']) {
      expect((await page.locator(sel).getAttribute('title')) || '').not.toBe('');
      const surface = await page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { background: cs.backgroundImage, shadow: cs.boxShadow };
      });
      expect(surface.background, `${sel} has a lit surface`).toContain('linear-gradient');
      expect(surface.shadow, `${sel} has depth`).not.toBe('none');
      const overflow = await page.locator(sel).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(shotDir, `popup-help-${width}.png`) });
    await page.close();
  }
});

test('popup raised actions retain keyboard focus and reduced-motion press feedback', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await page.locator('#tabControls').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tabHelp')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(page.locator('#sendReport')).toBeFocused();
  for (const sel of ['#sendReport', '#reportBug', '#openDebugLog']) {
    const button = page.locator(sel);
    await expect(button).toBeFocused();
    expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await button.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(2);
    const position = await button.boundingBox();
    await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2);
    const raisedShadow = await button.evaluate((el) => getComputedStyle(el).boxShadow);
    await page.mouse.down();
    const pressedShadow = await button.evaluate((el) => getComputedStyle(el).boxShadow);
    // Release outside the button: check feedback without sending reports or opening tabs.
    await page.mouse.move(1, 1);
    await page.mouse.up();
    expect(pressedShadow).not.toBe(raisedShadow);
    expect(await button.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await page.keyboard.press('Tab');
  }
  await page.close();
});

// Live report on SkyUI (12604): "Mod manager download" as a plain button still opened Nexus's
// requirements modal, and that modal's Close button / Escape did nothing.
test('Vortex button without href skips the requirements modal and says it is sending; modal Close and Escape reach Nexus', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  // Hold the link request so the in-between state can be seen.
  await page.route('**/Core/Libs/Common/Managers/Downloads**', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":""}' });
  });
  await page.evaluate(() => {
    const host = document.createElement('mod-file-download');
    host.setAttribute('file-id', '35407');
    const vortex = document.createElement('button');
    vortex.id = 'fake-vortex';
    vortex.innerHTML = '<span>Mod manager download</span>';
    host.append(vortex);
    document.body.append(host);
    window.nativeOpened = 0;
    vortex.addEventListener('click', () => { window.nativeOpened += 1; });

    const modal = document.createElement('download-modal');
    modal.setAttribute('file-id', '35407');
    modal.setAttribute('download-links', JSON.stringify({ downloadUrl: '/skyrimspecialedition/mods/12604?tab=files&file_id=35407' }));
    modal.tabIndex = -1;
    const close = document.createElement('button');
    close.id = 'fake-close';
    close.textContent = 'Close';
    modal.append(close);
    document.body.append(modal);
    window.closeClicks = 0;
    window.escaped = 0;
    close.addEventListener('click', () => { window.closeClicks += 1; });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.escaped += 1; });
  });
  const started = Date.now();
  await page.click('#fake-vortex');
  await expect(page.locator('#fake-vortex')).toHaveText(/Sending to Vortex/, { timeout: 1000 });
  expect(Date.now() - started, 'feedback is immediate').toBeLessThan(1500);
  expect(await page.evaluate(() => window.nativeOpened), 'Nexus never sees the click, so no modal').toBe(0);

  await page.click('#fake-close');
  expect(await page.evaluate(() => window.closeClicks), 'Close reaches Nexus').toBe(1);
  await page.focus('download-modal');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.escaped), 'Escape reaches Nexus').toBe(1);

  // With an extension dialog open as well, a click inside Nexus's own dialog is still not blocked.
  await page.click('#nxtk-settings-fab');
  await expect(page.locator('.nxtk-modal').first()).toBeVisible({ timeout: 10000 });
  const blocked = await page.evaluate(() => {
    const close = document.getElementById('fake-close');
    const event = new globalThis.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true });
    close.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(blocked, 'the overlay guard leaves Nexus dialogs alone').toBe(false);
  await page.close();
});

test('settings button stays small at 125/150% zoom and never covers Download all mods', async () => {
  for (const zoom of [1.25, 1.5]) {
    const page = await openPage('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123', 1280, 720, zoom);
    const deck = page.locator('#nxtk-control-deck');
    await expect(deck).toBeVisible({ timeout: 30000 });
    const fab = page.locator('#nxtk-settings-fab');
    await expect(fab).toBeVisible();
    const label = await fab.locator('.nxtk-fab-label').evaluate((el) => el.getBoundingClientRect().width);
    expect(label, 'icon only at this width').toBeLessThan(2);
    const button = page.locator('#nxtk-dl-all');
    for (let step = 0; step < 6; step += 1) {
      await button.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, step * 60);
      await page.waitForTimeout(250);
      const covered = await page.evaluate(() => {
        const target = document.getElementById('nxtk-dl-all');
        const fabEl = document.getElementById('nxtk-settings-fab');
        const a = target.getBoundingClientRect();
        const b = fabEl.getBoundingClientRect();
        if (fabEl.classList.contains('nxtk-fab-tucked')) return false;
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      });
      expect(covered, `zoom ${zoom}, step ${step}: the FAB sits on Download all mods`).toBe(false);
    }
    await page.screenshot({ path: path.join(shotDir, `fab-deck-${Math.round(zoom * 100)}.png`) });
    await page.close();
  }
});

test('popup Page settings deep link opens the in-page settings and drops the hash', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1#nxtk-settings', 1280, 800, 1);
  await expect(page.locator('.nxtk-modal').first()).toBeVisible({ timeout: 20000 });
  expect(new URL(page.url()).hash).toBe('');
  await page.close();
});

// Nexus's real markup (2026): the file card is <mod-file-download file='{"id":…}'> whose shadow root holds
// <mod-download-modal file='{…downloadUrl, vortexDownloadUrl}'>, whose own shadow root renders the
// "Mod manager download" button; the header Vortex button lives in <mod-download-buttons main-file=…>.
// No file-id attribute anywhere, which is why the first fix missed the live page.
test('real Nexus web components: Vortex buttons in nested shadow roots skip the requirements modal', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  const asked = [];
  const hold = async (route) => {
    asked.push({ url: route.request().url(), body: route.request().postData() || '' });
    await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":""}' });
  };
  await page.route('**/Core/Libs/Common/Managers/Downloads**', hold);
  await page.route('**/api/files/**', hold);
  await page.evaluate(() => {
    window.nativeOpened = 0;
    const build = (hostTag, hostAttrs, label, id, fileId = 35407) => {
      const host = document.createElement(hostTag);
      for (const [k, v] of Object.entries(hostAttrs)) host.setAttribute(k, v);
      const outer = host.attachShadow({ mode: 'open' });
      const modal = document.createElement('mod-download-modal');
      modal.setAttribute('file', JSON.stringify({ id: fileId, name: 'SkyUI', downloadUrl: `https://www.nexusmods.com/api/files/${fileId}?game=1704`, vortexDownloadUrl: `https://www.nexusmods.com/api/files/${fileId}?game=1704&nmm=1` }));
      outer.append(modal);
      const inner = modal.attachShadow({ mode: 'open' });
      const button = document.createElement('button');
      button.id = id;
      button.innerHTML = `<span>${label}</span>`;
      // Nexus opens its requirements modal from the button's own handler.
      button.addEventListener('click', () => { window.nativeOpened += 1; });
      inner.append(button);
      document.body.append(host);
      return host;
    };
    build('mod-file-download', { file: JSON.stringify({ id: 35407 }), 'game-id': '1704' }, 'Mod manager download', 'real-card-vortex');
    // A different file: one click per file is the dedupe rule, so the same id twice would be ignored.
    build('mod-download-buttons', { 'main-file': JSON.stringify({ id: 35408 }), 'game-id': '1704' }, 'Vortex', 'real-header-vortex', 35408);
  });
  const button = (id) => page.locator(`mod-file-download, mod-download-buttons`).locator(`#${id}`);
  for (const id of ['real-card-vortex', 'real-header-vortex']) {
    await button(id).click();
    await expect(button(id)).toHaveText(/Sending to Vortex/, { timeout: 1000 });
    await page.waitForTimeout(3500);
    // The stub answers without a link, so the extension shows its error dialog; close it.
    for (let i = 0; i < 3 && await page.locator('.nxtk-modal-backdrop').count(); i += 1) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }
  expect(await page.evaluate(() => window.nativeOpened), 'Nexus never opened its modal').toBe(0);
  expect(asked.length, 'the link was requested').toBeGreaterThan(0);
  for (const { url, body } of asked) {
    // Either the component's signed Vortex API link or the generator, always for the clicked file, as Vortex.
    if (url.includes('/api/files/')) {
      expect(url).toMatch(/\/api\/files\/3540[78]/);
      expect(new URL(url).searchParams.get('nmm')).toBe('1');
    } else {
      expect(new URLSearchParams(body).get('fid')).toMatch(/^3540[78]$/);
      expect(new URLSearchParams(body).get('nmm')).toBe('1');
    }
  }
  await page.close();
});

test('settings button steps aside when a Nexus menu (account / Sign out) drops under it at 150%', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604', 1280, 720, 1.5);
  const fab = page.locator('#nxtk-settings-fab');
  await expect(fab).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    const toggle = document.createElement('button');
    toggle.id = 'fake-account';
    toggle.textContent = 'Account';
    toggle.style.cssText = 'position:fixed;top:4px;right:4px;z-index:50';
    const menu = document.createElement('div');
    menu.id = 'fake-menu';
    menu.style.cssText = 'position:fixed;top:40px;right:0;bottom:0;width:260px;background:#222;z-index:50;display:none;flex-direction:column;justify-content:flex-end';
    menu.innerHTML = '<a href="/a">Profile</a><a href="/b">Settings</a><a href="https://users.nexusmods.com/auth/sign_out" style="display:block;padding:12px">Sign out</a>';
    toggle.addEventListener('click', () => { menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'; });
    document.body.append(toggle, menu);
  });
  // Away from the page's own links, so only the menu can be under the button.
  await page.evaluate(() => { document.querySelector('#mainContent, main, body > div')?.setAttribute('style', 'display:none'); });
  await page.evaluate(() => globalThis.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(400);
  await expect(fab, 'visible before the menu opens').toBeVisible();
  await page.click('#fake-account');
  await page.waitForTimeout(1000);
  const covered = await page.evaluate(() => {
    const fabEl = document.getElementById('nxtk-settings-fab');
    if (getComputedStyle(fabEl).visibility === 'hidden') return false;
    const b = fabEl.getBoundingClientRect();
    return Array.from(document.querySelectorAll('#fake-menu a')).some((a) => {
      const r = a.getBoundingClientRect();
      return r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom;
    });
  });
  expect(covered, 'the FAB sits on the account menu').toBe(false);
  await page.click('#fake-account');
  await page.waitForTimeout(700);
  await expect(fab, 'and comes back when the menu closes').toBeVisible();
  await page.close();
});

test('Vortex button state shows on a real-style label (icon span + bare text, re-rendered) and in a status toast', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  const hold = async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":""}' });
  };
  await page.route('**/Core/Libs/Common/Managers/Downloads**', hold);
  await page.route('**/api/files/**', hold);
  await page.evaluate(() => {
    const host = document.createElement('mod-file-download');
    host.setAttribute('file', JSON.stringify({ id: 35409 }));
    host.setAttribute('game-id', '1704');
    const outer = host.attachShadow({ mode: 'open' });
    const modal = document.createElement('mod-download-modal');
    modal.setAttribute('file', JSON.stringify({ id: 35409, downloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704', vortexDownloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704&nmm=1' }));
    outer.append(modal);
    const inner = modal.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.id = 'styled-vortex';
    // Like Nexus: an icon wrapper first, the label as a bare text node.
    button.innerHTML = '<span class="icon" aria-hidden="true"><svg width="16" height="16"></svg></span>Mod manager download';
    // A framework re-render puts its own label back shortly after the click.
    button.addEventListener('click', () => setTimeout(() => {
      button.lastChild.nodeValue = 'Mod manager download';
    }, 100));
    inner.append(button);
    document.body.append(host);
  });
  const button = page.locator('mod-file-download').locator('#styled-vortex');
  await button.click();
  await expect(page.locator('.nxtk-status-toast[role="status"]')).toContainText(/Sending to Vortex/, { timeout: 1000 });
  await page.waitForTimeout(400);
  await expect(button, 'the label survives the re-render').toHaveText(/Sending to Vortex/);
  expect(await button.locator('svg').count(), 'the icon is kept').toBe(1);
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3 && await page.locator('.nxtk-modal-backdrop').count(); i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.nxtk-status-toast'), 'a failed send removes the toast').toHaveCount(0, { timeout: 2000 });
  await page.close();
});

test('settings button hides while a Nexus menu in a shadow root (opened on pointerdown, animated) covers it at 150%', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604', 1280, 720, 1.5);
  const fab = page.locator('#nxtk-settings-fab');
  await expect(fab).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    const header = document.createElement('nexus-account-menu');
    header.style.cssText = 'position:fixed;top:4px;right:4px;z-index:50';
    const root = header.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <button id="acct" aria-expanded="false" aria-controls="acct-menu">Account</button>
      <div id="acct-menu" role="menu" hidden
        style="position:fixed;top:40px;right:0;bottom:0;width:260px;background:#222;display:flex;flex-direction:column;justify-content:flex-end;opacity:0;transition:opacity .5s">
        <div role="menuitem">Profile</div><div role="menuitem" style="padding:12px">Sign out</div>
      </div>`;
    const toggle = root.getElementById('acct');
    const menu = root.getElementById('acct-menu');
    toggle.addEventListener('pointerdown', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      globalThis.requestAnimationFrame(() => { menu.style.opacity = open ? '1' : '0'; });
    });
    document.body.append(header);
  });
  const toggle = page.locator('nexus-account-menu').locator('#acct');
  await toggle.dispatchEvent('pointerdown');
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => getComputedStyle(document.getElementById('nxtk-settings-fab')).visibility);
  expect(state, 'the FAB steps aside while the menu is open').toBe('hidden');
  await toggle.dispatchEvent('pointerdown');
  await page.waitForTimeout(1200);
  await expect(fab, 'and comes back when it closes').toBeVisible();
  await page.close();
});

test('single-file Auto NMM path (?file_id=…&nmm=1, no button) shows the Vortex toast, the "didn\'t open?" hint and logs both', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/popup/popup.html`);
  const patch = (values) => ext.evaluate((v) => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_settings', (o) => globalThis.chrome.storage.local.set({ nxtk_settings: { ...(o.nxtk_settings || {}), ...v }, nxtk_debug_log: [] }, r))), values);
  // The tab would close itself after the hand-off; keep it so the hint can be seen.
  await patch({ AutoCloseTab: false, DebugLogs: true });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const nxm = `nxm://skyrimspecialedition/mods/12604/files/35410?key=abc&expires=${expires}&user_id=1`;
  const answer = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: nxm }) });
  await page.route('**/Core/Libs/Common/Managers/Downloads**', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    return answer(route);
  });
  await page.route('**/api/files/**', answer);
  await page.goto('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35410&nmm=1');
  const toast = page.locator('.nxtk-status-toast[role="status"]');
  await expect(toast, 'the auto-start path announces the hand-off').toContainText(/Sending to Vortex/, { timeout: 15000 });
  await expect(toast).toContainText(/Sent to Vortex/, { timeout: 5000 });
  // Nothing takes the focus in the test browser, as when the xdg-open prompt is cancelled.
  await expect(page.locator('.nxtk-notice-toast:not(.nxtk-status-toast)'), 'a hint follows when Vortex shows no sign of opening')
    .toContainText(/Vortex didn't open\?/, { timeout: 8000 });
  const readLog = () => ext.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_debug_log', (o) => r((o.nxtk_debug_log || []).map((e) => e.text || JSON.stringify(e)).join('\n')))));
  // The log is written in batches.
  await expect.poll(readLog, { timeout: 10000 }).toMatch(/no sign Vortex opened/);
  const all = await readLog();
  expect(all, 'the toast is logged').toMatch(/Vortex hand-off: showing "Sending to Vortex…" \(toast\)/);
  expect(all, 'the sent state is logged').toMatch(/Vortex hand-off: link sent/);
  expect(all, 'the hint is logged').toMatch(/no sign Vortex opened/);
  await patch({ AutoCloseTab: true, DebugLogs: false });
  await page.close();
  await ext.close();
});

// ---- 3.1.0 friendlier UX ----

async function extensionPage() {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/popup/popup.html`);
  const patch = (values, extra = {}) => ext.evaluate(([v, x]) => new Promise((r) => globalThis.chrome.storage.local.get('nxtk_settings', (o) => globalThis.chrome.storage.local.set({ nxtk_settings: { ...(o.nxtk_settings || {}), ...v }, ...x }, r))), [values, extra]);
  const read = (key) => ext.evaluate((k) => new Promise((r) => globalThis.chrome.storage.local.get(k, (o) => r(o[k]))), key);
  return { id, ext, patch, read };
}

async function autoNmmRun(page) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const nxm = `nxm://skyrimspecialedition/mods/12604/files/35410?key=abc&expires=${expires}&user_id=1`;
  const answer = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: nxm }) });
  await page.route('**/Core/Libs/Common/Managers/Downloads**', answer);
  await page.route('**/api/files/**', answer);
  await page.goto('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35410&nmm=1');
}

test('auto-close on: a cancelled Vortex prompt keeps the tab, shows the hint, persists the log; two in a row offer browser downloads', async () => {
  const { ext, patch, read } = await extensionPage();
  await patch({ AutoCloseTab: true, CloseTabDelay: 1000, DebugLogs: true }, { nxtk_debug_log: [], nxtk_vortex_open: { confirmed: true, failStreak: 0 } });
  const readLog = async () => ((await read('nxtk_debug_log')) || []).map((e) => e.text || '').join('\n');
  for (let round = 1; round <= 2; round += 1) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await autoNmmRun(page);
    // As with Chrome's "Open Vortex?" dialog: the window blurs, then Cancel gives focus back with no focus event.
    await page.waitForTimeout(300);
    await page.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await expect(page.locator('.nxtk-notice-toast:not(.nxtk-status-toast)').first(), `round ${round}: the hint appears`)
      .toContainText(/Vortex didn't open\?/, { timeout: 9000 });
    expect(page.isClosed(), `round ${round}: the tab was kept`).toBe(false);
    if (round === 2) {
      await expect(page.locator('#nxtk-vortex-switch-offer, .nxtk-notice-toast').filter({ hasText: /not picking up the files/ }).first(),
        'the second failure offers browser downloads').toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('link', { name: /Vortex install guide/ })).toBeVisible();
    }
    await page.close();
  }
  await expect.poll(readLog, { timeout: 5000 }).toMatch(/Vortex hand-off: watching whether Vortex opens/);
  expect(await readLog()).toMatch(/Vortex hand-off: no sign Vortex opened \((focus-returned|no-signal|user-back)\)/);
  expect((await read('nxtk_vortex_open')).failStreak).toBe(2);
  await patch({ AutoCloseTab: true, CloseTabDelay: 3000, DebugLogs: false }, { nxtk_vortex_open: { confirmed: false, failStreak: 0 } });
  await ext.close();
});

test('settings: quick-setup presets apply and technical settings sit under Advanced', async () => {
  const { ext, patch, read } = await extensionPage();
  await patch({ NDC_downloadMethod: 0, AutoCloseTab: true, AutoStartDownload: true, SkipRequirements: true, HideDownloadPopup: true });
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 1280, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  const modal = page.locator('.nxtk-modal').first();
  await expect(modal.locator('[data-preset="vortex"]')).toHaveClass(/nxtk-preset-active/, { timeout: 10000 });
  await expect(modal.locator('#nxtk-advanced-body')).toBeHidden();
  await modal.locator('[data-preset="browser"]').click();
  await expect.poll(async () => (await read('nxtk_settings')).NDC_downloadMethod).toBe(1);
  expect((await read('nxtk_settings')).AutoCloseTab).toBe(false);
  await expect(page.locator('.nxtk-modal [data-preset="browser"]')).toHaveClass(/nxtk-preset-active/, { timeout: 10000 });
  // The note and the highlight follow a change at once, without reopening.
  await page.locator('.nxtk-modal [data-setting="AutoStartDownload"]').evaluate((el) => { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#nxtk-preset-note')).toContainText(/Custom/);
  await expect(page.locator('.nxtk-modal .nxtk-preset-active')).toHaveCount(0);
  await page.locator('.nxtk-modal [data-setting="AutoStartDownload"]').evaluate((el) => { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#nxtk-preset-note')).toHaveText('');
  await expect(page.locator('.nxtk-modal [data-preset="browser"]')).toHaveClass(/nxtk-preset-active/);
  await page.waitForTimeout(600);
  await assertFits(page, '.nxtk-modal', 'presets');
  await page.locator('#nxtk-advanced-toggle').click();
  await expect(page.locator('#nxtk-advanced-body')).toContainText(/browser check/);
  await patch({ NDC_downloadMethod: 0, AutoCloseTab: true });
  await page.close();
  await ext.close();
});

for (const [width, height] of [[1280, 800], [1366, 768], [360, 800]]) {
  for (const zoom of ZOOMS) {
    test(`compact settings groups fit at ${width}x${height}@${zoom}`, async () => {
      const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', width, height, zoom);
      await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
      const modal = page.locator('#nxtk-settings-modal .nxtk-modal');
      await expect(modal.locator('[data-settings-group="downloads"]')).toBeVisible();
      await page.waitForTimeout(600);
      await assertFits(page, '#nxtk-settings-modal .nxtk-modal', 'compact settings');
      const header = await modal.locator('.nxtk-modal-header').boundingBox();
      const closeButton = await modal.locator('.nxtk-modal-close').boundingBox();
      expect(closeButton.x + closeButton.width, 'close stays in the upper right, not on its own row').toBeGreaterThanOrEqual(header.x + header.width - 1);
      const layout = await modal.evaluate((el) => {
        const rect = (selector) => el.querySelector(selector).getBoundingClientRect().toJSON();
        const scroll = el.querySelector('.nxtk-modal-scroll');
        return {
          downloads: rect('[data-settings-group="downloads"]'), collections: rect('[data-settings-group="collections"]'),
          appearance: rect('[data-settings-group="appearance"]'), presets: rect('.nxtk-settings-presets'),
          overflow: scroll.scrollWidth - scroll.clientWidth,
          clipped: [...scroll.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > scroll.getBoundingClientRect().right + 1).map((child) => ({ class: child.className, flex: getComputedStyle(child).flex, width: child.getBoundingClientRect().width })),
          descSize: parseFloat(getComputedStyle(el.querySelector('.nxtk-setting-desc')).fontSize)
        };
      });
      expect(layout.overflow, JSON.stringify(layout.clipped)).toBeLessThanOrEqual(1);
      expect(layout.descSize).toBeGreaterThanOrEqual(12);
      expect(layout.presets.bottom).toBeLessThanOrEqual(layout.downloads.top);
      if (width / zoom >= 760) {
        expect(Math.abs(layout.downloads.top - layout.collections.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.downloads.width - layout.collections.width)).toBeLessThanOrEqual(1);
        expect(layout.appearance.height, 'appearance must not stretch into a tall empty card').toBeLessThan(260);
      } else {
        expect(layout.collections.top).toBeGreaterThanOrEqual(layout.downloads.bottom);
      }
      await page.screenshot({ path: path.join(shotDir, `compact-settings-${width}x${height}-${zoom}.png`) });
      await modal.locator('#nxtk-advanced-toggle').click();
      await expect(modal.locator('#nxtk-advanced-body')).toBeVisible();
      for (const input of await modal.locator('[data-setting]').all()) {
        await input.scrollIntoViewIfNeeded();
        const box = await input.evaluate((el) => {
          const target = el.type === 'checkbox' ? el.closest('.nxtk-toggle') : el;
          const r = target.getBoundingClientRect();
          const outer = el.closest('.nxtk-modal-scroll').getBoundingClientRect();
          return { left: r.left, right: r.right, parentLeft: outer.left, parentRight: outer.right };
        });
        expect(box.left).toBeGreaterThanOrEqual(box.parentLeft - 1);
        expect(box.right).toBeLessThanOrEqual(box.parentRight + 1);
      }
      await assertFits(page, '#nxtk-settings-modal .nxtk-modal-footer', 'footer stays reachable');
      await page.close();
    });
  }
}

test('compact settings information works by keyboard without changing the switch', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 1280, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  const row = page.locator('#nxtk-settings-modal [data-key="AutoStartDownload"]');
  const input = row.locator('input');
  const before = await input.isChecked();
  const help = row.locator('[data-setting-help]');
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.nxtk-setting-help')).toBeVisible();
  expect(await input.isChecked()).toBe(before);
  await page.keyboard.press('Space');
  await expect(row.locator('.nxtk-setting-help')).toBeHidden();
  expect(await input.isChecked()).toBe(before);
  await page.close();
});

test('quick setup preserves the dialog, open help, Advanced, scroll and focus without navigation', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 1280, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  const modal = page.locator('#nxtk-settings-modal .nxtk-modal');
  const original = await modal.elementHandle();
  await modal.locator('#nxtk-advanced-toggle').click();
  await modal.locator('[data-key="AutoStartDownload"] [data-setting-help]').click();
  const preset = modal.locator('[data-preset="browser"]');
  await preset.focus();
  const beforeScroll = await modal.locator('.nxtk-modal-scroll').evaluate((el) => el.scrollTop);
  let navigations = 0;
  page.on('framenavigated', () => { navigations++; });
  await page.keyboard.press('Enter');
  await expect(preset).toHaveAttribute('aria-pressed', 'true');
  expect(await original.evaluate((el) => el.isConnected), 'the same modal stays mounted').toBe(true);
  await expect(modal.locator('#nxtk-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(modal.locator('[data-key="AutoStartDownload"] [data-setting-help]')).toHaveAttribute('aria-expanded', 'true');
  expect(await modal.locator('.nxtk-modal-scroll').evaluate((el) => el.scrollTop)).toBe(beforeScroll);
  expect(await preset.evaluate((el) => document.activeElement === el)).toBe(true);
  await expect(modal.locator('[data-setting="AutoCloseTab"]')).not.toBeChecked();
  expect(navigations).toBe(0);
  await page.close();
});

test('compact settings switches work by clicking their label, track and using Space', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 1280, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  const row = page.locator('#nxtk-settings-modal [data-key="SkipRequirements"]');
  const input = row.locator('input');
  const before = await input.isChecked();
  await row.locator('label').click();
  expect(await input.isChecked()).toBe(!before);
  await row.locator('.nxtk-toggle').click();
  expect(await input.isChecked()).toBe(before);
  await input.focus();
  await page.keyboard.press('Space');
  expect(await input.isChecked()).toBe(!before);
  await page.keyboard.press('Space');
  expect(await input.isChecked()).toBe(before);
  await page.close();
});

test('compact settings numeric fields show the complete valid speed value', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 1280, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  await page.locator('#nxtk-advanced-toggle').click();
  const speed = page.locator('#nxtk-settings-modal [data-setting="NDC_downloadSpeed"]');
  const before = await speed.inputValue();
  await speed.fill('999.9');
  const measured = await speed.evaluate((el) => {
    const style = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      needed: ctx.measureText('999.9').width
    };
  });
  expect(measured.available, 'the whole speed value should fit, not just the caret end').toBeGreaterThanOrEqual(measured.needed - 1);
  await speed.fill(before);
  await page.close();
});

test('compact settings long labels and reset confirmation remain usable', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/1', 360, 800, 1);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  const modal = page.locator('#nxtk-settings-modal .nxtk-modal');
  await modal.locator('[data-key="AutoStartDownload"] .nxtk-setting-title').evaluate((el) => {
    el.textContent = 'Downloads automatisch starten, sobald eine Nexus-Dateiseite geöffnet wird';
  });
  const row = modal.locator('[data-key="AutoStartDownload"]');
  await row.scrollIntoViewIfNeeded();
  await row.locator('[data-setting-help]').click();
  await expect(row.locator('.nxtk-setting-help')).toBeVisible();
  const overflow = await modal.locator('.nxtk-modal-scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(shotDir, 'compact-settings-long-label.png') });
  await modal.locator('[data-key="DownloadFolder"] input').fill('CompactUiTest');
  await modal.locator('[data-key="DownloadFolder"] input').press('Tab');
  await modal.locator('[data-reset]').click();
  const confirm = page.locator('#nxtk-confirm-modal');
  await expect(confirm).toBeVisible();
  await confirm.locator('[data-close="cancel"]').click();
  await expect(modal.locator('[data-key="DownloadFolder"] input')).toHaveValue('CompactUiTest');
  await modal.locator('[data-reset]').click();
  await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('#nxtk-confirm-modal [data-close="confirm"]').click()]);
  await page.locator('#nxtk-settings-fab').click({ timeout: 20000 });
  await expect(page.locator('#nxtk-settings-modal input[data-setting="DownloadFolder"]')).toHaveValue('NexusMods');
  await page.close();
});

test('welcome page: setup saves choices and Test Vortex asks when it cannot tell', async () => {
  const { id, ext, read, patch } = await extensionPage();
  await patch({}, { nxtk_vortex_open: { confirmed: false, failStreak: 0 } });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${id}/onboarding/welcome.html`);
  await page.locator('input[name="method"][value="browser"]').check();
  await expect(page.locator('#setupTestVortex')).toBeHidden();
  await page.locator('#setupFolder').fill('Mods');
  await page.locator('#setupSave').click();
  await expect(page.locator('#setupStatus')).toContainText(/Saved/);
  let saved = await read('nxtk_settings');
  expect(saved.NDC_downloadMethod).toBe(1);
  expect(saved.DownloadFolder).toBe('Mods');
  await page.locator('input[name="method"][value="vortex"]').check();
  await page.locator('#setupCloseTab').uncheck();
  await page.locator('#setupSave').click();
  await expect.poll(async () => (await read('nxtk_settings')).NDC_downloadMethod).toBe(0);
  saved = await read('nxtk_settings');
  expect(saved.AutoCloseTab).toBe(false);
  // Headless Chromium has no nxm:// handler and nothing takes the focus: the page asks.
  await page.evaluate(() => { globalThis.__nav = []; });
  await page.locator('#setupTestVortex').click();
  await expect(page.locator('#setupAsk')).toBeVisible({ timeout: 10000 });
  // After a nxm:// navigation headless Chromium stops delivering real input, so the answer is clicked in the page.
  await page.evaluate(() => document.getElementById('setupAskYes').click());
  await expect(page.locator('#setupStatus')).toContainText(/all set/);
  expect((await read('nxtk_vortex_open')).confirmed).toBe(true);
  await assertFits(page, '#setup', 'welcome setup');
  await patch({ AutoCloseTab: true, DownloadFolder: '' });
  await page.close();
  await ext.close();
});

test('error dialog: a missing link offers Retry, Open file page and Use browser download', async () => {
  const { ext, patch, read } = await extensionPage();
  await patch({ NDC_downloadMethod: 0, ShowAlertsOnError: true });
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  const empty = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":""}' });
  await page.route('**/Core/Libs/Common/Managers/Downloads**', empty);
  await page.route('**/api/files/**', empty);
  await page.evaluate(() => {
    const host = document.createElement('mod-file-download');
    host.setAttribute('file', JSON.stringify({ id: 35409 }));
    host.setAttribute('game-id', '1704');
    const outer = host.attachShadow({ mode: 'open' });
    const modal = document.createElement('mod-download-modal');
    modal.setAttribute('file', JSON.stringify({ id: 35409, downloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704', vortexDownloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704&nmm=1' }));
    outer.append(modal);
    const inner = modal.attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id="v">Mod manager download</button>';
    document.body.append(host);
  });
  await page.locator('mod-file-download').locator('#v').click();
  const dialog = page.locator('.nxtk-modal').filter({ has: page.locator('[data-retry]') }).first();
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('[data-open-file-page]')).toBeVisible();
  await dialog.locator('[data-switch-browser]').click();
  await expect.poll(async () => (await read('nxtk_settings')).NDC_downloadMethod).toBe(1);
  await expect(page.locator('.nxtk-notice-toast').filter({ hasText: /Switched to browser downloads/ })).toBeVisible();
  await patch({ NDC_downloadMethod: 0 });
  await page.close();
  await ext.close();
});

test('error dialog: a rate limit counts down before Retry is allowed', async () => {
  const { ext, patch } = await extensionPage();
  await patch({ NDC_downloadMethod: 0, ShowAlertsOnError: true });
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  const limited = (route) => route.fulfill({ status: 429, contentType: 'text/plain', headers: { 'Retry-After': '3' }, body: 'Too Many Requests' });
  await page.route('**/Core/Libs/Common/Managers/Downloads**', limited);
  await page.route('**/api/files/**', limited);
  await page.evaluate(() => {
    const host = document.createElement('mod-file-download');
    host.setAttribute('file', JSON.stringify({ id: 35409 }));
    host.setAttribute('game-id', '1704');
    const outer = host.attachShadow({ mode: 'open' });
    const modal = document.createElement('mod-download-modal');
    modal.setAttribute('file', JSON.stringify({ id: 35409, downloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704', vortexDownloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704&nmm=1' }));
    outer.append(modal);
    modal.attachShadow({ mode: 'open' }).innerHTML = '<button id="v">Mod manager download</button>';
    document.body.append(host);
  });
  await page.locator('mod-file-download').locator('#v').click();
  const button = page.locator('[data-retry-in]');
  await expect(button).toBeVisible({ timeout: 15000 });
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(/Retry in 0:0[1-3]/);
  await expect(button).toBeEnabled({ timeout: 6000 });
  await expect(button).toHaveText(/Retry now/);
  await expect(page.locator('[data-switch-browser]'), 'a rate limit never suggests switching').toHaveCount(0);
  await page.close();
  await ext.evaluate(() => new Promise((r) => globalThis.chrome.storage.local.remove('nxtk_ndc_rate_limit', r)));
  await ext.close();
});

test('collection: Download history view shows sent / downloaded / missing and clears', async () => {
  const page = await openPage('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123', 1280, 900, 1);
  const deck = page.locator('#nxtk-control-deck');
  await expect(deck).toBeVisible({ timeout: 30000 });
  await deck.locator('#nxtk-menu-toggle').click();
  await page.locator('#nxtk-history-view').click({ timeout: 10000 });
  const modal = page.locator('#nxtk-history-view-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  await expect(modal).toContainText(/Sent to Vortex/);
  await expect(modal).toContainText(/Not downloaded yet/);
  await expect(modal.locator('[data-history-resend]')).toBeEnabled();
  await assertFits(page, '#nxtk-history-view-modal', 'history view');
  await page.close();
});

// ---- stress and edge cases ----

for (const lang of ['de', 'ru', 'el']) {
  test(`longest locales (${lang}): popup and collection deck fit at 380px`, async () => {
    // Headless Chromium ignores --lang for extensions, so a copy of the extension serves this
    // locale's messages as its English ones: the same strings, rendered in the real layout.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nxtk-${lang}-`));
    fs.cpSync(extensionDir, dir, { recursive: true });
    fs.copyFileSync(path.join(extensionDir, `_locales/${lang}/messages.json`), path.join(dir, '_locales/en/messages.json'));
    const ctx = await launchContext({ dir });
    try {
      let [worker] = ctx.serviceWorkers();
      if (!worker) worker = await ctx.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      const popup = await ctx.newPage();
      await popup.setViewportSize({ width: 380, height: 600 });
      await popup.goto(`chrome-extension://${id}/popup/popup.html`);
      const sample = JSON.parse(fs.readFileSync(path.join(extensionDir, `_locales/${lang}/messages.json`), 'utf8')).setupSave.message;
      expect(await popup.evaluate(() => globalThis.chrome.i18n.getMessage('setupSave'))).toBe(sample);
      await popup.waitForTimeout(500);
      const overflow = await popup.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const clipped = Array.from(document.querySelectorAll('button, a, label, h1, h2, h3, p, span'))
          .filter((el) => el.offsetParent && el.textContent.trim() && el.getBoundingClientRect().right > vw + 1)
          .map((el) => el.textContent.trim().slice(0, 40));
        return { x: document.documentElement.scrollWidth - vw, clipped };
      });
      expect(overflow.x, `${lang} popup scrolls horizontally`).toBeLessThanOrEqual(1);
      expect(overflow.clipped, `${lang} popup text past the edge`).toEqual([]);
      await popup.screenshot({ path: path.join(shotDir, `popup-${lang}-380.png`) });
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 380, height: 800 });
      await page.goto('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123');
      const deck = page.locator('#nxtk-control-deck');
      await expect(deck).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(800);
      const deckOverflow = await deck.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('button, .nxtk-selector-title, .nxtk-radio-hint, .nxtk-btn'))
          // A closed dropdown is invisible (opacity 0, no pointer events) and laid out off to the side.
          .filter((c) => c.offsetParent && c.textContent.trim() && !c.closest('.nxtk-dropdown-menu:not(.nxtk-open)') && getComputedStyle(c).visibility !== 'hidden')
          .filter((c) => c.getBoundingClientRect().right > r.right + 1)
          .map((c) => `${c.id || c.className}: ${c.textContent.trim().slice(0, 40)} (+${Math.round(c.getBoundingClientRect().right - r.right)}px)`);
      });
      expect(deckOverflow, `${lang} deck text past the deck edge`).toEqual([]);
      await assertFits(page, '.nxtk-deck', `${lang} deck 380`);
      await page.screenshot({ path: path.join(shotDir, `deck-${lang}-380.png`), fullPage: true });
      // The open menu with the longest labels stays on screen.
      await deck.locator('#nxtk-menu-toggle').click();
      await expect(page.locator('#nxtk-select-mods')).toBeVisible();
      await page.waitForTimeout(400);
      await assertFits(page, '#nxtk-dropdown-portal .nxtk-open', `${lang} deck menu 380`);
      await deck.locator('#nxtk-menu-toggle').click();
      await page.locator('#nxtk-settings-fab').click();
      const settings = page.locator('#nxtk-settings-modal .nxtk-modal');
      const catalog = JSON.parse(fs.readFileSync(path.join(extensionDir, `_locales/${lang}/messages.json`), 'utf8'));
      await expect(settings.locator('[data-settings-group="appearance"] h3')).toHaveText(catalog.setSectionLanguage.message);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(400);
        await assertFits(page, '#nxtk-settings-modal .nxtk-modal', `${lang} settings ${width}`);
        expect(await settings.locator('.nxtk-modal-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await settings.locator('.nxtk-modal-scroll').evaluate((el) => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(shotDir, `compact-settings-${lang}-${width}.png`) });
      }
    } finally {
      await ctx.close();
    }
  });
}

test('rapid double and triple clicks on a Vortex button start one request', async () => {
  const page = await openPage('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', 1280, 800, 1);
  await expect(page.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 20000 });
  let hits = 0;
  const slow = async (route) => {
    hits += 1;
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":""}' });
  };
  await page.route('**/Core/Libs/Common/Managers/Downloads**', slow);
  await page.route('**/api/files/**', slow);
  await page.evaluate(() => {
    const host = document.createElement('mod-file-download');
    host.setAttribute('file', JSON.stringify({ id: 35409 }));
    host.setAttribute('game-id', '1704');
    const outer = host.attachShadow({ mode: 'open' });
    const modal = document.createElement('mod-download-modal');
    modal.setAttribute('file', JSON.stringify({ id: 35409, downloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704', vortexDownloadUrl: 'https://www.nexusmods.com/api/files/35409?game=1704&nmm=1' }));
    outer.append(modal);
    modal.attachShadow({ mode: 'open' }).innerHTML = '<button id="v">Mod manager download</button>';
    document.body.append(host);
  });
  const button = page.locator('mod-file-download').locator('#v');
  await button.dblclick();
  await button.click({ delay: 0 });
  await page.waitForTimeout(2500);
  expect(hits, 'one link request for a burst of clicks').toBe(1);
  expect(await page.locator('.nxtk-status-toast').count(), 'at most one status toast').toBeLessThanOrEqual(1);
  for (let i = 0; i < 3 && await page.locator('.nxtk-modal-backdrop').count(); i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  expect(await page.locator('.nxtk-modal-backdrop').count(), 'one error dialog, not a stack').toBe(0);
  await page.close();
});

test('extension update mid-run: after the worker restarts, the collection page restores the progress UI', async () => {
  // An update replaces the service worker and the content scripts; the queue lives in storage.
  // Closing the browser and starting it again on the same profile does the same to the extension.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-update-'));
  let ctx = await launchContext({ userDataDir });
  const jobId = 'e2e-update-job';
  const items = Array.from({ length: 5 }, (_, i) => ({ fileId: 900 + i, modId: 100 + i, name: `Mod ${i}`, size: 10, url: '' }));
  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker');
    await worker.evaluate(async ([jid, list]) => {
      const now = Date.now();
      await globalThis.chrome.storage.local.set({
        nxtk_background_ndc_jobs: { [jid]: {
          id: jid, tabId: -1, gameId: 'skyrimspecialedition', collectionId: 'abc123', type: 'all',
          itemCount: list.length, index: 2, completed: 2, failed: [], status: 'paused',
          activeDownloadId: null, createdAt: now, updatedAt: now
        } },
        [`nxtk_ndc_items:${jid}`]: list
      });
    }, [jobId, items]);
  } finally {
    await ctx.close();
  }
  ctx = await launchContext({ userDataDir });
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123');
    await expect(page.locator('#nxtk-control-deck')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#nxtk-progress-area'), 'the progress UI comes back').toBeVisible({ timeout: 15000 });
    await expect(page.locator('#nxtk-control-deck')).toContainText(/Reconnected|2\s*\/\s*5/, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test('collection menu: "Select mods to download" opens the picker with a real mouse click at every zoom', async () => {
  for (const [w, h, zoom] of [[1920, 1080, 1], [1280, 720, 1.5], [1920, 1080, 1.25]]) {
    const page = await openPage('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123', w, h, zoom);
    const deck = page.locator('#nxtk-control-deck');
    await expect(deck).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(800);
    await deck.locator('#nxtk-menu-toggle').click();
    const item = page.locator('#nxtk-select-mods');
    await expect(item).toBeVisible();
    await page.waitForTimeout(400);
    const box = await item.boundingBox();
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { inside: !!el?.closest('#nxtk-select-mods'), what: el ? `${el.tagName}#${el.id}.${el.className}` : 'none' };
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit.inside, `${w}x${h}@${zoom}: the item is covered by ${hit.what}`).toBe(true);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#nxtk-select-modal'), `${w}x${h}@${zoom}: picker opens`).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#nxtk-select-modal .nxtk-mod-item').first()).toBeVisible({ timeout: 10000 });
    await page.close();
  }
});
