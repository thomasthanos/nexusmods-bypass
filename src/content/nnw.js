/*
 * Download-flow component for NexusMods Bypass.
 *
 * Based on Nexus No Wait ++ by Torkelicious and upstream contributors:
 * https://github.com/torkelicious/nexus-no-wait-pp
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Modifications Copyright (C) 2026 Thomas Thanos.
 * Copyright in the upstream portions remains with its respective holders.
 *
 * This file is distributed under the GNU General Public License, version 3
 * or (at your option) any later version. See ../LICENSE-GPL-3.0-or-later.txt.
 * This notice and license apply to this file; see the repository LICENSE for
 * the terms that cover the rest of NexusMods Bypass.
 */

window.NexusExt = window.NexusExt || {};

(function () {
  'use strict';

  let cfg = {};
  let listenersAttached = false;
  let domEnhancementRun = 0;
  let premiumObserver = null;
  let premiumObserverTimer = null;
  let closeTabTimer = null;
  let closeTabToast = null;
  let fallbackWatchdogTimer = null;
  let fallbackWatchdogDeadline = 0;
  let downloadAttemptSequence = 0;
  let nativeFallbackKey = '';
  let nativeFallbackIsNMM = null;
  let nativeFallbackAutoStartPending = false;
  let nativeFallbackAutoStarted = false;
  const Errors = NexusExt.Errors;
  const Auth = NexusExt.Auth;

  const CLOUDFLARE_FALLBACK_KEY = 'nxtk_cloudflare_native_fallback';
  const CLOUDFLARE_FALLBACK_TTL_MS = 5 * 60 * 1000;
  const FALLBACK_WATCHDOG_MS = 12000;
  const FALLBACK_WATCHDOG_MAX_MS = 3 * 60 * 1000;

  const LOG_BADGE = 'background:#d98f40;color:#191106;font-weight:700;padding:1px 6px;border-radius:3px';
  const LOG_STYLES = {
    debug: 'color:#8a8f98',
    info: 'color:#4da3ff',
    warn: 'color:#e8b339;font-weight:600',
    error: 'color:#ff6b6b;font-weight:600'
  };

  function emitLog(level, args) {
    const fn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
        : level === 'info' ? console.info
          : console.debug;
    fn('%cNexusMods Bypass%c ', LOG_BADGE, LOG_STYLES[level], ...args);
  }

  // Recorded for the bug report either way; printed only when something is wrong,
  // so a working page stays quiet.
  const Logger = {
    debug: (...args) => { if (cfg.DebugLogs) emitLog('debug', args); },
    info: (...args) => { NXTK.noteActivity?.('info', args); if (cfg.DebugLogs) emitLog('info', args); },
    warn: (...args) => { NXTK.noteActivity?.('warn', args); emitLog('warn', args); },
    error: (...args) => { NXTK.noteActivity?.('error', args); emitLog('error', args); }
  };

  function safeSendMessage(message) {
    try {
      if (!chrome.runtime?.id) return;
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => undefined);
    } catch (_) {
    }
  }

  const gameIdCache = new Map();
  const NUMERIC_GAME_ID_PATTERN = /^\d{1,12}$/;
  const GAME_PAGE_PATTERN = /^\/([a-z0-9][a-z0-9-]{0,63})\/mods\/\d+(?:\/|$)/i;

  function normalizeGameId(value) {
    const id = String(value ?? '').trim();
    return NUMERIC_GAME_ID_PATTERN.test(id) && Number(id) > 0 ? id : '';
  }

  // Numeric game ids from the official API (game(domainName)), cached for the page's lifetime. The
  // DOM and response sniffing below stay as the fallback, and as the only source when the API is off.
  const apiGameIds = new Map();

  function officialApi() {
    return cfg.UseOfficialApi !== false ? NexusExt.NexusApi?.shared?.() || null : null;
  }

  function prefetchGameIdFromApi(url = location.href) {
    const api = officialApi();
    const domain = getGameDomainFromUrl(url);
    if (!api || !domain) return Promise.resolve('');
    if (apiGameIds.has(domain)) return Promise.resolve(apiGameIds.get(domain));
    return api.gameId(domain).then((id) => {
      const normalized = normalizeGameId(id);
      if (normalized) {
        apiGameIds.set(domain, normalized);
        gameIdCache.set(domain, normalized);
      }
      return normalized;
    }).catch(() => '');
  }

  function getGameDomainFromUrl(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      if (host !== 'nexusmods.com' && !host.endsWith('.nexusmods.com')) return '';
      return parsed.pathname.match(GAME_PAGE_PATTERN)?.[1]?.toLowerCase() || '';
    } catch (_) {
      return '';
    }
  }

  function collectGameIdsFromText(text) {
    const ids = new Set();
    if (!text) return ids;
    const inputText = String(text).slice(0, 2 * 1024 * 1024);
    const patterns = [
      /data-game-id=["'](\d{1,12})["']/gi,
      /["']game[_-]?id["']\s*:\s*["']?(\d{1,12})["']?/gi,
      /\bgameId["']?\s*[:=]\s*["']?(\d{1,12})["']?/gi
    ];
    for (const pattern of patterns) {
      for (const match of inputText.matchAll(pattern)) {
        const id = normalizeGameId(match[1]);
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  function extractGameIdFromText(text) {
    const ids = collectGameIdsFromText(text);
    return ids.size === 1 ? ids.values().next().value : '';
  }

  function getGameId(url = location.href) {
  const requestedDomain = getGameDomainFromUrl(url);
  const documentDomain = getGameDomainFromUrl(location.href);
  const domain = requestedDomain || documentDomain;

  if (cfg.UseOfficialApi !== false && domain && apiGameIds.has(domain)) {
    return apiGameIds.get(domain);
  }

  if (requestedDomain && requestedDomain !== documentDomain) {
    return gameIdCache.get(requestedDomain) || '';
  }

  const sectionId = normalizeGameId(
    document.getElementById('section')?.dataset?.gameId
  );

  if (sectionId) {
    if (domain) gameIdCache.set(domain, sectionId);
    return sectionId;
  }

  const nodeIds = new Set(
    Array.from(document.querySelectorAll('[data-game-id], [game-id]'))
      .map((node) => normalizeGameId(
        node.dataset?.gameId || node.getAttribute('game-id')
      ))
      .filter(Boolean)
  );

  if (nodeIds.size === 1) {
    const nodeId = nodeIds.values().next().value;
    if (domain) gameIdCache.set(domain, nodeId);
    return nodeId;
  }

  if (nodeIds.size > 1) return '';

  if (domain && gameIdCache.has(domain)) {
    return gameIdCache.get(domain);
  }

  // legacy pages expose the numeric ID in inline state
  const scriptIds = new Set();

  for (const script of Array.from(document.querySelectorAll('script')).slice(0, 128)) {
    for (const id of collectGameIdsFromText(script.textContent || '')) {
      scriptIds.add(id);
    }

    if (scriptIds.size > 1) return '';
  }

  const scriptId = scriptIds.values().next().value || '';

  if (scriptId && domain) {
    gameIdCache.set(domain, scriptId);
  }

  return scriptId;
}  function rememberGameId(gameId, url = location.href) {
    const domain = getGameDomainFromUrl(url);
    const id = normalizeGameId(gameId);
    if (domain && id) gameIdCache.set(domain, id);
  }

  const MOD_PAGE_PATTERN = /\/mods\/\d+$/;

  function normalizeModPathname(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function isModPage() {
    return MOD_PAGE_PATTERN.test(normalizeModPathname(location.pathname));
  }

  function getModPagePath(value = location.href) {
    try {
      const parsed = new URL(value, location.href);
      const pathname = normalizeModPathname(parsed.pathname);
      if (!MOD_PAGE_PATTERN.test(pathname)) return '';
      return `${parsed.origin}${pathname}`;
    } catch (_) {
      return '';
    }
  }

  // nmm=1 asks for the mod-manager link; anything else (nmm=0, nmmx=1) does not.
  function hrefWantsNmm(href) {
    try {
      return new URL(String(href || ''), location.href).searchParams.get('nmm') === '1';
    } catch (_) {
      return false;
    }
  }

  function controlLabel(node) {
    return normalizeText([
      node?.textContent,
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title')
    ].filter(Boolean).join(' '));
  }

  function matchesAny(node, key) {
    const list = globalThis.NexusSelectors?.SELECTORS?.[key] || [];
    for (const selector of list) {
      try {
        if (node?.matches?.(selector) || node?.closest?.(selector)) return true;
      } catch (_) {
      }
    }
    return false;
  }

  function textIs(value, key, fallback) {
    const Sel = globalThis.NexusSelectors;
    return Sel ? Sel.textMatches(value, key) : fallback.some((phrase) => normalizeText(value).includes(phrase));
  }

  // The file id a value names: a file id as it is, or the file id inside a Nexus file uid (game id *
  // 2^32 + file id), which the modal JSON and /api/files/<uid>/download carry. '' for anything else.
  const toFileId = (value) => globalThis.NXTKDownloadParser.normalizeFileId(value);

  // Nexus's download web components carry the file as JSON, not as a file-id attribute:
  // <mod-file-download file='{"id":…}' game-id>, <mod-download-buttons main-file='{"id":…}'> (header
  // Vortex/Manual buttons) and <mod-download-modal file='{"uid":…,"downloadUrl":…,"vortexDownloadUrl":…}'>.
  const DOWNLOAD_MODAL_TAGS = new Set(['DOWNLOAD-MODAL', 'MOD-DOWNLOAD-MODAL']);
  const DOWNLOAD_HOST_TAGS = new Set(['MOD-FILE-DOWNLOAD', 'MOD-DOWNLOAD-BUTTONS', 'MOD-DOWNLOAD-MODAL', 'DOWNLOAD-MODAL']);
  function fileJsonOf(node) {
    for (const name of ['file', 'main-file']) {
      const raw = node?.getAttribute?.(name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {
      }
    }
    return null;
  }
  function fileIdFromNode(node) {
    if (!node || node.nodeType !== 1) return '';
    const json = fileJsonOf(node);
    const legacyCard = node.tagName === 'DT' || node.tagName === 'DD' || /^file-expander/.test(String(node.id || ''));
    // The first that names a file: an "id" can also be a GraphQL global id, which names none.
    const candidates = [node.getAttribute?.('file-id'), node.getAttribute?.('data-file-id'), node.dataset?.fileId,
      json?.fileId, json?.id, json?.file_id, json?.uid,
      legacyCard ? node.getAttribute?.('data-id') || (node.tagName === 'DD' ? node.previousElementSibling?.getAttribute?.('data-id') : '') : '',
      String(node.id || '').match(/^file-expander-header-(\d+)$/)?.[1]];
    for (const candidate of candidates) {
      const id = toFileId(candidate);
      if (id) return id;
    }
    return '';
  }
  // The modal element a click belongs to: on the path, or held by the clicked button's host component.
  function downloadModalFor(path) {
    const direct = path.find((node) => DOWNLOAD_MODAL_TAGS.has(node?.tagName));
    if (direct) return direct;
    const host = path.find((node) => DOWNLOAD_HOST_TAGS.has(node?.tagName));
    return host?.querySelector?.('mod-download-modal, download-modal')
      || host?.shadowRoot?.querySelector?.('mod-download-modal, download-modal')
      || null;
  }

  // A control that closes or cancels a dialog. The extension never takes these clicks.
  function isDismissControl(node) {
    if (!node) return false;
    if (node.hasAttribute?.('data-close') || node.hasAttribute?.('data-dismiss') || node.hasAttribute?.('data-bs-dismiss')) return true;
    if (/(^|[-_\s])close([-_\s]|$)/i.test(String(node.className?.baseVal ?? node.className ?? ''))) return true;
    const label = controlLabel(node);
    if (/^[×✕✖x]$/i.test(label)) return true;
    return textIs(label, 'dismissAction', ['close', 'cancel']);
  }

  // Which kind of download a control without its own href asks for: 'nmm', 'manual' or '' (not one).
  function classifyDownloadControl(node) {
    if (!node || isDismissControl(node)) return '';
    if (matchesAny(node, 'modManagerControl')) return 'nmm';
    const label = controlLabel(node);
    if (textIs(label, 'modManagerDownload', ['mod manager', 'vortex'])) return 'nmm';
    if (textIs(label, 'manualDownload', ['manual download'])) return 'manual';
    return '';
  }

  function getCurrentFileId() {
    try {
      const fileId = new URLSearchParams(location.search).get('file_id') || '';
      return /^\d{1,12}$/.test(fileId) ? fileId : '';
    } catch (_) {
      return '';
    }
  }

  function getCurrentFileKey() {
    const modPage = getModPagePath();
    const fileId = getCurrentFileId();
    return modPage && fileId ? `${modPage}?file_id=${fileId}` : '';
  }

  function isCloudflareChallengeDocument() {
    try {
      if (/just a moment|attention required|checking your browser|security verification/i.test(document.title || '')) {
        return true;
      }
      if (document.documentElement?.classList?.contains('cf-chl-interstitial')) return true;
      return !!document.querySelector('#challenge-form');
    } catch (_) {
      return false;
    }
  }

  // A mod Nexus will not show (removed, hidden, unpublished, missing) is served as a notice where the mod
  // page would be. The page says so already, and no request can return a file for it. On a page the browser
  // has translated the title no longer matches; the download then stops on the same check of Nexus's answer.
  function unavailableModNotice() {
    try {
      if (document.getElementById('section')) return '';
      const titles = Array.from(document.querySelectorAll('h3[id^="Notice"][id$="-title"]'), (title) => title.outerHTML);
      if (!titles.length) return '';
      return globalThis.NXTKResponseClassifier?.unavailableNotice?.(titles.join('')) || '';
    } catch (_) {
      return '';
    }
  }

  function clearStoredCloudflareFallback() {
    try {
      sessionStorage.removeItem(CLOUDFLARE_FALLBACK_KEY);
    } catch (_) {
    }
  }

  function readStoredCloudflareFallback() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CLOUDFLARE_FALLBACK_KEY) || 'null');
      if (!parsed || parsed.expiresAt < Date.now() || !parsed.modPage) {
        clearStoredCloudflareFallback();
        return null;
      }
      return parsed;
    } catch (_) {
      clearStoredCloudflareFallback();
      return null;
    }
  }

  function rememberCloudflareFallback(targetUrl, fileId, isNMM, autoStartPending = cfg.AutoStartDownload) {
    try {
      const target = new URL(targetUrl, location.href);
      const modPage = getModPagePath(target.href) || getModPagePath(location.href);
      if (!modPage) return;
      const targetFileId = target.searchParams.get('file_id');
      const expectedFileId = /^\d{1,12}$/.test(targetFileId || '')
        ? targetFileId
        : getModPagePath(target.href) && /^\d{1,12}$/.test(String(fileId || ''))
          ? String(fileId)
          : '';
      sessionStorage.setItem(CLOUDFLARE_FALLBACK_KEY, JSON.stringify({
        modPage,
        fileId: expectedFileId,
        isNMM: !!isNMM,
        autoStartPending: !!autoStartPending,
        expiresAt: Date.now() + CLOUDFLARE_FALLBACK_TTL_MS
      }));
    } catch (_) {
    }
  }

  function setStoredCloudflareAutoStartPending(pending) {
    nativeFallbackAutoStartPending = !!pending;
    try {
      const marker = readStoredCloudflareFallback();
      if (!marker) return;
      marker.autoStartPending = !!pending;
      sessionStorage.setItem(CLOUDFLARE_FALLBACK_KEY, JSON.stringify(marker));
    } catch (_) {
    }
  }

  function syncNativeFallbackState() {
    const currentKey = getCurrentFileKey();
    if (nativeFallbackKey && nativeFallbackKey === currentKey) return true;

    cancelFallbackWatchdog();
    nativeFallbackKey = '';
    nativeFallbackIsNMM = null;
    nativeFallbackAutoStartPending = false;
    nativeFallbackAutoStarted = false;
    const marker = readStoredCloudflareFallback();
    if (!marker || !currentKey) return false;

    const modPage = getModPagePath();
    const fileId = getCurrentFileId();
    if (marker.modPage !== modPage || (marker.fileId && marker.fileId !== fileId)) {
      clearStoredCloudflareFallback();
      return false;
    }

    nativeFallbackKey = currentKey;
    nativeFallbackIsNMM = typeof marker.isNMM === 'boolean' ? marker.isNMM : null;
    nativeFallbackAutoStartPending = marker.autoStartPending !== false;
    armFallbackWatchdog();
    return true;
  }

  function isNativeFallbackActive() {
    const currentKey = getCurrentFileKey();
    return !!currentKey && nativeFallbackKey === currentKey;
  }

  function cancelScheduledTabClose() {
    if (closeTabToast) {
      try { closeTabToast(); } catch (_) { }
      closeTabToast = null;
    }
    if (closeTabTimer === null) return;
    clearTimeout(closeTabTimer);
    closeTabTimer = null;
  }

  function cancelFallbackWatchdog() {
    fallbackWatchdogDeadline = 0;
    if (fallbackWatchdogTimer === null) return;
    clearTimeout(fallbackWatchdogTimer);
    fallbackWatchdogTimer = null;
  }

  function clearNativeFallbackState() {
    cancelFallbackWatchdog();
    clearStoredCloudflareFallback();
    nativeFallbackKey = '';
    nativeFallbackIsNMM = null;
    nativeFallbackAutoStartPending = false;
    nativeFallbackAutoStarted = false;
  }

  function abandonNativeFallback(reason) {
    if (!isNativeFallbackActive()) {
      cancelFallbackWatchdog();
      return;
    }
    const wasNMM = nativeFallbackIsNMM;
    clearNativeFallbackState();
    Logger.warn('Cloudflare fallback gave up:', reason);

    try {
      setupSlowDownloadIntercept();
    } catch (cause) {
      Logger.warn('Could not restore the download interceptors:', cause);
    }

    NXTK.setActivity?.({ trigger: 'fallback', method: 'native', fallbackActive: true });
    handleError(null, Errors.create('cloudflare', {
      context: 'Cloudflare fallback',
      technicalMessage: `native download control unavailable after ${FALLBACK_WATCHDOG_MS}ms | ${reason} | method=${wasNMM ? 'vortex' : 'browser'}`
    }));
  }

  function armFallbackWatchdog({ extend = false } = {}) {
    const deadline = extend && fallbackWatchdogDeadline
      ? fallbackWatchdogDeadline
      : Date.now() + FALLBACK_WATCHDOG_MAX_MS;
    cancelFallbackWatchdog();
    if (!nativeFallbackAutoStartPending) return;
    fallbackWatchdogDeadline = deadline;

    fallbackWatchdogTimer = setTimeout(() => {
      fallbackWatchdogTimer = null;
      if (!isNativeFallbackActive() || nativeFallbackAutoStarted) return;
      if (!nativeFallbackAutoStartPending) return;

      if (isCloudflareChallengeDocument() && Date.now() < fallbackWatchdogDeadline) {
        Logger.info('Cloudflare verification still on screen; waiting for you to complete it.');
        armFallbackWatchdog({ extend: true });
        return;
      }
      abandonNativeFallback(isCloudflareChallengeDocument()
        ? 'Cloudflare verification was never completed'
        : 'native download control was never found');
    }, FALLBACK_WATCHDOG_MS);
  }

  function beginDownloadAttempt() {
    cancelScheduledTabClose();
    downloadAttemptSequence += 1;
    return downloadAttemptSequence;
  }

  function invalidateDownloadAttempts() {
    cancelScheduledTabClose();
    downloadAttemptSequence += 1;
  }

  function waitForDomSettled({ root = document.getElementById('mainContent') || document.body, quietMs = 500, timeoutMs = 4000 } = {}) {
    return new Promise((resolve) => {
      if (!root) {
        resolve();
        return;
      }

      let done = false;
      let quietTimer = null;
      let timeoutTimer = null;

      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        resolve();
      };

      const armQuietTimer = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      const observer = new MutationObserver(() => {
        armQuietTimer();
      });

      observer.observe(root, { childList: true, subtree: true, characterData: true });
      armQuietTimer();
      timeoutTimer = setTimeout(finish, timeoutMs);
    });
  }

  function scheduleDomEnhancements() {
    const runId = ++domEnhancementRun;
    waitForDomSettled().then(() => {
      if (runId !== domEnhancementRun) return;
      upsellBlocker();
      archivedFileHandler();
      expandRequirementsSection();
      loadApiFileList();
    }).catch((cause) => Logger.warn('Could not apply page enhancements:', cause));
  }

  // Issue #29: the description tab's Requirements section, which Nexus shows collapsed, starts open.
  // Nexus's accordion keeps its state in the DOM (an open item is dt.accopen + dd.open shown as a
  // block), and its toggle listens for a "tap" a scripted click does not make, so the section is opened
  // the way Nexus opens one it marks expand-default; its own toggle then closes it as usual. Each
  // section is opened once: one the user closed stays closed, and only a re-rendered tab opens again.
  const openedRequirementSections = new WeakSet();
  function expandRequirementsSection() {
    if (!cfg.ExpandRequirements || !isModPage()) return;
    const headers = new Set(document.querySelectorAll('.accordionitems dl.accordion > dt[data-accordion-track="file_requirements"]'));
    for (const body of document.querySelectorAll('.accordionitems dl.accordion > dd')) {
      if (body.querySelector('main-file-requirements') && body.previousElementSibling?.tagName === 'DT') headers.add(body.previousElementSibling);
    }
    for (const header of headers) {
      const body = header.nextElementSibling;
      if (openedRequirementSections.has(header) || body?.tagName !== 'DD') continue;
      openedRequirementSections.add(header);
      if (body.classList.contains('open')) continue;
      body.style.display = 'block';
      body.classList.add('open');
      header.classList.add('accopen');
    }
  }

  // Reading the download link out of a Nexus response is done by download-url-parser.js, which the
  // background queue loads as well, so a download started here and a queued one read it the same way.
  const DownloadParser = globalThis.NXTKDownloadParser;
  const decodeDownloadUrlValue = (value) => DownloadParser.decodeLinkText(value);
  // Scoped to the file asked for: Vortex only hands a link to the download waiting for that file.
  const parseNxmDownloadLink = (text, fileId = '') => DownloadParser.findSignedNxmLink(text, { fileId });
  const isValidNxmUrl = (url) => DownloadParser.isSignedNxmLink(url);

  function parseDownloadURLFromResponse(text, options = false) {
    const given = options && typeof options === 'object' ? options : { isNMM: options === true };
    return DownloadParser.findDownloadLink(text, { ...given, baseUrl: location.href });
  }

  // A download that ends with no link, or with a failure no fallback got around, carries what each step
  // was answered: its status and the shape of the answer, never a link, key or page text. Without it a
  // report said "no Vortex link" and nothing about which request gave what.
  const TRAILED_CODES = new Set(['no_download_url', 'no_nmm_link', 'network_error', 'timeout', 'server_error', 'invalid_response']);

  function withTrail(error, trail, isNMM) {
    if (!error || !TRAILED_CODES.has(error.code) || !trail.length) return error;
    return {
      ...error,
      context: error.context || (isNMM ? 'Finding the Vortex link' : 'Finding the download link'),
      technicalMessage: [error.technicalMessage, `steps: ${trail.slice(-4).join(' | ')}`].filter(Boolean).join(' | ')
    };
  }

  // Only the final outcome is an error. A failed route answered by a fallback must not trigger
  // a user error report (or consume the automatic reporting allowance).
  async function getDownloadUrl(options = {}) {
    const trail = [];
    const result = await resolveDownloadUrl({ ...options, trail });
    if (result?.error) {
      result.error = withTrail(result.error, trail, options.isNMM === true);
      // A cancel (Stop, or the page going away) is not a failure, as in nexus-api.js.
      if (result.error.code !== 'aborted') Errors.record?.(result.error);
    }
    return result;
  }

  async function resolveDownloadUrl({
    fileId,
    gameId,
    isNMM,
    href,
    prefetchedText = null,
    prefetchedFinalUrl = null,
    prefetchedStatus = 0,
    prefetchedError = null,
    signal = null,
    trail = []
  } = {}) {
    fileId = toFileId(fileId);
    if (!fileId && !href) return { url: null, error: Errors.create('missing_file', { record: false }) };
    // What a step was answered when it gave no link (getDownloadUrl puts this in the final error).
    const noteFailure = (step, response) => {
      trail.push(`${step} ${response?.error?.code || 'failed'}${response?.status ? ` HTTP ${response.status}` : ''}`);
    };
    const noteAnswer = (step, response, nmm) => {
      const shape = DownloadParser.explainMissingLink(response?.text, { mode: nmm ? 'vortex' : 'browser', fileId, baseUrl: location.href });
      trail.push(`${step} HTTP ${response?.status || 200}: ${shape}`);
    };

    let isApiFileHref = false;
    try {
      const link = href ? new URL(href, location.href) : null;
      isApiFileHref = !!link?.pathname.startsWith('/api/files/');
      if (isApiFileHref) fileId ||= toFileId(link.pathname.match(/^\/api\/files\/(\d+)(?:\/|$)/)?.[1]);
    } catch (_) {
      return { url: null, error: Errors.create('invalid_response', { context: 'Reading download link', record: false }) };
    }
    const canonicalFilePage = `${location.origin}${location.pathname}?tab=files&file_id=${encodeURIComponent(fileId || '')}`;
    const filePageUrl = isApiFileHref ? canonicalFilePage : (href || canonicalFilePage);
    let resolvedGameId = normalizeGameId(gameId) || getGameId(filePageUrl);
    const gameDomain = getGameDomainFromUrl(filePageUrl) || getGameDomainFromUrl(location.href);
    refreshAdTimerCookie();
    const endpoint = new URL('/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl', filePageUrl).href;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    };
    const requestOptions = (context) => ({
      timeoutMs: cfg.RequestTimeout || Errors.DEFAULT_TIMEOUT_MS,
      context,
      signal,
      record: false
    });

    let pendingPrefetch = (prefetchedText === null && !prefetchedError) ? null : {
      ok: !prefetchedError && prefetchedStatus >= 200 && prefetchedStatus < 400,
      status: prefetchedStatus || 0,
      text: prefetchedText || '',
      finalUrl: prefetchedFinalUrl || href || '',
      error: prefetchedError || null
    };
    let prefetchHref = '';
    try {
      prefetchHref = href ? new URL(href, location.href).href : '';
    } catch (_) {
      pendingPrefetch = null;
    }

    const takePrefetch = (absoluteUrl) => {
      if (!pendingPrefetch || absoluteUrl !== prefetchHref) return null;
      const response = pendingPrefetch;
      pendingPrefetch = null;
      return response;
    };

    const fetchText = async (url, { ajax = true, context = 'Loading Nexus download page' } = {}) => {
      if (signal?.aborted) return { ok: false, error: Errors.create('aborted', { record: false }) };
      const absoluteUrl = new URL(url, location.href).href;
      const reused = takePrefetch(absoluteUrl);
      if (reused) {
        Logger.debug('Reusing prefetched response for', context);
        return reused;
      }
      return Errors.request(absoluteUrl, {
        credentials: 'include',
        headers: ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}
      }, requestOptions(context));
    };

    const fetchGeneratedDownloadUrl = async (nmm = false) => {
      if (!fileId) return { url: null, text: '', error: Errors.create('missing_file', { record: false }) };
      if (signal?.aborted) return { url: null, error: Errors.create('aborted', { record: false }) };

      const body = `fid=${encodeURIComponent(fileId)}&game_id=${encodeURIComponent(resolvedGameId || gameDomain)}${nmm ? '&nmm=1' : ''}`;
      const response = await Errors.request(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers,
        body
      }, requestOptions(nmm ? 'Generating Vortex download link' : 'Generating download link'));

      if (!response.ok) {
        Logger.warn('GenerateDownloadUrl failed:', response.error);
        noteFailure('generator', response);
        return { url: null, text: response.text, error: response.error };
      }

      const responseGameId = extractGameIdFromText(response.text);
      if (responseGameId) {
        resolvedGameId = responseGameId;
        rememberGameId(responseGameId, filePageUrl);
      }

      if (nmm) {
        const nxmUrl = parseNxmDownloadLink(response.text, fileId);
        if (nxmUrl) return { url: nxmUrl, text: response.text, error: null };
      }

      const extracted = parseDownloadURLFromResponse(response.text, {
        mode: nmm ? 'vortex' : 'browser',
        fileId
      });
      if (!(nmm ? parseNxmDownloadLink(extracted?.url, fileId) : extracted?.url)) noteAnswer('generator', response, nmm);
      if (extracted?.url) return { url: extracted.url, text: response.text, error: null };
      return { url: null, text: response.text, error: null };
    };

    const resolveApiFileUrl = async (url) => {
      let apiUrl = new URL(url, location.href).href;
      if (isNMM && !apiUrl.includes('nmm=1')) {
        apiUrl += apiUrl.includes('?') ? '&nmm=1' : '?nmm=1';
      }

      // Loaded as a click loads it: the route redirects to the file page, and a redirect keeps the
      // X-Requested-With header, which makes Nexus answer with the tab fragment and no link.
      const response = await fetchText(apiUrl, { ajax: false, context: 'Resolving Nexus API download link' });
      if (!response.ok) {
        noteFailure('API route', response);
        return { url: null, error: response.error };
      }

      if (isNMM) {
        const fromFinalUrl = parseNxmDownloadLink(response.finalUrl, fileId);
        if (fromFinalUrl) return { url: fromFinalUrl };
      }
      if (!isNMM && response.finalUrl && response.finalUrl !== apiUrl && !response.finalUrl.includes('/api/files/')) {
        return { url: response.finalUrl };
      }

      if (isNMM) {
        const fromBodyNxm = parseNxmDownloadLink(response.text, fileId);
        if (fromBodyNxm) return { url: fromBodyNxm };
      }

      const extracted = parseDownloadURLFromResponse(response.text, {
        mode: isNMM ? 'vortex' : 'browser',
        fileId
      });
      if (extracted?.url) {
        const nxmUrl = parseNxmDownloadLink(extracted.url, fileId);
        if (isNMM && nxmUrl) return { url: nxmUrl };
        if (!isNMM) return { url: extracted.url };
      }

      noteAnswer('API route', response, isNMM);
      return { url: null, error: Errors.create(isNMM ? 'no_nmm_link' : 'no_download_url', { record: false }) };
    };

    if (isApiFileHref) {
      const result = await resolveApiFileUrl(href);
      if (result.url) return result;
      // A redirecting API route may be unreadable to fetch, even when the same-origin generator
      // works. Never fall back around authentication, verification, rate limits or cancellation.
      const recoverable = ['network_error', 'timeout', 'server_error', 'invalid_response', 'no_download_url', 'no_nmm_link'];
      if (!fileId || signal?.aborted || !recoverable.includes(result.error?.code)) return result;
      NXTK.queueDebugEntry?.('debug', `Download API route failed (${result.error.code}); trying the download generator.`);
      href = filePageUrl;
    }

    if (isNMM && href) {
      // The site's own Vortex button asks GenerateDownloadUrl for the nxm link; that small POST answers in
      // well under a second, where loading the whole file page first took several. So it goes first, and
      // the page is read only when it gives nothing.
      const quick = await fetchGeneratedDownloadUrl(true);
      const quickNxm = parseNxmDownloadLink(quick?.url, fileId);
      if (quickNxm) return { url: quickNxm };
      if (quick?.error && Errors.isBlocking(quick.error)) return { url: null, error: quick.error };

      // Asked with X-Requested-With, Nexus answers a mod page with the tab fragment, which has no nxm
      // link. The download page a click opens carries it in <mod-file-download download-url>.
      const firstResponse = await fetchText(href, { ajax: false, context: 'Loading Vortex download page' });
      let latestError = firstResponse.error;
      Logger.info('Fetching NMM download URL');
      if (!firstResponse.ok) noteFailure('page', firstResponse);

      if (firstResponse.ok) {
        const firstResponseGameId = extractGameIdFromText(firstResponse.text);
        if (firstResponseGameId) {
          resolvedGameId = firstResponseGameId;
          rememberGameId(firstResponseGameId, filePageUrl);
        }
        const link = parseNxmDownloadLink(firstResponse.finalUrl, fileId) || parseNxmDownloadLink(firstResponse.text, fileId);
        if (link) return { url: link };
        noteAnswer('page', firstResponse, true);

        const extracted = parseDownloadURLFromResponse(firstResponse.text, { mode: 'vortex', fileId });
        if (extracted?.url) {
          const nxmUrl = parseNxmDownloadLink(extracted.url, fileId);
          if (nxmUrl) return { url: nxmUrl };
          if (extracted.url.includes('/api/files/')) {
            const result = await resolveApiFileUrl(extracted.url);
            if (result.url) return result;
            latestError = result.error || latestError;
          }
        }

        if (/ModRequirementsPopUp/.test(href)) {
          const downloadHrefMatch = firstResponse.text.match(/href=["']([^"']*?(?:file_id|\/api\/files\/)[^"']*?)["']/i);
          if (downloadHrefMatch) {
            const downloadPageUrl = new URL(decodeDownloadUrlValue(downloadHrefMatch[1]), location.href).href;
            if (downloadPageUrl.includes('/api/files/')) {
              const result = await resolveApiFileUrl(downloadPageUrl);
              if (result.url) return result;
              latestError = result.error || latestError;
            }
            const downloadPageResponse = await fetchText(downloadPageUrl, { ajax: false, context: 'Loading requirement download page' });
            if (downloadPageResponse.ok) {
              const link2 = parseNxmDownloadLink(downloadPageResponse.finalUrl, fileId) || parseNxmDownloadLink(downloadPageResponse.text, fileId);
              if (link2) return { url: link2 };
              noteAnswer('requirements page', downloadPageResponse, true);
            } else {
              noteFailure('requirements page', downloadPageResponse);
              latestError = downloadPageResponse.error || latestError;
            }
          }
        }
      }

      return { url: null, error: latestError || quick?.error || Errors.create('no_nmm_link', { record: false }) };
    }

    if (isNMM) {
      const generated = await fetchGeneratedDownloadUrl(true);
      const generatedNxm = parseNxmDownloadLink(generated?.url, fileId);
      return generatedNxm
        ? { url: generatedNxm }
        : { url: null, error: generated?.error || Errors.create('no_nmm_link', { record: false }) };
    }

    const fetchFilePageFallback = async () => {
      const pageResponse = await fetchText(filePageUrl, {
        ajax: false,
        context: 'Loading manual download page'
      });
      if (!pageResponse.ok) {
        noteFailure('page', pageResponse);
        return { url: null, error: pageResponse.error };
      }

      const pageGameId = extractGameIdFromText(pageResponse.text);
      if (pageGameId) {
        resolvedGameId = pageGameId;
        rememberGameId(pageGameId, filePageUrl);
      }
      const extracted = parseDownloadURLFromResponse(pageResponse.text, {
        mode: isNMM ? 'vortex' : 'browser',
        fileId
      });
      if (extracted) {
        Logger.info('Manual download URL found from file page:', extracted.source);
        return { url: extracted.url };
      }
      noteAnswer('page', pageResponse, false);
      return { url: null, error: Errors.create('no_download_url', { context: 'Reading manual download page', record: false }) };
    };

    const attemptFetch = async (attempt, didPageFallback = false, lastError = null) => {
      if (signal?.aborted) return { url: null, error: Errors.create('aborted', { record: false }) };
      const generated = await fetchGeneratedDownloadUrl(false);
      if (generated?.url) {
        Logger.info('Manual download URL found from GenerateDownloadUrl');
        return { url: generated.url };
      }

      let latestError = generated?.error || lastError;
      if (latestError && Errors.isBlocking(latestError)) return { url: null, error: latestError };

      if (!didPageFallback) {
        const fallbackResult = await fetchFilePageFallback();
        if (fallbackResult.url) return fallbackResult;
        latestError = fallbackResult.error || latestError;
        if (latestError && Errors.isBlocking(latestError)) return { url: null, error: latestError };
      }

      if (attempt < 2 && (!latestError || latestError.retryable)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return attemptFetch(attempt + 1, true, latestError);
      }

      return { url: null, error: latestError || Errors.create('no_download_url', { record: false }) };
    };
    return attemptFetch(1);
  }

  // Bound recursive URL resolution and reject invalid Vortex links.
  async function normalizeDownloadUrl(url, isNMM, depth = 0) {
    if (!url) return null;
    const decodedUrl = decodeDownloadUrlValue(url);

    try {
      const parsed = new URL(decodedUrl, location.href);
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      const isNexusHost = host === 'nexusmods.com' || host.endsWith('.nexusmods.com');
      if (depth < 3 && isNexusHost && (parsed.searchParams.has('file_id') || parsed.pathname.includes('/api/files/'))) {
        const fileId = parsed.searchParams.get('file_id') || parsed.searchParams.get('id') || parsed.pathname.match(/\/api\/files\/(\d+)/)?.[1];
        const resolved = await getDownloadUrl({
          fileId,
          gameId: getGameId(parsed.href),
          isNMM,
          href: parsed.href
        });
        if (resolved?.url && resolved.url !== decodedUrl) {
          return normalizeDownloadUrl(resolved.url, isNMM, depth + 1);
        }
      }
    } catch (_) {}

    if (isNMM && !isValidNxmUrl(decodedUrl)) return null;
    return decodedUrl;
  }

  // The text node that carries a control's visible label. Nexus's controls put an icon wrapper (a
  // <span> around an <svg>) before the label, keep the label as a bare text node, or render it inside
  // the element's own shadow root, so "the first span" was the wrong target on the real page and the
  // state text never showed. The longest non-blank text node, outside svg/style/script, is the label.
  function findButtonLabelNode(button) {
    let best = null;
    const visit = (root, depth) => {
      if (!root || depth > 4) return;
      for (const node of root.childNodes || []) {
        if (node.nodeType === 3) {
          const text = node.nodeValue.trim();
          if (text && (!best || text.length > best.nodeValue.trim().length)) best = node;
        } else if (node.nodeType === 1 && !/^(svg|style|script|template)$/i.test(node.tagName)) {
          if (node.getAttribute?.('aria-hidden') === 'true' && !node.textContent.trim()) continue;
          visit(node, depth + 1);
          if (node.shadowRoot) visit(node.shadowRoot, depth + 1);
        }
      }
    };
    visit(button, 0);
    if (button?.shadowRoot) visit(button.shadowRoot, 0);
    return best;
  }

  function applyButtonLabel(button, text) {
    const original = button._nxtkOriginalButtonState;
    let node = original?.labelNode;
    if (!node || !node.isConnected) {
      node = findButtonLabelNode(button);
      if (original) original.labelNode = node;
    }
    if (node) {
      if (node.nodeValue !== text) node.nodeValue = text;
    } else {
      button.textContent = text;
    }
    button.setAttribute?.('aria-label', text);
  }

  function setButtonState(button, state, message) {
    if (!button._nxtkOriginalButtonState) {
      const labelNode = findButtonLabelNode(button);
      button._nxtkOriginalButtonState = {
        labelNode,
        text: labelNode ? labelNode.nodeValue : button.textContent,
        ariaLabel: button.getAttribute?.('aria-label') ?? null,
        color: button.style.color
      };
    }
    const stateConfig = {
      waiting: { text: message || NXTK.t('btnStatePleaseWait', null, 'Please Wait...'), color: 'orange' },
      downloading: { text: NXTK.t('btnStateDownloading', null, 'Downloading!'), color: '#3dbb5e' },
      sent: { text: NXTK.t('toastSentToVortex', null, 'Sent to Vortex'), color: '#3dbb5e' },
      error: { text: message || NXTK.t('btnStateError', null, 'Error'), color: '#e04040' }
    };
    const config = stateConfig[state] || stateConfig.error;
    const original = button._nxtkOriginalButtonState;
    original.stateText = config.text;
    applyButtonLabel(button, config.text);
    button.style.color = config.color;
    // A framework re-render puts its own label back; keep ours until the state is restored.
    if (!original.observer && typeof MutationObserver === 'function') {
      original.observer = new MutationObserver(() => {
        const current = button._nxtkOriginalButtonState;
        if (!current) return;
        const node = current.labelNode;
        if (!node || !node.isConnected || node.nodeValue !== current.stateText) {
          applyButtonLabel(button, current.stateText);
        }
      });
      const options = { childList: true, subtree: true, characterData: true };
      original.observer.observe(button, options);
      if (button.shadowRoot) original.observer.observe(button.shadowRoot, options);
    }
  }

  function restoreButtonState(button) {
    const original = button?._nxtkOriginalButtonState;
    if (!original) return;
    original.observer?.disconnect();
    if (original.labelNode?.isConnected) original.labelNode.nodeValue = original.text;
    else if (!original.labelNode) button.textContent = original.text;
    if (original.ariaLabel === null) button.removeAttribute?.('aria-label');
    else button.setAttribute?.('aria-label', original.ariaLabel);
    button.style.color = original.color;
    delete button._nxtkOriginalButtonState;
  }

  function inferBrowserDownloadName(url, fileId) {
    const urlName = NXTK.downloadNameFromUrl(url);
    if (urlName) return urlName;
    const pageTitle = String(
      document.querySelector('h1')?.textContent
      || document.title.split(/\s+(?:at|on)\s+Nexus Mods/i)[0]
      || 'nexus-mod'
    ).replace(/\s+/g, ' ').trim();
    const idSuffix = fileId ? `-${fileId}` : '';
    return `${pageTitle || 'nexus-mod'}${idSuffix}`;
  }

  async function startManagedFileDownload(url, fileId) {
    try {
      const settings = await NexusExt.Storage.getSettings();
      const reply = await NexusExt.Storage.sendDownloadCommand('DOWNLOAD_START', {
        url,
        folder: settings.DownloadFolder ?? '',
        filename: inferBrowserDownloadName(url, fileId),
        fallbackExtension: '.zip',
        // The worker de-duplicates by game+file across every tab and content-script copy.
        fileId: String(fileId || ''),
        gameId: String(getGameId() || '')
      });
      if (reply?.ok && reply.value?.duplicate) Logger.info(`File ${fileId} is already downloading; not starting a second copy.`);
      if (reply?.ok) return true;
      if (reply?.error) Logger.warn('Managed download failed:', reply.error);
      return false;
    } catch (cause) {
      Logger.warn('Managed download failed:', cause);
      return false;
    }
  }

  const NATIVE_PASSTHROUGH_TTL_MS = 5 * 60 * 1000;
  const MAX_NATIVE_PASSTHROUGH_FILES = 64;
  const nativePassthroughFiles = new Map();

  // Keyed by method as well: a file whose Vortex link could not be found still gets its Manual
  // download from the extension, and the other way round.
  const passthroughKey = (fileId, isNMM) => (fileId ? `${isNMM ? 'nmm' : 'browser'}:${fileId}` : '');

  function allowNativeDownload(fileId, isNMM) {
    const key = passthroughKey(fileId, isNMM);
    if (!key) return;
    nativePassthroughFiles.delete(key);
    nativePassthroughFiles.set(key, Date.now() + NATIVE_PASSTHROUGH_TTL_MS);
    while (nativePassthroughFiles.size > MAX_NATIVE_PASSTHROUGH_FILES) {
      nativePassthroughFiles.delete(nativePassthroughFiles.keys().next().value);
    }
  }

  function shouldPassThroughToNative(fileId, isNMM) {
    const key = passthroughKey(fileId, isNMM);
    const expiresAt = nativePassthroughFiles.get(key);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    nativePassthroughFiles.delete(key);
    return false;
  }

  function clearNativeDownloadPassthrough() {
    nativePassthroughFiles.clear();
  }

  const NATIVE_HANDOFF_CODES = new Set(['no_download_url', 'no_nmm_link', 'unsafe_download_url', 'mod_unavailable']);

  // Release unresolved files to Nexus instead of trapping the click.
  function releaseToNativeControl(button, fileId, error, isNMM) {
    if (!NATIVE_HANDOFF_CODES.has(error?.code)) return false;
    allowNativeDownload(fileId, isNMM);
    restoreButtonState(button);
    Logger.info('Handing this file back to the native Nexus controls; the extension cannot resolve it.');
    return true;
  }

  function isDifferentPage(href) {
    try {
      return new URL(href, location.href).href !== location.href;
    } catch (_) {
      return false;
    }
  }

  function getCurrentNativeDownloadHost(fileId = getCurrentFileId(), isNMM = null) {
    const expectedFileId = String(fileId || '');
    const hosts = getSearchRoots(document)
      .flatMap((root) => Array.from(root.querySelectorAll('mod-file-download[file-id]')))
      .filter((element) => element.getAttribute('file-id') === expectedFileId);
    if (typeof isNMM !== 'boolean') return hosts[0] || null;
    return hosts.find((element) => element.getAttribute('is-nmm-download') === String(isNMM))
      || hosts[0]
      || null;
  }

  function currentNativeMethodMatches(isNMM, fileId) {
    const host = getCurrentNativeDownloadHost(fileId, !!isNMM);
    const method = host?.getAttribute('is-nmm-download');
    if (method === 'true' || method === 'false') return (method === 'true') === !!isNMM;
    try {
      return new URLSearchParams(location.search).has('nmm') === !!isNMM;
    } catch (_) {
      return false;
    }
  }

  function enableNativeFallbackForCurrentFile(fileId, isNMM, button = null) {
    const currentFileId = getCurrentFileId();
    const currentKey = getCurrentFileKey();
    if (!currentKey || (fileId && String(fileId) !== currentFileId)
      || !currentNativeMethodMatches(isNMM, currentFileId)) return false;

    cancelScheduledTabClose();
    const shouldAutoStart = !!button || !!cfg.AutoStartDownload;
    rememberCloudflareFallback(location.href, currentFileId, isNMM, shouldAutoStart);
    nativeFallbackKey = currentKey;
    nativeFallbackIsNMM = !!isNMM;
    nativeFallbackAutoStartPending = shouldAutoStart;
    nativeFallbackAutoStarted = false;
    restoreButtonState(button);
    Logger.warn('Cloudflare blocked the extension request; using the native Nexus download control.');
    armFallbackWatchdog();
    syncSlowDownloadIntercept();
    return true;
  }

  function activateCloudflareFallback({ button = null, fileId, isNMM, href } = {}) {

    if (cfg.CloudflareFallback === false) {
      Logger.info('Cloudflare fallback is turned off; reporting the block instead of opening the page.');
      return false;
    }

    let target;
    try {
      target = new URL(href || location.href, location.href);
      if (isNMM) target.searchParams.set('nmm', '1');
    } catch (_) {
      return false;
    }

    if (!NXTK.isSafeNexusPageUrl(target.href) || target.hostname !== location.hostname
      || !getModPagePath(target.href)) return false;

    const currentModPage = getModPagePath(location.href);
    const targetModPage = getModPagePath(target.href);
    const targetFileId = target.searchParams.get('file_id') || '';
    const currentFileId = getCurrentFileId();
    if (currentModPage && targetModPage === currentModPage && currentFileId
      && (!targetFileId || targetFileId === currentFileId)
      && enableNativeFallbackForCurrentFile(fileId || currentFileId, isNMM, button)) {
      return true;
    }

    rememberCloudflareFallback(target.href, fileId, isNMM, !!button || !!cfg.AutoStartDownload);
    invalidateDownloadAttempts();
    if (button) {
      setButtonState(button, 'waiting', NXTK.t('btnStateOpeningPage', null, 'Opening file page...'));
    }
    Logger.warn('Cloudflare blocked the extension request; opening the Nexus page for verification.');
    location.assign(target.href);
    return true;
  }

  function handleError(btn, error, { onRetry = null } = {}) {
    activeStatusToast?.dismiss();
    activeStatusToast = null;
    btn?._nxtkStatusToast?.dismiss();
    if (btn) delete btn._nxtkStatusToast;
    const normalized = Errors.normalize(error);
    const shown = Errors.displayText ? Errors.displayText(normalized) : {
      message: normalized.userMessage,
      recovery: normalized.recovery
    };
    if (btn) setButtonState(btn, 'error', shown.message);
    Logger.error(`[${normalized.code}] ${normalized.userMessage}`, normalized.technicalMessage || normalized.context);
    if (!cfg.ShowAlertsOnError) return normalized;

    if (NexusExt.UI?.showError) {
      // The run this button started, not whichever started last: two overlapping runs used to point
      // the dialog at the other file's page and method.
      const runContext = btn?._nxtkRunContext || lastRunContext;
      NexusExt.UI.showError(normalized, {
        onRetry,
        filePageUrl: runContext.filePageUrl,
        method: runContext.method
      });
    } else {
      NexusExt.UI?.nxtkAlert?.(`${shown.message}\n${shown.recovery}`.trim());
    }
    return normalized;
  }

  // One file must never start two browser downloads at once: an automatic start, the slow-download
  // button listener and the page-wide click interceptor can all react to the same file page. A start
  // for a file that is already in flight, or that started moments ago, is dropped.
  const DOWNLOAD_DEDUPE_WINDOW_MS = 15000;
  const activeDownloads = new Map();

  function claimDownload(fileId, isNMM) {
    if (!fileId) return true;
    const key = `${isNMM ? 'nmm' : 'browser'}:${fileId}`;
    const now = Date.now();
    const previous = activeDownloads.get(key);
    if (previous && (previous.inFlight || now - previous.at < DOWNLOAD_DEDUPE_WINDOW_MS)) return null;
    // A content script orphaned by an extension reload or update keeps its listeners in the page. The
    // DOM is the one thing both copies share, so the claim is also written there.
    const attr = `data-nxtk-claim-${key.replace(/[^a-z0-9]/gi, '-')}`;
    const rootEl = document.documentElement;
    const domAt = Number(rootEl?.getAttribute(attr) || 0);
    if (domAt && now - domAt < DOWNLOAD_DEDUPE_WINDOW_MS) return null;
    rootEl?.setAttribute(attr, String(now));
    const entry = { inFlight: true, at: now };
    activeDownloads.set(key, entry);
    return {
      done(started) {
        entry.inFlight = false;
        entry.at = Date.now();
        if (started) {
          rootEl?.setAttribute(attr, String(entry.at));
        } else {
          activeDownloads.delete(key);
          rootEl?.removeAttribute(attr);
        }
      },
      // The "Vortex didn't open?" hint says to click again: that click must not be dropped as a
      // duplicate of the hand-off that just showed no sign of Vortex. A newer claim is left alone.
      release() {
        if (entry.inFlight || activeDownloads.get(key) !== entry) return;
        activeDownloads.delete(key);
        if (rootEl?.getAttribute(attr) === String(entry.at)) rootEl.removeAttribute(attr);
      }
    };
  }

  let activeStatusToast = null;
  // What the error dialog's "Open file page" and "Use browser download" refer to.
  let lastRunContext = { filePageUrl: '', method: '' };

  // A single file is not worth a question, but when the hand-off shows no sign of reaching Vortex
  // (the browser prompt cancelled or dismissed, nothing took focus), say what to check.
  let singleHandoffSequence = 0;

  function watchSingleHandoff() {
    const wait = NXTK.waitForProtocolHandoff;
    if (typeof wait !== 'function') return Promise.resolve(true);
    const sequence = ++singleHandoffSequence;
    let reason = '';
    Logger.info('Vortex hand-off: watching whether Vortex opens');
    return wait({ timeoutMs: SINGLE_HANDOFF_TIMEOUT_MS, maxMs: SINGLE_HANDOFF_MAX_MS, onResult: (r) => { reason = r; } }).then((opened) => {
      if (opened) {
        Logger.info(`Vortex hand-off: Vortex opened (${reason || 'page left'})`);
        NXTK.recordVortexOpenEvent?.('opened');
        return true;
      }
      // A newer hand-off has its own watch. ("Keep open" on the close countdown is not a newer one.)
      if (sequence !== singleHandoffSequence) return false;
      Logger.info(`Vortex hand-off: no sign Vortex opened (${reason || 'no-signal'}); showing the hint`);
      // Keep the tab: closing it would take the hint (and the way to retry) with it.
      cancelScheduledTabClose();
      // Silence is not a failure: Vortex takes no focus when its "Bring Vortex to foreground" setting
      // is off, or when the browser opens nxm:// links without asking, and a page in the background
      // sees nothing at all. Counting those offered a switch to browser downloads while every file
      // was reaching Vortex. Only focus coming back after the prompt, or the user, says it failed.
      const silent = !reason || reason === 'no-signal' || reason === 'started-hidden';
      if (!silent) {
        Promise.resolve(NXTK.recordVortexOpenEvent?.('notDetected')).then((next) => {
          if (next && NXTK.shouldOfferBrowserSwitch?.(next)) {
            Logger.info('Vortex hand-off: two in a row with no sign of Vortex; offering browser downloads');
            NexusExt.UI?.offerBrowserSwitch?.();
          }
        }).catch(() => undefined);
      }
      NexusExt.UI?.showNotice?.({
        title: NXTK.t('noticeVortexNotOpenedTitle', null, "Vortex didn't open?"),
        detail: NXTK.t('noticeVortexNotOpenedDetail', null, 'If nothing happened, check that Vortex is installed, set to handle nxm:// links and signed in to the same Nexus account as this browser (and allow the browser prompt), then click the button again.'),
        ms: 12000
      });
      return false;
    });
  }

  const SINGLE_HANDOFF_TIMEOUT_MS = 4000;
  // A blur only counts as "Vortex opened" when focus has not come back for this long: Chrome's own
  // "Open Vortex?" dialog can stay up well past 8 s before it is cancelled.
  const SINGLE_HANDOFF_MAX_MS = NXTK.PROTOCOL_BLUR_OPENED_MS ?? 20000;

  // How long "Sent to Vortex" stays on the button and in the status toast.
  const SENT_STATE_MS = 2500;

  async function runDownload(given) {
    // Every start goes by the file id: a uid from the modal or the API route is the same file, and was
    // compared with the nxm link's file id as though it were another one.
    const options = { ...given, fileId: toFileId(given?.fileId) };
    const claim = claimDownload(options.fileId, options.isNMM);
    if (!claim) {
      Logger.info(`Ignored a duplicate start for file ${options?.fileId}.`);
      return false;
    }
    let started = false;
    try {
      started = await runDownloadOnce({ ...options, claim });
      return started;
    } finally {
      // claimDownload answers a bare `true` for a start with no file id, which has nothing to settle.
      claim.done?.(started);
    }
  }

  async function runDownloadOnce(options) {
    let handoffVerdict = Promise.resolve(true);
    const {
      button = null,
      fileId,
      isNMM,
      href,
      openFilePageOnNoUrl = false,
      closeTabAfterStart = false
    } = options;
    const attemptId = beginDownloadAttempt();
    try {
      const page = new URL(href || location.href, location.href);
      lastRunContext = { filePageUrl: NXTK.isSafeNexusPageUrl(page.href) ? page.href : '', method: isNMM ? 'vortex' : 'browser' };
    } catch (_) {
      lastRunContext = { filePageUrl: '', method: isNMM ? 'vortex' : 'browser' };
    }
    if (button) button._nxtkRunContext = lastRunContext;

    NXTK.setActivity?.({
      trigger: button ? 'manual' : 'automatic',
      method: isNMM ? 'vortex' : 'browser',
      fileId: String(fileId || ''),
      autoClose: !!(closeTabAfterStart && cfg.AutoCloseTab && isNMM),
      fallbackActive: isNativeFallbackActive()
    });

    const loginError = Auth?.getDocumentLoginError?.(document, 'Starting download');
    if (loginError) {
      handleError(button, loginError, { onRetry: () => runDownload(options) });
      return false;
    }

    // Feedback on the click itself: the hand-off needs one request before Vortex can be asked.
    if (button) setButtonState(button, 'waiting', isNMM ? NXTK.t('btnStateSendingVortex', null, 'Sending to Vortex…') : '');
    Logger.debug('fileId', fileId, 'isNMM', isNMM);
    // Also announced in a status toast: visible (and read out) even where the control's own label
    // cannot be changed.
    // Every Vortex hand-off gets it, including the single-file page's auto-start ("Auto NMM"), which
    // has no button to label: a click that lands on ?file_id=…&nmm=1 runs that path.
    const statusToast = isNMM
      ? NexusExt.UI?.showStatusToast?.(NXTK.t('btnStateSendingVortex', null, 'Sending to Vortex…'))
      : null;
    if (statusToast) {
      activeStatusToast = statusToast;
      if (button) button._nxtkStatusToast = statusToast;
    }
    if (isNMM) {
      Logger.info(`Vortex hand-off: showing "Sending to Vortex…" (${[button ? 'button' : '', statusToast ? 'toast' : ''].filter(Boolean).join(' + ') || 'nothing to show it on'})`);
    }

    let result;
    try {
      result = await getDownloadUrl({ fileId, gameId: getGameId(), isNMM, href });
    } catch (cause) {
      result = { url: null, error: Errors.fromException(cause, { context: 'Resolving download link' }) };
    }
    let error = result?.error || (!result?.url ? Errors.create(isNMM ? 'no_nmm_link' : 'no_download_url') : null);
    if (error) {
      error = Errors.normalize(error);
      if (error.code === 'cloudflare') {
        if (attemptId !== downloadAttemptSequence) {

          restoreButtonState(button);
          return false;
        }
        if (activateCloudflareFallback({ button, fileId, isNMM, href })) return false;
      }
      const shouldOpenFilePage = openFilePageOnNoUrl && !isNMM && href
        && error.code === 'no_download_url' && isDifferentPage(href)
        && !!getModPagePath(href);
      if (shouldOpenFilePage) {
        if (!NXTK.isSafeNexusPageUrl(new URL(href, location.href).href)) {
          handleError(button, Errors.create('unsafe_download_url', {
            context: 'Opening file page',
            technicalMessage: 'rejected: not a Nexus Mods page URL'
          }));
          return false;
        }
        if (button) setButtonState(button, 'waiting', NXTK.t('btnStateOpeningPage', null, 'Opening file page...'));
        location.assign(href);
        return false;
      }
      handleError(button, error, { onRetry: () => runDownload(options) });
      releaseToNativeControl(button, fileId, error, isNMM);
      return false;
    }

    if (button) setButtonState(button, isNMM ? 'waiting' : 'downloading', isNMM ? NXTK.t('btnStateSendingVortex', null, 'Sending to Vortex…') : '');
    let finalUrl = null;
    try {
      finalUrl = await normalizeDownloadUrl(result.url, isNMM);
    } catch (cause) {
      handleError(button, Errors.fromException(cause, { context: 'Validating download link' }), {
        onRetry: () => runDownload(options)
      });
      return false;
    }
    if (!finalUrl) {
      const missing = Errors.create(isNMM ? 'no_nmm_link' : 'no_download_url');
      handleError(button, missing, { onRetry: () => runDownload(options) });
      releaseToNativeControl(button, fileId, missing, isNMM);
      return false;
    }

    const verdict = NXTK.validateDownloadTarget(finalUrl, { method: isNMM ? 0 : 1 });
    if (!verdict.ok) {
      const unsafe = Errors.create('unsafe_download_url', {
        context: 'Validating download target',
        technicalMessage: `rejected: ${verdict.detail} | method=${isNMM ? 'vortex' : 'browser'}`
      });
      handleError(button, unsafe);
      releaseToNativeControl(button, fileId, unsafe, isNMM);
      return false;
    }
    // Vortex hands a link only to the download waiting for that file: a link for another file would
    // start a separate download there and leave that one waiting.
    if (isNMM && fileId && DownloadParser.nxmFileId(finalUrl) !== toFileId(fileId)) {
      const wrongFile = Errors.create('no_nmm_link', {
        context: 'Checking the Vortex link',
        technicalMessage: 'the nxm link names another file',
        fileIdentity: { expectedId: toFileId(fileId), receivedId: DownloadParser.nxmFileId(finalUrl) }
      });
      handleError(button, wrongFile, { onRetry: () => runDownload(options) });
      releaseToNativeControl(button, fileId, wrongFile, isNMM);
      return false;
    }
    if (isNMM) {
      try {
        location.assign(finalUrl);
      } catch (cause) {
        handleError(button, Errors.fromException(cause, { context: 'Sending link to Vortex' }), {
          onRetry: () => runDownload(options)
        });
        return false;
      }
      statusToast?.update(NXTK.t('toastSentToVortex', null, 'Sent to Vortex'), SENT_STATE_MS);
      Logger.info('Vortex hand-off: link sent, showing "Sent to Vortex"');
      handoffVerdict = watchSingleHandoff();
      handoffVerdict.then((opened) => { if (!opened) options.claim?.release?.(); }, () => undefined);
      if (button) {
        setButtonState(button, 'sent');
        // Per button: a start on another file moments later used to leave "Sent to Vortex" on this one.
        button._nxtkSentAttempt = attemptId;
        setTimeout(() => {
          if (button._nxtkSentAttempt === attemptId && button.isConnected) restoreButtonState(button);
        }, SENT_STATE_MS);
      }
    } else if (!await startManagedFileDownload(finalUrl, fileId)) {
      handleError(button, Errors.create('request_failed', {
        context: 'Starting browser download',
        technicalMessage: 'chrome.downloads did not start the resolved file'
      }), { onRetry: () => runDownload(options) });
      return false;
    }
    globalThis.NXTK?.bumpTotalDownloads?.();
    if (closeTabAfterStart && cfg.AutoCloseTab && isNMM && attemptId === downloadAttemptSequence) {
      const closeDelay = NXTK.normalizeSetting('CloseTabDelay', Number(cfg.CloseTabDelay))
        ?? NXTK.DEFAULTS.CloseTabDelay;
      // The tab closes only once the watch says Vortex opened: closing earlier would take the
      // "Vortex didn't open?" hint (and its debug line) with it.
      const closeNow = async () => {
        closeTabTimer = null;
        closeTabToast = null;
        if (attemptId !== downloadAttemptSequence) return;
        const opened = await handoffVerdict;
        if (!opened || attemptId !== downloadAttemptSequence) return;
        NXTK.flushDebugLog?.();
        safeSendMessage({ type: 'CLOSE_TAB' });
      };

      if (NexusExt.UI?.showCloseCountdown && closeDelay >= 1000) {
        statusToast?.dismiss();
        closeTabToast = NexusExt.UI.showCloseCountdown({
          ms: closeDelay,
          onDone: closeNow,
          onCancel: () => {
            closeTabToast = null;
            invalidateDownloadAttempts();
            Logger.info('Tab close cancelled — leaving this page open.');
          }
        });
      } else {
        closeTabTimer = setTimeout(closeNow, closeDelay);
      }
    }
    return true;
  }

  function attachClickInterceptor() {
    async function handleDownload(btn, fileId, isNMM, href) {
      return runDownload({
        button: btn,
        fileId,
        isNMM,
        href,
        openFilePageOnNoUrl: true
      });
    }

    const extractFileId = (href) => {
      try {
        const url = new URL(href, location.href);
        const apiMatch = url.pathname.match(/\/api\/files\/(\d+)/);
        return toFileId(apiMatch ? apiMatch[1] : url.searchParams.get('file_id') || url.searchParams.get('id')) || null;
      } catch {}
      return null;
    };

    const OWN_UI_SELECTOR = '.nxtk-close-toast, .nxtk-modal-backdrop, .nxtk-modal, #nxtk-extension-root, #nxtk-dropdown-portal, #nxtk-settings-fab';
    const IGNORE_ANCESTORS = 'nav, .nav, .pagination, .comment-container, .comment-content, .forum-post, .header-nav, .search-results, .nxtk-deck';
    const DOWNLOAD_HREF_PATTERNS = ['/Core/Libs/Common/', 'tab=files&file_id=', 'file_id=', 'ModRequirementsPopUp', '/api/files/'];
    const isDownloadHref = (href) => DOWNLOAD_HREF_PATTERNS.some(p => href.includes(p));

    // Registered on window in the capture phase: it runs before any handler Nexus puts on the page,
    // its shadow roots or the button itself, so when the extension takes a click Nexus never sees it
    // (one owner per click: no native download racing the extension's).
    window.addEventListener('click', async function (event) {
      if (!isModPage()) return;
      if (isNativeFallbackActive()) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      // The extension's own UI (toasts with "Keep open", dialogs, the deck) is never a Nexus download.
      if (path.some((node) => node?.closest && node.matches?.(OWN_UI_SELECTOR))) return;
      noteFileClick(path);

      if (cfg.SkipRequirements && path.length) {
        const modal = path.find((node) => DOWNLOAD_MODAL_TAGS.has(node?.tagName));
        if (modal) {
          const modalButton = path.find(node => node && (node.tagName === 'BUTTON' || node.tagName === 'A'));
          // Only the modal's download buttons are taken. Close, Cancel and anything else is left to Nexus,
          // which used to be swallowed here and started a download instead of closing the dialog.
          if (modalButton && isModalDownloadAction(modalButton)) {
            const isNMMModal = classifyDownloadControl(modalButton) === 'nmm'
              || hrefWantsNmm(modalButton.href || modalButton.getAttribute?.('href'));
            const modalHref = resolveModalHref(modal, modalButton, isNMMModal);

            if (modalHref && !shouldPassThroughToNative(extractFileId(modalHref), isNMMModal)) {
              event.preventDefault();
              event.stopImmediatePropagation();
              handleDownload(modalButton, extractFileId(modalHref), isNMMModal, modalHref)
                .catch((cause) => handleError(
                  modalButton,
                  Errors.fromException(cause, { context: 'Starting modal download' })
                ));
              return;
            }
          }
        }
      }

      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      // The first link or button on the click's path, shadow DOM included (event.target is retargeted
      // to the shadow host, which hid links inside Nexus's file cards from this check).
      const element = path.find((node) => node?.tagName === 'A' || node?.tagName === 'BUTTON')
        || event.target?.closest?.('a,button');
      if (!element) return;
      if (element.closest(IGNORE_ANCESTORS)) return;
      const linkHref = element.href || element.getAttribute('href') || '';
      if (!linkHref) {
        // Nexus's newer file cards render "Mod manager download" / "Manual download" as plain buttons
        // that open the requirements modal in script. With Skip requirement screens on, those are taken
        // the same way a link is, so the requirements step is skipped for Vortex as well as manual.
        const synthesized = cfg.SkipRequirements ? hrefForHreflessControl(element, path) : null;
        if (!synthesized || shouldPassThroughToNative(synthesized.fileId, synthesized.isNMM)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handleDownload(element, synthesized.fileId, synthesized.isNMM, synthesized.href)
          .catch((cause) => handleError(
            element,
            Errors.fromException(cause, { context: 'Starting download' })
          ));
        return;
      }
      if (!isDownloadHref(linkHref)) return;
      const fileId = extractFileId(linkHref);
      if (!fileId) return;
      const isNMM = hrefWantsNmm(linkHref) || matchesAny(element, 'modManagerControl');
      if (shouldPassThroughToNative(fileId, isNMM)) return;
      const hasRequirements = linkHref.includes('ModRequirementsPopUp') || linkHref.includes('tab=requirements');
      if (hasRequirements && !cfg.SkipRequirements) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handleDownload(element, fileId, isNMM, linkHref)
        .catch((cause) => handleError(
          element,
          Errors.fromException(cause, { context: 'Starting download' })
        ));
    }, true);

    // The slow-download button, taken the same way: before Nexus's own listener on it can start the
    // native download alongside the extension's.
    window.addEventListener('click', (event) => {
      if (!isFilePage() || isNativeFallbackActive()) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const slowButton = path.find((node) => node?.tagName === 'BUTTON'
        && (boundSlowButtons.has(node) || node.id === 'slowDownloadButton'));
      if (!slowButton) return;
      handleSlowDownloadClick(slowButton, event)
        .catch((cause) => handleError(
          slowButton,
          Errors.fromException(cause, { context: 'Starting slow download' })
        ));
    }, true);

    // Which file the user last clicked a control for. The requirements modal that click opens is for
    // that file, so the modal may only ever download that file id.
    let lastFileClick = { id: '', at: 0 };
    function noteFileClick(path) {
      // A click inside the modal is the modal's own button; it must not replace the file it is for.
      if (path.some((node) => DOWNLOAD_MODAL_TAGS.has(node?.tagName))) return;
      for (const node of path) {
        const id = fileIdFromNode(node)
          || (node?.tagName === 'A' ? extractFileId(node.href || node.getAttribute?.('href') || '') : '');
        if (/^\d{1,12}$/.test(String(id || ''))) {
          lastFileClick = { id: String(id), at: Date.now() };
          return;
        }
      }
    }
    function recentlyClickedFileId() {
      return Date.now() - lastFileClick.at < FILE_CLICK_MEMORY_MS ? lastFileClick.id : '';
    }
    function isModalDownloadAction(button) {
      if (isDismissControl(button)) return false;
      if (classifyDownloadControl(button)) return true;
      const href = button.href || button.getAttribute?.('href') || '';
      if (href && isDownloadHref(href)) return true;
      return textIs(controlLabel(button), 'downloadWord', ['download']);
    }

    // A file id for a control with no href: from its host element, or from the page's own file_id.
    function hrefForHreflessControl(element, path) {
      const kind = classifyDownloadControl(element);
      if (!kind) return null;
      let fileId = '';
      for (const node of path) {
        fileId = fileIdFromNode(node);
        if (fileId) break;
      }
      // The component's modal names the file too, and its own signed API link when there is one.
      const modal = downloadModalFor(path);
      if (!fileId) fileId = fileIdFromNode(modal);
      if (!fileId) fileId = String(new URLSearchParams(location.search).get('file_id') || '');
      if (!/^\d{1,12}$/.test(fileId)) return null;
      const page = getModPagePath();
      if (!page) return null;
      const isNMM = kind === 'nmm';
      const modalFile = fileJsonOf(modal);
      const picked = modalFile ? pickModalHref({ modalFileId: fileId, linksJson: JSON.stringify(modalFile), isNMM, base: page }) : '';
      return { fileId, isNMM, href: picked || `${page}?tab=files&file_id=${fileId}${isNMM ? '&nmm=1' : ''}` };
    }

    function resolveModalHref(modal, modalButton, isNMMModal) {
      return pickModalHref({
        modalFileId: fileIdFromNode(modal) || recentlyClickedFileId(),
        buttonHref: modalButton.href || modalButton.getAttribute?.('href') || '',
        linksJson: modal.getAttribute('download-links') || modal.getAttribute('file'),
        isNMM: isNMMModal
      });
    }
  }

  const FILE_CLICK_MEMORY_MS = 2 * 60 * 1000;

  // The link a requirements-modal button may follow. Only a link for the file the modal is about is
  // accepted: the modal's download-links can name another file of the mod (its main file), which made
  // "Download mod file" fetch the main file instead of the one clicked. When the file cannot be pinned
  // down the click is left to Nexus (empty result), never guessed.
  function pickModalHref({ modalFileId = '', buttonHref = '', linksJson = '', isNMM = false, base = '' }) {
    const expected = toFileId(modalFileId);
    let links = null;
    if (linksJson) {
      try {
        links = JSON.parse(decodeDownloadUrlValue(linksJson));
      } catch (err) {
        Logger.warn('Failed to parse download modal links:', err);
      }
    }
    const candidates = (isNMM
      ? [links?.vortexDownloadUrl, links?.nmmDownloadUrl, links?.downloadUrl, buttonHref]
      : [links?.downloadUrl, buttonHref]).filter(Boolean).map(String);
    for (const candidate of candidates) {
      let id = '';
      try {
        const url = new URL(candidate, location.href);
        id = toFileId(url.pathname.match(/\/api\/files\/(\d+)/)?.[1] || url.searchParams.get('file_id') || url.searchParams.get('id'));
      } catch (_) {
        id = '';
      }
      if (expected ? id === expected : !!id) return candidate;
    }
    if (!expected) return '';
    const page = base || getModPagePath() || `${location.origin}${normalizeModPathname(location.pathname)}`;
    return `${page}?tab=files&file_id=${expected}${isNMM ? '&nmm=1' : ''}`;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  const SHADOW_HOST_SELECTOR = 'mod-file-download, mod-download-buttons, mod-download-modal, download-modal';

  function getSearchRoots(root = document) {
    const roots = [root];
    if (typeof root.querySelectorAll !== 'function') return roots;
    const seen = new Set(roots);
    const queue = [root];

    while (queue.length) {
      const currentRoot = queue.shift();
      if (typeof currentRoot.querySelectorAll !== 'function') continue;
      for (const host of currentRoot.querySelectorAll(SHADOW_HOST_SELECTOR)) {
        const shadowRoot = host.shadowRoot;
        if (!shadowRoot || seen.has(shadowRoot)) continue;
        seen.add(shadowRoot);
        roots.push(shadowRoot);
        queue.push(shadowRoot);
      }
    }

    return roots;
  }

  function findSlowDownloadButtons(root, { includeBound = false } = {}) {
    // Nexus relabels the same button, so anything not yet bound has to be re-read each pass.
    const selector = includeBound ? 'button' : 'button:not([data-nxtk-slow-bound])';
    const buttons = Array.from(root.querySelectorAll(selector));
    return buttons.filter((button) => {
      const Sel = globalThis.NexusSelectors;
      const buttonText = normalizeText(button.textContent);
      const isSlow = Sel ? Sel.textMatches(buttonText, 'slowDownload') : buttonText.includes('slow download');
      if (!isSlow) return false;
      if (button.id === 'slowDownloadButton') return true;

      const cardText = normalizeText(button.closest('div,section,article')?.textContent);
      return Sel
        ? Sel.textMatches(cardText, 'slowCardHint')
        : (cardText.includes('wait more')
          || cardText.includes('delay before each download')
          || cardText.includes('throttled downloads'));
    });
  }

  function startNativeFallbackIfReady() {
    if (!isNativeFallbackActive() || !nativeFallbackAutoStartPending
      || nativeFallbackAutoStarted) return;
    if (isCloudflareChallengeDocument()) return;

    const fileId = getCurrentFileId();
    if (typeof nativeFallbackIsNMM === 'boolean'
      && !currentNativeMethodMatches(nativeFallbackIsNMM, fileId)) return;

    const host = getCurrentNativeDownloadHost(fileId, nativeFallbackIsNMM);
    const roots = host?.shadowRoot ? getSearchRoots(host.shadowRoot) : getSearchRoots(document);
    const button = host?.shadowRoot?.querySelector('#slowDownloadButton')
      || roots.flatMap((root) => Array.from(root.querySelectorAll(
        '#slowDownloadButton, button[data-nxtk-slow-bound]'
      )))[0]
      || roots
        .flatMap((root) => findSlowDownloadButtons(root, { includeBound: true }))[0];
    if (!button || button.disabled) return;

    nativeFallbackAutoStarted = true;
    cancelFallbackWatchdog();
    setStoredCloudflareAutoStartPending(false);
    restoreButtonState(button);
    NXTK.setActivity?.({
      trigger: 'fallback',
      method: 'native',
      fileId: String(fileId || ''),
      fallbackActive: true
    });
    Logger.info('Starting the native Nexus download after the Cloudflare fallback.');
    Promise.resolve().then(() => {
      if (!isNativeFallbackActive() || !button.isConnected) {

        nativeFallbackAutoStarted = false;
        setStoredCloudflareAutoStartPending(true);
        armFallbackWatchdog();
        return;
      }
      button.click();
    }).catch((cause) => {
      nativeFallbackAutoStarted = false;
      setStoredCloudflareAutoStartPending(true);
      armFallbackWatchdog();
      Logger.warn('Could not start the native Nexus download:', cause);
    });
  }

  async function handleSlowDownloadClick(button, event) {
    const params = new URLSearchParams(location.search);
    const fileId = params.get('file_id');

    const isNMM = wantsVortexHandoff(params);
    if (!fileId || shouldPassThroughToNative(fileId, isNMM)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    return runDownload({ button, fileId, isNMM, href: location.href });
  }

  function wantsVortexHandoff(params) {
    return params.get('nmm') === '1';
  }

  function isFilePage() {
    return isModPage() && location.search.includes('file_id');
  }

  // Nexus re-renders the card and can drop the data attribute while keeping the same element; the
  // WeakSet makes sure one button never gets a second listener (which started the file twice).
  const boundSlowButtons = new WeakSet();

  function setupSlowDownloadIntercept() {
    if (isNativeFallbackActive()) {
      startNativeFallbackIfReady();
      return;
    }

    const roots = getSearchRoots(document);
    for (const root of roots) {
      const slowDownloadButtons = findSlowDownloadButtons(root);
      for (const slowDownloadBtn of slowDownloadButtons) {
        // Marked only; the click itself is taken by the window capture listener in
        // attachClickInterceptor, ahead of Nexus's own listener on the button.
        slowDownloadBtn.dataset.nxtkSlowBound = '1';
        boundSlowButtons.add(slowDownloadBtn);
      }
    }
  }

  // Nexus builds and relabels the download card after load (and inside shadow roots), so the binding
  // follows DOM changes instead of a one-second poll. The safety tick stays as a slow backstop for
  // shadow-root changes a document observer cannot see, and for the Cloudflare fallback.
  const SLOW_DOWNLOAD_SAFETY_MS = 5000;
  let slowDownloadTimer = null;
  let slowDownloadObserver = null;
  let slowDownloadScheduled = false;

  function scheduleSlowDownloadSetup() {
    if (slowDownloadScheduled) return;
    slowDownloadScheduled = true;
    const run = () => {
      slowDownloadScheduled = false;
      if (!isFilePage()) {
        stopSlowDownloadPolling();
        return;
      }
      if (!document.hidden || isNativeFallbackActive()) setupSlowDownloadIntercept();
    };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
    else setTimeout(run, 50);
  }

  function syncSlowDownloadIntercept() {
    if (isFilePage()) {
      setupSlowDownloadIntercept();
      if (!slowDownloadObserver && typeof MutationObserver === 'function' && document.body) {
        slowDownloadObserver = new MutationObserver(scheduleSlowDownloadSetup);
        slowDownloadObserver.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', scheduleSlowDownloadSetup);
      }
      if (slowDownloadTimer === null) {
        slowDownloadTimer = setInterval(scheduleSlowDownloadSetup, SLOW_DOWNLOAD_SAFETY_MS);
      }
      return;
    }
    stopSlowDownloadPolling();
  }

  function stopSlowDownloadPolling() {
    if (slowDownloadObserver) {
      slowDownloadObserver.disconnect();
      slowDownloadObserver = null;
      document.removeEventListener('visibilitychange', scheduleSlowDownloadSetup);
    }
    if (slowDownloadTimer === null) return;
    clearInterval(slowDownloadTimer);
    slowDownloadTimer = null;
  }

  function interceptRequirementsTab() {
  document.body.addEventListener('click', function (event) {
    if (!event.isTrusted || event.defaultPrevented || !cfg.SkipRequirements) return;
    const linkElement = event.composedPath
      ? event.composedPath().find(node =>
          node?.tagName === 'A' &&
          node.href?.includes('tab=requirements')
        )
      : event.target.closest("a[href*='tab=requirements']");
    if (!linkElement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const linkHref = linkElement.href || linkElement.getAttribute('href') || '';
      let target;
      try {
        target = new URL(linkHref.replace('tab=requirements', 'tab=files'), location.href).href;
      } catch (_) {
        return;
      }
      if (!NXTK.isSafeNexusPageUrl(target)) {
        Logger.warn('Ignored requirements link with unexpected target.');
        return;
      }
      location.replace(target);
    }, true);
  }

  let lastAutoStartHref = '';

  // True once the tab is shown while it is still on the same address and automatic starts are still on;
  // false if either changed while it waited.
  function waitUntilShown(pageKey) {
    const stillWanted = () => !!cfg.AutoStartDownload
      && location.origin + location.pathname + location.search === pageKey;
    if (!document.hidden) return Promise.resolve(stillWanted());
    return new Promise((resolve) => {
      const onVisibility = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onVisibility);
        resolve(stillWanted());
      };
      document.addEventListener('visibilitychange', onVisibility);
    });
  }

  async function autoStartDownload() {
    if (!cfg.AutoStartDownload) return;
    if (isCloudflareChallengeDocument()) return;
    if (!isModPage()) return;
    const params = new URLSearchParams(location.search);
    const fileId = params.get('file_id');
    if (!fileId) return;
    if (isNativeFallbackActive()) {
      startNativeFallbackIfReady();
      return;
    }
    const autoStartKey = location.origin + location.pathname + location.search;
    if (lastAutoStartHref === autoStartKey) return;
    lastAutoStartHref = autoStartKey;
    const unavailable = unavailableModNotice();
    if (unavailable) {
      Logger.info(`No download started: the page shows only a ${unavailable}.`);
      return;
    }
    const isNMM = wantsVortexHandoff(params);
    // Handing a link to Vortex asks the browser to open another program, then counts down to close this tab
    // behind a "Keep open" button. Neither should happen in a tab nobody is looking at, so it waits to be shown.
    if (isNMM && !await waitUntilShown(autoStartKey)) return;
    Logger.debug('Auto-start: fileId', fileId, 'isNMM', isNMM);
    await new Promise(r => setTimeout(r, 200));
    Logger.info(`Auto ${isNMM ? 'NMM' : 'manual'}: starting download`);
    return runDownload({
      fileId,
      isNMM,
      href: location.href,
      closeTabAfterStart: true
    });
  }

  const UPSELL_SELECTORS = [
      '#nonPremiumBanner', '#freeTrialBanner', '#ig-banner-container', '#rj-vortex',
      '[class*="ads-bottom"]', '[class*="ads-top"]', '[class*="to-premium"]',
      '[class*="from-premium"]',
      '#mainContent > div.ads-holder.clearfix.ads-top',
      '#mainContent > div.ads-holder.clearfix.ads-bottom',
      '#mainContent > div > div.relative.next-container > div > section.flex.items-center.justify-center > div',
      '#mainContent > div > div.relative.next-container > div > a',
      '#mainContent > div.flex.items-center.justify-center.gap-x-4.border-y.border-stroke-subdued.bg-surface-low.py-2',
      '#mainContent > div.hidden.items-center.justify-center.gap-x-4.border-b.border-stroke-subdued.bg-surface-low.py-2.md\\:flex',
      '#mainContent > div.relative > div.relative.next-container.pb-20 > div.space-y-16 > div.relative.overflow-hidden.rounded-lg.border-2.border-\\[\\#FCD23F\\]',
      '#mainContent > div.relative > div.relative.next-container.pb-20 > div.mb-6.w-full.space-y-6.border-b.border-stroke-weak.pt-4.pb-6.sm\\:mb-0.sm\\:border-none.sm\\:pb-8 > section > div.flex.flex-col.gap-2.rounded-sm.bg-surface-translucent-low.p-2\\.5.backdrop-blur-xs.xs\\:w-fit.xs\\:max-w-sm.order-4.h-fit.w-full',
      '#filters-panel > div.mt-4.hidden.rounded-lg.border.border-creator-subdued.bg-creator-weak.bg-cover.p-4',
      '#head > div.rj-right-tray.rj-profile-tray.rj-open > ul > li.user-profile-menu-section-top > a'
  ];

  const UPSELL_SELECTOR = (() => {
    const joined = UPSELL_SELECTORS.join(', ');
    try {
      document.createDocumentFragment().querySelector(joined);
      return joined;
    } catch (_) {
      return '';
    }
  })();

  const UPSELL_FUZZY_SELECTORS = [
    '[class*="premium"]', '[id*="premium"]', '[class*="upsell"]', '[id*="upsell"]'
  ];
  const UPSELL_FUZZY_SELECTOR = UPSELL_FUZZY_SELECTORS.join(', ');
  const UPSELL_PAGE_CONTENT_SELECTOR = 'h1, #mainContent';

  function looksLikePageContent(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'mainContent') return true;
    try {
      return !!el.querySelector(UPSELL_PAGE_CONTENT_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  const AD_SLOT_SELECTORS = [
    "[data-testid^=\"ad-\"]",
    "[id^=\"standard_iab_\"]",
    "[id^=\"google_ads_iframe_\"]",
    "[class*=\"pw-standardIAB-tag\"]",
    "[class*=\"pw-tag\"]",
    "#ig-banner-container",
    ".ads-holder",
  ];
  const AD_SLOT_SELECTOR = AD_SLOT_SELECTORS.join(", ");

  const AD_CONTENT_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "form",
    "h1, h2, h3, h4, h5, h6",
    "img",
    "video",
    "[role=\"button\"]",
    "[data-testid]:not([data-testid^=\"ad-\"])",
  ].join(", ");

  const AD_WRAPPER_STOP_TAGS = new Set(["BODY", "HTML", "MAIN", "HEADER", "FOOTER", "NAV"]);
  const AD_WRAPPER_MAX_DEPTH = 4;

  function isAdOnlyContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (AD_WRAPPER_STOP_TAGS.has(el.tagName)) return false;
    if (el.id === "mainContent" || el.id === "nxtk-extension-root") return false;
    if (el.closest("[id^=\"nxtk-\"], .nxtk-deck")) return false;
    if (el.textContent && el.textContent.trim()) return false;
    if (el.querySelector(AD_CONTENT_SELECTOR)) return false;
    return !!el.querySelector(AD_SLOT_SELECTOR);
  }

  function findAdSlotWrapper(slot) {
    let wrapper = slot;
    let node = slot.parentElement;
    for (let depth = 0; node && depth < AD_WRAPPER_MAX_DEPTH; depth += 1) {
      if (!isAdOnlyContainer(node)) break;
      wrapper = node;
      node = node.parentElement;
    }
    return wrapper;
  }

  function collectMatches(root, selector) {
    const matches = [];
    try {
      if (root.nodeType === 1 && root.matches(selector)) matches.push(root);
      root.querySelectorAll(selector).forEach((el) => matches.push(el));
    } catch (_) {
    }
    return matches;
  }

  function hideAdSlots(root = document) {
    for (const slot of collectMatches(root, AD_SLOT_SELECTOR)) {
      hideUpsellElement(findAdSlotWrapper(slot), "nxtk-ad-hidden");
    }
  }

  function applyUpsellHiding(root) {
    if (UPSELL_SELECTOR) {
      collectMatches(root, UPSELL_SELECTOR).forEach((el) => hideUpsellElement(el));
    } else {
      for (const selector of UPSELL_SELECTORS) {
        collectMatches(root, selector).forEach((el) => hideUpsellElement(el));
      }
    }
    for (const el of collectMatches(root, UPSELL_FUZZY_SELECTOR)) {
      if (!looksLikePageContent(el)) hideUpsellElement(el);
    }
    hideAdSlots(root);
  }

  const SHADOW_UPSELL_CSS = `
        [class*="from-premium"],
        [class*="to-premium"],
        [class*="premium"],
        #upsell-cards,
        #upsell-cards > * {
          display: none !important;
          visibility: hidden !important;
        }
      `;

  function upsellBlocker() {
    if (!cfg.HidePremiumUpsells) return;
    applyUpsellHiding(document);

    document.querySelectorAll('mod-file-download').forEach((modFileDownload) => {
      const shadowRoot = modFileDownload.shadowRoot;
      if (!shadowRoot || shadowRoot.querySelector('.nxtk-shadow-style')) return;
      const shadowStyle = document.createElement('style');
      shadowStyle.className = 'nxtk-shadow-style';
      shadowStyle.textContent = SHADOW_UPSELL_CSS;
      shadowRoot.appendChild(shadowStyle);
    });

    const premiumBanner = globalThis.NexusSelectors?.find(document, 'premiumBanner')?.element
      || document.querySelector('.bg-nexus-premium-gradient');
    if (premiumBanner) {
      hideUpsellElement(premiumBanner);
      Logger.info('Hidden premium upsell banner');
    }

    startPremiumObserver();
  }

  const UPSELL_FLUSH_DEBOUNCE_MS = 100;
  const UPSELL_FLUSH_MAX_WAIT_MS = 500;
  const UPSELL_FULL_RESCAN_THRESHOLD = 24;

  let pendingUpsellRoots = [];
  let pendingUpsellSince = 0;
  let pendingUpsellNeedsFullScan = false;

  function scheduleUpsellFlush() {
    const now = Date.now();
    if (!pendingUpsellSince) pendingUpsellSince = now;
    if (now - pendingUpsellSince >= UPSELL_FLUSH_MAX_WAIT_MS) {
      flushPendingUpsellRoots();
      return;
    }
    clearTimeout(premiumObserverTimer);
    premiumObserverTimer = setTimeout(flushPendingUpsellRoots, UPSELL_FLUSH_DEBOUNCE_MS);
  }

  function flushPendingUpsellRoots() {
    clearTimeout(premiumObserverTimer);
    premiumObserverTimer = null;
    const connected = pendingUpsellRoots.filter((node) => node.isConnected);
    const needsFullScan = pendingUpsellNeedsFullScan;
    pendingUpsellRoots = [];
    pendingUpsellSince = 0;
    pendingUpsellNeedsFullScan = false;
    if (!cfg.HidePremiumUpsells) return;
    const unique = [...new Set(connected)];
    if (needsFullScan || unique.length > UPSELL_FULL_RESCAN_THRESHOLD) {
      applyUpsellHiding(document);
      return;
    }
    const roots = unique.filter(
      (node) => !unique.some((other) => other !== node && other.contains(node))
    );
    for (const root of roots) {
      applyUpsellHiding(root);
    }
  }

  function startPremiumObserver() {
    if (premiumObserver || !document.body) return;

    premiumObserver = new MutationObserver((mutations) => {
      let queued = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.closest && node.closest("[id^=\"nxtk-\"], .nxtk-deck")) continue;

          if (pendingUpsellRoots.length >= UPSELL_FULL_RESCAN_THRESHOLD) pendingUpsellNeedsFullScan = true;
          else pendingUpsellRoots.push(node);
          queued = true;
        }
      }
      if (!queued) return;
      scheduleUpsellFlush();
    });
    premiumObserver.observe(document.body, { childList: true, subtree: true });
  }

  const AD_TIMER_WINDOW_MS = 5 * 60 * 1000;
  const AD_TIMER_REFRESH_MS = 60 * 1000;
  let adTimerWrittenAt = 0;

  function refreshAdTimerCookie() {
    if (!cfg.HidePremiumUpsells) return;
    const now = Date.now();
    if (now - adTimerWrittenAt < AD_TIMER_REFRESH_MS) return;
    try {
      if (typeof document === 'undefined') return;
      if (!/(?:^|\.)nexusmods\.com$/i.test(location.hostname)) return;
      const elapsedAt = Math.round((now + AD_TIMER_WINDOW_MS) / 1000);
      const expires = new Date(now + AD_TIMER_WINDOW_MS).toUTCString();
      document.cookie = `ab=0|${elapsedAt};expires=${expires};domain=nexusmods.com;path=/;SameSite=Lax;Secure`;
      adTimerWrittenAt = now;
    } catch (_) {
    }
  }

  // The marker keeps what the page had, so switching the setting off puts back exactly that: its own
  // aria-hidden (an icon it hides from screen readers, a card it exposes) and no class attribute where
  // it had none.
  function hideUpsellElement(el, className = "nxtk-upsell-hidden") {
    if (!el || !el.dataset || el.dataset.nxtkUpsellHidden) return;
    el.dataset.nxtkUpsellHidden = JSON.stringify({
      ariaHidden: el.getAttribute("aria-hidden"),
      hadClass: el.hasAttribute("class")
    });
    el.classList.add(className);
    el.setAttribute("aria-hidden", "true");
  }

  function resetUpsellBlocker() {
    if (premiumObserver) {
      premiumObserver.disconnect();
      premiumObserver = null;
    }
    clearTimeout(premiumObserverTimer);
    premiumObserverTimer = null;
    pendingUpsellRoots = [];
    pendingUpsellSince = 0;
    pendingUpsellNeedsFullScan = false;

    document.querySelectorAll('.nxtk-upsell-hidden, .nxtk-ad-hidden, [data-nxtk-upsell-hidden]').forEach((el) => {
      let saved = null;
      try { saved = JSON.parse(el.dataset.nxtkUpsellHidden || 'null'); } catch (_) { }
      el.classList.remove('nxtk-upsell-hidden');
      el.classList.remove('nxtk-ad-hidden');
      if (!saved?.hadClass && !el.classList.length) el.removeAttribute('class');
      if (typeof saved?.ariaHidden === 'string') el.setAttribute('aria-hidden', saved.ariaHidden);
      else el.removeAttribute('aria-hidden');
      delete el.dataset.nxtkUpsellHidden;
    });

    document.querySelectorAll('mod-file-download').forEach((host) => {
      host.shadowRoot?.querySelectorAll('.nxtk-shadow-style').forEach((style) => {
        style.remove();
      });
    });
  }
  function waitForElement(selector, cb, timeoutMs = 10000) {
    const el = document.querySelector(selector);
    if (el) {
      cb(el);
      return () => undefined;
    }
    const mo = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { mo.disconnect(); clearTimeout(timer); cb(found); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => mo.disconnect(), timeoutMs);
    return () => {
      mo.disconnect();
      clearTimeout(timer);
    };
  }

  let cancelArchivedFooterWait = null;

  const ARCHIVED_FILE_ID_PATTERN = /^\d{1,12}$/;

  const ARCHIVED_DOWNLOADS_CLASS = 'accordion-downloads';

  function findArchivedDownloadBox(header) {
    if (!header) return null;

    const sibling = header.nextElementSibling;
    if (sibling?.classList?.contains(ARCHIVED_DOWNLOADS_CLASS)) return sibling;

    return header.parentElement?.querySelector(`.${ARCHIVED_DOWNLOADS_CLASS}`) || null;
  }

  function buildArchivedDownloadLink(href, label) {
    const anchor = document.createElement('a');
    anchor.className = 'btn inline-flex';
    anchor.href = href;
    const span = document.createElement('span');
    span.className = 'flex-label';
    span.textContent = label;
    anchor.appendChild(span);
    return anchor;
  }

  function buildArchivedFilesUrl(value = location.href) {
    try {
      const url = new URL(value, location.href);
      url.searchParams.set('category', 'archived');
      return url.href;
    } catch (_) {
      return '';
    }
  }

  // The mod's file list from the official API (modFiles). The page is still where buttons go; the API
  // supplies the data, so a header Nexus renders without its data-id can still be matched by name.
  let apiFileList = { key: '', files: [] };

  function currentModId() {
    return normalizeModPathname(location.pathname).match(/\/mods\/(\d+)$/)?.[1] || '';
  }

  async function loadApiFileList() {
    const api = officialApi();
    if (!api || !isModPage()) return;
    const modId = currentModId();
    const gameId = (await prefetchGameIdFromApi()) || getGameId();
    if (!modId || !gameId) return;
    const key = `${gameId}:${modId}`;
    if (apiFileList.key === key) return;
    const files = await api.modFiles({ modId, gameId });
    if (!Array.isArray(files) || currentModId() !== modId) return;
    apiFileList = { key, files };
    // A second pass can now match archived headers that had no id.
    archivedFileHandler();
  }

  function apiFileIdForHeader(header) {
    const modId = currentModId();
    if (!header || !apiFileList.key.endsWith(`:${modId}`)) return '';
    const text = String(header.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return '';
    const matches = apiFileList.files.filter((file) => {
      const name = String(file?.name || '').trim().toLowerCase();
      return name && text.includes(name) && (!file.version || text.includes(String(file.version).toLowerCase()));
    });
    return matches.length === 1 ? String(matches[0].fileId) : '';
  }

  function archivedFileHandler() {
    if (!cfg.HandleArchivedFiles) return;
    if (!isModPage()) return;
    let pageUrl;
    try {
      pageUrl = new URL(location.href);
    } catch (_) {
      return;
    }
    const isArchivedView = pageUrl.searchParams.get('category') === 'archived';
    if (pageUrl.searchParams.get('tab') === 'files' && !isArchivedView) {
      const archiveUrl = buildArchivedFilesUrl(pageUrl.href);
      cancelArchivedFooterWait?.();
      cancelArchivedFooterWait = waitForElement('#files-tab-footer', (footer) => {
        if (!cfg.HandleArchivedFiles || !archiveUrl) return;
        const p = footer.querySelector('p');
        if (p) {
          p.dataset.nxtkArchiveHidden = '1';
          p.style.display = 'none';
        }
        const hasArchiveBtn = footer.querySelector('[data-nxtk-archive]');
        if (!hasArchiveBtn) {

          const btn = buildArchivedDownloadLink(
            archiveUrl,
            NXTK.t('btnFileArchive', null, 'File archive')
          );
          btn.classList.add('nxtk-archive-btn');
          btn.dataset.nxtkArchive = '1';
          footer.appendChild(btn);
        }
      });
    }
    if (!isArchivedView) return;
    const headers = Array.from(document.getElementsByClassName('file-expander-header'));
    const base = getModPagePath() || `${location.origin}${normalizeModPathname(location.pathname)}`;
    const claimed = new Set();
    for (const header of headers) {
      const fileId = String(header?.dataset?.id ?? '') || apiFileIdForHeader(header);
      const box = findArchivedDownloadBox(header);
      if (!ARCHIVED_FILE_ID_PATTERN.test(fileId) || !box || box.dataset.nxtkDone) continue;

      if (claimed.has(box)) {
        Logger.warn('Archived files: two headers resolved to the same download box; skipping', fileId);
        continue;
      }
      claimed.add(box);
      box.dataset.nxtkDone = '1';
      box._nxtkOriginalHtml = box.innerHTML;
      box.replaceChildren(
        buildArchivedDownloadLink(
          `${base}?tab=files&file_id=${fileId}&nmm=1`,
          NXTK.t('btnModManagerDownload', null, 'Mod manager download')
        ),
        buildArchivedDownloadLink(
          `${base}?tab=files&file_id=${fileId}`,
          NXTK.t('btnManualDownload', null, 'Manual download')
        )
      );
    }
  }

  function resetArchivedFileHandler() {
    document.querySelectorAll('[data-nxtk-archive]').forEach((el) => {
      el.remove();
    });

    document.querySelectorAll('[data-nxtk-archive-hidden]').forEach((el) => {
      delete el.dataset.nxtkArchiveHidden;
      el.style.display = '';
    });

    document.querySelectorAll('.accordion-downloads[data-nxtk-done]').forEach((box) => {
      if (typeof box._nxtkOriginalHtml === 'string') {
        box.innerHTML = box._nxtkOriginalHtml;
      }
      delete box._nxtkOriginalHtml;
      delete box.dataset.nxtkDone;
    });
  }

  function startAutoDownload() {
    autoStartDownload().catch((cause) => handleError(
      null,
      Errors.fromException(cause, { context: 'Starting automatic download' })
    ));
  }

  async function init() {
    cfg = await NexusExt.Storage.getSettings();
    NXTK.setForceEnglish(cfg.ForceEnglish);
    NXTK.setDebugLogging?.(cfg.DebugLogs);
    syncNativeFallbackState();
    if (!listenersAttached) {
      attachClickInterceptor();
      interceptRequirementsTab();
      watchStoredSettings();
      listenersAttached = true;
    }
    if (isCloudflareChallengeDocument()) {
      Logger.info('Cloudflare verification page detected; automatic actions are paused.');
      syncSlowDownloadIntercept();
      return;
    }
    syncSlowDownloadIntercept();
    prefetchGameIdFromApi();
    scheduleDomEnhancements();
    startAutoDownload();
    Logger.debug('NNW module initialized');
  }

  async function onNavigate() {
    invalidateDownloadAttempts();
    clearNativeDownloadPassthrough();
    cfg = await NexusExt.Storage.getSettings();
    syncNativeFallbackState();
    cancelArchivedFooterWait?.();
    cancelArchivedFooterWait = null;
    if (isCloudflareChallengeDocument()) {
      syncSlowDownloadIntercept();
      return;
    }
    syncSlowDownloadIntercept();
    prefetchGameIdFromApi();
    scheduleDomEnhancements();
    startAutoDownload();
  }

  function watchStoredSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes?.[NXTK.SETTINGS_KEY]) return;
        updateConfig(changes[NXTK.SETTINGS_KEY].newValue);
      });
    } catch (_) {
    }
  }

  function updateConfig(newCfg) {
    const previousCfg = { ...cfg };
    cfg = { ...(NexusExt.Storage?.DEFAULTS || {}), ...(newCfg || {}) };
    NXTK.setForceEnglish(cfg.ForceEnglish);
    NXTK.setDebugLogging?.(cfg.DebugLogs);

    if (!cfg.AutoCloseTab) cancelScheduledTabClose();
    if (isNativeFallbackActive()) startNativeFallbackIfReady();

    if (!cfg.HidePremiumUpsells && previousCfg.HidePremiumUpsells) {
      resetUpsellBlocker();
    }

    if (!cfg.HandleArchivedFiles && previousCfg.HandleArchivedFiles) {
      resetArchivedFileHandler();
    }

    scheduleDomEnhancements();
  }

  function isActionablePage() {
    return isModPage() || isNativeFallbackActive();
  }

  window.NexusExt.NNW = {
    hrefWantsNmm,
    fileIdFromNode,
    isDismissControl,
    classifyDownloadControl,
    init,
    onNavigate,
    updateConfig,
    getDownloadUrl,
    isActionablePage,
    getGameId,
    getSearchRoots,
    Logger,
    waitForDomSettled,
    parseDownloadURLFromResponse,
    parseNxmDownloadLink,
    refreshAdTimerCookie,
    pickModalHref,
    expandRequirementsSection
  };
})();
