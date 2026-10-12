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
    }
  }));
  return { data: { collectionRevision: { externalResources: [], modFiles } } };
}

let context;
test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-visual-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
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
  await context.route(/^(?!https:\/\/(www|api-router)\.nexusmods\.com)https?:\/\//, (route) => route.abort());
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
      await page.screenshot({ path: path.join(shotDir, `deck-${tag}.png`), fullPage: true });
      // The mod picker: split-button menu → "Select mods".
      await deck.locator('#nxtk-menu-toggle').click();
      await page.locator('#nxtk-select-mods').click({ timeout: 10000 });
      const modal = page.locator('.nxtk-modal').first();
      await expect(modal).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(600);
      await assertFits(page, '.nxtk-modal', `${tag} mod picker`);
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
