// Real settings modal + storage + shared helpers. Only browser APIs are supplied by the fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/_locales/en/messages.json'), 'utf8'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

function fixture(locale = 'en', { userAgent = '' } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Settings</button></body>', {
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
  for (const file of ['src/shared.js', 'src/content/storage.js', 'src/content/ui.js', 'src/content/ui-settings.js']) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  const modal = () => w.document.querySelector('#nxtk-settings-modal .nxtk-modal');
  return { w, store, modal, close: () => { observers.forEach((o) => o.disconnect()); dom.window.close(); } };
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
      downloads: ['AutoStartDownload', 'AutoCloseTab', 'SkipRequirements', 'HandleArchivedFiles', 'DownloadFolder', 'WriteMo2Meta'],
      collections: ['WabbajackImport', 'HideDownloadPopup', 'NDC_smallestFirst', 'FollowUpdatePolicy', 'ShowModActions'],
      appearance: ['HidePremiumUpsells', 'ExpandRequirements', 'ShowAlertsOnError', 'ForceEnglish'],
      diagnostics: ['AutoErrorReports', 'PrivateDiagnostics']
    };
    for (const [group, keys] of Object.entries(groups)) {
      const section = find(`[data-settings-group="${group}"]`);
      assert.ok(section, `${group} has its own readable group`);
      assert.deepEqual([...section.querySelectorAll('[data-setting]')].map((el) => el.dataset.setting), keys);
    }
    assert.equal(find('#nxtk-advanced-body').hidden, true);
    assert.equal(modal().querySelectorAll('[data-setting]').length, 23, 'all settings appear exactly once');
    assert.equal(new Set([...modal().querySelectorAll('[data-setting]')].map((el) => el.dataset.setting)).size, 23);
    for (const input of modal().querySelectorAll('[data-setting]')) {
      assert.ok(input.labels?.length || input.getAttribute('aria-labelledby'), `${input.dataset.setting} has an accessible label`);
    }

    // The footer: a bug report is an issue with its diagnostics; an idea is a new GitHub discussion.
    const idea = find('.nxtk-modal-footer [data-suggest-idea]');
    assert.ok(idea, 'Suggest an idea sits in the footer');
    assert.equal(idea.closest('.nxtk-settings-github'), find('.nxtk-modal-footer [data-report-issue]').closest('.nxtk-settings-github'),
      'beside Report a bug');
    assert.equal(idea.getAttribute('href'), 'https://github.com/thomasthanos/nexusmods-bypass/discussions/new?category=ideas');
    assert.equal(idea.getAttribute('target'), '_blank');
    assert.match(idea.getAttribute('rel'), /noopener/);
    assert.match(idea.textContent, /Suggest an idea/);
    assert.equal(find('.nxtk-modal-footer').children.length, 3, 'the footer keeps its three parts: reset, GitHub, Done');

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
    find('#nxtk-advanced-toggle').click();
    const keptHelp = find('[data-key="AutoStartDownload"] [data-setting-help]');
    keptHelp.click();
    find('.nxtk-modal-scroll').scrollTop = 137;
    change('DownloadFolder', '  Pending preset folder  ', 'input');
    find('[data-preset="browser"]').focus();
    find('[data-preset="browser"]').click();
    await tick();
    assert.equal(modal(), sameModal, 'Quick setup updates the existing dialog instead of replacing it');
    assert.equal(find('.nxtk-modal-scroll').scrollTop, 137, 'preset preserves scroll');
    assert.equal(find('#nxtk-advanced-body').hidden, false, 'preset preserves expanded Advanced');
    assert.equal(keptHelp.getAttribute('aria-expanded'), 'true', 'preset preserves open explanations');
    assert.equal(w.document.activeElement, find('[data-preset="browser"]'), 'preset preserves keyboard focus');
    assert.equal(store.nxtk_settings.NDC_downloadMethod, 1);
    assert.equal(store.nxtk_settings.DownloadFolder, 'Pending preset folder', 'preset flushes a pending field without resetting it');
    assert.equal(find('[data-preset="browser"]').getAttribute('aria-pressed'), 'true');
    assert.equal(find('[data-setting="AutoCloseTab"]').checked, false, 'visible switches update in place');
    assert.equal(find('#nxtk-advanced-body').hidden, false);
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
