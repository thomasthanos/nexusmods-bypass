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

let context;
test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-visual-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.NXTK_PLAYWRIGHT_CHANNEL || 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  await context.route('https://www.nexusmods.com/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
    const html = url.pathname.includes('/collections/') ? fixture('visual-collection-page.html') : fixture('visual-mod-page.html');
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await context.route('https://api-router.nexusmods.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(collectionAnswer()),
    headers: { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true' }
  }));
  await context.route('https://api.nexusmods.com/v2/graphql', (route) => {
    const cors = { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = null; }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(officialAnswer(body)) });
  });
  await context.route(/^(?!https:\/\/(www|api-router|api)\.nexusmods\.com)https?:\/\//, (route) => route.abort());
  // Skip the onboarding tab opened on install.
  await new Promise((r) => setTimeout(r, 1000));
  for (const page of context.pages()) if (page.url().includes('onboarding')) await page.close();
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

test('popup help tab: one solid primary, two compact secondaries, sentence case, tooltips', async () => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  for (const width of [380]) { // the popup body is a fixed 380px
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`chrome-extension://${id}/popup/popup.html`);
    await page.click('#tabHelp');
    const primary = page.locator('#sendReport');
    await expect(primary).toBeVisible();
    const style = await primary.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, transform: cs.textTransform, color: cs.color, bg: cs.backgroundColor, h: el.getBoundingClientRect().height };
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
      const overflow = await page.locator(sel).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(shotDir, `popup-help-${width}.png`) });
    await page.close();
  }
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
      requestAnimationFrame(() => { menu.style.opacity = open ? '1' : '0'; });
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
