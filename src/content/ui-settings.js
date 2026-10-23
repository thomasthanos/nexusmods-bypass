// The settings dialog, loaded the first time it is opened (UI.showSettingsModal in ui.js asks for it).
(function () {
  'use strict';

  const kit = window.NexusExt?.UIKit;
  if (!kit || kit.settings) return;

  const { svgIcon, escapeHtml, L, openModal, copyReportAndOpenIssue } = kit;

  kit.registerIcons({
    bulb: '<svg viewBox="0 0 24 24"><path d="M9 21a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1H9v1Zm3-19a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2Zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6a5 5 0 1 1 5.7 0Z"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>',
    github: '<svg viewBox="0 0 24 24"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.04 1.77 2.72 1.26 3.38.96.1-.75.41-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.14c.98 0 1.96.13 2.88.39 2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.82 1.19 3.08 0 4.41-2.71 5.39-5.29 5.68.42.36.78 1.07.78 2.16v3.24c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>'
  });

  const SETTINGS_UI = [
    { key: 'AutoErrorReports', label: () => NXTK.t('rpAuto', null, 'Send technical error reports automatically'), type: 'bool', desc: () => NXTK.t('rpAutoDesc', null, 'Off by default. Sends only technical errors, extension and browser versions, action and page type. Repeated errors are grouped; up to ten reports a day. No page content, history or settings. Failed sends retry automatically.') },
    { key: 'PrivateDiagnostics', label: () => NXTK.t('setPrivateDiagnosticsLabel', null, 'Private diagnostics dashboard'), type: 'bool', desc: () => NXTK.t('setPrivateDiagnosticsDesc', null, 'Separate opt-in, off by default. Requires automatic error reports. Stores sampled technical errors, extension/browser versions, OS and a random installation hash in the developer\'s private dashboard, with Discord/push alerts. Extra debug lines require the separate extra diagnostics choice. No download-success telemetry. Turning this off deletes unsent dashboard reports.') },
    { key: 'AutoStartDownload', label: () => NXTK.t('setAutoStartDownloadLabel', null, 'Start downloads automatically'), type: 'bool', desc: () => NXTK.t('setAutoStartDownloadDesc', null, 'On a Nexus file page, start the selected file without another click. This does not download every file on a mod page.') },
    { key: 'AutoCloseTab', label: () => NXTK.t('setAutoCloseTabLabel', null, 'Close the extra Nexus tab'), type: 'bool', desc: () => NXTK.t('setAutoCloseTabDesc', null, 'Close the temporary Nexus tab after an automatically started file is sent to Vortex. The file does not need to finish downloading first. Turn off to keep that tab open.') },
    { key: 'SkipRequirements', label: () => NXTK.t('setSkipRequirementsLabel', null, 'Skip requirement screens'), type: 'bool', desc: () => NXTK.t('setSkipRequirementsDesc', null, 'Skip Nexus windows that list other mods this file needs and continue to the download. You may still need to install those requirements yourself; they are not downloaded automatically.') },
    { key: 'ShowAlertsOnError', label: () => NXTK.t('setShowAlertsOnErrorLabel', null, 'Show error popups'), type: 'bool', desc: () => NXTK.t('setShowAlertsOnErrorDesc', null, 'Show a message when a download cannot start, with available actions to help you continue. Turning this off hides these popups; it does not fix the problem.') },
    { key: 'HidePremiumUpsells', label: () => NXTK.t('setHidePremiumUpsellsLabel', null, 'Hide ads and Premium panels'), type: 'bool', desc: () => NXTK.t('setHidePremiumUpsellsDesc', null, 'Hide advertisements and Premium upgrade panels on Nexus, and skip the download countdown. This does not give you a Premium account or Premium download speeds.') },
    { key: 'HandleArchivedFiles', label: () => NXTK.t('setHandleArchivedFilesLabel', null, 'Buttons for older file versions'), type: 'bool', desc: () => NXTK.t('setHandleArchivedFilesDesc', null, 'Add download buttons to older file versions that Nexus has moved to its archive. This does not restore deleted files or unlock restricted content.') },
    { key: 'ExpandRequirements', label: () => NXTK.t('setExpandRequirementsLabel', null, 'Open the Requirements section'), type: 'bool', desc: () => NXTK.t('setExpandRequirementsDesc', null, 'On a mod\'s Description tab, show the Requirements section open instead of collapsed. You can still close it. This does not download the required mods.') },
    {
      key: 'WabbajackImport',
      label: () => NXTK.t('setWabbajackImportLabel', null, 'Wabbajack modlist import (beta)'),
      type: 'bool',
      desc: () => NXTK.t('setWabbajackImportDesc', null, 'Show an import button for .wabbajack modlists. It queues supported Nexus files for browser download, not automatic installation. Files from other sites or unrecognised games are listed but skipped.')
    },
    { key: 'HideDownloadPopup', label: () => NXTK.t('setHideDownloadPopupLabel', null, 'Hide collection download popups'), type: 'bool', desc: () => NXTK.t('setHideDownloadPopupDesc', null, 'Chrome and Edge only. Keep the browser download bubble from opening for each file during a collection run. It is restored when the run ends, stops or fails; downloads still continue normally.') },
    { key: 'NDC_smallestFirst', label: () => NXTK.t('setSmallestFirstLabel', null, 'Smallest files first'), type: 'bool', desc: () => NXTK.t('setSmallestFirstDesc', null, 'Download smaller collection files first so more files finish early. Files with no known size go last. This changes queue order, not your network speed.') },
    { key: 'UseOfficialApi', label: () => NXTK.t('setUseOfficialApiLabel', null, 'Official Nexus connection (API)'), type: 'bool', desc: () => NXTK.t('setUseOfficialApiDesc', null, 'Use the official Nexus API, its direct interface for file and collection details. Keep on for collection update rules and Endorse/Track buttons. Turn off only to try older page-based lookups if something fails.') },
    { key: 'FollowUpdatePolicy', label: () => NXTK.t('setFollowUpdatePolicyLabel', null, 'Collection file version rules'), type: 'bool', desc: () => NXTK.t('setFollowUpdatePolicyDesc', null, 'On: follow each collection file\'s rule. Exact keeps the listed file; Latest chooses its newest version; Prefer Exact keeps the listed file while available, replacing it only when unavailable. Off: use the listed files. Requires the official Nexus API; it does not update installed mods.') },
    { key: 'WriteMo2Meta', label: () => NXTK.t('setWriteMo2MetaLabel', null, 'Write Mod Organizer 2 .meta files'), type: 'bool', desc: () => NXTK.t('setWriteMo2MetaDesc', null, 'Off by default. For each mod file saved in the browser, from a mod page or a collection, also save a .meta file beside it in the same folder, so Mod Organizer 2 knows the mod\'s Nexus ID, file ID and version, and can show its description and open its Nexus page. Only files downloaded from now on get one. It does not install anything.') },
    { key: 'ShowModActions', label: () => NXTK.t('setShowModActionsLabel', null, 'Show Endorse and Track buttons'), type: 'bool', desc: () => NXTK.t('setShowModActionsDesc', null, 'Show buttons beside collection mods. Endorse is a like for the mod; Track adds it to your Nexus tracking list. Neither action happens until you click. Nexus may require a wait after downloading before allowing Endorse. Requires the official Nexus API.') },
    { key: 'CloudflareFallback', label: () => NXTK.t('setCloudflareFallbackLabel', null, 'Open page for a browser check'), type: 'bool', desc: () => NXTK.t('setCloudflareFallbackDesc', null, 'If Nexus asks you to verify you are human, open the file page so you can complete the browser check yourself. It does not bypass the check. This is why the current tab may change pages.') },
    {
      key: 'ForceEnglish',
      group: 'language',
      label: () => NXTK.t('setForceEnglishLabel', null, 'Always use English'),
      type: 'bool',
      desc: () => NXTK.t('setForceEnglishDesc', null, 'Use English for this extension instead of your browser\'s language. This does not change your browser or Nexus language. The extension name in the browser\'s extension list still follows the browser language.')
    },
    {
      key: 'DownloadFolder',
      label: () => NXTK.t('setDownloadFolderLabel', null, 'Browser download folder'),
      type: 'text',
      maxLength: 100,
      desc: () => NXTK.t('setDownloadFolderDesc', null, 'A folder inside your browser\'s download location, for example NexusMods. Leave it empty to save files where your browser saves its own downloads. A full path such as D:\\mods cannot be used: an extension can only save inside the browser\'s download location, so set D:\\mods as that location in your browser\'s settings. This does not change where Vortex stores files.'),
      // Issue #34: "D:\mods" here became Downloads\D mods. Such a value is not saved, and says why.
      warn: (value) => (NXTK.isFullFolderPath(value)
        ? NXTK.t('setDownloadFolderFullPath', [value.trim()], `${value.trim()} is a full path, which an extension cannot save to. Choose ${value.trim()} as the download location in your browser's settings and leave this field empty.`)
        : '')
    },
    { key: 'RequestTimeout', label: () => NXTK.t('setRequestTimeoutLabel', null, 'Wait for a download link'), type: 'number', unit: () => NXTK.t('unitSeconds', null, 'Seconds'), scale: 1000, advanced: true, desc: () => NXTK.t('setRequestTimeoutDesc', null, 'Time allowed to get a download link from Nexus, not the time needed to download the whole file. Increase only if slow replies keep timing out.') },
    { key: 'CloseTabDelay', label: () => NXTK.t('setCloseTabDelayLabel', null, 'Close-tab delay'), type: 'number', unit: () => NXTK.t('unitSeconds', null, 'Seconds'), scale: 1000, advanced: true, desc: () => NXTK.t('setCloseTabDelayDesc', null, 'For automatically started Vortex downloads only. Seconds to wait before closing the temporary Nexus tab after Vortex opens. Try a longer delay if Vortex misses links.') },
    {
      key: 'NDC_downloadSpeed',
      label: () => NXTK.t('setDownloadSpeedLabel', null, 'Download speed shown in Vortex'),
      type: 'decimal',
      unit: 'MB/s',
      min: 0.1,
      step: 0.1,
      desc: () => NXTK.t('setDownloadSpeedDesc', null, 'Vortex only. Enter the download speed you actually see in Vortex, in MB/s. The extension uses it to estimate when to send the next file because the browser cannot see Vortex\'s progress. It does not increase or limit your download speed.')
    },
    {
      key: 'NDC_pauseBetweenDownload',
      label: () => NXTK.t('setPauseBetweenModsLabel', null, 'Pause between mods'),
      type: 'number',
      unit: () => NXTK.t('unitSecondsShort', null, 's'),
      desc: () => NXTK.t('setPauseBetweenModsDesc', null, 'Vortex only. Extra seconds added to the estimated download time before sending the next file. With 0, skip that estimate and let Vortex queue files; a minimum 2-second gap remains.')
    }
  ];

  // Technical settings live under "Advanced" (one list in shared.js, also used by the tests).
  for (const s of SETTINGS_UI) {
    if (NXTK.ADVANCED_SETTING_KEYS.includes(s.key)) s.advanced = true;
  }


  const SETTING_GROUPS = [
    { name: 'downloads', titleKey: 'setSectionFlow', title: 'Downloads', keys: ['AutoStartDownload', 'AutoCloseTab', 'SkipRequirements', 'HandleArchivedFiles', 'DownloadFolder', 'WriteMo2Meta'] },
    { name: 'collections', titleKey: 'setSectionPacing', title: 'Collections', keys: ['WabbajackImport', 'HideDownloadPopup', 'NDC_smallestFirst', 'FollowUpdatePolicy', 'ShowModActions'] },
    { name: 'appearance', titleKey: 'setSectionLanguage', title: 'Appearance & language', keys: ['HidePremiumUpsells', 'ExpandRequirements', 'ShowAlertsOnError', 'ForceEnglish'] },
    { name: 'diagnostics', titleKey: 'setSectionDiagnostics', title: 'Diagnostics', keys: ['AutoErrorReports', 'PrivateDiagnostics'] }
  ];
  const SHORT_COPY = {
    "AutoErrorReports": ["setShortAutoErrorReports", "Off until you choose. Send sampled technical errors."],
    "PrivateDiagnostics": ["setShortPrivateDiagnostics", "Also store future technical errors in the private dashboard."],
    "AutoStartDownload": [
      "setShortAutoStartDownload",
      "Start when you open a file page."
    ],
    "AutoCloseTab": [
      "setShortAutoCloseTab",
      "Vortex only. Close the temporary tab after sending."
    ],
    "SkipRequirements": [
      "setShortSkipRequirements",
      "Go straight to the download step."
    ],
    "ShowAlertsOnError": [
      "setShortShowAlertsOnError",
      "Show a message when a download cannot start."
    ],
    "HidePremiumUpsells": [
      "setShortHidePremiumUpsells",
      "Hide ads, upgrade panels and the download countdown."
    ],
    "HandleArchivedFiles": [
      "setShortHandleArchivedFiles",
      "Add buttons to older files in the Nexus archive."
    ],
    "ExpandRequirements": [
      "setShortExpandRequirements",
      "Show a mod's requirements without a click."
    ],
    "WabbajackImport": [
      "setShortWabbajackImport",
      "Queue Nexus files from a .wabbajack modlist (beta)."
    ],
    "HideDownloadPopup": [
      "setShortHideDownloadPopup",
      "Chrome / Edge: keep the download bubble quiet during a run."
    ],
    "NDC_smallestFirst": [
      "setShortNDC_smallestFirst",
      "Download smaller collection files first."
    ],
    "UseOfficialApi": [
      "setShortUseOfficialApi",
      "Recommended way to get Nexus file information."
    ],
    "FollowUpdatePolicy": [
      "setShortFollowUpdatePolicy",
      "Follow the collection creator's version choices."
    ],
    "WriteMo2Meta": [
      "setShortWriteMo2Meta",
      "Save .meta files for Mod Organizer 2 beside browser downloads."
    ],
    "ShowModActions": [
      "setShortShowModActions",
      "Likes and tracking happen only when you click."
    ],
    "CloudflareFallback": [
      "setShortCloudflareFallback",
      "You complete the check yourself; it is not bypassed."
    ],
    "ForceEnglish": [
      "setShortForceEnglish",
      "Use English instead of your browser language."
    ],
    "DownloadFolder": [
      "setShortDownloadFolder",
      "Browser only. Empty uses your browser's own download folder."
    ],
    "RequestTimeout": [
      "setShortRequestTimeout",
      "Wait for a link, not for the entire file."
    ],
    "CloseTabDelay": [
      "setShortCloseTabDelay",
      "Vortex only. Wait before closing the temporary tab."
    ],
    "NDC_downloadSpeed": [
      "setShortNDC_downloadSpeed",
      "Estimate waiting time, not a speed limit."
    ],
    "NDC_pauseBetweenDownload": [
      "setShortNDC_pauseBetweenDownload",
      "Vortex only. Add a gap between files."
    ]
  };

  const PRESETS_UI = [
    { name: 'vortex', label: () => NXTK.t('presetVortex', null, 'Vortex user'), desc: () => NXTK.t('presetVortexDesc', null, 'Send to Vortex and close the tab.') },
    { name: 'browser', label: () => NXTK.t('presetBrowser', null, 'Browser downloads'), desc: () => NXTK.t('presetBrowserDesc', null, 'Save files with your browser.') },
    { name: 'minimal', label: () => NXTK.t('presetMinimal', null, 'Minimal'), desc: () => NXTK.t('presetMinimalDesc', null, 'Start only when you click.') }
  ];

  // UI.showSettingsModal in ui.js checks that the extension is still connected, then calls this.
  async function openSettingsModal() {
    const cfg = await NexusExt.Storage.getSettings();
    const activePreset = NXTK.matchingPreset(cfg);
    const presetButtons = PRESETS_UI.map((p) => `<button type="button" class="nxtk-preset${activePreset === p.name ? ' nxtk-preset-active' : ''}" data-preset="${p.name}" aria-pressed="${activePreset === p.name}"><span class="nxtk-preset-title">${escapeHtml(p.label())}</span><span class="nxtk-preset-desc">${escapeHtml(p.desc())}</span></button>`).join('');
    const presetsHtml = `<div class="nxtk-settings-section nxtk-settings-presets"><div class="nxtk-settings-section-title">${L('setSectionPresets', 'Quick setup')}</div><div class="nxtk-preset-row" role="group">${presetButtons}</div><div class="nxtk-preset-note" id="nxtk-preset-note">${activePreset ? '' : escapeHtml(NXTK.t('presetCustom', null, 'Custom: your own mix of settings.'))}</div></div>`;

    const text = (v) => (typeof v === 'function' ? v() : (v ?? ''));
    const buildRow = (s) => {
      const inputId = `nxtk-setting-${s.key}`;
      const summaryId = `${inputId}-summary`;
      const helpId = `${inputId}-help`;
      const title = text(s.label);
      const [summaryKey, summaryFallback] = SHORT_COPY[s.key];
      const summary = NXTK.t(summaryKey, null, summaryFallback);
      const copy = `<div class="nxtk-setting-copy"><div class="nxtk-setting-title-row"><label class="nxtk-setting-title" for="${inputId}">${escapeHtml(title)}</label><button type="button" class="nxtk-setting-help-toggle" data-setting-help="${s.key}" aria-expanded="false" aria-controls="${helpId}" aria-label="${escapeHtml(NXTK.t('setHelpFor', [title], 'More information: ' + title))}">${svgIcon('info')}</button></div><span class="nxtk-setting-desc" id="${summaryId}">${escapeHtml(summary)}</span></div>`;
      const help = `<p class="nxtk-setting-help" id="${helpId}" hidden>${escapeHtml(text(s.desc))}</p>`;
      let control = '';
      let warning = '';
      if (s.type === 'bool') {
        control = `<span class="nxtk-toggle"><input id="${inputId}" type="checkbox" data-setting="${s.key}" aria-describedby="${summaryId}" ${cfg[s.key] ? 'checked' : ''}><span class="nxtk-toggle-track"></span></span>`;
      } else if (s.type === 'number' || s.type === 'decimal') {
        const decimal = s.type === 'decimal' ? ' data-decimal="1"' : '';
        const scale = Number(s.scale) || 1;
        const scaleAttr = scale === 1 ? '' : ` data-scale="${scale}"`;
        const step = s.step ? ` step="${escapeHtml(s.step)}"` : '';
        const min = s.min === undefined ? 0 : s.min;
        const displayValue = Number(cfg[s.key]) / scale;
        control = `<span class="nxtk-setting-field"><input id="${inputId}" type="number" data-setting="${s.key}" aria-describedby="${summaryId}"${decimal}${scaleAttr}${step} value="${escapeHtml(displayValue)}" min="${escapeHtml(min)}"><span class="nxtk-setting-unit">${escapeHtml(text(s.unit))}</span></span>`;
      } else if (s.type === 'text') {
        const maxLength = Number(s.maxLength) > 0 ? ` maxlength="${Number(s.maxLength)}"` : '';
        const warned = s.warn ? s.warn(String(cfg[s.key] ?? '')) : '';
        const describedBy = s.warn ? `${summaryId} ${inputId}-warning` : summaryId;
        control = `<span class="nxtk-setting-field"><input id="${inputId}" type="text" data-setting="${s.key}" aria-describedby="${describedBy}"${warned ? ' aria-invalid="true"' : ''} value="${escapeHtml(cfg[s.key] ?? '')}"${maxLength} spellcheck="false"></span>`;
        if (s.warn) warning = `<p class="nxtk-setting-warning" id="${inputId}-warning" role="status"${warned ? '' : ' hidden'}>${escapeHtml(warned)}</p>`;
      }
      if (!control) return '';
      return `<div class="nxtk-setting-row${s.type === 'bool' ? '' : ' nxtk-setting-row-field'}" data-key="${s.key}"><div class="nxtk-setting-label">${copy}${control}</div>${warning}${help}</div>`;
    };

    const grouped = SETTING_GROUPS.map((group) => {
      const rows = group.keys.map((key) => SETTINGS_UI.find((s) => s.key === key)).map(buildRow).join('');
      const importButton = group.name === 'collections'
        ? `<button class="nxtk-btn nxtk-btn-secondary" id="nxtk-wj-import" ${cfg.WabbajackImport ? '' : 'hidden'}>${L('btnImportWabbajack', 'Import Wabbajack modlist')}</button>` : '';
      return `<section class="nxtk-settings-section nxtk-settings-${group.name}" data-settings-group="${group.name}" aria-labelledby="nxtk-group-${group.name}"><h3 class="nxtk-settings-section-title" id="nxtk-group-${group.name}">${L(group.titleKey, group.title)}</h3><div class="nxtk-settings-rows">${rows}</div>${importButton}</section>`;
    }).join('');
    const advanced = SETTINGS_UI.filter(s => s.advanced).map(buildRow).join('');

    const SETTING_INPUT_DEBOUNCE_MS = 400;
    const pendingInputWrites = new Map();
    const savedCfg = { ...cfg };
    const settingRevisions = new Map();
    let settingWrites = Promise.resolve();

    const { modal, close } = openModal({
      id: 'nxtk-settings-modal',
      ariaLabel: NXTK.t('setTitle', null, 'Download Helper Settings'),
      restoreFocus: true,
      // Flush pending edits before the dialog and its inputs leave the page.
      beforeClose: flushPendingInputs,
      html: `
      <div class="nxtk-modal-header">
        <div>
          <div class="nxtk-settings-heading"><div class="nxtk-modal-title">${L('setTitle', 'Download Helper Settings')}</div><span class="nxtk-settings-version-tag">v${escapeHtml(chrome.runtime.getManifest().version)}</span></div>
          <div class="nxtk-modal-subtitle">${L('setSubtitle', 'Changes save automatically.')}</div>
        </div>
        <button class="nxtk-modal-close" data-close aria-label="${L('ariaClose', 'Close')}">&times;</button>
      </div>
      <div class="nxtk-modal-scroll">
        ${presetsHtml}
        <div class="nxtk-settings-groups">${grouped}</div>
        <div class="nxtk-settings-advanced">
          <div class="nxtk-settings-advanced-bar">
            <button type="button" class="nxtk-settings-advanced-toggle" id="nxtk-advanced-toggle"
                    aria-expanded="false" aria-controls="nxtk-advanced-body">${svgIcon('chevronRight')} ${L('setSectionAdvanced', 'Advanced')}</button>
          </div>
          <div class="nxtk-settings-advanced-body" id="nxtk-advanced-body" hidden>
            <div class="nxtk-settings-advanced-panel">${advanced}</div>
          </div>
        </div>
      </div>
      <div class="nxtk-modal-footer">
        <button class="nxtk-btn nxtk-btn-secondary" data-reset>${L('setRestoreDefaults', 'Restore defaults')}</button>
        <div class="nxtk-settings-github">
          <button type="button" class="nxtk-settings-report" data-report-issue>${svgIcon('github')}<span data-report-label>${L('setReportOnGithub', 'Report a bug')}</span></button>
          <a class="nxtk-settings-report" data-suggest-idea href="${escapeHtml(NXTK.newDiscussionUrl('idea'))}" target="_blank" rel="noopener noreferrer" title="${L('setSuggestIdeaTip', 'Share an idea or ask a question in GitHub Discussions')}">${svgIcon('bulb')}<span>${L('setSuggestIdea', 'Suggest an idea')}</span></a>
        </div>
        <button class="nxtk-btn nxtk-btn-primary" data-close>${L('btnDone', 'Done')}</button>
      </div>
    `
    });

    // A text field that says why a value is not saved (DownloadFolder: a full path), while it holds one.
    function syncFieldWarning(input) {
      const setting = SETTINGS_UI.find((s) => s.key === input.dataset.setting);
      const note = setting?.warn ? modal.querySelector(`#${input.id}-warning`) : null;
      if (!note) return;
      const message = setting.warn(input.value);
      if (note.textContent !== message) note.textContent = message;
      note.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

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
        syncFieldWarning(el);
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
      const save = queueSetting(key, value);
      syncDiagnosticsControls();
      if (NexusExt.NNW) NexusExt.NNW.updateConfig(cfg);
      syncPresetState();

      if (key === 'WabbajackImport') syncImportControls();

      if (key === 'ForceEnglish') {
        const revision = settingRevisions.get(key);
        save.then(async (saved) => {
          if (!saved || settingRevisions.get(key) !== revision || !modal.isConnected) return;
          flushPendingInputs();
          await settingWrites;
          if (!modal.isConnected || settingRevisions.get(key) !== revision) return;
          NXTK.setForceEnglish(cfg[key]);
          close();
          NexusExt.UI.showSettingsModal().catch(() => undefined);
        });
      }
    }

    function showSaveFailure(reset = false) {
      const title = reset
        ? NXTK.t('setRestoreTitle', null, 'Restore Defaults')
        : NXTK.t('setTitle', null, 'Download Helper Settings');
      const { modal: alert } = openModal({
        id: 'nxtk-settings-save-error',
        className: 'nxtk-modal nxtk-modal-sm nxtk-alert-modal',
        role: 'alertdialog', ariaLabel: title, restoreFocus: true,
        html: `<div class="nxtk-modal-header"><div class="nxtk-modal-title">${escapeHtml(title)}</div></div>
          <div class="nxtk-alert-body"><div class="nxtk-alert-line">${L('rpSettingFailed', 'The setting could not be saved. Try again.')}</div></div>
          <div class="nxtk-modal-footer"><button type="button" class="nxtk-btn nxtk-btn-primary" data-close>${L('btnOk', 'OK')}</button></div>`
      });
      alert.querySelector('[data-close]').focus();
    }

    // Presets and individual edits share one queue, in click order. Revision checks
    // prevent an older failed write from rolling back a newer visible choice.
    function queueSetting(key, value) {
      return queueSettings({ [key]: value, ...(key === 'AutoErrorReports' && !value
        ? { PrivateDiagnostics: false, AutoReportDiagnostics: false } : {}) });
    }

    // One write for every setting in the patch (a preset), queued behind earlier writes. A setting the
    // user changed again meanwhile keeps that newer choice if this write fails.
    function queueSettings(patch) {
      const revisions = {};
      for (const [key, value] of Object.entries(patch)) {
        revisions[key] = (settingRevisions.get(key) || 0) + 1;
        settingRevisions.set(key, revisions[key]);
        cfg[key] = value;
      }
      const save = settingWrites.then(async () => {
        let saved = false;
        try { saved = await NexusExt.Storage.patchSettings(patch); } catch (_) { }
        if (saved) Object.assign(savedCfg, patch);
        else {
          let rolledBack = false;
          for (const key of Object.keys(patch)) {
            if (settingRevisions.get(key) !== revisions[key]) continue;
            rolledBack = true;
            cfg[key] = savedCfg[key];
            const input = modal.querySelector(`[data-setting="${key}"]`);
            if (input?.type === 'checkbox') input.checked = !!cfg[key];
            else if (input) input.value = typeof cfg[key] === 'number'
              ? String(cfg[key] / (Number(input.dataset.scale) || 1)) : cfg[key];
            if (input?.type === 'text') syncFieldWarning(input);
          }
          if (rolledBack) {
            if (NexusExt.NNW) NexusExt.NNW.updateConfig(cfg);
            syncImportControls();
            syncDiagnosticsControls();
            syncPresetState();
          }
          showSaveFailure();
        }
        return saved;
      });
      settingWrites = save.then(() => undefined);
      return save;
    }

    function flushPendingInputs() {
      for (const [target, timer] of pendingInputWrites) {
        clearTimeout(timer);
        if (target.isConnected) update(target, { commit: true });
      }
      pendingInputWrites.clear();
    }

    function syncImportControls() {
      if (cfg.WabbajackImport) kit.preloadBundle('wabbajack');
      for (const id of ['#nxtk-wj-import', '#nxtk-wj-deck-import', '#nxtk-wj-info']) {
        const button = id === '#nxtk-wj-import' ? modal.querySelector(id) : document.querySelector(id);
        if (button) button.hidden = !cfg.WabbajackImport;
      }
    }

    function syncDiagnosticsControls() {
      const control = modal.querySelector('[data-setting="PrivateDiagnostics"]');
      if (control) {
        control.disabled = !NXTK.RELAY_CONFIGURED || !cfg.AutoErrorReports;
        control.checked = !!cfg.AutoErrorReports && !!cfg.PrivateDiagnostics;
      }
    }
    syncDiagnosticsControls();

    // Quick setup follows every change live: the matching preset lights up, a mix says "Custom".
    function syncPresetState() {
      const active = NXTK.matchingPreset(cfg);
      modal.querySelectorAll('[data-preset]').forEach((button) => {
        const on = button.dataset.preset === active;
        button.classList.toggle('nxtk-preset-active', on);
        button.setAttribute('aria-pressed', String(on));
      });
      const note = modal.querySelector('#nxtk-preset-note');
      if (note) note.textContent = active ? '' : NXTK.t('presetCustom', null, 'Custom: your own mix of settings.');
    }

    const helpAnimations = new WeakMap();
    modal.addEventListener('click', (event) => {
      const button = event.target.closest('[data-setting-help]');
      if (!button || !modal.contains(button)) return;
      const detail = document.getElementById(button.getAttribute('aria-controls'));
      if (!detail || !modal.contains(detail)) return;
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      const previous = helpAnimations.get(detail);
      const snapshot = () => {
        const style = getComputedStyle(detail);
        return { height: `${detail.getBoundingClientRect().height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom, opacity: style.opacity, transform: style.transform, overflow: 'hidden' };
      };
      // A rapid reversal starts from the current visual size, not from a jump to full height.
      const current = previous && !detail.hidden ? snapshot() : null;
      previous?.cancel();
      button.setAttribute('aria-expanded', String(expanded));
      detail.setAttribute('aria-hidden', String(!expanded));
      if (!detail.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        helpAnimations.delete(detail);
        detail.hidden = !expanded;
        return;
      }
      detail.hidden = false;
      const full = { ...snapshot(), opacity: 1, transform: 'translateY(0)' };
      const collapsed = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0, transform: 'translateY(6px)', overflow: 'hidden' };
      const animation = detail.animate([
        current || (expanded ? collapsed : full), expanded ? full : collapsed
      ], { duration: expanded ? 260 : 220, easing: 'ease-out', fill: 'both' });
      helpAnimations.set(detail, animation);
      // Release the measured height once settled: long translations/resize can wrap naturally.
      animation.finished.then(() => {
        if (helpAnimations.get(detail) === animation) {
          helpAnimations.delete(detail);
          detail.hidden = !expanded;
          animation.cancel();
        }
      }, () => {
        if (helpAnimations.get(detail) === animation) helpAnimations.delete(detail);
      });
    });

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
    modal.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
      // Commit an edit before applying a preset, without replacing the dialog or its focused node.
      flushPendingInputs();
      const name = button.dataset.preset;
      const next = NXTK.applyPreset(cfg, name);
      const changes = {};
      for (const key of Object.keys(NXTK.SETTING_PRESETS[name] || {})) {
        if (cfg[key] !== next[key]) changes[key] = next[key];
      }
      const saves = Object.keys(changes).length ? [queueSettings(changes)] : [];
      if (NexusExt.NNW) NexusExt.NNW.updateConfig(cfg);
      modal.querySelectorAll('input[type="checkbox"][data-setting]').forEach((input) => {
        input.checked = !!cfg[input.dataset.setting];
      });
      syncImportControls();
      syncPresetState();
      kit.runUiTask(() => Promise.all(saves), { context: 'Applying quick setup', title: NXTK.t('setTitle', null, 'Download Helper Settings') });
    }));
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
    let resetting = false;
    modal.querySelector('[data-reset]').addEventListener('click', async () => {
      const resetButton = modal.querySelector('[data-reset]');
      if (resetting) return;
      resetting = true;
      try {
        const confirmed = await nxtkConfirm({
          title: NXTK.t('setRestoreTitle', null, 'Restore Defaults'),
          message: NXTK.t('setRestoreConfirm', null, 'Restore the default settings and refresh this Nexus page?'),
          confirmText: NXTK.t('btnRestore', null, 'Restore'),
          cancelText: NXTK.t('btnCancel', null, 'Cancel')
        });
        if (!confirmed) return;
        resetButton.disabled = true;
        flushPendingInputs();
        // Block new edits while finishing outstanding saves and applying defaults.
        modal.inert = true;
        await settingWrites;
        if (!await NexusExt.Storage.resetSettings()) {
          showSaveFailure(true);
          return;
        }
        close();
        location.reload();
      } catch (_) {
        showSaveFailure(true);
      } finally {
        modal.inert = false;
        resetButton.disabled = false;
        resetting = false;
      }
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
        restoreFocus: true,
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
