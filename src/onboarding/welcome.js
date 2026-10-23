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
    // Issue #34: a full path such as D:\mods is not a folder the extension can save in; say so, not "Saved".
    const folder = $('setupFolder').value.trim();
    if (method() === 'browser' && NXTK.isFullFolderPath(folder)) {
      setStatus(t('setDownloadFolderFullPath', `${folder} is a full path, which an extension cannot save to. Choose ${folder} as the download location in your browser's settings and leave this field empty.`, [folder]), 'warn');
      $('setupFolder').focus();
      return;
    }
    const reply = await sendPatch(setupPatch());
    setStatus(reply.ok ? t('setupSaved', 'Saved. Open any Nexus Mods file page to try it.') : t('setupSaveFailed', 'Could not save. Try again from the settings button on a Nexus page.'), reply.ok ? 'ok' : 'warn');
  });

  // ---- Custom Vortex test dialog ----
  function createVortexDialog() {
    const backdrop = document.createElement('div');
    backdrop.className = 'vortex-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="vortex-dialog">
        <div class="vortex-dialog-icon">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>
        </div>
        <div class="vortex-dialog-title" data-i18n="vortexDialogTitle">Test Vortex Connection</div>
        <div class="vortex-dialog-text" data-i18n="vortexDialogText">We'll send a harmless test link to Vortex. Your browser may show a permission prompt — click <strong>Open</strong> to allow it.</div>
        <div class="vortex-dialog-actions" id="vortexDialogActions">
          <button type="button" class="btn btn-primary" id="vortexDialogOpen">${t('vortexDialogOpenBtn', 'Open Vortex')}</button>
          <button type="button" class="btn btn-secondary" id="vortexDialogCancel">${t('vortexDialogCancelBtn', 'Cancel')}</button>
        </div>
        <div id="vortexDialogBody"></div>
      </div>`;
    NXTK.applyI18nTo(backdrop);
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function dismissDialog(backdrop) {
    const dialog = backdrop.querySelector('.vortex-dialog');
    if (dialog) dialog.style.animation = 'vortex-dialog-out 0.22s ease forwards';
    backdrop.style.animation = 'vortex-backdrop-in 0.22s ease reverse forwards';
    setTimeout(() => backdrop.remove(), 240);
  }

  // Test Vortex: show custom dialog, then hand Vortex a harmless link.
  $('setupTestVortex').addEventListener('click', () => {
    $('setupAsk').hidden = true;
    const backdrop = createVortexDialog();
    const body = backdrop.querySelector('#vortexDialogBody');
    const actions = backdrop.querySelector('#vortexDialogActions');
    const openBtn = backdrop.querySelector('#vortexDialogOpen');
    const cancelBtn = backdrop.querySelector('#vortexDialogCancel');

    cancelBtn.addEventListener('click', () => dismissDialog(backdrop));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismissDialog(backdrop); });

    openBtn.addEventListener('click', async () => {
      actions.innerHTML = '';
      body.innerHTML = `<div class="vortex-dialog-spinner"></div>
        <div class="vortex-dialog-text" style="margin-bottom:0">${t('setupTesting', 'Connecting to Vortex…')}</div>`;

      const watching = NXTK.waitForProtocolHandoff({ timeoutMs: 6000, maxMs: 8000 });
      try { location.href = NXTK.VORTEX_TEST_LINK; } catch (_) { }
      const opened = await watching;

      if (opened) {
        await NXTK.recordVortexOpenEvent('opened');
        body.innerHTML = `<div class="vortex-dialog-result ok">✓ ${t('setupTestOk', 'Vortex opened. You are all set.')}</div>`;
        setStatus(t('setupTestOk', 'Vortex opened. You are all set.'), 'ok');
        actions.innerHTML = `<button type="button" class="btn btn-primary" id="vortexDialogDone">${t('vortexDialogDoneBtn', 'Done')}</button>`;
        backdrop.querySelector('#vortexDialogDone').addEventListener('click', () => dismissDialog(backdrop));
        return;
      }

      // Could not tell — ask the user. A Vortex that is already running re-reads the membership for
      // this link and stays where it is, so it shows nothing; only a cold start is visible.
      body.innerHTML = `<div class="vortex-dialog-result warn">${t('setupTestUnsure', 'Could not detect whether Vortex opened.')}</div>
        <div class="vortex-dialog-text">${t('setupTestAlreadyOpen', 'If Vortex was already open, this test cannot bring it to the front. Close Vortex and test again.')}</div>`;
      const title = backdrop.querySelector('.vortex-dialog-title');
      if (title) title.textContent = t('setupAskOpened', 'Did Vortex open?');
      actions.innerHTML = `
        <button type="button" class="btn btn-primary" id="vortexAskYes">${t('dlgVortexOpenedYesShort', 'Yes')}</button>
        <button type="button" class="btn btn-secondary" id="vortexAskNo">${t('dlgVortexOpenedNoShort', 'No')}</button>`;

      backdrop.querySelector('#vortexAskYes').addEventListener('click', async () => {
        await NXTK.recordVortexOpenEvent('answeredYes');
        body.innerHTML = `<div class="vortex-dialog-result ok">✓ ${t('setupTestOk', 'Vortex opened. You are all set.')}</div>`;
        setStatus(t('setupTestOk', 'Vortex opened. You are all set.'), 'ok');
        actions.innerHTML = `<button type="button" class="btn btn-primary" id="vortexDialogDone">${t('vortexDialogDoneBtn', 'Done')}</button>`;
        backdrop.querySelector('#vortexDialogDone').addEventListener('click', () => dismissDialog(backdrop));
      });

      backdrop.querySelector('#vortexAskNo').addEventListener('click', async () => {
        // A "no" here can be a Vortex that was running all along, so it does not count as a failed
        // hand-off (two of those offer browser downloads); the next run simply asks again.
        await NXTK.recordVortexOpenEvent('reset');
        body.innerHTML = `<div class="vortex-dialog-result error">${t('setupTestFailed', 'Vortex did not open. Install Vortex and let it handle nxm:// links (Vortex Settings → Downloads), or choose browser downloads above.')}</div>`;
        setStatus(t('setupTestFailed', 'Vortex did not open.'), 'warn');
        actions.innerHTML = `<button type="button" class="btn btn-secondary" id="vortexDialogDone">${t('vortexDialogDoneBtn', 'Close')}</button>`;
        backdrop.querySelector('#vortexDialogDone').addEventListener('click', () => dismissDialog(backdrop));
      });
    });
  });

  // Keep the inline buttons working as fallback (they're still in the DOM).
  $('setupAskYes').addEventListener('click', async () => {
    $('setupAsk').hidden = true;
    await NXTK.recordVortexOpenEvent('answeredYes');
    setStatus(t('setupTestOk', 'Vortex opened. You are all set.'), 'ok');
  });
  $('setupAskNo').addEventListener('click', async () => {
    $('setupAsk').hidden = true;
    await NXTK.recordVortexOpenEvent('reset');
    setStatus(t('setupTestFailed', 'Vortex did not open. Install Vortex and let it handle nxm:// links (Vortex Settings → Downloads), or choose browser downloads above.'), 'warn');
  });
})();
