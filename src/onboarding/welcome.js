(function () {
  'use strict';

  const NXTK = globalThis.NXTK;
  if (!NXTK?.applyI18nTo) return;

  try {
    const version = document.getElementById('welcomeVersion');
    if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (_) {
  }

  try {
    chrome.storage.local.get(NXTK.SETTINGS_KEY, (result) => {
      if (!chrome.runtime.lastError) {
        const stored = result?.[NXTK.SETTINGS_KEY];
        NXTK.setForceEnglish(stored ? stored.ForceEnglish : NXTK.DEFAULTS.ForceEnglish);
      }
      NXTK.applyI18nTo(document);
      try {
        const stored = result?.[NXTK.SETTINGS_KEY];
        const forceEnglish = stored ? stored.ForceEnglish : NXTK.DEFAULTS.ForceEnglish;
        const ui = forceEnglish ? 'en' : (chrome.i18n.getUILanguage?.() || '');
        if (ui) document.documentElement.lang = ui;
      } catch (_) {
      }
    });
  } catch (_) {
  }

  // ---- First-run setup ----
  const t = (key, fallback, subs = null) => NXTK.t(key, subs, fallback);
  const $ = (id) => document.getElementById(id);
  const form = $('setupForm');
  if (!form) return;

  const sendPatch = (patch) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch } }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || { ok: false });
      });
    } catch (_) {
      resolve({ ok: false });
    }
  });
  const setStatus = (text, kind = '') => {
    const status = $('setupStatus');
    status.textContent = text;
    status.className = `setup-status${kind ? ` ${kind}` : ''}`;
  };
  const method = () => form.querySelector('input[name="method"]:checked')?.value || 'vortex';
  const syncRows = () => {
    const vortex = method() === 'vortex';
    $('setupCloseRow').hidden = !vortex;
    $('setupFolderRow').hidden = vortex;
    $('setupTestVortex').hidden = !vortex;
  };

  // Prefill from what is stored, so reopening the page shows the current choices.
  try {
    chrome.storage.local.get(NXTK.SETTINGS_KEY, (result) => {
      const cfg = { ...NXTK.DEFAULTS, ...(result?.[NXTK.SETTINGS_KEY] || {}) };
      form.querySelector(`input[name="method"][value="${cfg.NDC_downloadMethod === 1 ? 'browser' : 'vortex'}"]`).checked = true;
      $('setupFolder').value = cfg.DownloadFolder || '';
      $('setupCloseTab').checked = !!cfg.AutoCloseTab;
      syncRows();
    });
  } catch (_) {
    syncRows();
  }
  form.addEventListener('change', syncRows);

  // The setup choices as a settings patch: the matching preset, then the two answers.
  function setupPatch() {
    const preset = NXTK.applyPreset({}, method());
    const patch = { ...preset };
    if (method() === 'vortex') {
      patch.AutoCloseTab = $('setupCloseTab').checked;
    } else {
      const folder = NXTK.normalizeSetting('DownloadFolder', $('setupFolder').value.trim());
      if (folder !== undefined) patch.DownloadFolder = folder;
    }
    return patch;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reply = await sendPatch(setupPatch());
    setStatus(reply.ok ? t('setupSaved', 'Saved. Open any Nexus Mods file page to try it.') : t('setupSaveFailed', 'Could not save. Try again from the settings button on a Nexus page.'), reply.ok ? 'ok' : 'warn');
  });

  // Test Vortex: hand Vortex a harmless link and watch whether anything took over.
  $('setupTestVortex').addEventListener('click', async () => {
    $('setupAsk').hidden = true;
    setStatus(t('setupTesting', 'Asking the browser to open Vortex… allow the prompt if one appears.'));
    const watching = NXTK.waitForProtocolHandoff({ timeoutMs: 6000, maxMs: 8000 });
    try {
      location.href = NXTK.VORTEX_TEST_LINK;
    } catch (_) { }
    const opened = await watching;
    if (opened) {
      await NXTK.recordVortexOpenEvent('opened');
      setStatus(t('setupTestOk', 'Vortex opened. You are all set.'), 'ok');
      return;
    }
    setStatus(t('setupTestUnsure', 'Could not tell whether Vortex opened.'), 'warn');
    $('setupAsk').hidden = false;
    $('setupAskYes').focus();
  });
  $('setupAskYes').addEventListener('click', async () => {
    $('setupAsk').hidden = true;
    await NXTK.recordVortexOpenEvent('answeredYes');
    setStatus(t('setupTestOk', 'Vortex opened. You are all set.'), 'ok');
  });
  $('setupAskNo').addEventListener('click', async () => {
    $('setupAsk').hidden = true;
    await NXTK.recordVortexOpenEvent('answeredNo');
    setStatus(t('setupTestFailed', 'Vortex did not open. Install Vortex and let it handle nxm:// links (Vortex Settings → Downloads), or choose browser downloads above.'), 'warn');
  });
})();
