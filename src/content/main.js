(function () {
  'use strict';

  const { NNW, UI } = window.NexusExt;

  let previousRoute = null;
  let activeNdc = null;
  let deckMountRun = 0;
  let bootstrapDone = false;
  let initAttempts = 0;
  let initRetryAt = 0;
  let initRetryTimer = null;
  let bundleRetryAt = 0;
  let bundleRetryTimer = null;
  let bundleErrorShown = false;

  const INIT_RETRY_BASE_MS = 15000;
  const INIT_RETRY_MAX_MS = 5 * 60 * 1000;
  const ACTIVE_POLL_MS = 1000;
  const IDLE_POLL_MS = 5000;

  function toExtensionError(cause, context) {
    return window.NexusExt.Errors?.fromException
      ? window.NexusExt.Errors.fromException(cause, { context })
      : cause;
  }

  function logUnhandled(cause, context) {
    const error = toExtensionError(cause, context);
    NNW.Logger.error(`[${error?.code || 'request_failed'}] ${error?.userMessage || 'Unexpected extension error'}`, error?.technicalMessage || cause);
    return error;
  }

  // Firefox serves extension files from moz-extension://, so the scheme alone cannot identify them.
  function isExtensionScript(filename) {
    const file = String(filename || '');
    try {
      if (chrome.runtime?.id) return file.startsWith(chrome.runtime.getURL(''));
    } catch (_) {
    }
    return /^(?:chrome|moz|safari-web|ms-browser)-extension:\/\//i.test(file);
  }

  window.addEventListener('error', (event) => {
    if (!isExtensionScript(event.filename)) return;
    globalThis.NXTK?.recordError?.({
      code: 'uncaught_exception',
      context: `Uncaught at ${event.filename}:${event.lineno}:${event.colno}`,
      userMessage: 'An unexpected extension error occurred.',
      technicalMessage: String(event.message || ''),
      // A thrown string has no stack; where it was thrown still tells two faults apart.
      stack: String(event.error?.stack || '') || `    at ${event.filename}:${event.lineno}:${event.colno}`
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    // Promise failures from Nexus itself are outside the extension's responsibility.
    const reason = event.reason;
    const stack = String(reason?.stack || '');
    let ownStack = false;
    try { ownStack = stack.includes(chrome.runtime.getURL('')); } catch (_) { }
    if (!ownStack) return;
    NXTK.recordError({
      code: 'unhandled_rejection', context: 'Unhandled extension promise',
      userMessage: 'An unexpected extension error occurred.',
      technicalMessage: String(reason?.message || reason || ''), stack
    });
  });

  // A background tab does not paint, so waiting for a frame there held everything back until the tab was
  // shown — a browser download or a collection queue included, and neither needs anyone watching. The one
  // start that does, handing a link to Vortex, waits for the tab itself in nnw.js.
  function waitForNextPaint() {
    if (document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', done);
        resolve();
      };
      // A tab hidden while it waits would otherwise wait until it is shown again, and a page that reports
      // itself visible but is not being drawn, as an embedded browser view can, would wait for ever.
      document.addEventListener('visibilitychange', done);
      timer = setTimeout(done, 1000);
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
  }

  function waitForPageLoad() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  // Firefox can run the content scripts in a loaded document that has no body (E-1vrmg48). There is no
  // page to work on there, and startup failed on "document.body is null", so it waits for a body: one a
  // page adds later starts the extension, and a document that never gets one leaves it idle.
  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
  }

  async function waitForSafeStartup() {
    await waitForPageLoad();
    await waitForBody();
    await NNW.waitForDomSettled({
      root: document.getElementById('mainContent') || document.body,
      quietMs: 700,
      timeoutMs: 6000
    });
    await waitForNextPaint();
  }

  function extractRouteDetails(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const collectionIndex = parts.indexOf('collections');
    if (collectionIndex < 1 || !parts[collectionIndex + 1]) return null;

    const revisionIndex = parts.indexOf('revisions', collectionIndex + 2);
    return {
      gameDomain: parts[collectionIndex - 1],
      collectionSlug: parts[collectionIndex + 1],
      revisionNumber: revisionIndex !== -1 ? parts[revisionIndex + 1] || null : null
    };
  }

  function findCollectionHost() {
    const legacy = document.querySelector('.bg-surface-low.w-full.space-y-3.rounded-lg.p-4.mt-4');
    if (legacy?.parentElement) {
      return { container: legacy.parentElement, legacy };
    }

    let container = document.querySelector('#mainContent > div > div.relative > div.next-container')
      || document.querySelector('#mainContent .next-container');
    let layout = 'next-container';
    if (!container) {
      // Nexus can change its utility classes without changing the actual collection page. Mount
      // inside rendered main content, never in the body/header or a still-loading skeleton.
      const main = document.getElementById('mainContent') || document.querySelector('main, [role="main"]');
      if (main?.querySelector('h1') && !main.matches('[aria-busy="true"]')
        && !main.querySelector('[aria-busy="true"]')) {
        container = main;
        layout = 'page-content';
      }
    }
    if (!container) return null;

    return {
      container,
      layout,
      legacy: container.querySelector('.bg-surface-low.w-full.space-y-3.rounded-lg.p-4.mt-4')
    };
  }

  function teardownActiveCollection() {
    clearTimeout(initRetryTimer);
    initRetryTimer = null;
    clearTimeout(deckMountRetryTimer);
    deckMountRetryTimer = null;
    deckMountAttempts = 0;
    activeNdc?.dispose?.();
    UI.closeExtensionOverlays?.();

    const deck = document.getElementById('nxtk-control-deck');
    if (!deck) return;

    UI.disposeControlDeck?.(deck);
    deck.remove();
  }

  function resumeBackgroundRunFor(ndc) {
    ndc.resumeBackgroundRun?.()
      .catch((cause) => logUnhandled(cause, 'Reconnecting to a background collection download'));
  }

  async function ensureControlDeckMounted(ndc) {
    if (!ndc?.initialized) return;
    const mountRun = ++deckMountRun;
    await NNW.waitForDomSettled({ root: document.getElementById('mainContent') || document.body });
    if (mountRun !== deckMountRun || activeNdc !== ndc) return;

    const existingDeck = document.getElementById('nxtk-control-deck');
    if (existingDeck) {
      deckMountAttempts = 0;
      return;
    }

    const host = findCollectionHost();
    if (!host?.container) {
      // Next.js hydrates the collection page in stages, and the spot for the deck can arrive after
      // the DOM first goes quiet. Retry on a short, growing timer instead of waiting for a reload.
      scheduleDeckMountRetry(ndc);
      return;
    }
    deckMountAttempts = 0;

    const deck = UI.createControlDeck(ndc);
    if (host.legacy) {
      host.legacy.classList.add('nxtk-hidden');
      host.legacy.insertAdjacentElement('afterend', deck);
    } else if (host.layout === 'page-content') {
      host.container.prepend(deck);
    } else {
      host.container.appendChild(deck);
    }

    resumeBackgroundRunFor(ndc);
  }

  const DECK_MOUNT_RETRY_BASE_MS = 250;
  const DECK_MOUNT_RETRY_MAX_MS = 4000;
  const DECK_MOUNT_MAX_ATTEMPTS = 20;
  let deckMountAttempts = 0;
  let deckMountRetryTimer = null;

  function scheduleDeckMountRetry(ndc) {
    if (deckMountRetryTimer || deckMountAttempts >= DECK_MOUNT_MAX_ATTEMPTS) return;
    const delay = Math.min(DECK_MOUNT_RETRY_BASE_MS * Math.pow(2, deckMountAttempts), DECK_MOUNT_RETRY_MAX_MS);
    deckMountAttempts += 1;
    // A genuine mount failure is checked after the bounded recovery period, not while Nexus is
    // hydrating. This runs once; the normal page poll must not continually restart the check.
    if (deckMountAttempts === DECK_MOUNT_MAX_ATTEMPTS) window.NexusExt.PageCheck?.schedule();
    deckMountRetryTimer = setTimeout(() => {
      deckMountRetryTimer = null;
      if (activeNdc === ndc && !document.getElementById('nxtk-control-deck')) handleRouteChange();
    }, delay);
  }

  const ROUTE_CHANGE_DEBOUNCE_MS = 150;
  // A page that never stops mutating would otherwise push the update back indefinitely.
  const ROUTE_CHANGE_MAX_WAIT_MS = 1000;
  let routeChangeTimer = null;
  let routeChangePendingSince = 0;
  // Serialize SPA route updates so navigation cannot race deck setup.
  let routeChangeChain = Promise.resolve();
  function handleRouteChange() {
    const now = Date.now();
    if (!routeChangePendingSince) routeChangePendingSince = now;
    const overdue = now - routeChangePendingSince >= ROUTE_CHANGE_MAX_WAIT_MS;
    clearTimeout(routeChangeTimer);
    routeChangeTimer = setTimeout(() => {
      routeChangeTimer = null;
      routeChangePendingSince = 0;
      const run = () => handleRouteChangeInner()
        .catch((cause) => logUnhandled(cause, 'Updating Nexus route'));
      routeChangeChain = routeChangeChain.then(run, run);
    }, overdue ? 0 : ROUTE_CHANGE_DEBOUNCE_MS);
  }

  async function handleRouteChangeInner() {
    if (!bootstrapDone) return;

    UI.cleanupOrphanedPortals?.();

    const route = extractRouteDetails(location.pathname);
    if (!route) {
      if (previousRoute === null && !activeNdc) return;
      previousRoute = null;
      deckMountRun++;
      teardownActiveCollection();
      activeNdc = null;
      return;
    }

    // The collection downloader is not among the scripts every page loads; the first collection page asks.
    if (!window.NexusExt.NDC) {
      if (Date.now() < bundleRetryAt) return;
      try {
        await UI.loadBundle('collection');
      } catch (cause) {
        await reportCollectionBundleFailure(cause);
        return;
      }
      // The page can have moved on while it loaded, so the route is read again.
      if (window.NexusExt.NDC) await handleRouteChangeInner();
      return;
    }

    const { gameDomain, collectionSlug, revisionNumber } = route;
    const routeKey = `${gameDomain}/${collectionSlug}/`;
    const parsedRevision = revisionNumber ? parseInt(revisionNumber, 10) : NaN;
    const rev = Number.isFinite(parsedRevision) ? parsedRevision : null;

    // A modlist deck that took this collection's place disposed its downloader. Once that deck is closed the
    // collection starts over, or its page would be left with no deck at all.
    const replacedAndClosed = !!activeNdc?.disposed && !document.getElementById('nxtk-control-deck');
    if (previousRoute !== routeKey || activeNdc?.revision !== rev || replacedAndClosed) {
      previousRoute = routeKey;
      deckMountRun++;

      teardownActiveCollection();

      activeNdc = new window.NexusExt.NDC(gameDomain, collectionSlug, rev);
      initAttempts = 0;
      initRetryAt = 0;
      await startCollection(activeNdc);
      return;
    }

    if (activeNdc && !activeNdc.initialized) {
      if (Date.now() < initRetryAt) return;
      await startCollection(activeNdc);
      return;
    }

    if (activeNdc && !document.getElementById('nxtk-control-deck')) {
      await ensureControlDeckMounted(activeNdc);
    }
  }

  async function reportCollectionBundleFailure(cause) {
    const error = logUnhandled(cause, 'Loading the collection downloader');
    // A reloaded extension cannot add anything to this page again; only a refresh brings the deck back.
    const reloaded = window.NexusExt.Storage?.isContextValid?.() === false;
    bundleRetryAt = reloaded ? Infinity : Date.now() + INIT_RETRY_BASE_MS;
    clearTimeout(bundleRetryTimer);
    if (!reloaded) bundleRetryTimer = setTimeout(handleRouteChange, INIT_RETRY_BASE_MS);
    if (bundleErrorShown) return;
    bundleErrorShown = true;
    let cfg = null;
    try {
      cfg = await window.NexusExt.Storage.getSettings();
    } catch (_) {
    }
    if (cfg?.ShowAlertsOnError) {
      UI.showError(error, { title: NXTK.t('dlgCantLoadCollection', null, 'Could not load collection') });
    }
  }

  async function startCollection(ndc) {
    const success = await ndc.init();
    if (activeNdc !== ndc) return;
    if (!success) {
      initAttempts += 1;
      const retryDelay = Math.min(INIT_RETRY_BASE_MS * Math.pow(2, initAttempts - 1), INIT_RETRY_MAX_MS);
      initRetryAt = Date.now() + retryDelay;
      clearTimeout(initRetryTimer);
      initRetryTimer = setTimeout(() => {
        initRetryTimer = null;
        if (activeNdc === ndc && !ndc.initialized) handleRouteChange();
      }, retryDelay);
      if (initAttempts === 1 && ndc.showAlertsOnError) {
        UI.showError(ndc.lastError, { title: NXTK.t('dlgCantLoadCollection', null, 'Could not load collection') });
      }
      return;
    }
    initAttempts = 0;
    initRetryAt = 0;
    clearTimeout(initRetryTimer);
    initRetryTimer = null;
    await ensureControlDeckMounted(ndc);
  }

  function navKey() {
    return location.origin + location.pathname + location.search;
  }

  let lastNavKey = navKey();

  function syncNavigation() {
    const key = navKey();
    if (key === lastNavKey) return;
    lastNavKey = key;
    if (!bootstrapDone) return;
    NNW.onNavigate().catch((cause) => logUnhandled(cause, 'Applying page navigation'));
    handleRouteChange();
    window.NexusExt.PageCheck?.schedule();
  }

  window.addEventListener('popstate', syncNavigation);
  // A content script cannot see the page's history.pushState calls; the Navigation API, where the
  // browser has it, reports SPA navigations directly instead of leaving them to the next poll tick.
  try {
    window.navigation?.addEventListener?.('navigatesuccess', syncNavigation);
  } catch (_) {
  }

  // Opened from the popup's "Page settings" with #nxtk-settings: show the panel, then drop the hash so a
  // reload or a shared link does not reopen it.
  function openSettingsFromHash() {
    if (location.hash !== NXTK.PAGE_SETTINGS_HASH) return;
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch (_) {
    }
    UI.showSettingsModal().catch((cause) => {
      const error = logUnhandled(cause, 'Opening page settings');
      UI.showError?.(error, { title: NXTK.t('dlgCantOpenSettings', null, 'Could not open settings') });
    });
  }
  openSettingsFromHash();
  addEventListener('hashchange', openSettingsFromHash);

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type !== 'TOGGLE_POPOUT') return false;
      UI.showSettingsModal().catch((cause) => {
        const error = logUnhandled(cause, 'Opening page settings');
        UI.showError?.(error, { title: NXTK.t('dlgCantOpenSettings', null, 'Could not open settings') });
      });
      sendResponse({ ok: true });
      return false;
    });
  } catch (_) {
  }

  function isExtensionOwnedMutation(mutation) {
    const target = mutation.target;
    if (!target || target.nodeType !== 1) return false;
    return !!target.closest?.('[id^="nxtk-"], .nxtk-deck, .nxtk-modal-backdrop, #nxtk-dropdown-portal');
  }

  async function bootstrap() {
    await waitForSafeStartup();
    await NNW.init();
    UI.createSettingsFAB();
    UI.showAutoReportInvitation?.().catch(() => undefined);
    bootstrapDone = true;

    window.NexusExt.PageCheck?.configure({
      findCollectionHost,
      collectionMountPending: () => !activeNdc?.initialized ||
        (!document.getElementById('nxtk-control-deck') && deckMountAttempts < DECK_MOUNT_MAX_ATTEMPTS),
      isCollectionRoute: (pathname) => !!extractRouteDetails(pathname)
    });
    window.NexusExt.PageCheck?.schedule();

    syncNavigation();

    const observer = new MutationObserver((mutations) => {
      if (mutations.every(isExtensionOwnedMutation)) return;
      syncNavigation();
      handleRouteChange();
      syncPollRate();
    });

    let observedRoot = null;
    function syncObserverRoot() {
      const root = document.getElementById('mainContent') || document.body;
      if (!root || root === observedRoot) return;
      observer.disconnect();
      observer.observe(root, { childList: true, subtree: true });
      observedRoot = root;
      handleRouteChange();
    }

    syncObserverRoot();
    handleRouteChange();

    let pollTimer = null;
    let pollInterval = 0;

    function syncPollRate() {
      const actionable = NNW.isActionablePage?.() || !!extractRouteDetails(location.pathname);
      const next = actionable ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      if (next === pollInterval) return;
      pollInterval = next;
      clearInterval(pollTimer);
      pollTimer = setInterval(tick, next);
    }

    function tick() {
      syncObserverRoot();
      syncNavigation();
      syncPollRate();
      // Self-heal: a collection page whose deck was never mounted, or was wiped by a re-render.
      if (activeNdc?.initialized && !activeNdc.disposed && extractRouteDetails(location.pathname)
        && !document.getElementById('nxtk-control-deck')) {
        handleRouteChange();
      }
    }

    syncPollRate();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      UI.showAutoReportInvitation?.().catch(() => undefined);
      syncObserverRoot();
      syncNavigation();
      syncPollRate();
    });
  }

  bootstrap().catch((cause) => {
    const error = logUnhandled(cause, 'Starting NexusMods Bypass');
    UI.showError?.(error, { title: NXTK.t('dlgStartupIssue', null, 'Extension startup issue') });
  });
})();
