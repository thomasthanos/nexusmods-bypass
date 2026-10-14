(function () {
  'use strict';
  const enable = document.getElementById('enable');
  const close = document.getElementById('close');
  const status = document.getElementById('status');
  const T = (key, fallback) => NXTK.t(key, null, fallback);
  let busy = false;

  function done() {
    enable.hidden = true;
    close.textContent = T('btnDone', 'Done');
    status.removeAttribute('data-error');
    status.textContent = T('autoEnabled', 'Automatic reports are on. Thank you for helping improve the extension.');
  }

  enable.addEventListener('click', () => {
    if (busy || !NXTK.RELAY_CONFIGURED) return;
    busy = true;
    enable.disabled = true;
    close.disabled = true;
    status.textContent = '';
    // A content script cannot request permissions. This extension page receives the real click;
    // request must run before any await, especially on Firefox.
    let permission;
    try { permission = chrome.permissions.request({ origins: [...NXTK.RELAY_PERMISSION.origins] }); }
    catch (_) { permission = Promise.resolve(false); }
    Promise.resolve(permission).then(async (granted) => {
      if (!granted) throw new Error('permission');
      const reply = await chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch: { AutoErrorReports: true } } });
      if (!reply?.ok) throw new Error('settings');
      done();
    }).catch((cause) => {
      status.setAttribute('data-error', '');
      status.textContent = cause?.message === 'permission'
        ? T('autoPermissionDenied', 'Reports are still off. You can try again and allow the browser permission, or close this page.')
        : T('autoEnableFailed', 'Reports could not be enabled. Please try again.');
    }).finally(() => {
      busy = false;
      enable.disabled = false;
      close.disabled = false;
    });
  });
  close.addEventListener('click', () => {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id);
      else window.close();
    });
  });
  async function init() {
    const stored = await chrome.storage.local.get(NXTK.SETTINGS_KEY);
    NXTK.setForceEnglish(!!stored?.[NXTK.SETTINGS_KEY]?.ForceEnglish);
    NXTK.applyI18nTo(document);
    document.documentElement.lang = chrome.i18n.getUILanguage();
    if (!NXTK.RELAY_CONFIGURED) {
      enable.disabled = true;
      status.textContent = T('rpErrNotConfigured', 'The report server is not set up yet.');
    } else if (stored?.[NXTK.SETTINGS_KEY]?.AutoErrorReports && await chrome.permissions.contains(NXTK.RELAY_PERMISSION)) {
      done();
    }
  }
  init().catch(() => undefined);
})();
