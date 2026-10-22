// End-to-end flows across the popup, the extension pages and a Nexus page, each starting from a fresh
// storage state. The browser is offline (tests/visual/helpers.mjs): Nexus pages are local fixtures and
// every other request is refused.
import { test, expect } from '@playwright/test';
import {
  blockedRequests, closeExtension, extensionId, extensionPage, launchExtension, readStorage, resetStorage, settle, storedZip
} from './helpers.mjs';

const MOD_URL = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604';
const COLLECTION_URL = 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123';

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Test Mod at Skyrim Special Edition Nexus</title>
<style>body{margin:0;font-family:sans-serif;background:#1b1c22;color:#ddd}#head{height:56px;background:#101116;display:flex;align-items:center;gap:8px}
.next-container{max-width:1200px;margin:0 auto;padding:16px}main{padding:24px}</style></head>
<body><header id="head"><nav class="header-nav"><a href="https://www.nexusmods.com/auth/sign_out" style="display:none">Log out</a></nav></header>
${body}</body></html>`;

// Today's mod page: the content column the modlist deck belongs in.
const MODERN_MOD_PAGE = page(`<div id="mainContent"><div class="relative"><div class="next-container">
<section id="section" data-game-id="1704"><h1>Test mod</h1><p>Fixture page.</p></section></div></div></div>`);

// Upsells as Nexus marks them, next to markup the page owns: an icon the page itself keeps out of the
// accessibility tree and a card it explicitly exposes.
const UPSELL_PAGE = page(`<div id="nonPremiumBanner" style="height:90px">Go Premium</div>
<div id="mainContent"><div class="ads-holder clearfix ads-top"><div data-testid="ad-top" style="height:90px"></div></div>
<section id="section" data-game-id="1704"><main><h1>Test mod</h1><p>Fixture page.</p>
<span class="icon-premium-star" aria-hidden="true">★</span>
<aside class="upsell-card" aria-hidden="false" style="height:120px">Upgrade</aside></main></section></div>`);

const nexusArchive = (modId, fileId, name) => ({
  Name: `${name}.7z`, Size: 2048,
  State: { $type: 'NexusDownloader, Wabbajack.Lib', GameName: 'SkyrimSpecialEdition', ModID: modId, FileID: fileId, Name: name }
});
const MODLIST = storedZip([{
  name: 'modlist',
  data: JSON.stringify({
    Name: 'QA Modlist', Author: 'QA', Version: '1.0.0', GameType: 'SkyrimSpecialEdition',
    Archives: [
      nexusArchive(266, 1000, 'Cool Mod'),
      nexusArchive(267, 1001, 'Other Mod'),
      { Name: 'FromGoogleDrive.7z', State: { $type: 'GoogleDriveDownloader+State, Wabbajack.Lib', Id: 'abc' } }
    ]
  })
}]);

// The page as the site built it: every element outside the extension's own UI, with all its attributes.
// The body and root carry the scroll locks a modal can leave behind, so they are part of it too.
const hostSignature = (target) => target.evaluate(() => {
  const ours = (el) => el.id.startsWith('nxtk-') || [...el.classList].some((name) => name.startsWith('nxtk-'));
  const describe = (el) => `${el.tagName} ${[...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(' ')}`;
  const lines = [describe(document.documentElement), describe(document.body)];
  const walk = (el, depth) => {
    for (const child of el.children) {
      if (ours(child)) continue;
      lines.push(`${'  '.repeat(depth)}${describe(child)}`);
      walk(child, depth + 1);
    }
  };
  walk(document.body, 0);
  return lines.join('\n');
});

let ctx;
let pageErrors;
test.beforeAll(async () => { ctx = await launchExtension(); });
test.afterAll(async () => { await closeExtension(ctx); });
test.beforeEach(async () => {
  await resetStorage(ctx, { nxtk_settings: { AutoErrorReports: false, WabbajackImport: true } });
  pageErrors = [];
});
test.afterEach(async () => {
  for (const open of ctx.pages()) await open.close();
  expect(pageErrors, 'no uncaught errors on any page').toEqual([]);
});

async function nexusPage(url, html = null) {
  const tab = await ctx.newPage();
  tab.on('pageerror', (error) => pageErrors.push(`${url}: ${error.message}`));
  await tab.setViewportSize({ width: 1280, height: 900 });
  if (html) await tab.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await tab.goto(url);
  await expect(tab.locator('#nxtk-settings-fab')).toBeVisible({ timeout: 30000 });
  return tab;
}

// Picks the modlist in the file dialog the importer opens and accepts the summary it shows.
async function importModlist(tab, trigger) {
  const chooser = tab.waitForEvent('filechooser');
  await trigger.click();
  await (await chooser).setFiles({ name: 'QA Modlist.wabbajack', mimeType: 'application/octet-stream', buffer: MODLIST });
  const summary = tab.locator('.nxtk-alert-modal');
  await expect(summary).toContainText(/2 of the 3 archives in QA Modlist/);
  await summary.locator('.nxtk-alert-ok').click();
}

test('Wabbajack modlist on a mod page: the deck mounts in the content column and closing it restores the page', async () => {
  const tab = await nexusPage(MOD_URL, MODERN_MOD_PAGE);
  const before = await hostSignature(tab);

  await tab.locator('#nxtk-settings-fab').click();
  await importModlist(tab, tab.locator('#nxtk-settings-modal #nxtk-wj-import'));

  const deck = tab.locator('.nxtk-deck');
  await expect(deck).toHaveCount(1);
  await expect(deck).toContainText('QA Modlist');
  await expect(tab.locator('#nxtk-settings-modal'), 'the settings dialog made way for the deck').toHaveCount(0);
  expect(await deck.evaluate((el) => el.parentElement.matches('#mainContent .next-container')),
    'the deck sits in the page content column, not on the bare strip above it').toBe(true);
  for (const id of ['#nxtk-update-collection', '#nxtk-dl-mandatory', '#nxtk-dl-optional']) {
    await expect(deck.locator(id), `a modlist has no ${id}`).toHaveCount(0);
  }
  await settle(tab);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    'the deck does not widen the page').toBeLessThanOrEqual(1);

  await deck.locator('.nxtk-deck-close').click();
  await expect(tab.locator('.nxtk-deck')).toHaveCount(0);
  await expect(tab.locator('.nxtk-modal-backdrop')).toHaveCount(0);
  expect(await hostSignature(tab), 'the page is exactly as it was before the import').toBe(before);
  expect(await readStorage(ctx, 'nxtk_error_log') || [], 'an import and a close are not errors').toEqual([]);
});

test('Wabbajack modlist on a collection page: it replaces the collection deck in place, and closing it brings that deck back', async () => {
  const tab = await nexusPage(COLLECTION_URL);
  const collectionDeck = tab.locator('#nxtk-control-deck');
  await expect(collectionDeck.locator('#nxtk-dl-mandatory')).toHaveCount(1, { timeout: 30000 });
  const slot = await collectionDeck.evaluate((el) => ({ parent: el.parentElement.className, index: [...el.parentElement.children].indexOf(el) }));

  await importModlist(tab, collectionDeck.locator('#nxtk-wj-deck-import'));
  const decks = tab.locator('.nxtk-deck');
  await expect(decks.filter({ hasText: 'QA Modlist' })).toHaveCount(1);
  await expect(decks, 'one deck on the page, never the modlist next to the collection').toHaveCount(1);
  expect(await decks.evaluate((el) => ({ parent: el.parentElement.className, index: [...el.parentElement.children].indexOf(el) })),
    'the modlist took the collection deck\'s place').toEqual(slot);

  await decks.locator('.nxtk-deck-close').click();
  await expect(tab.locator('#nxtk-control-deck #nxtk-dl-mandatory'), 'the collection deck is back').toHaveCount(1, { timeout: 15000 });
  await expect(decks).toHaveCount(1);
  await expect(decks).not.toContainText('QA Modlist');
});

test('Hide ads and Premium panels: switched from the popup, the page is restored exactly, attributes it set itself included', async () => {
  await resetStorage(ctx, { nxtk_settings: { AutoErrorReports: false, HidePremiumUpsells: false } });
  const tab = await nexusPage(MOD_URL, UPSELL_PAGE);
  const pristine = await hostSignature(tab);
  const upsells = ['#nonPremiumBanner', '.ads-holder', '.icon-premium-star', '.upsell-card'];
  const content = tab.locator('main h1');
  const contentBox = await content.boundingBox();

  const popup = await extensionPage(ctx, 'popup/popup.html');
  await popup.setViewportSize({ width: 380, height: 600 });
  const toggle = popup.locator('input[data-key="HidePremiumUpsells"]');
  await expect(toggle).not.toBeChecked();
  const flip = async (on) => {
    await popup.locator('label.popup-toggle-row', { has: toggle }).click();
    await expect(toggle).toBeChecked({ checked: on });
    await expect.poll(async () => (await readStorage(ctx, 'nxtk_settings'))?.HidePremiumUpsells).toBe(on);
  };

  await flip(true);
  for (const selector of upsells) await expect(tab.locator(selector), `${selector} is hidden`).toBeHidden();
  await expect(content, 'the page content stays').toBeVisible();
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await flip(false);
  for (const selector of upsells) await expect(tab.locator(selector), `${selector} is back`).toBeVisible();
  expect(await hostSignature(tab), 'switching off leaves the page as it was served').toBe(pristine);
  await settle(tab);
  expect(await content.boundingBox(), 'and the content where it was').toEqual(contentBox);

  await flip(true);
  for (const selector of upsells) await expect(tab.locator(selector), `${selector} is hidden again`).toBeHidden();
  await flip(false);
  expect(await hostSignature(tab), 'a second round trip changes nothing either').toBe(pristine);
});

test('popup: the section tabs follow the ARIA tab pattern, and each action opens the right page', async () => {
  const id = await extensionId(ctx);
  const popup = await extensionPage(ctx, 'popup/popup.html');
  popup.on('pageerror', (error) => pageErrors.push(`popup: ${error.message}`));
  await popup.setViewportSize({ width: 380, height: 600 });
  const tabs = { controls: popup.locator('#tabControls'), help: popup.locator('#tabHelp') };
  const panels = { controls: popup.locator('#panelControls'), help: popup.locator('#panelHelp') };
  const expectSelected = async (name) => {
    const other = name === 'controls' ? 'help' : 'controls';
    await expect(tabs[name]).toHaveAttribute('aria-selected', 'true');
    await expect(tabs[name]).toHaveAttribute('tabindex', '0');
    await expect(tabs[name]).toBeFocused();
    await expect(tabs[other]).toHaveAttribute('aria-selected', 'false');
    await expect(tabs[other], 'one tab stop for the whole list').toHaveAttribute('tabindex', '-1');
    await expect(panels[name]).toBeVisible();
    await expect(panels[other]).toBeHidden();
  };

  await tabs.controls.focus();
  await expectSelected('controls');
  for (const [key, expected] of [['ArrowRight', 'help'], ['ArrowRight', 'controls'], ['ArrowLeft', 'help'], ['Home', 'controls'], ['End', 'help']]) {
    await popup.keyboard.press(key);
    await expectSelected(expected);
  }

  const opened = async (button) => {
    const [next] = await Promise.all([ctx.waitForEvent('page'), button.click()]);
    await next.waitForLoadState('domcontentloaded');
    next.on('pageerror', (error) => pageErrors.push(`${next.url()}: ${error.message}`));
    return next;
  };
  const debug = await opened(popup.locator('#openDebugLog'));
  expect(debug.url()).toBe(`chrome-extension://${id}/debug-page/debug.html`);
  await expect(debug.locator('#dbLog')).toBeAttached();
  await expect(debug.locator('#dbVersion')).not.toHaveText('v—');

  const report = await opened(popup.locator('#sendReport'));
  expect(report.url()).toBe(`chrome-extension://${id}/report-page/report.html`);
  await expect(report.locator('#rpPreview'), 'the report opens with its redacted preview').toContainText('schema');

  // Home and End belong to the tab list: from a button in a panel they do nothing.
  await popup.keyboard.press('Home');
  await expect(tabs.help).toHaveAttribute('aria-selected', 'true');
  await tabs.help.focus();
  await popup.keyboard.press('Home');
  await expectSelected('controls');
  const nexus = await opened(popup.locator('#openSettings'));
  await expect(nexus.locator('#nxtk-settings-modal'), 'Page settings opens the in-page settings').toBeVisible({ timeout: 30000 });
  await expect.poll(() => new URL(nexus.url()).hash, { message: 'and drops the hash' }).toBe('');

  // Only Nexus and the extension's own pages were asked for anything.
  expect(blockedRequests(ctx).filter((url) => !/^https:\/\/([a-z-]+\.)?nexusmods\.com\//.test(url))).toEqual([]);
});

// Every issue filed from the popup was a bug: "Report on GitHub" opened the bug form only, so a
// feature request came in labelled bug (issue #29). The button opens a menu: a bug report is an issue
// with its diagnostics, an idea or a question a new GitHub discussion in its category.
test('popup: Report on GitHub opens a menu: a bug report, or an idea or a question in Discussions', async () => {
  // GitHub answers with a stub, so nothing leaves the test and no request counts as blocked.
  await ctx.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>GitHub</title>' }));
  try {
    const popup = await extensionPage(ctx, 'popup/popup.html');
    popup.on('pageerror', (error) => pageErrors.push(`popup: ${error.message}`));
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.locator('#tabHelp').click();
    const button = popup.locator('#reportBug');
    const menu = popup.locator('#githubReportMenu');
    const items = menu.getByRole('menuitem');
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();

    await button.click();
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toBeFocused();
    for (const [key, index] of [['ArrowDown', 1], ['End', 2], ['ArrowDown', 0], ['ArrowUp', 2], ['Home', 0]]) {
      await popup.keyboard.press(key);
      await expect(items.nth(index)).toBeFocused();
    }
    const box = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: document.documentElement.clientWidth,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(box.left, 'the menu stays inside the popup').toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
    expect(box.overflowX).toBeLessThanOrEqual(0);
    await popup.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    await popup.keyboard.press('ArrowDown');
    await expect(menu, 'ArrowDown on the button opens it too').toBeVisible();
    // The open menu covers the help text below it, so "elsewhere" is the tab bar above.
    await popup.locator('#tabHelp').click();
    await expect(menu, 'a click elsewhere closes it').toBeHidden();

    // What the new tab asks GitHub for (the offline harness never commits that navigation).
    const pick = async (index) => {
      await button.click();
      const [request] = await Promise.all([
        ctx.waitForEvent('request', { predicate: (r) => r.url().startsWith('https://github.com/'), timeout: 15000 }),
        items.nth(index).click()
      ]);
      await expect(menu).toBeHidden();
      return new URL(request.url());
    };
    for (const [index, category] of [[1, 'ideas'], [2, 'q-a']]) {
      const url = await pick(index);
      expect(`${url.origin}${url.pathname}`).toBe('https://github.com/thomasthanos/nexusmods-bypass/discussions/new');
      expect(url.searchParams.get('category')).toBe(category);
    }
    const bug = await pick(0);
    expect(bug.searchParams.get('template'), 'a bug report keeps its prefilled diagnostics').toBe('nexus_bug_report.yml');
    expect(bug.searchParams.get('title')).toBe('[Bug] ');
  } finally {
    await ctx.unroute('https://github.com/**');
  }
});
