import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('download popup restoration respects a second extension without recording a background error', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-download-ui-'));
  const blockerDir = path.join(temp, 'blocker');
  fs.mkdirSync(blockerDir);
  fs.writeFileSync(path.join(blockerDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Download UI conflict fixture', version: '1.0',
    permissions: ['downloads', 'downloads.ui'], background: { service_worker: 'blocker.js' }
  }));
  fs.writeFileSync(path.join(blockerDir, 'blocker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const extensions = [path.join(root, 'src'), blockerDir].join(',');
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: process.env.NXTK_PLAYWRIGHT_CHANNEL || 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`]
    });
    await context.route(/^https?:\/\//, route => route.abort());
    await expect.poll(() => context.serviceWorkers().length).toBe(2);
    const blocker = context.serviceWorkers().find(worker => worker.url().endsWith('/blocker.js'));
    const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'));
    await worker.evaluate(async () => {
      await globalThis.storageSetLocal(globalThis.NXTK.SETTINGS_KEY, {
        ...globalThis.NXTK.DEFAULTS, HideDownloadPopup: true, AutoErrorReports: false
      });
      await globalThis.syncDownloadUi({ immediate: true });
    });
    await blocker.evaluate(() => globalThis.chrome.downloads.setUiOptions({ enabled: false }));
    const nativeConflict = await worker.evaluate(async () => {
      try {
        await globalThis.chrome.downloads.setUiOptions({ enabled: true });
        return '';
      } catch (cause) { return cause.message; }
    });
    expect(nativeConflict).toBe('Another extension has disabled the download UI');

    for (let run = 0; run < 2; run += 1) {
      await worker.evaluate(async () => {
        await globalThis.storageSetLocal('nxtk_ndc_run_claims', {
          'test/collection': { tabId: 1, at: Date.now(), method: 'browser' }
        });
        await globalThis.syncDownloadUi({ immediate: true });
      });
      expect(await worker.evaluate(() => globalThis.chrome.alarms.get('nxtk-download-ui'))).toBeTruthy();
      await worker.evaluate(async () => {
        await globalThis.storageSetLocal('nxtk_ndc_run_claims', {});
        await globalThis.syncDownloadUi({ immediate: true });
        await globalThis.syncDownloadUi({ immediate: true });
      });
      expect(await worker.evaluate(() => globalThis.chrome.alarms.get('nxtk-download-ui'))).toBeUndefined();
      const errors = await worker.evaluate(async () => {
        const entries = await globalThis.storageGetLocal(globalThis.NXTK.ERROR_LOG_KEY, []);
        return entries.filter(entry => entry.code === 'background_error' && entry.context === 'download popup toggle');
      });
      expect(errors).toEqual([]);
      // This succeeds only if our extension really released its own restriction, even though
      // Chrome rejected its enabling request while the fixture still held the UI disabled.
      await blocker.evaluate(() => globalThis.chrome.downloads.setUiOptions({ enabled: true }));
      await blocker.evaluate(() => globalThis.chrome.downloads.setUiOptions({ enabled: false }));
    }
    await blocker.evaluate(() => globalThis.chrome.downloads.setUiOptions({ enabled: true }));
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
