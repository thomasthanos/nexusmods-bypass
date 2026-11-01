// Real settings modal + storage + shared helpers. Only browser APIs are supplied by the fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/_locales/en/messages.json'), 'utf8'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

function fixture(locale = 'en', { userAgent = '', html = '<!doctype html><body><button id="opener">Settings</button></body>' } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: userAgent, configurable: true });
  const observers = [];
  const NativeObserver = w.MutationObserver;
  w.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const store = {};
  const messages = JSON.parse(fs.readFileSync(path.join(root, `src/_locales/${locale}/messages.json`), 'utf8'));
  w.chrome = {
    runtime: {
      id: 'settings-test', lastError: null, getManifest: () => ({ version: '3.1.0' }),
      sendMessage: (message, callback) => {
        if (message.type === 'SETTINGS_PATCH' || message.type === 'SETTINGS_RESET') {
          const next = message.type === 'SETTINGS_RESET' ? { ...w.NXTK.DEFAULTS }
            : { ...w.NXTK.DEFAULTS, ...store.nxtk_settings, ...message.payload.patch };
          store.nxtk_settings = next;
          callback({ ok: true, value: next });
        } else callback({ ok: false, error: 'fixture does not load optional bundles' });
      }
    },
    storage: {
      local: {
        get: (key, callback) => callback({ [key]: store[key] }),
        set: (values, callback) => { Object.assign(store, values); callback?.(); }
      }, onChanged: { addListener() {} }
    },
    i18n: {
      getMessage: (key, args = []) => (messages[key]?.message || en[key]?.message || '').replace(/\$(\d+)/g, (_, n) => args[Number(n) - 1] || ''),
      getUILanguage: () => locale
    }
  };
  for (const file of ['src/lib/shared.js', 'src/content/storage.js', 'src/content/ui.js', 'src/content/ui-settings.js']) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  const modal = () => w.document.querySelector('#nxtk-settings-modal .nxtk-modal');
  return { w, store, modal, close: () => { observers.forEach((o) => o.disconnect()); dom.window.close(); } };
}

async function popupRegressionTests() {
  const html = fs.readFileSync(path.join(root, 'src/popup/popup.html'), 'utf8');
  for (const failFirst of [true, false]) {
    const f = fixture('el', { html });
    try {
      const pending = [];
      const send = f.w.chrome.runtime.sendMessage;
      f.w.NXTK.prepareRatingPrompt = async () => null;
      f.w.chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'SETTINGS_PATCH') {
          pending.push((ok) => ok ? send(message, callback) : callback({ ok: false, error: 'write-rejected' }));
        } else send(message, callback);
      };
      f.w.eval(fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8'));
      await tick();
      const input = f.w.document.querySelector('[data-key="ForceEnglish"]');
      const change = (checked) => {
        input.checked = checked;
        input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      };
      change(true);
      change(false);
      await tick();
      assert.equal(pending.length, 1, 'popup writes wait for the previous reply');
      pending.shift()(!failFirst);
      await tick();
      assert.equal(input.checked, false, 'an older reply preserves the newer visible choice');
      assert.equal(pending.length, 1, 'the next choice is saved after the first settles');
      pending.shift()(failFirst);
      await tick();
      const expected = !failFirst;
      assert.equal(input.checked, expected, 'the final switch matches the last successfully saved value');
      assert.equal(f.store.nxtk_settings.ForceEnglish, expected);
      assert.equal(f.w.document.documentElement.lang, expected ? 'en' : 'el', 'language metadata follows the saved setting');
    } finally { f.close(); }
  }
  console.log('Popup settings regressions OK: ordered saves, rejected writes and language metadata');
}

async function onboardingRegressionTests() {
  const html = fs.readFileSync(path.join(root, 'src/onboarding/welcome.html'), 'utf8');
  const f = fixture('en', { html });
  try {
    const pending = [];
    f.w.chrome.storage.local.get = (key, callback) => pending.push(() => callback({ [key]: { ...f.w.NXTK.DEFAULTS, DownloadFolder: 'Old folder' } }));
    f.w.eval(fs.readFileSync(path.join(root, 'src/onboarding/welcome.js'), 'utf8'));
    const form = f.w.document.getElementById('setupForm');
    const browser = form.querySelector('[name="method"][value="browser"]');
    browser.checked = true;
    browser.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    const folder = f.w.document.getElementById('setupFolder');
    folder.value = 'New folder';
    folder.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const closeTab = f.w.document.getElementById('setupCloseTab');
    closeTab.checked = false;
    closeTab.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    pending.forEach((release) => release());
    assert.equal(browser.checked, true, 'late onboarding settings never reset a method the user chose');
    assert.equal(folder.value, 'New folder', 'late onboarding settings preserve a folder already being typed');
    assert.equal(closeTab.checked, false, 'late onboarding settings preserve the user\'s close-tab choice');
    form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(f.store.nxtk_settings.NDC_downloadMethod, 1);
    assert.equal(f.store.nxtk_settings.DownloadFolder, 'New folder', 'Save uses the user\'s choices rather than the late prefill');
    console.log('Onboarding late-prefill regression OK');
  } finally { f.close(); }
}

async function collectionSelectionRegressionTests() {
  const cases = [
    { label: 'ASCII', names: ['Alpha package', 'Beta package'], uris: ['alpha-package-1.7z', 'beta-package-2.7z'], imported: 'alpha-package-1.7z' },
    { label: 'Greek', names: ['Άλφα', 'Βήτα'], uris: ['Άλφα-1234.7z', 'Βήτα-1234.7z'], imported: 'Άλφα-1234.7z' },
    { label: 'Japanese/Korean', names: ['日本語', '한국어'], uris: ['日本語-1234.7z', '한국어-1234.7z'], imported: '日本語-1234.7z' },
    { label: 'canonical Unicode', names: ['Café', 'Other'], uris: ['Cafe\u0301-1234.7z', 'Other-5678.7z'], imported: 'Café-1234.7z' }
  ];
  for (const entry of cases) {
    const f = fixture();
    try {
      for (const file of ['src/content/errors.js', 'src/content/ndc.js', 'src/content/ui-collection.js']) {
        f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      const ndc = new f.w.NexusExt.NDC('skyrimspecialedition', 'abc');
      ndc.mods.all = [
        { fileId: 101, file: { fileId: 101, name: entry.names[0], uri: entry.uris[0], size: 1024, mod: { modId: 1, name: 'Alpha' } } },
        { fileId: 102, file: { fileId: 102, name: entry.names[1], uri: entry.uris[1], size: 1024, mod: { modId: 2, name: 'Beta' } } }
      ];
      ndc.mods.mandatory = ndc.mods.all;
      const deck = f.w.NexusExt.UI.createControlDeck(ndc);
      f.w.document.body.appendChild(deck);
      deck.querySelector('#nxtk-select-mods').click();
      await tick();
      const picker = f.w.document.getElementById('nxtk-select-modal');
      picker.querySelector('#nxtk-sel-all').click();
      assert.equal(picker.querySelectorAll('.nxtk-mod-item.nxtk-selected').length, 2);
      let input;
      const click = f.w.HTMLInputElement.prototype.click;
      f.w.HTMLInputElement.prototype.click = function () { if (this.type === 'file') input = this; else click.call(this); };
      picker.querySelector('#nxtk-import-dl-mods').click();
      Object.defineProperty(input, 'files', { value: [{ name: entry.imported }] });
      input.dispatchEvent(new f.w.Event('change'));
      const selected = [...picker.querySelectorAll('.nxtk-mod-item.nxtk-selected')].map((row) => row.dataset.fileId);
      assert.deepEqual(selected, ['102'], `${entry.label}: importing an archive removes only that file, preserving different names with the same numeric suffix`);
      assert.match(f.w.document.querySelector('.nxtk-alert-modal').textContent, /Selected 1 mod/);
      let historyPatch;
      f.w.NexusExt.Storage.mergeCollectionHistory = async (payload) => { historyPatch = payload; };
      deck.querySelector('#nxtk-import-mods').click();
      Object.defineProperty(input, 'files', { value: [{ name: entry.imported }] });
      input.dispatchEvent(new f.w.Event('change'));
      await tick();
      assert.deepEqual([...historyPatch.lists.all], [101], `${entry.label}: only the archive actually imported is marked downloaded in history`);
    } finally { f.close(); }
  }
  console.log('Collection downloaded-file selection regressions OK: ASCII, Unicode identity and canonical normalization');
}

// QA on 2026-11-01: "Import downloaded mods" matched 44 of a collection's 53 files, all 53 on disk. A newer
// Nexus file's API uri is a content address (d6/87/9c/<uuid>), not its name, so it matched by its file name
// followed by digits only. 3.3.7 saved such a file as "<mod name>-<file id>", and a mod's name is often not
// its file's ("…Dual Wield Normal and Power Attacks" for the file "…Dual Wield Attacks"); Nexus's own
// name, "<file name>-<mod id>-<version>-<time>", has letters in many versions ("1-0a").
async function importRecognizesSavedNamesTests() {
  const f = fixture();
  try {
    for (const file of ['src/content/errors.js', 'src/content/ndc.js', 'src/content/ui-collection.js']) {
      f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    const ndc = new f.w.NexusExt.NDC('skyrimspecialedition', 'verolevi');
    const mod = (fileId, name, uri, modId, modName) => ({ fileId, file: { fileId, name, uri, size: 1024, mod: { modId, name: modName } } });
    ndc.mods.all = [
      mod(798362, 'Vanargand Animations - Dual Wield Attacks', 'd6/87/9c/d6879c21-5ebd-4d6f-b8cc-7756784d7d65', 59737,
        'Vanargand Animations - Dual Wield Normal and Power Attacks'),
      mod(794557, 'Goetia Animations - Sneak Magic', '24/cf/bb/24cfbb67-3a72-43ca-9371-e1ed2be5e4f4', 68005, 'Goetia Animations'),
      mod(51507, 'Conditional Armor Type Animations', 'Conditional Armor Type Animations-51507-1-3c-1687702364.7z', 51507, 'CATA')
    ];
    ndc.mods.mandatory = ndc.mods.all;
    const deck = f.w.NexusExt.UI.createControlDeck(ndc);
    f.w.document.body.appendChild(deck);
    let input;
    const click = f.w.HTMLInputElement.prototype.click;
    f.w.HTMLInputElement.prototype.click = function () { if (this.type === 'file') input = this; else click.call(this); };
    let historyPatch;
    f.w.NexusExt.Storage.mergeCollectionHistory = async (payload) => { historyPatch = payload; };
    deck.querySelector('#nxtk-import-mods').click();
    Object.defineProperty(input, 'files', { value: [
      { name: 'Vanargand Animations - Dual Wield Normal and Power Attacks-798362.zip' },
      { name: 'Goetia Animations - Sneak Magic-68005-1-0a-1745000000.7z' },
      { name: 'Conditional Armor Type Animations-51507-1-3c-1687702364.7z' },
      { name: 'Goetia Animations - Sneak Magic-99999-1-0a-1745000000.7z' },
      { name: 'Some Other Mod-123.zip' }
    ].map((entry) => ({ ...entry })) });
    input.dispatchEvent(new f.w.Event('change'));
    await tick();
    assert.deepEqual([...historyPatch.lists.all], [798362, 794557, 51507], 'each collection file by the name it was saved under');
    const alert = f.w.document.querySelector('.nxtk-alert-modal').textContent;
    assert.match(alert, /Imported 3 of 3/);
    assert.match(alert, /2 selected files did not match/, 'another mod\'s file of the same name is not this one');
  } finally { f.close(); }
  console.log('Import: names 3.3.7 and Nexus give a file are recognized OK');
}

// QA on 2026-11-01: the deck's menu button had no accessible name, and a closed menu's items stayed in the
// accessibility tree (only made transparent), where screen readers and automation still found them.
async function deckMenuAccessibilityTests() {
  for (const locale of ['en', 'el']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `src/_locales/${locale}/messages.json`), 'utf8'));
    const say = (key) => (messages[key] || en[key])?.message;
    const f = fixture(locale);
    try {
      for (const file of ['src/content/errors.js', 'src/content/ndc.js', 'src/content/ui-collection.js']) {
        f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      const ndc = new f.w.NexusExt.NDC('skyrimspecialedition', 'menus');
      const deck = f.w.NexusExt.UI.createControlDeck(ndc);
      f.w.document.body.appendChild(deck);
      const toggle = deck.querySelector('#nxtk-menu-toggle');
      assert.ok(say('ariaMoreDownloadOptions'), 'the label is a message of its own');
      assert.equal(toggle.getAttribute('aria-label'), say('ariaMoreDownloadOptions'), `${locale}: the menu button is named`);
      const menu = () => f.w.document.getElementById('nxtk-dl-menu');
      assert.ok(menu().hasAttribute('inert'), `${locale}: a closed menu is out of reach`);
      toggle.click();
      await tick();
      assert.ok(menu().classList.contains('nxtk-open'));
      assert.ok(!menu().hasAttribute('inert'), 'an open one is not');
      toggle.click();
      await tick();
      assert.ok(menu().hasAttribute('inert'), 'and closed again, it is out of reach again');
      deck.querySelector('#nxtk-select-mods').click();
      await tick();
      const options = f.w.document.getElementById('nxtk-sel-opts-toggle');
      assert.equal(options.getAttribute('aria-label'), say('ariaSelectionOptions'), `${locale}: the picker's options button is named`);
      assert.ok(f.w.document.getElementById('nxtk-sel-opts-menu').hasAttribute('inert'), 'its closed menu is out of reach too');
    } finally { f.close(); }
  }
  console.log('Deck menus: named buttons, closed menus out of reach (en, el) OK');
}

// The end-of-run card. A browser run's files were downloaded, not sent; and the collection's files that are
// not on Nexus are listed, an off-site one linked to its page (never a non-web link), a bundled one with
// where it comes from. A Vortex run's card keeps "sent" and has no such list when there is none.
async function runSummaryTests() {
  for (const locale of ['en', 'el']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `src/_locales/${locale}/messages.json`), 'utf8'));
    const say = (key, args = []) => (messages[key] || en[key]).message.replace(/\$(\d+)/g, (_, n) => args[Number(n) - 1]);
    const f = fixture(locale);
    try {
      for (const file of ['src/content/errors.js', 'src/content/ndc.js', 'src/content/ui-collection.js']) {
        f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      const card = () => f.w.document.querySelector('.nxtk-run-summary-modal');
      f.w.NexusExt.UI.showRunSummary({
        method: 'browser',
        sent: [{ name: 'A.7z', pageUrl: '' }],
        skipped: [],
        failed: [],
        offNexus: [
          { name: 'Mod Update Menu', kind: 'offsite', url: 'https://forums.stardewvalley.net/threads/unofficial-mod-updates.2096/' },
          { name: 'Translation bundle', kind: 'bundled', url: '' },
          { name: 'Sneaky', kind: 'offsite', url: 'javascript:alert(1)' }
        ]
      });
      await tick();
      assert.equal(card().querySelector('.nxtk-modal-subtitle').textContent, say('summaryCountsDownloaded', ['1', '0', '0']), `${locale}: counted as downloaded`);
      assert.match(card().querySelector('.nxtk-summary-sent summary').textContent, new RegExp(say('summaryDownloaded')));
      const offNexus = card().querySelector('.nxtk-summary-offnexus');
      assert.ok(offNexus?.open, `${locale}: the files not on Nexus are listed, open`);
      assert.match(offNexus.querySelector('summary').textContent, new RegExp(`3\\s+${say('summaryOffNexus')}`));
      const [site, bundle, sneaky] = offNexus.querySelectorAll('li');
      const link = site.querySelector('a');
      assert.equal(link?.href, 'https://forums.stardewvalley.net/threads/unofficial-mod-updates.2096/');
      assert.equal(link.target, '_blank');
      assert.match(link.rel, /noopener/);
      assert.match(site.textContent, new RegExp(say('summaryOffsiteNote')));
      assert.equal(bundle.querySelector('a'), null);
      assert.match(bundle.textContent, new RegExp(say('summaryBundledNote').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(sneaky.querySelector('a'), null, `${locale}: a link that is not a web page is not a link`);
      card().querySelector('.nxtk-modal-close').click();
      await tick();

      f.w.NexusExt.UI.showRunSummary({ method: 'vortex', sent: [{ name: 'A.7z', pageUrl: '' }], skipped: [], failed: [] });
      await tick();
      assert.equal(card().querySelector('.nxtk-modal-subtitle').textContent, say('summaryCounts', ['1', '0', '0']), `${locale}: a Vortex run sent its files`);
      assert.equal(card().querySelector('.nxtk-summary-offnexus'), null);
    } finally { f.close(); }
  }
  console.log('Run summary: downloaded vs sent, and files not on Nexus (en, el) OK');
}

async function settingsNavigationTests() {
  const f = fixture('el');
  const { w, store, modal } = f;
  try {
    await w.NexusExt.UIKit.settings.open();
    const original = modal();
    const tabs = [...original.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.length, 6, 'six categories replace the wall of settings');
    const select = original.querySelector('#nxtk-settings-category');
    const visible = () => [...modal().querySelectorAll('[role="tabpanel"]')].filter((p) => !p.hidden);
    const activate = (name) => original.querySelector(`[data-settings-tab="${name}"]`).click();
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].dataset.settingsGroup, 'basics', 'Basics opens first');
    assert.equal(tabs.filter((tab) => tab.tabIndex === 0).length, 1);
    assert.equal(select.value, 'basics');
    const scroller = original.querySelector('.nxtk-modal-scroll');
    scroller.scrollTop = 147;
    activate('basics');
    assert.equal(scroller.scrollTop, 147, 'selecting the current category does not jump to the top');

    tabs[0].focus();
    tabs[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(visible()[0].dataset.settingsGroup, 'downloads');
    assert.equal(w.document.activeElement, tabs[1]);
    assert.equal(select.value, 'downloads');
    assert.equal(original.querySelector('[data-settings-details="browser"]').open, false);
    assert.equal(original.querySelector('[data-settings-details="vortex"]').open, false);
    const browserDetails = original.querySelector('[data-settings-details="browser"]');
    browserDetails.open = true;
    const folder = original.querySelector('[data-setting="DownloadFolder"]');
    const speed = original.querySelector('[data-setting="NDC_downloadSpeed"]');
    const edit = (input, value) => {
      input.value = value;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    edit(folder, '  Category test  ');
    edit(speed, '7.5');
    activate('basics');
    assert.equal(scroller.scrollTop, 147, 'each category restores its scroll position');
    await tick();
    assert.equal(store.nxtk_settings.DownloadFolder, 'Category test', 'switching category commits pending text');
    assert.equal(store.nxtk_settings.NDC_downloadSpeed, 7.5, 'switching category commits pending numbers');
    const help = original.querySelector('[data-setting-help="AutoStartDownload"]');
    help.click();
    activate('downloads');
    assert.equal(browserDetails.open, true, 'subsections survive category changes');
    assert.equal(original.querySelector('[data-setting="DownloadFolder"]'), folder, 'inputs are never replaced');
    activate('basics');
    assert.equal(help.getAttribute('aria-expanded'), 'true', 'open help survives category changes');

    select.value = 'appearance';
    select.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(visible()[0].dataset.settingsGroup, 'appearance', 'mobile selector uses the same category state');
    assert.equal(tabs[3].getAttribute('aria-selected'), 'true');
    assert.equal(visible().length, 1);
    const language = original.querySelector('[data-setting="ForceEnglish"]');
    language.checked = true;
    language.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    assert.equal(visible()[0].dataset.settingsGroup, 'appearance', 'language refresh stays in the current category');
    assert.equal(modal().querySelector('#nxtk-settings-category').value, 'appearance');
    assert.match(visible()[0].textContent, /Always use English/);
  } finally { f.close(); }
  console.log('Settings categories OK: keyboard, mobile selection, pending saves, stable controls and language state');
}

async function settingsRegressionTests() {
  const failures = [];
  const cases = [
    ['latest manual choice wins during a delayed preset', async (f) => {
      const send = f.w.chrome.runtime.sendMessage;
      let release;
      f.w.chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'SETTINGS_PATCH' && 'NDC_downloadMethod' in message.payload.patch && !release) {
          release = () => send(message, callback);
        } else send(message, callback);
      };
      f.modal().querySelector('[data-preset="browser"]').click();
      await tick();
      assert.ok(release, 'the first preset write is held in flight');
      const input = f.modal().querySelector('[data-setting="AutoCloseTab"]');
      input.checked = true;
      input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      release();
      await tick();
      assert.equal(f.store.nxtk_settings.AutoCloseTab, true, 'later manual choice stays saved');
      assert.equal(input.checked, true, 'later manual choice stays visible');
      assert.match(f.modal().querySelector('#nxtk-preset-note').textContent, /Custom/);
    }],
    ['a preset is saved in one write', async (f) => {
      // Saved one setting at a time, the Browser preset could be read (and left, if the tab closed)
      // with the new download method and the old "close the tab" choice.
      const send = f.w.chrome.runtime.sendMessage;
      const patches = [];
      f.w.chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'SETTINGS_PATCH') patches.push(message.payload.patch);
        send(message, callback);
      };
      f.modal().querySelector('[data-preset="browser"]').click();
      await tick();
      assert.equal(patches.length, 1, 'one write for the whole preset');
      assert.deepEqual({ ...patches[0] }, { NDC_downloadMethod: 1, AutoCloseTab: false }, 'with every setting it changes');
      assert.equal(f.store.nxtk_settings.NDC_downloadMethod, 1);
      assert.equal(f.store.nxtk_settings.AutoCloseTab, false);
    }],
    ['a rejected preset rolls every setting back', async (f) => {
      const send = f.w.chrome.runtime.sendMessage;
      f.w.chrome.runtime.sendMessage = (message, callback) => message.type === 'SETTINGS_PATCH'
        ? callback({ ok: false, error: 'write-rejected' }) : send(message, callback);
      f.modal().querySelector('[data-preset="browser"]').click();
      await tick();
      assert.equal(f.modal().querySelector('[data-setting="AutoCloseTab"]').checked, true, 'the switch shows the saved value again');
      assert.ok(f.modal().querySelector('[data-preset="vortex"]').classList.contains('nxtk-preset-active'), 'and the preset that is really saved');
      assert.ok(f.w.document.querySelector('[role="alertdialog"]'), 'the failure is visible');
    }],
    ['rejected save restores the saved value and shows an explanation', async (f) => {
      const send = f.w.chrome.runtime.sendMessage;
      f.w.chrome.runtime.sendMessage = (message, callback) => message.type === 'SETTINGS_PATCH'
        ? callback({ ok: false, error: 'write-rejected' }) : send(message, callback);
      const input = f.modal().querySelector('[data-setting="AutoStartDownload"]');
      input.checked = false;
      input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      await tick();
      assert.equal(input.checked, true, 'unsaved switch rolls back');
      assert.equal((f.store.nxtk_settings || f.w.NXTK.DEFAULTS).AutoStartDownload, true);
      const alert = f.w.document.querySelector('[role="alertdialog"]');
      assert.ok(alert, 'write failure is visible');
      assert.match(alert.textContent, /could not be saved/i);
    }],
    ['rejected reset leaves settings open and unchanged', async (f) => {
      const send = f.w.chrome.runtime.sendMessage;
      f.w.chrome.runtime.sendMessage = (message, callback) => message.type === 'SETTINGS_RESET'
        ? callback({ ok: false, error: 'reset-rejected' }) : send(message, callback);
      f.modal().querySelector('[data-reset]').click();
      await tick();
      f.w.document.querySelector('#nxtk-confirm-modal [data-close="confirm"]').click();
      await tick();
      assert.ok(f.modal(), 'failed reset must not close settings or reload');
      assert.equal(f.store.nxtk_settings.DownloadFolder, 'Custom-folder');
      assert.ok(f.w.document.querySelector('[role="alertdialog"]'), 'reset failure is visible');
    }],
    ['cancel and Escape restore focus to Restore defaults', async (f) => {
      const button = f.modal().querySelector('[data-reset]');
      for (const cancel of ['button', 'Escape']) {
        button.focus();
        button.click();
        await tick();
        const confirm = f.w.document.querySelector('#nxtk-confirm-modal');
        if (cancel === 'button') confirm.querySelector('[data-close="cancel"]').click();
        else f.w.document.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await tick();
        assert.equal(f.w.document.activeElement, button, `${cancel} returns focus to the opener`);
      }
    }]
  ];
  for (const [name, run] of cases) {
    const f = fixture();
    try {
      f.store.nxtk_settings = { ...f.w.NXTK.DEFAULTS, DownloadFolder: 'Custom-folder' };
      await f.w.NexusExt.UIKit.settings.open();
      await run(f);
      console.log(`Settings regression OK: ${name}`);
    } catch (error) {
      console.error(`Settings regression FAILED: ${name}: ${error.message}`);
      failures.push(name);
    } finally { f.close(); }
  }
  assert.equal(failures.length, 0, failures.join('; '));
}

(async () => {
  const newRegressions = await Promise.allSettled([onboardingRegressionTests(), collectionSelectionRegressionTests()]);
  const failures = newRegressions.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Onboarding/collection selection regressions failed');
  await popupRegressionTests();
  await runSummaryTests();
  await importRecognizesSavedNamesTests();
  await deckMenuAccessibilityTests();
  await settingsNavigationTests();
  await settingsRegressionTests();
  const f = fixture();
  const { w, store, modal } = f;
  const find = (selector) => modal().querySelector(selector);
  const change = (key, value, type = 'change') => {
    const input = find(`[data-setting="${key}"]`);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  try {
    await w.NexusExt.UIKit.settings.open();
    const groups = {
      basics: ['AutoStartDownload', 'SkipRequirements', 'ShowAlertsOnError'],
      downloads: ['HandleArchivedFiles', 'DownloadFolder', 'WriteMo2Meta', 'AutoCloseTab', 'CloseTabDelay', 'NDC_downloadSpeed', 'NDC_pauseBetweenDownload'],
      collections: ['WabbajackImport', 'HideDownloadPopup', 'NDC_smallestFirst', 'FollowUpdatePolicy', 'ShowModActions'],
      appearance: ['HidePremiumUpsells', 'ExpandRequirements', 'ForceEnglish'],
      diagnostics: ['AutoErrorReports', 'PrivateDiagnostics'],
      advanced: ['RequestTimeout', 'UseOfficialApi', 'CloudflareFallback']
    };
    for (const [group, keys] of Object.entries(groups)) {
      const section = find(`[data-settings-group="${group}"]`);
      assert.ok(section, `${group} has its own readable group`);
      assert.deepEqual([...section.querySelectorAll('[data-setting]')].map((el) => el.dataset.setting), keys);
    }
    assert.equal(find('[data-settings-group="advanced"]').hidden, true);
    assert.equal(modal().querySelectorAll('[data-setting]').length, 23, 'all settings appear exactly once');
    assert.equal(new Set([...modal().querySelectorAll('[data-setting]')].map((el) => el.dataset.setting)).size, 23);
    for (const input of modal().querySelectorAll('[data-setting]')) {
      assert.ok(input.labels?.length || input.getAttribute('aria-labelledby'), `${input.dataset.setting} has an accessible label`);
    }

    // Reporting belongs in Privacy & reports, leaving only reset and Done in the footer.
    const idea = find('[data-settings-group="diagnostics"] [data-suggest-idea]');
    assert.ok(idea, 'Suggest an idea sits in Privacy & reports');
    assert.equal(idea.closest('.nxtk-settings-github'), find('[data-report-issue]').closest('.nxtk-settings-github'),
      'beside Report a bug');
    assert.equal(idea.getAttribute('href'), 'https://github.com/thomasthanos/nexusmods-bypass/discussions/new?category=ideas');
    assert.equal(idea.getAttribute('target'), '_blank');
    assert.match(idea.getAttribute('rel'), /noopener/);
    assert.match(idea.textContent, /Suggest an idea/);
    assert.equal(find('.nxtk-modal-footer').children.length, 2, 'the footer has only reset and Done');

    // Help opens separately: tapping information must never change the neighbouring setting.
    const row = find('[data-key="AutoStartDownload"]');
    const help = row.querySelector('[data-setting-help]');
    const detail = w.document.getElementById(help.getAttribute('aria-controls'));
    const before = row.querySelector('input').checked;
    assert.equal(detail.hidden, true);
    help.click();
    assert.equal(detail.hidden, false);
    assert.equal(help.getAttribute('aria-expanded'), 'true');
    assert.match(detail.textContent, /Nexus file page/);
    assert.equal(row.querySelector('input').checked, before);
    help.click();
    assert.equal(detail.hidden, true);
    assert.equal(help.getAttribute('aria-expanded'), 'false');

    change('AutoStartDownload', false);
    await tick();
    assert.equal(store.nxtk_settings.AutoStartDownload, false);
    assert.match(find('#nxtk-preset-note').textContent, /Custom/);
    change('DownloadFolder', '  Mods & archives  ', 'input');
    find('.nxtk-modal-footer [data-close]').click();
    await tick();
    assert.equal(store.nxtk_settings.DownloadFolder, 'Mods & archives', 'closing flushes a pending folder edit');

    // Issue #34: "D:\mods" as the folder became Downloads\D mods. A full path is not saved, and the field says why.
    await w.NexusExt.UIKit.settings.open();
    const folderInput = find('[data-setting="DownloadFolder"]');
    const folderWarning = find('#nxtk-setting-DownloadFolder-warning');
    assert.equal(folderWarning.hidden, true, 'no warning for a folder name');
    assert.match(folderInput.getAttribute('aria-describedby'), /nxtk-setting-DownloadFolder-warning/);
    change('DownloadFolder', 'D:\\mods');
    await tick();
    assert.equal(folderWarning.hidden, false, 'a full path says why it is not used');
    assert.match(folderWarning.textContent, /D:\\mods is a full path/);
    assert.equal(folderInput.getAttribute('aria-invalid'), 'true');
    assert.equal(store.nxtk_settings.DownloadFolder, '',
      'a finished edit to a full path empties the folder: only the browser can save there, so it places the file');
    change('DownloadFolder', 'Mods');
    await tick();
    assert.equal(folderWarning.hidden, true);
    assert.equal(folderInput.hasAttribute('aria-invalid'), false);
    assert.equal(store.nxtk_settings.DownloadFolder, 'Mods');
    // While a full path is still being typed nothing is stored, so "D" on the way to "D:mods" never is.
    change('DownloadFolder', 'D:', 'input');
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(store.nxtk_settings.DownloadFolder, 'Mods', 'a full path being typed is not stored');
    assert.equal(folderWarning.hidden, false);
    change('DownloadFolder', 'Mods');
    await tick();
    assert.equal(find('#nxtk-setting-DownloadFolder-note'), null, 'no Opera note outside Opera');
    find('.nxtk-modal-footer [data-close]').click();
    await tick();
    // One saved before this check still says so when the dialog opens.
    store.nxtk_settings = { ...store.nxtk_settings, DownloadFolder: 'D:\\mods' };
    await w.NexusExt.UIKit.settings.open();
    assert.equal(find('#nxtk-setting-DownloadFolder-warning').hidden, false);
    assert.equal(find('[data-setting="DownloadFolder"]').getAttribute('aria-invalid'), 'true');
    find('.nxtk-modal-footer [data-close]').click();
    await tick();
    store.nxtk_settings = { ...store.nxtk_settings, DownloadFolder: 'Mods & archives' };

    await w.NexusExt.UIKit.settings.open();
    const sameModal = modal();
    find('[data-settings-tab="downloads"]').click();
    find('[data-settings-details="vortex"]').open = true;
    find('[data-settings-tab="basics"]').click();
    const keptHelp = find('[data-key="AutoStartDownload"] [data-setting-help]');
    keptHelp.click();
    find('.nxtk-modal-scroll').scrollTop = 137;
    change('DownloadFolder', '  Pending preset folder  ', 'input');
    find('[data-preset="browser"]').focus();
    find('[data-preset="browser"]').click();
    await tick();
    assert.equal(modal(), sameModal, 'Quick setup updates the existing dialog instead of replacing it');
    assert.equal(find('.nxtk-modal-scroll').scrollTop, 137, 'preset preserves scroll');
    assert.equal(find('[data-settings-details="vortex"]').open, true, 'preset preserves expanded Vortex');
    assert.equal(keptHelp.getAttribute('aria-expanded'), 'true', 'preset preserves open explanations');
    assert.equal(w.document.activeElement, find('[data-preset="browser"]'), 'preset preserves keyboard focus');
    assert.equal(store.nxtk_settings.NDC_downloadMethod, 1);
    assert.equal(store.nxtk_settings.DownloadFolder, 'Pending preset folder', 'preset flushes a pending field without resetting it');
    assert.equal(find('[data-preset="browser"]').getAttribute('aria-pressed'), 'true');
    assert.equal(find('[data-setting="AutoCloseTab"]').checked, false, 'visible switches update in place');
    assert.equal(find('[data-settings-group="basics"]').hidden, false);
    change('RequestTimeout', '45', 'input');
    find('.nxtk-modal-footer [data-close]').click();
    await tick();
    assert.equal(store.nxtk_settings.RequestTimeout, 45000, 'seconds remain milliseconds in storage');

    await w.NexusExt.UIKit.settings.open();
    change('WabbajackImport', true);
    assert.equal(find('#nxtk-wj-import').hidden, false);
    find('[data-preset="minimal"]').click();
    await tick();
    assert.equal(find('[data-setting="WabbajackImport"]').checked, false);
    assert.equal(find('#nxtk-wj-import').hidden, true, 'Minimal updates the import action without reopening');
    find('[data-preset="vortex"]').click();
    find('[data-preset="minimal"]').click();
    find('[data-preset="browser"]').click();
    await tick();
    assert.equal(store.nxtk_settings.NDC_downloadMethod, 1, 'rapid preset clicks are serialized in click order');
    assert.equal(store.nxtk_settings.AutoStartDownload, true);
    assert.equal(store.nxtk_settings.AutoCloseTab, false);
    assert.equal(find('[data-preset="browser"]').getAttribute('aria-pressed'), 'true');
    change('WabbajackImport', false);
    assert.equal(find('#nxtk-wj-import').hidden, true);
    change('ForceEnglish', true);
    await tick();
    assert.equal(find('[data-setting="ForceEnglish"]').checked, true, 'language change reopens with the saved state');
    find('[data-reset]').click();
    await tick();
    const confirm = w.document.querySelector('#nxtk-confirm-modal');
    assert.ok(confirm, 'restore still requires confirmation');
    confirm.querySelector('[data-close="cancel"]').click();
    await tick();
    assert.equal(store.nxtk_settings.DownloadFolder, 'Pending preset folder', 'cancel leaves settings untouched');
    assert.ok(modal(), 'cancel returns to settings');
    for (const locale of fs.readdirSync(path.join(root, 'src/_locales'))) {
      const localized = fixture(locale);
      try {
        await localized.w.NexusExt.UIKit.settings.open();
        const localizedRow = localized.modal().querySelector('[data-key="ForceEnglish"]');
        const button = localizedRow.querySelector('[data-setting-help]');
        assert.ok(!button.getAttribute('aria-label').includes('$1'), `${locale} substitutes the setting name in the help label`);
        button.click();
        assert.equal(localizedRow.querySelector('.nxtk-setting-help').hidden, false);
        assert.equal(localizedRow.querySelector('input').checked, false, `${locale} help must not force English`);
      } finally {
        localized.w.NexusExt.UIKit.closeModal('nxtk-settings-modal');
        await tick();
        localized.close();
      }
    }
    // Issue #34: Opera puts a file the extension names in the system Downloads folder, not in the
    // location set in Opera, so a folder there sends files somewhere the user did not choose.
    const opera = fixture('en', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/126.0.0.0' });
    try {
      opera.store.nxtk_settings = { ...opera.w.NXTK.DEFAULTS, DownloadFolder: 'NexusMods' };
      await opera.w.NexusExt.UIKit.settings.open();
      const operaFind = (selector) => opera.modal().querySelector(selector);
      const note = operaFind('#nxtk-setting-DownloadFolder-note');
      assert.ok(note, 'Opera shows a note on the folder field');
      assert.equal(note.hidden, false, 'while a folder is set');
      assert.match(note.textContent, /Opera/);
      assert.match(operaFind('[data-setting="DownloadFolder"]').getAttribute('aria-describedby'), /nxtk-setting-DownloadFolder-note/);
      assert.equal(operaFind('[data-setting="DownloadFolder"]').hasAttribute('aria-invalid'), false, 'a note is no error');
      const input = operaFind('[data-setting="DownloadFolder"]');
      input.value = '';
      input.dispatchEvent(new opera.w.Event('change', { bubbles: true }));
      await tick();
      assert.equal(note.hidden, true, 'and goes once the field is empty');
      assert.equal(opera.store.nxtk_settings.DownloadFolder, '');
    } finally {
      opera.w.NexusExt.UIKit.closeModal('nxtk-settings-modal');
      await tick();
      opera.close();
    }
    console.log('Compact settings: grouping, help, labels, autosave, presets, language, Advanced, import and reset-cancel OK');
  } finally {
    w.NexusExt.UIKit.closeModal('nxtk-settings-modal');
    await tick();
    f.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
