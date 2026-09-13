// The settings dialog, loaded the first time it is opened (UI.showSettingsModal in ui.js asks for it).
(function () {
  'use strict';

  const kit = window.NexusExt?.UIKit;
  if (!kit || kit.settings) return;

  const { svgIcon, escapeHtml, L, openModal, copyReportAndOpenIssue } = kit;

  kit.registerIcons({
    chevronRight: '<svg viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>',
    github: '<svg viewBox="0 0 24 24"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.04 1.77 2.72 1.26 3.38.96.1-.75.41-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.14c.98 0 1.96.13 2.88.39 2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.82 1.19 3.08 0 4.41-2.71 5.39-5.29 5.68.42.36.78 1.07.78 2.16v3.24c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>'
  });

  const SETTINGS_UI = [
    { key: 'AutoStartDownload', label: () => NXTK.t('setAutoStartDownloadLabel', null, 'Start downloads automatically'), type: 'bool', desc: () => NXTK.t('setAutoStartDownloadDesc', null, 'When you open a Nexus file download page, start the Vortex handoff or browser download without another click.') },
    { key: 'AutoCloseTab', label: () => NXTK.t('setAutoCloseTabLabel', null, 'Close Vortex tabs'), type: 'bool', desc: () => NXTK.t('setAutoCloseTabDesc', null, 'After a Vortex link is sent, close the temporary Nexus tab after the delay below.') },
    { key: 'SkipRequirements', label: () => NXTK.t('setSkipRequirementsLabel', null, 'Skip requirement screens'), type: 'bool', desc: () => NXTK.t('setSkipRequirementsDesc', null, 'Continue past Nexus requirements popups and go straight to the download step.') },
    { key: 'ShowAlertsOnError', label: () => NXTK.t('setShowAlertsOnErrorLabel', null, 'Show error popups'), type: 'bool', desc: () => NXTK.t('setShowAlertsOnErrorDesc', null, 'Show a clear message when Nexus does not return a usable download link.') },
    { key: 'HidePremiumUpsells', label: () => NXTK.t('setHidePremiumUpsellsLabel', null, 'Hide ads and Premium panels'), type: 'bool', desc: () => NXTK.t('setHidePremiumUpsellsDesc', null, 'Hide Nexus advertising slots, empty ad containers, Premium banners and upgrade panels while browsing. It also sets the Nexus ad-timer cookie so queued downloads do not wait through the countdown before each link.') },
    { key: 'HandleArchivedFiles', label: () => NXTK.t('setHandleArchivedFilesLabel', null, 'Archived file buttons'), type: 'bool', desc: () => NXTK.t('setHandleArchivedFilesDesc', null, 'Add Vortex and browser download buttons to archived file entries when Nexus hides them.') },
    {
      key: 'WabbajackImport',
      label: () => NXTK.t('setWabbajackImportLabel', null, 'Wabbajack modlist import (beta)'),
      type: 'bool',
      desc: () => NXTK.t('setWabbajackImportDesc', null, 'Adds a button to this dialog that reads a .wabbajack file and queues the Nexus files it lists. Files hosted outside Nexus, and games this build does not recognise, are reported instead of downloaded.')
    },
    { key: 'CloudflareFallback', label: () => NXTK.t('setCloudflareFallbackLabel', null, 'Cloudflare fallback'), type: 'bool', desc: () => NXTK.t('setCloudflareFallbackDesc', null, 'When Nexus answers a background download request with a browser verification page, open the file page so you can complete the check, instead of failing. This is why the tab sometimes navigates on its own.') },
    {
      key: 'ForceEnglish',
      group: 'language',
      label: () => NXTK.t('setForceEnglishLabel', null, 'Always use English'),
      type: 'bool',
      desc: () => NXTK.t('setForceEnglishDesc', null, 'Show this extension in English even when your browser is set to another language. Useful when following guides written in English. The extension name in your browser list still follows the browser language.')
    },
    { key: 'DownloadFolder', label: () => NXTK.t('setDownloadFolderLabel', null, 'Browser download folder'), type: 'text', maxLength: 100, desc: () => NXTK.t('setDownloadFolderDesc', null, 'Subfolder inside your browser Downloads directory, used by Browser Download mode. Leave it empty to save straight into Downloads — some mod managers only watch that folder and never look inside subfolders. Vortex downloads are handled by Vortex and are unaffected.') },
    { key: 'RequestTimeout', label: () => NXTK.t('setRequestTimeoutLabel', null, 'Download request timeout'), type: 'number', unit: () => NXTK.t('unitSeconds', null, 'Seconds'), scale: 1000, advanced: true, desc: () => NXTK.t('setRequestTimeoutDesc', null, 'How long the extension waits for Nexus to return a download link before it gives up.') },
    { key: 'CloseTabDelay', label: () => NXTK.t('setCloseTabDelayLabel', null, 'Close-tab delay'), type: 'number', unit: () => NXTK.t('unitSeconds', null, 'Seconds'), scale: 1000, advanced: true, desc: () => NXTK.t('setCloseTabDelayDesc', null, 'Only applies to auto-started Vortex downloads that close their tab. Increase it if Vortex misses links.') },
    {
      key: 'NDC_downloadSpeed',
      label: () => NXTK.t('setDownloadSpeedLabel', null, 'Your Nexus download speed'),
      type: 'decimal',
      unit: 'MB/s',
      min: 0.1,
      step: 0.1,
      desc: () => NXTK.t('setDownloadSpeedDesc', null, 'Vortex mode only. The browser cannot watch a transfer happening inside Vortex, so this estimates how long each file takes and spaces the hand-offs out. Set it to the speed you actually see — too low and the queue waits far longer than it needs to.')
    },
    {
      key: 'NDC_pauseBetweenDownload',
      label: () => NXTK.t('setPauseBetweenModsLabel', null, 'Pause between mods'),
      type: 'number',
      unit: () => NXTK.t('unitSecondsShort', null, 's'),
      desc: () => NXTK.t('setPauseBetweenModsDesc', null, 'Vortex mode only. Added to the estimate above. Set it to 0 to switch the wait off entirely — including the size estimate — and hand every file to Vortex back to back, letting Vortex queue them itself.')
    }
  ];

  // UI.showSettingsModal in ui.js checks that the extension is still connected, then calls this.
  async function openSettingsModal() {
    const cfg = await NexusExt.Storage.getSettings();

    const text = (v) => (typeof v === 'function' ? v() : (v ?? ''));
    const buildRow = (s) => {
      const copy = `<span class="nxtk-setting-copy"><span class="nxtk-setting-title">${escapeHtml(text(s.label))}</span><span class="nxtk-setting-desc">${escapeHtml(text(s.desc))}</span></span>`;
      const timingTitle = `<span class="nxtk-setting-copy"><span class="nxtk-setting-title-row"><span class="nxtk-setting-title">${escapeHtml(text(s.label))}</span><span class="nxtk-setting-info-icon" data-tooltip="${escapeHtml(text(s.desc))}" aria-label="${escapeHtml(text(s.desc))}" tabindex="0">${svgIcon('info')}</span></span></span>`;
      if (s.type === 'bool') {
        return `<div class="nxtk-setting-row" data-key="${s.key}"><label class="nxtk-setting-label"><span class="nxtk-toggle"><input type="checkbox" data-setting="${s.key}" ${cfg[s.key] ? 'checked' : ''}><span class="nxtk-toggle-track"></span></span>${copy}</label></div>`;
      }
      if (s.type === 'number' || s.type === 'decimal') {
        const decimal = s.type === 'decimal' ? ' data-decimal="1"' : '';
        const scale = Number(s.scale) || 1;
        const scaleAttr = scale === 1 ? '' : ` data-scale="${scale}"`;
        const step = s.step ? ` step="${escapeHtml(s.step)}"` : '';
        const min = s.min === undefined ? 0 : s.min;
        const displayValue = Number(cfg[s.key]) / scale;
        return `<div class="nxtk-setting-row nxtk-setting-row-field" data-key="${s.key}"><div class="nxtk-setting-label">${timingTitle}<span class="nxtk-setting-field"><input type="number" data-setting="${s.key}"${decimal}${scaleAttr}${step} value="${escapeHtml(displayValue)}" min="${escapeHtml(min)}"><span class="nxtk-setting-unit">${escapeHtml(text(s.unit))}</span></span></div></div>`;
      }
      if (s.type === 'text') {
        const maxLength = Number(s.maxLength) > 0 ? ` maxlength="${Number(s.maxLength)}"` : '';
        return `<div class="nxtk-setting-row nxtk-setting-row-field" data-key="${s.key}"><div class="nxtk-setting-label">${timingTitle}<span class="nxtk-setting-field"><input type="text" data-setting="${s.key}" value="${escapeHtml(cfg[s.key] ?? '')}"${maxLength} spellcheck="false"></span></div></div>`;
      }
      return '';
    };

    const isField = (s) => s.type === 'number' || s.type === 'decimal' || s.type === 'text';
    const features = SETTINGS_UI.filter(s => s.type === 'bool' && !s.advanced && !s.group).map(buildRow).join('');
    const language = SETTINGS_UI.filter(s => s.group === 'language').map(buildRow).join('');
    const timing = SETTINGS_UI.filter(s => isField(s) && !s.advanced).map(buildRow).join('');
    const advanced = SETTINGS_UI.filter(s => s.advanced).map(buildRow).join('');

    const SETTING_INPUT_DEBOUNCE_MS = 400;
    const pendingInputWrites = new Map();

    const { modal, close } = openModal({
      id: 'nxtk-settings-modal',
      ariaLabel: NXTK.t('setTitle', null, 'Download Helper Settings'),
      restoreFocus: true,
      // Flush pending edits before the dialog and its inputs leave the page.
      beforeClose: () => {
        for (const [target, timer] of pendingInputWrites) {
          clearTimeout(timer);
          if (target.isConnected) update(target, { commit: true });
        }
        pendingInputWrites.clear();
      },
      html: `
      <div class="nxtk-modal-header">
        <div>
          <div class="nxtk-modal-title">${L('setTitle', 'Download Helper Settings')}</div>
          <div class="nxtk-modal-subtitle">${L('setSubtitle', 'Changes save instantly. Restore defaults will reload this page.')}</div>
        </div>
        <button class="nxtk-modal-close" data-close aria-label="${L('ariaClose', 'Close')}">&times;</button>
      </div>
      <div class="nxtk-modal-scroll">
        <div class="nxtk-settings-col nxtk-settings-col-main">
          <div class="nxtk-settings-section nxtk-settings-flow"><div class="nxtk-settings-section-title">${L('setSectionFlow', 'Download Flow')}</div><div class="nxtk-settings-rows">${features}</div></div>
        </div>
        <div class="nxtk-settings-col nxtk-settings-col-side">
          <div class="nxtk-settings-section nxtk-settings-language"><div class="nxtk-settings-section-title">${L('setSectionLanguage', 'Language')}</div><div class="nxtk-settings-rows">${language}</div></div>
          <div class="nxtk-settings-section nxtk-settings-pacing"><div class="nxtk-settings-section-title">${L('setSectionPacing', 'Files & Pacing')}</div><div class="nxtk-settings-rows">${timing}</div></div>
          <div class="nxtk-settings-version">
            <span class="nxtk-settings-version-name">${L('appName', 'NexusMods Bypass')}</span>
            <span class="nxtk-settings-version-tag">v${escapeHtml(chrome.runtime.getManifest().version)}</span>
          </div>
        </div>
        <div class="nxtk-settings-advanced">
          <div class="nxtk-settings-advanced-bar">
            <button type="button" class="nxtk-settings-advanced-toggle" id="nxtk-advanced-toggle"
                    aria-expanded="false" aria-controls="nxtk-advanced-body">${svgIcon('chevronRight')} ${L('setSectionAdvanced', 'Advanced')}</button>
            <div class="nxtk-settings-support">
              <span>${L('setNeedHelp', 'Need help with a download?')}</span>
              <button type="button" class="nxtk-settings-report" data-report-issue>${svgIcon('github')}<span data-report-label>${L('setReportOnGithub', 'Report a bug on GitHub')}</span></button>
            </div>
          </div>
          <div class="nxtk-settings-advanced-body" id="nxtk-advanced-body" hidden>
            <div class="nxtk-settings-advanced-panel">${advanced}</div>
          </div>
        </div>
      </div>
      <div class="nxtk-modal-footer">
        <button class="nxtk-btn nxtk-btn-secondary" id="nxtk-wj-import" ${cfg.WabbajackImport ? '' : 'hidden'}>${L('btnImportWabbajack', 'Import Wabbajack modlist')}</button>
        <button class="nxtk-btn nxtk-btn-secondary" data-reset>${L('setRestoreDefaults', 'Restore Defaults & Refresh')}</button>
        <button class="nxtk-btn nxtk-btn-primary" data-close>${L('btnDone', 'Done')}</button>
      </div>
    `
    });

    // `commit` marks a finished edit (a change, or the dialog closing). Only then is a value the
    // stored form had to bring into range written back into its field, so typing is never fought.
    function update(el, { commit = false } = {}) {
      const key = el.dataset.setting;
      if (!key) return;
      let value;
      if (el.type === 'checkbox') {
        value = el.checked;
      } else if (el.type === 'text') {
        value = el.value.trim();
      } else if (el.dataset.decimal) {
        value = parseFloat(el.value);
        if (!Number.isFinite(value) || value <= 0) return;
      } else {
        value = parseInt(el.value, 10);
        if (isNaN(value)) return;
      }
      const scale = Number(el.dataset.scale) || 1;
      if (typeof value === 'number') value *= scale;
      value = NXTK.normalizeSetting(key, value);
      if (value === undefined) return;
      if (commit && el.type !== 'checkbox') {
        const shown = typeof value === 'number' ? String(value / scale) : value;
        if (el.value !== shown) el.value = shown;
      }
      cfg[key] = value;
      NexusExt.Storage.patchSetting(key, value);
      if (NexusExt.NNW) NexusExt.NNW.updateConfig(cfg);

      if (key === 'WabbajackImport') {
        if (value) kit.preloadBundle('wabbajack');
        for (const id of ['#nxtk-wj-import', '#nxtk-wj-deck-import', '#nxtk-wj-info']) {
          const button = id === '#nxtk-wj-import' ? modal.querySelector(id) : document.querySelector(id);
          if (button) button.hidden = !value;
        }
      }

      if (key === 'ForceEnglish') {
        NXTK.setForceEnglish(value);
        close();
        NexusExt.UI.showSettingsModal().catch(() => undefined);
      }
    }

    modal.addEventListener('change', e => {
      if (!e.target.dataset.setting) return;
      clearTimeout(pendingInputWrites.get(e.target));
      pendingInputWrites.delete(e.target);
      update(e.target, { commit: true });
    });
    modal.addEventListener('input', e => {
      const target = e.target;
      if ((target.type !== 'number' && target.type !== 'text') || !target.dataset.setting) return;
      clearTimeout(pendingInputWrites.get(target));
      pendingInputWrites.set(target, setTimeout(() => {
        pendingInputWrites.delete(target);
        if (target.isConnected) update(target);
      }, SETTING_INPUT_DEBOUNCE_MS));
    });
    modal.querySelectorAll('[data-report-issue]').forEach(b => b.addEventListener('click', () => copyReportAndOpenIssue(b)));
    modal.querySelector('#nxtk-wj-import')?.addEventListener('click', () => kit.withWabbajack(
      (wabbajack) => wabbajack.importModlist(close)
    ));

    // Fetched while the dialog is open, so the report button and, when it is shown, the modlist import
    // answer at once — a file picker only opens while the click that asked for it still counts.
    kit.preloadBundle('report');
    if (cfg.WabbajackImport) kit.preloadBundle('wabbajack');

    const advancedToggle = modal.querySelector('#nxtk-advanced-toggle');
    const advancedBody = modal.querySelector('#nxtk-advanced-body');
    let advancedCloseTimer = 0;
    const setAdvanced = (open) => {
      clearTimeout(advancedCloseTimer);
      advancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      advancedToggle.classList.toggle('nxtk-expanded', open);
      if (open) {
        advancedBody.hidden = false;
        void advancedBody.offsetHeight;
        advancedBody.classList.add('nxtk-open');
        advancedCloseTimer = setTimeout(() => advancedBody.classList.add('nxtk-settled'), 280);
        return;
      }
      advancedBody.classList.remove('nxtk-open', 'nxtk-settled');
      advancedCloseTimer = setTimeout(() => { advancedBody.hidden = true; }, 280);
    };
    advancedToggle.addEventListener('click', () => setAdvanced(!advancedBody.classList.contains('nxtk-open')));
    modal.querySelector('[data-reset]').addEventListener('click', async () => {
      const confirmed = await nxtkConfirm({
        title: NXTK.t('setRestoreTitle', null, 'Restore Defaults'),
        message: NXTK.t('setRestoreConfirm', null, 'Restore the default settings and refresh this Nexus page?'),
        confirmText: NXTK.t('btnRestore', null, 'Restore'),
        cancelText: NXTK.t('btnCancel', null, 'Cancel')
      });
      if (!confirmed) return;
      await NexusExt.Storage.resetSettings();
      close();
      location.reload();
    });

    modal.querySelector('[data-close]')?.focus?.({ preventScroll: true });
  }

  function nxtkConfirm({ title, message, confirmText, cancelText } = {}) {
    title = title || NXTK.t('dlgConfirmTitle', null, 'Confirm Action');
    confirmText = confirmText || NXTK.t('btnOk', null, 'OK');
    cancelText = cancelText || NXTK.t('btnCancel', null, 'Cancel');
    return new Promise((resolve) => {
      const { modal } = openModal({
        id: 'nxtk-confirm-modal',
        className: 'nxtk-modal nxtk-modal-sm nxtk-alert-modal',
        backdropClassName: 'nxtk-modal-backdrop nxtk-alert-backdrop',
        // Enter confirms only when no control has focus. On a focused button it has to do what that
        // button does, or Enter on Cancel would confirm the very thing it was meant to refuse.
        onKeyDown: (event, close) => {
          if (event.key !== 'Enter') return;
          if (event.target?.closest?.('button, a, input, select, textarea')) return;
          close('confirm');
        },
        onClose: (value) => resolve(value === 'confirm'),
        html: `
        <div class="nxtk-modal-header">
          <div class="nxtk-alert-header-inner">
            <span class="nxtk-alert-icon">${svgIcon('info')}</span>
            <span class="nxtk-modal-title">${escapeHtml(title)}</span>
          </div>
          <button class="nxtk-modal-close" data-close aria-label="${L('ariaClose', 'Close')}">&times;</button>
        </div>
        <div class="nxtk-alert-body">
          <div class="nxtk-alert-line">${escapeHtml(message)}</div>
        </div>
        <div class="nxtk-modal-footer nxtk-alert-footer">
          <button class="nxtk-btn nxtk-btn-secondary" type="button" data-close="cancel">${escapeHtml(cancelText)}</button>
          <button class="nxtk-btn nxtk-btn-primary" type="button" data-close="confirm">${escapeHtml(confirmText)}</button>
        </div>`
      });
      modal.querySelector('[data-close="confirm"]').focus();
    });
  }

  kit.settings = { open: openSettingsModal };
})();
