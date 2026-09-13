window.NexusExt = window.NexusExt || {};

(function () {
  'use strict';

  // What the bundles loaded later share with this file (see loadBundle). They run in the same isolated
  // world as the manifest's content scripts, which the page itself cannot reach.
  const kit = { collection: null, dropdowns: null, settings: null, wabbajack: null };

  const ICONS = {
    settings: '<svg viewBox="0 0 24 24"><path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.04 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/></svg>',
    info: '<svg viewBox="0 0 24 24"><path d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/></svg>'
  };

  function svgIcon(name, extraClass) {
    const html = ICONS[name] || '';
    if (!extraClass) return html;
    return html.replace('<svg ', `<svg class="${extraClass}" `);
  }

  // A bundle brings the icons only it uses, and svgIcon serves them like the rest.
  function registerIcons(icons) {
    Object.assign(ICONS, icons);
  }

  const escapeHtml = NXTK.escapeHtml;

  const L = (key, fallback) => escapeHtml(NXTK.t(key, null, fallback));

  // The collection downloader, the settings dialog, the Wabbajack importer and the bug report builder are
  // not needed on most Nexus pages, so they are not among the content scripts every page loads. The first
  // time a page needs one, the worker adds that bundle's packaged files to this frame (CONTENT_BUNDLES in
  // background.js), and each file registers itself on kit as it runs.
  const BUNDLES = {
    report: { ready: () => typeof NXTK.buildReportIssueUrl === 'function' },
    settings: { ready: () => !!kit.settings },
    collection: { ready: () => !!kit.collection },
    wabbajack: { requires: ['collection'], ready: () => !!kit.wabbajack }
  };
  const bundleLoads = new Map();

  function requestBundle(name) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'LOAD_BUNDLE', bundle: name }, (reply) => {
        const failure = chrome.runtime.lastError?.message || (reply?.ok ? '' : String(reply?.error || 'no reply'));
        if (failure) reject(new Error(`Could not load ${name}: ${failure}`));
        else resolve();
      });
    });
  }

  function loadBundle(name) {
    const bundle = Object.prototype.hasOwnProperty.call(BUNDLES, name) ? BUNDLES[name] : null;
    if (!bundle) return Promise.reject(new Error(`Unknown bundle: ${name}`));
    if (bundle.ready()) return Promise.resolve();
    if (!bundleLoads.has(name)) {
      const pending = (async () => {
        for (const required of bundle.requires || []) await loadBundle(required);
        await requestBundle(name);
        if (!bundle.ready()) throw new Error(`${name} was added to the page but did not register`);
      })();
      bundleLoads.set(name, pending);
      // A failed load can be asked for again; a finished one is answered by ready().
      pending.catch(() => bundleLoads.delete(name));
    }
    return bundleLoads.get(name);
  }

  // For a bundle a click is likely to need, so it is already there when the click comes.
  function preloadBundle(name) {
    loadBundle(name).catch(() => undefined);
  }

  function openReportIssue(url = NXTK.REPORT_ISSUE_URL) {
    if (NexusExt.Errors?.openReportIssue) {
      NexusExt.Errors.openReportIssue(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function copyReportAndOpenIssue(button, currentError = null) {
    let copied = false;
    let complete = false;
    let issueUrl = NXTK.REPORT_ISSUE_URL;
    try {
      await loadBundle('report');
      const result = await NXTK.buildReportIssueUrl(currentError);
      issueUrl = result.url;
      complete = result.complete;
      if (!complete && result.report) copied = await NXTK.copyText(result.report);
    } catch (_) {
      copied = false;
    }
    if (button) {
      const label = button.querySelector('[data-report-label]') || button;
      const originalText = label.textContent;
      button.disabled = true;
      label.textContent = complete
        ? NXTK.t('dlgReportOpeningFull', null, 'GitHub opens with the full report…')
        : copied
          ? NXTK.t('dlgReportOpeningCopied', null, 'Report copied — GitHub opens prefilled…')
          : NXTK.t('popupReportNoCopy', null, 'GitHub opens prefilled — the full report could not be copied.');
      setTimeout(() => {
        button.disabled = false;
        label.textContent = originalText;
      }, 2500);
    }
    openReportIssue(issueUrl);
  }

  function runUiTask(task, { context = 'Running extension action', title = 'Extension action failed' } = {}) {
    Promise.resolve()
      .then(task)
      .catch((cause) => {
        const error = NexusExt.Errors?.fromException
          ? NexusExt.Errors.fromException(cause, { context })
          : cause;
        showError(error, { title });
      });
  }

  // Runs something from the Wabbajack importer, loading it and the collection downloader it builds on first.
  function withWabbajack(run) {
    runUiTask(async () => {
      await loadBundle('wabbajack');
      await run(kit.wabbajack);
    }, {
      context: 'Loading the Wabbajack importer',
      title: NXTK.t('dlgWabbajackTitle', null, 'Wabbajack Modlist Import')
    });
  }

  function applyGlassLayers(el) {
    if (!el || el.dataset.nxtkGlass === '1') return;
    el.dataset.nxtkGlass = '1';

    const specular = document.createElement('span');
    specular.className = 'nxtk-glass-specular';
    specular.setAttribute('aria-hidden', 'true');

    const sheen = document.createElement('span');
    sheen.className = 'nxtk-glass-sheen';
    sheen.setAttribute('aria-hidden', 'true');

    el.insertBefore(sheen, el.firstChild);
    el.insertBefore(specular, el.firstChild);
  }

  function decorateGlass(root) {
    if (!root) return root;
    const selectors = [
      '.nxtk-deck',
      '.nxtk-settings-fab'
    ];
    selectors.forEach((sel) => {
      const matches = root.matches?.(sel) ? [root] : [];
      root.querySelectorAll?.(sel).forEach((el) => matches.push(el));
      matches.forEach(applyGlassLayers);
    });
    return root;
  }

  function prepareToolkitSurface(root) {
    if (!root) return root;

    root.querySelectorAll('button').forEach((button) => {
      if (!button.getAttribute('type')) button.type = 'button';
      button.draggable = false;
    });

    root.querySelectorAll('.nxtk-btn, .nxtk-selector-item, .nxtk-dropdown-item, .nxtk-history-option, .nxtk-modal-close, .nxtk-radio-label, .nxtk-mod-item').forEach((el) => {
      el.draggable = false;
    });

    decorateGlass(root);

    return root;
  }

  let overlayScrollLockAttached = false;

  const NDC_BOUND_MODAL_IDS = [
    'nxtk-error-modal',
    'nxtk-vortex-check-modal',
    'nxtk-history-modal',
    'nxtk-import-info-modal',
    'nxtk-wj-info-modal',
    'nxtk-select-modal',
    'nxtk-update-modal'
  ];

  function closeExtensionOverlays() {
    NDC_BOUND_MODAL_IDS.forEach(closeModal);
    kit.dropdowns?.closeAll();
    kit.dropdowns?.cleanupOrphanedPortals();
  }

  let modalInteractionGuardBound = false;

  function getTopModalBackdrop() {
    const backdrops = Array.from(document.querySelectorAll('.nxtk-modal-backdrop'));
    return backdrops[backdrops.length - 1] || null;
  }

  function canScrollModalTarget(target, modal, deltaY) {
    let node = target;
    while (node && node !== modal.parentElement) {
      if (node.nodeType === 1 && modal.contains(node)) {
        const style = getComputedStyle(node);
        const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        if (canScroll) {
          const atTop = node.scrollTop <= 0;
          const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          return deltaY < 0 ? !atTop : !atBottom;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function ensureModalInteractionGuard() {
    if (modalInteractionGuardBound) return;
    modalInteractionGuardBound = true;

    document.addEventListener('pointerdown', (event) => {
      const backdrop = getTopModalBackdrop();
      if (!backdrop) return;

      const modal = backdrop.querySelector('.nxtk-modal');
      if (!modal) return;

      if (!modal.contains(event.target) && event.target !== backdrop) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  ensureModalInteractionGuard();

  function onOverlayWheel(event) {
    kit.dropdowns?.blockPageScroll(event);

    const backdrop = getTopModalBackdrop();
    if (!backdrop) return;
    const modal = backdrop.querySelector('.nxtk-modal');
    if (!modal) return;
    if (!modal.contains(event.target) || !canScrollModalTarget(event.target, modal, event.deltaY)) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  function onOverlayTouchMove(event) {
    kit.dropdowns?.blockPageScroll(event);
  }

  // Install blocking scroll handlers only while extension overlays are open.
  function syncOverlayScrollLock() {
    const needed = !!kit.dropdowns?.hasOpenMenus() || !!document.querySelector('.nxtk-modal-backdrop');
    if (needed === overlayScrollLockAttached) return;
    overlayScrollLockAttached = needed;
    if (needed) {
      document.addEventListener('wheel', onOverlayWheel, { capture: true, passive: false });
      document.addEventListener('touchmove', onOverlayTouchMove, { capture: true, passive: false });
      return;
    }
    document.removeEventListener('wheel', onOverlayWheel, true);
    document.removeEventListener('touchmove', onOverlayTouchMove, true);
  }

  // Menus only exist once the collection bundle has loaded; until then there is only the scroll lock to keep.
  function syncOverlayState() {
    if (kit.dropdowns) kit.dropdowns.syncPageLock();
    else syncOverlayScrollLock();
  }

  function watchOverlayPresence() {
    if (!document.body) return;
    new MutationObserver(syncOverlayScrollLock)
      .observe(document.body, { childList: true });
  }
  watchOverlayPresence();

  function createSettingsFAB() {
    let host = document.getElementById('nxtk-extension-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'nxtk-extension-root';
      host.dataset.nxtkOwned = '1';
      document.body.appendChild(host);
    }

    if (host.querySelector('#nxtk-settings-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'nxtk-settings-fab';
    fab.className = 'nxtk-settings-fab';
    fab.innerHTML = `${svgIcon('settings')} NexusMods Bypass`;
    fab.addEventListener('click', () => runUiTask(
      () => showSettingsModal(),
      { context: 'Opening page settings', title: NXTK.t('dlgCantOpenSettings', null, 'Could not open settings') }
    ));
    host.appendChild(fab);
    applyGlassLayers(fab);
  }

  async function showSettingsModal() {
    closeModal('nxtk-settings-modal');

    if (NexusExt.Storage.isContextValid && !NexusExt.Storage.isContextValid()) {
      await nxtkAlert(NXTK.t('alertContextInvalid', null,
        'NexusMods Bypass was updated or reloaded.\nPlease refresh this page to open settings.'));
      return;
    }

    await loadBundle('settings');
    await kit.settings.open();
  }

  function showError(error, { onRetry = null, title = '' } = {}) {
    const normalized = NexusExt.Errors?.normalize
      ? NexusExt.Errors.normalize(error)
      : {
        code: 'request_failed',
        userMessage: String(error || 'The download request failed.'),
        recovery: 'Retry the download. If it keeps happening, report the issue.',
        retryable: false
      };
    const canRetry = normalized.retryable && typeof onRetry === 'function';
    const requiresLogin = normalized.code === 'requires_login';
    const shown = NexusExt.Errors?.displayText
      ? NexusExt.Errors.displayText(normalized)
      : { message: normalized.userMessage, recovery: normalized.recovery };
    // Without a title of its own the dialog names what is needed: a sign-in, or a look at the
    // download. A caller's title is kept as given, in whatever language it was translated into.
    const dialogTitle = title || (requiresLogin
      ? NXTK.t('dlgSignInRequired', null, 'Sign in required')
      : NXTK.t('dlgDownloadIssue', null, 'Download issue'));

    // Fetched while the dialog is read, so its "Report a bug" button answers at once.
    if (!normalized.blocking) preloadBundle('report');

    return new Promise((resolve) => {
      const { modal, close } = openModal({
        id: 'nxtk-error-modal',
        className: 'nxtk-modal nxtk-modal-sm nxtk-alert-modal nxtk-error-modal',
        backdropClassName: 'nxtk-modal-backdrop nxtk-alert-backdrop',
        role: 'alertdialog',
        onClose: () => resolve(),
        html: `
        <div class="nxtk-modal-header">
          <div class="nxtk-alert-header-inner">
            <span class="nxtk-alert-icon nxtk-error-icon">${svgIcon('info')}</span>
            <span class="nxtk-modal-title">${escapeHtml(dialogTitle)}</span>
          </div>
          <button class="nxtk-modal-close" type="button" data-close aria-label="${escapeHtml(NXTK.t('ariaCloseErrorDialog', null, 'Close error dialog'))}">&times;</button>
        </div>
        <div class="nxtk-alert-body">
          <div class="nxtk-error-message">${escapeHtml(shown.message)}</div>
          <div class="nxtk-error-recovery">${escapeHtml(shown.recovery)}</div>
          <div class="nxtk-error-code">${escapeHtml(NXTK.t('dlgErrorId', null, 'Error ID'))}: ${escapeHtml(normalized.code)}</div>
        </div>
        <div class="nxtk-modal-footer nxtk-alert-footer nxtk-error-footer">
          ${normalized.blocking
            ? `<a class="nxtk-btn nxtk-btn-secondary" href="${escapeHtml(NXTK.TROUBLESHOOTING_URL)}" target="_blank" rel="noopener noreferrer">${escapeHtml(NXTK.t('dlgWhatDoesThisMean', null, 'What does this mean?'))}</a>`
            : `<button class="nxtk-btn nxtk-btn-secondary" type="button" data-report>${escapeHtml(NXTK.t('dlgReportBug', null, 'Report a bug'))}</button>`}
          ${requiresLogin
            ? `<button class="nxtk-btn nxtk-btn-primary" type="button" data-login>${escapeHtml(NXTK.t('btnSignIn', null, 'Sign in to Nexus Mods'))}</button>`
            : canRetry
              ? `<button class="nxtk-btn nxtk-btn-primary" type="button" data-retry>${escapeHtml(NXTK.t('btnRetry', null, 'Retry'))}</button>`
              : `<button class="nxtk-btn nxtk-btn-primary" type="button" data-close>${escapeHtml(NXTK.t('btnDone', null, 'Done'))}</button>`}
        </div>`
      });

      const reportButton = modal.querySelector('[data-report]');
      reportButton?.addEventListener('click', () => copyReportAndOpenIssue(reportButton, normalized));
      modal.querySelector('[data-login]')?.addEventListener('click', () => {
        close();
        NexusExt.Auth?.openLogin?.();
      });
      modal.querySelector('[data-retry]')?.addEventListener('click', () => {
        close();
        Promise.resolve().then(onRetry).catch((cause) => {
          const retryError = NexusExt.Errors?.fromException
            ? NexusExt.Errors.fromException(cause, { context: 'Retrying download' })
            : cause;
          showError(retryError, { onRetry, title });
        });
      });
      (modal.querySelector('[data-login]') || modal.querySelector('[data-retry]') || modal.querySelector('[data-close]'))?.focus();
    });
  }

  function nxtkAlert(message) {
    return new Promise((resolve) => {
      const lines = String(message).split('\n');
      const bodyHtml = lines.map(l => `<div class="nxtk-alert-line">${escapeHtml(l)}</div>`).join('');

      const { modal } = openModal({
        className: 'nxtk-modal nxtk-modal-sm nxtk-alert-modal',
        backdropClassName: 'nxtk-modal-backdrop nxtk-alert-backdrop',
        onClose: () => resolve(),
        html: `
        <div class="nxtk-modal-header">
          <div class="nxtk-alert-header-inner">
            <span class="nxtk-alert-icon">${svgIcon('info')}</span>
            <span class="nxtk-modal-title">NexusMods Bypass</span>
          </div>
        </div>
        <div class="nxtk-alert-body">${bodyHtml}</div>
        <div class="nxtk-modal-footer nxtk-alert-footer">
          <button class="nxtk-btn nxtk-btn-primary nxtk-alert-ok" type="button" data-close>${L('btnOk', 'OK')}</button>
        </div>`
      });
      modal.querySelector('.nxtk-alert-ok').focus();
    });
  }

  const MODAL_SETTLE = Symbol('nxtkModalSettle');

  // Every extension dialog is built here: the backdrop, Escape and a backdrop click to close, and any
  // [data-close] control closing with its value. onClose runs exactly once, whatever closed the dialog
  // (closeModal() from a teardown included), so a promise waiting on the dialog always settles.
  function openModal({
    id = '',
    className = 'nxtk-modal nxtk-modal-sm',
    backdropClassName = 'nxtk-modal-backdrop',
    role = 'dialog',
    ariaLabel = '',
    html = '',
    restoreFocus = false,
    onKeyDown = null,
    beforeClose = null,
    onClose = null
  } = {}) {
    if (id) closeModal(id);

    const backdrop = document.createElement('div');
    backdrop.className = backdropClassName;
    if (id) backdrop.id = id;

    const modal = document.createElement('div');
    modal.className = className;
    modal.setAttribute('role', role);
    modal.setAttribute('aria-modal', 'true');
    if (ariaLabel) modal.setAttribute('aria-label', ariaLabel);
    modal.innerHTML = html;
    prepareToolkitSurface(modal);

    const previouslyFocused = restoreFocus ? document.activeElement : null;
    let closed = false;

    const handleKeyDown = (event) => {
      if (!document.contains(backdrop)) {
        close();
        return;
      }
      // Only the dialog on top answers, so Escape on an alert does not also close what it sits on.
      if (getTopModalBackdrop() !== backdrop) return;
      if (event.key === 'Escape') {
        close();
        return;
      }
      onKeyDown?.(event, close);
    };

    function close(value) {
      if (closed) return;
      closed = true;
      beforeClose?.();
      document.removeEventListener('keydown', handleKeyDown);
      backdrop[MODAL_SETTLE] = null;
      kit.dropdowns?.disposeMenusIn(modal);
      backdrop.remove();
      syncOverlayState();
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.({ preventScroll: true });
      try {
        onClose?.(value);
      } catch (_) {
      }
    }

    backdrop[MODAL_SETTLE] = () => close();
    modal.addEventListener('click', (event) => {
      const trigger = event.target.closest?.('[data-close]');
      if (trigger && modal.contains(trigger)) close(trigger.dataset.close || undefined);
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', handleKeyDown);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    return { backdrop, modal, close };
  }

  function closeModal(id) {
    const existing = document.getElementById(id);
    if (!existing) return;
    const settle = existing[MODAL_SETTLE];
    if (typeof settle === 'function') {
      settle();
    } else {
      kit.dropdowns?.disposeMenusIn(existing);
      existing.remove();
    }
    syncOverlayState();
  }

  function showCloseCountdown({ ms = 3000, onDone = null, onCancel = null } = {}) {
    const total = Math.max(1000, Number(ms) || 3000);
    let remaining = Math.ceil(total / 1000);
    let finished = false;
    let ticker = null;

    const toast = document.createElement('div');
    toast.className = 'nxtk-close-toast';
    toast.setAttribute('role', 'group');
    toast.setAttribute('aria-label', NXTK.t('toastSentToVortex', null, 'Sent to Vortex'));

    const copy = document.createElement('div');
    copy.className = 'nxtk-close-toast-copy';

    const title = document.createElement('strong');
    title.setAttribute('role', 'status');
    title.setAttribute('aria-live', 'polite');
    title.textContent = NXTK.t('toastSentToVortex', null, 'Sent to Vortex');

    const detail = document.createElement('span');
    detail.setAttribute('aria-hidden', 'true');
    const renderDetail = () => {
      detail.textContent = NXTK.tPlural(
        'toastClosingIn',
        remaining,
        `Closing this tab in ${remaining}s`,
        [String(remaining)]
      );
    };
    renderDetail();

    copy.append(title, detail);

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'nxtk-btn nxtk-btn-secondary nxtk-close-toast-keep';
    keep.textContent = NXTK.t('toastKeepOpen', null, 'Keep open');

    const bar = document.createElement('span');
    bar.className = 'nxtk-close-toast-bar';
    bar.style.setProperty('--nxtk-close-duration', `${total}ms`);

    toast.append(copy, keep, bar);

    const teardown = () => {
      if (finished) return false;
      finished = true;
      clearInterval(ticker);
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 200);
      return true;
    };

    keep.addEventListener('click', () => {
      if (!teardown()) return;
      try { onCancel?.(); } catch (_) { }
    });

    ticker = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        renderDetail();
        return;
      }
      if (!teardown()) return;
      try { onDone?.(); } catch (_) { }
    }, 1000);

    prepareToolkitSurface(toast);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));

    return () => { teardown(); };
  }

  Object.assign(kit, {
    svgIcon,
    registerIcons,
    escapeHtml,
    L,
    runUiTask,
    prepareToolkitSurface,
    copyReportAndOpenIssue,
    withWabbajack,
    openModal,
    closeModal,
    syncOverlayScrollLock,
    showError,
    nxtkAlert,
    loadBundle,
    preloadBundle
  });
  window.NexusExt.UIKit = kit;

  window.NexusExt.UI = {
    createSettingsFAB,
    closeExtensionOverlays,
    cleanupOrphanedPortals: () => kit.dropdowns?.cleanupOrphanedPortals(),
    disposeControlDeck: (deck) => kit.collection?.disposeControlDeck(deck),
    showSettingsModal,
    showError,
    showCloseCountdown,
    nxtkAlert,
    loadBundle
  };
})();
