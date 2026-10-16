const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const script = (w, path) => w.eval(fs.readFileSync(path, 'utf8'));
const english = JSON.parse(fs.readFileSync('src/_locales/en/messages.json', 'utf8'));
const greek = JSON.parse(fs.readFileSync('src/_locales/el/messages.json', 'utf8'));

function fixture(html = '<!doctype html><body></body>', url = 'https://www.nexusmods.com/games/skyrim', locale = 'en') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  const observers = [];
  const Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  w.CSS = { escape: (value) => value };
  const store = {};
  const sent = [];
  const changes = [];
  let claims = 0;
  let failSave = false;
  const callbackOrPromise = (callback, value) => callback ? callback(value) : Promise.resolve(value);
  w.chrome = {
    runtime: { id: 'test', lastError: null, getURL: (path) => `chrome-extension://test/${path}`, getManifest: () => ({ version: '3.1.1' }),
      sendMessage: (message, callback) => {
        sent.push(message);
        let reply = { ok: true };
        if (message.type === 'AUTO_REPORT_PROMPT_CLAIM') reply.value = claims++ === 0;
        if (message.type === 'SETTINGS_PATCH') {
          reply.ok = !failSave;
          if (!failSave) Object.assign(store, { nxtk_settings: { ...store.nxtk_settings, ...message.payload.patch } });
        }
        return callbackOrPromise(callback, reply);
      }
    },
    storage: { local: {
      get: (key, callback) => callbackOrPromise(callback, { [key]: store[key] }),
      set: (data, callback) => { Object.assign(store, data); return callbackOrPromise(callback); }
    }, onChanged: { addListener: (fn) => changes.push(fn), removeListener: (fn) => { const i = changes.indexOf(fn); if (i >= 0) changes.splice(i, 1); } } },
    tabs: { getCurrent: (callback) => callback({ id: 1 }), remove: () => {} },
    i18n: { getMessage: (key) => (locale === 'el' ? greek[key] : english[key])?.message || '', getUILanguage: () => locale }
  };
  script(w, 'src/shared.js');
  return { w, store, sent, changes, failSave: (value) => { failSave = value; }, close: () => { observers.forEach((o) => o.disconnect()); dom.window.close(); } };
}

async function run() {
  {
    const f = fixture();
    script(f.w, 'src/content/ui.js');
    const show = f.w.NexusExt.UI.showAutoReportInvitation;
    Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
    await show();
    assert.equal(f.sent.length, 0, 'hidden tabs cannot consume the one-time invitation');
    Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: false });
    await Promise.all([show(), show()]);
    assert.equal(f.w.document.querySelectorAll('.nxtk-report-invitation').length, 1);
    assert.match(f.w.document.querySelector('.nxtk-report-invitation').textContent, /stay off unless/);
    assert.equal(f.store.nxtk_settings?.AutoErrorReports, undefined, 'displaying invitation never enables reports');
    f.w.document.querySelector('.nxtk-report-invitation button:not(.nxtk-notice-action)').click();
    await show();
    assert.equal(f.sent.filter((m) => m.type === 'OPEN_AUTO_REPORT_CONSENT').length, 0, 'declining never requests access');
    f.close();
  }
  {
    const f = fixture(undefined, undefined, 'el'); script(f.w, 'src/content/ui.js');
    await f.w.NexusExt.UI.showAutoReportInvitation();
    const root = f.w.document.querySelector('.nxtk-report-invitation');
    assert.match(root.textContent, /ιδιωτικό Discord/);
    assert.equal(root.getAttribute('role'), 'region');
    assert.ok(f.w.document.getElementById(root.getAttribute('aria-labelledby')));
    assert.ok(f.w.document.getElementById(root.getAttribute('aria-describedby')));
    const enable = root.querySelector('.nxtk-notice-action');
    f.failSave(true); enable.click(); await tick();
    assert.notEqual(f.store.nxtk_settings?.AutoErrorReports, true, 'a failed write leaves reporting off');
    assert.ok(!root.classList.contains('is-leaving'), 'a failed save keeps the invitation available');
    assert.match(root.querySelector('[role="alert"]').textContent, /Δοκίμασε ξανά/);
    f.failSave(false); enable.click(); await tick();
    assert.equal(f.store.nxtk_settings.AutoErrorReports, true, 'one in-page click enables reports without another permission');
    assert.equal(f.sent.filter(m => m.type === 'SETTINGS_PATCH').length, 2);
    assert.equal(f.sent.some(m => m.type === 'OPEN_AUTO_REPORT_CONSENT'), false, 'no extra page opens');
    assert.match(f.w.document.querySelector('.nxtk-status-toast').textContent, /ενεργοποιήθηκαν/);
    f.close();
  }
  {
    const f = fixture(); script(f.w, 'src/content/ui.js');
    await f.w.NexusExt.UI.showAutoReportInvitation();
    const enable = f.w.document.querySelector('.nxtk-notice-action');
    enable.focus(); enable.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(f.w.document.querySelector('.nxtk-report-invitation').classList.contains('is-leaving'));
    assert.equal(f.sent.some(m => m.type === 'SETTINGS_PATCH'), false, 'Escape dismisses without consenting');
    f.close();
  }
  {
    const f = fixture(); script(f.w, 'src/content/errors.js'); script(f.w, 'src/content/ui.js');
    const error = f.w.NexusExt.Errors.create('nexus_api_changed', { context: 'Reading collection response', record: false });
    f.w.NexusExt.UI.showError(error);
    const button = f.w.document.querySelector('[data-send-report]');
    assert.equal(button.textContent, 'Add details');
    button.click();
    assert.equal(f.sent.at(-1).type, 'OPEN_REPORT_PAGE');
    assert.equal(f.sent.at(-1).error.code, 'nexus_api_changed');
    assert.match(f.w.document.querySelector('.nxtk-error-code').textContent, /E-[a-z0-9]{7}/);
    f.close();
  }
  {
    const error = { code: 'nexus_api_changed', context: 'Earlier collection failure', url: 'https://www.nexusmods.com/games/skyrim/collections/abc' };
    const f = fixture(fs.readFileSync('src/report-page/report.html', 'utf8'), `https://extension.test/report-page/report.html#${encodeURIComponent(JSON.stringify(error))}`);
    f.w.NXTK.buildReportPayload = async (selected) => ({ version: '3.1.1', browser: 'Chrome 155', errors: [], logs: [], currentError: selected,
      reference: f.w.NXTK.errorReference(selected), summary: '', note: '' });
    script(f.w, 'src/report-page/report.js'); await tick();
    const preview = JSON.parse(f.w.document.getElementById('rpPreview').textContent);
    assert.equal(preview.currentError.context, error.context, 'the chosen error survives a newer error in the local log');
    assert.equal(f.w.location.hash, '', 'diagnostics are removed from the address bar');
    assert.match(f.w.document.getElementById('rpErrorCode').textContent, /E-[a-z0-9]{7}/);
    const auto = f.w.document.getElementById('rpAuto');
    const details = f.w.document.getElementById('rpAutoDetails');
    assert.ok(details, 'extended diagnostics have a separate explicit choice');
    assert.equal(details.checked, false);
    assert.equal(details.disabled, true, 'extended reporting cannot be enabled without basic consent');
    auto.click(); await tick();
    assert.equal(details.disabled, false);
    assert.equal(details.checked, false, 'enabling basic reports does not consent to extra data');
    details.click(); await tick();
    assert.equal(f.store.nxtk_settings.AutoReportDiagnostics, true);
    auto.click(); await tick();
    assert.equal(f.store.nxtk_settings.AutoErrorReports, false);
    assert.equal(f.store.nxtk_settings.AutoReportDiagnostics, false);
    assert.equal(details.checked, false);
    assert.equal(details.disabled, true);
    f.close();
  }
  console.log('Report consent/UI tests passed: one-time invitation, explicit opt-in, keyboard/accessibility, Greek copy and selected-error details.');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
