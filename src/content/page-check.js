// Checks that a Nexus page has the game id, rendered mod content, download controls and a spot for the
// collection deck. Sign-in evidence is included when available; missing account controls are unknown.
// When Nexus changes its site, a check that keeps failing is logged
// once per tab, named in the console, and shown in the bug report beside the Nexus build it happened on.
window.NexusExt = window.NexusExt || {};

(function () {
  'use strict';

  const SETTLE_MS = 3000;
  const RECHECK_MS = 6000;
  const BUILD_KEY = 'nxtk_nexus_build';
  const REPORTED_KEY = 'nxtk_page_check_reported';
  const MAX_REPORTED = 20;

  const PAGE_LABELS = {
    collection: 'collection page',
    'mod-file': 'file download page',
    mod: 'mod page',
    'mod-notice': 'mod notice page (removed, hidden or not found)'
  };

  const DOWNLOAD_CONTROL_SELECTORS = (globalThis.NexusSelectors?.SELECTORS?.downloadControl
    || ['#slowDownloadButton', '[data-download-url]']).filter((selector) => selector !== 'mod-file-download');

  let deps = {};
  let runToken = 0;
  let lastResult = null;
  let buildRecord = null;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const navKey = (loc = location) => loc.origin + loc.pathname + loc.search;

  function configure(next) {
    deps = { ...deps, ...(next || {}) };
  }

  function pageTypeOf(doc, loc, isCollectionRoute) {
    const path = String(loc?.pathname || '');
    if (typeof isCollectionRoute === 'function' && isCollectionRoute(path)) return 'collection';
    if (!/^\/[^/]+\/mods\/\d+(?:\/|$)/i.test(path)) return '';
    const notice = doc.querySelector?.('h3[id^="Notice"][id$="-title"]');
    if (notice && !doc.getElementById?.('section')) return 'mod-notice';
    let fileId = '';
    try {
      fileId = new URLSearchParams(loc.search || '').get('file_id') || '';
    } catch (_) { }
    return /^\d+$/.test(fileId) ? 'mod-file' : 'mod';
  }

  function isChallengeDocument(doc) {
    try {
      if (doc.querySelector?.('#challenge-form, .cf-chl-interstitial, #cf-browser-verification')) return true;
      return /^just a moment/i.test(String(doc.title || '').trim());
    } catch (_) {
      return false;
    }
  }

  function check(id, label, ok, detail = '') {
    return { id, label, ok: !!ok, detail: String(detail || '') };
  }

  function signInCheck(doc, auth) {
    try {
      if (auth?.isSignedIn?.(doc)) return { result: check('sign-in', 'sign-in state', true, 'signed in'), signedOut: false };
      if (auth?.getDocumentLoginError?.(doc)) {
        return { result: check('sign-in', 'sign-in state', true, 'signed out'), signedOut: true };
      }
    } catch (_) { }
    // Account controls can be lazy-rendered or hidden by the layout. Their absence proves neither
    // a signed-in session nor a broken page. Authentication remains the request's responsibility.
    return {
      result: check('sign-in', 'sign-in state', true, 'unknown (account controls not rendered)'),
      signedOut: false
    };
  }

  function downloadControlCheck(doc, loc, nnw) {
    let fileId = '';
    try {
      fileId = new URLSearchParams(loc.search || '').get('file_id') || '';
    } catch (_) { }
    const roots = typeof nnw?.getSearchRoots === 'function' ? nnw.getSearchRoots(doc) : [doc];
    const selectors = [`mod-file-download[file-id="${fileId}"]`, ...DOWNLOAD_CONTROL_SELECTORS];
    for (const root of roots) {
      for (const selector of selectors) {
        try {
          if (root.querySelector?.(selector)) return check('download-control', 'download control for this file', true, selector);
        } catch (_) { }
      }
      // Current Nexus components carry the file as JSON rather than a file-id attribute.
      for (const host of root.querySelectorAll?.('mod-file-download, mod-download-buttons, mod-download-modal') || []) {
        if (nnw?.fileIdFromNode?.(host) === fileId) {
          return check('download-control', 'download control for this file', true, `${host.tagName.toLowerCase()} (file data)`);
        }
      }
    }
    return check('download-control', 'download control for this file', false,
      `none of ${selectors.join(', ')}`);
  }

  // The checks for one page as it is now. Everything it reads is passed in, so it can be run on any
  // document; the defaults are the live page and the modules the content scripts loaded.
  function runChecks({
    doc = document,
    loc = location,
    auth = window.NexusExt.Auth,
    nnw = window.NexusExt.NNW,
    findCollectionHost = deps.findCollectionHost,
    collectionMountPending = deps.collectionMountPending,
    isCollectionRoute = deps.isCollectionRoute
  } = {}) {
    const page = pageTypeOf(doc, loc, isCollectionRoute);
    if (!page) return null;
    const base = { page, label: PAGE_LABELS[page] || page, url: navKey(loc) };
    if (isChallengeDocument(doc)) return { ...base, skipped: 'Cloudflare check on screen', checks: [] };
    if (doc.readyState === 'loading' || doc.querySelector?.('main[aria-busy="true"], #mainContent[aria-busy="true"]')) {
      return { ...base, skipped: 'Nexus page still loading', checks: [] };
    }

    const checks = [];
    const signIn = signInCheck(doc, auth);
    checks.push(signIn.result);

    if (page === 'collection') {
      let host = null;
      try {
        host = typeof findCollectionHost === 'function' ? findCollectionHost() : null;
      } catch (_) { }
      const mounted = !!doc.getElementById?.('nxtk-control-deck');
      if (!host?.container && !mounted && collectionMountPending?.()) {
        return { ...base, skipped: 'Collection panel still loading', checks: [] };
      }
      checks.push(check('deck-spot', 'mount point for download panel', !!host?.container || mounted,
        mounted ? 'panel mounted' : host?.container ? (host.legacy ? 'classic layout' : host.layout || 'next-container') : 'no supported content root after mount retries'));
    }

    if (page === 'mod' || page === 'mod-file') {
      let gameId = '';
      try {
        gameId = String(nnw?.getGameId?.(loc.href) || '');
      } catch (_) { }
      checks.push(check('game-id', 'game id', /^\d+$/.test(gameId), gameId || 'no numeric game id on the page'));
      // The live download components work without the legacy #section wrapper.
      const content = doc.getElementById?.('section') || doc.querySelector?.('mod-file-download, mod-download-buttons, #mainContent h1, main h1');
      checks.push(check('mod-section', 'page content region', !!content, '#section or rendered page content'));
    }

    if (page === 'mod-file' && !signIn.signedOut) checks.push(downloadControlCheck(doc, loc, nnw));

    return { ...base, skipped: '', checks };
  }

  const failuresOf = (result) => (result?.checks || []).filter((entry) => !entry.ok);

  // Nexus can have a complete, quiet document containing its header/modals before the mod renders.
  // This is only evidence to wait once more, never evidence that a persistently missing page is OK.
  function hasOnlyModShell(result, doc = document) {
    const failed = failuresOf(result);
    return result?.page === 'mod' && failed.length === 1 && failed[0].id === 'mod-section'
      && /nexus/i.test(String(doc.title || ''))
      && !doc.querySelector?.('main, h1')
      && !!doc.querySelector?.('quick-search, create-draft-mod-modal, upload-modal-button');
  }

  // The Nexus deploy the page came from, when the page says. Next.js pages name their build; failing
  // that, the set of hashed script chunks changes with every deploy, so a digest of it stands in.
  function detectBuild(doc = document) {
    try {
      const data = doc.getElementById?.('__NEXT_DATA__');
      const id = data ? JSON.parse(data.textContent || '{}')?.buildId : '';
      if (/^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''))) return String(id);
    } catch (_) { }
    const sources = Array.from(doc.querySelectorAll?.('script[src]') || [], (script) => String(script.src || script.getAttribute?.('src') || ''));
    for (const src of sources) {
      const match = /\/_next\/static\/([A-Za-z0-9_-]{4,64})\/_(?:buildManifest|ssgManifest)\.js/.exec(src);
      if (match) return match[1];
    }
    const chunks = sources
      .map((src) => /\/_next\/static\/chunks\/([^?#]+)/.exec(src)?.[1] || '')
      .filter(Boolean)
      .sort();
    if (!chunks.length) return '';
    let hash = 5381;
    for (const char of chunks.join('|')) hash = (((hash << 5) + hash) ^ char.charCodeAt(0)) >>> 0;
    return `chunks-${hash.toString(36)}`;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (items) => {
          void chrome.runtime.lastError;
          resolve(items?.[key] ?? null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    try {
      chrome.storage.local.set({ [key]: value }, () => void chrome.runtime.lastError);
    } catch (_) { }
  }

  // Kept across pages, so a report can say when Nexus last deployed and what it ran before.
  async function rememberBuild(id, now = Date.now()) {
    const stored = await storageGet(BUILD_KEY);
    if (!id) return stored;
    if (stored?.id === id) return stored;
    const record = {
      id,
      since: now,
      previous: stored?.id ? { id: stored.id, since: stored.since, until: now } : null
    };
    storageSet(BUILD_KEY, record);
    if (stored?.id) window.NexusExt.NNW?.Logger?.info?.(`Nexus site build changed: ${stored.id} -> ${id}`);
    return record;
  }

  function alreadyReported(signature) {
    try {
      const seen = JSON.parse(sessionStorage.getItem(REPORTED_KEY) || '[]');
      if (Array.isArray(seen) && seen.includes(signature)) return true;
      const next = [...(Array.isArray(seen) ? seen : []), signature].slice(-MAX_REPORTED);
      sessionStorage.setItem(REPORTED_KEY, JSON.stringify(next));
    } catch (_) { }
    return false;
  }

  // Checks whose loss turns a feature off. These are told to the user once per tab, so a Nexus site
  // update shows up as a clear notice instead of a button that quietly does nothing.
  const USER_VISIBLE_CHECKS = new Set(['download-control', 'deck-spot']);

  function notifyDegraded(result, failed) {
    if (!failed.some((entry) => USER_VISIBLE_CHECKS.has(entry.id))) return;
    try {
      window.NexusExt.UI?.showNotice?.({
        title: globalThis.NXTK?.t?.('noticePageChangedTitle', null, 'Nexus Mods changed this page') || 'Nexus Mods changed this page',
        detail: globalThis.NXTK?.t?.('noticePageChangedDetail', null,
          'Some NexusMods Bypass features may not work here until the extension is updated. Nexus\'s own buttons still work. You can send details with "Report a bug" in the extension popup.')
          || ''
      });
    } catch (_) { }
  }

  // Legitimate states in which the usual page parts are hidden or not rendered: a download modal
  // over the page, or Nexus's adult-content gate. A check failing then is not a site change.
  const ADULT_GATE_TEXT = /(contains|includes) adult content|adult content (is )?(hidden|blocked|filter)|show adult content|confirm (that )?you are (over )?18|you must be 18/i;
  const FILE_MISSING_TEXT = /object not found|file (was |has been )?(not found|removed|deleted|hidden)|this file (is|has been) (no longer )?(available|removed|deleted|hidden)/i;
  // Next.js's own 404 page, which a mod route can be served as.
  const PAGE_MISSING_TEXT = /this page could not be found|^\s*404\b/i;
  // A document with no Nexus app in it at all and a title that is not Nexus's is somebody else's page
  // served at a mod's address: Cloudflare's check or block page, or a bare "429 Too Many Requests" or
  // "503" page. Those were reported as "Nexus page may have changed".
  function isForeignDocument(doc) {
    const scripts = Array.from(doc.querySelectorAll?.('script[src]') || [], (script) => String(script.src || script.getAttribute?.('src') || ''));
    const nexusApp = doc.getElementById?.('__next') || doc.getElementById?.('section') || scripts.some((src) => src.includes('/_next/'));
    const title = String(doc.title || '').trim();
    return !nexusApp && !!title && !/nexus/i.test(title);
  }

  function pageVariant(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc?.querySelector) return '';
    try {
      if (doc.querySelector('download-modal[open], dialog[open], [role="dialog"][aria-modal="true"]')) return 'modal open';
      if (doc.querySelector('[data-e2e-id*="adult" i], [class*="adult-gate" i], [id*="adult-content" i]')) return 'adult content gate';
      const main = doc.querySelector('main') || doc.body;
      const text = String(main?.innerText || main?.textContent || '').slice(0, 20000);
      if (ADULT_GATE_TEXT.test(text)) return 'adult content gate';
      if (FILE_MISSING_TEXT.test(text) || /not\s*found/i.test(doc.title || '')) return 'file not found';
      if (PAGE_MISSING_TEXT.test(text) || PAGE_MISSING_TEXT.test(doc.title || '')) return 'page not found';
      if (isForeignDocument(doc)) return 'not a Nexus page';
    } catch (_) { }
    return '';
  }

  // What a page that failed a check does have, as structure only: the kind of app, whether it has the
  // usual landmarks, which custom elements and test ids it renders, roughly how much text, and the
  // kind of title. Never the text, the title or an id. "missing: page content region" alone could not
  // tell a new Nexus layout from an error page or a page that had not finished rendering.
  const MAX_SHAPE_NODES = 5000;
  const howMany = (count) => (count === 0 ? 'none' : count === 1 ? 'one' : 'several');
  function pageShape(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc?.querySelectorAll) return '';
    try {
      const scripts = Array.from(doc.querySelectorAll('script[src]') || [], (script) => String(script.src || script.getAttribute?.('src') || ''));
      const app = doc.getElementById?.('__next') || scripts.some((src) => src.includes('/_next/')) ? 'next app'
        : doc.getElementById?.('section') ? 'legacy page' : 'unknown app';
      const components = new Set();
      const nodes = doc.body?.getElementsByTagName?.('*') || [];
      for (let i = 0; i < nodes.length && i < MAX_SHAPE_NODES && components.size < 3; i += 1) {
        const tag = String(nodes[i]?.tagName || '').toLowerCase();
        if (tag.includes('-') && !tag.startsWith('nxtk-') && /^[a-z][a-z0-9-]{1,40}$/.test(tag)) components.add(tag);
      }
      const testIds = new Set();
      for (const node of Array.from(doc.querySelectorAll('[data-e2e-id]') || []).slice(0, 200)) {
        const id = String(node.getAttribute?.('data-e2e-id') || '');
        // Fixed hook names only; one with a space or a digit can carry a name or an id.
        if (/^[a-z][a-z-]{1,40}$/i.test(id)) testIds.add(id);
        if (testIds.size >= 3) break;
      }
      const text = String(doc.body?.innerText || doc.body?.textContent || '').trim();
      const title = String(doc.title || '');
      const parts = [
        app,
        `main ${howMany(doc.querySelectorAll('main').length)}`,
        `h1 ${howMany(doc.querySelectorAll('h1').length)}`,
        `components ${components.size ? [...components].join(', ') : 'none'}`,
        `e2e ${testIds.size ? [...testIds].join(', ') : 'none'}`,
        `text ${!text ? 'none' : text.length < 200 ? 'little' : 'some'}`
      ];
      if (/application error|client-side exception|internal server error|something went wrong/i.test(text.slice(0, 2000))) parts.push('next error text');
      parts.push(`title ${!title ? 'none' : /not\s*found|\b404\b/i.test(title) ? 'not found' : /error/i.test(title) ? 'error' : /nexus/i.test(title) ? 'nexus' : 'other'}`);
      return `shape: ${parts.join('; ')}`;
    } catch (_) {
      return '';
    }
  }

  // A file page whose file is gone: offer the mod's Files tab instead of a silent banner.
  let fileMissingShown = false;
  function notifyFileMissing(doc) {
    if (fileMissingShown) return;
    fileMissingShown = true;
    const t = (key, fallback) => globalThis.NXTK?.t?.(key, null, fallback) || fallback;
    let filesUrl = '';
    try {
      const url = new URL(doc?.location?.href || location.href);
      url.search = '?tab=files';
      url.hash = '';
      if (globalThis.NXTK?.isSafeNexusPageUrl?.(url.href) !== false) filesUrl = url.href;
    } catch (_) { }
    window.NexusExt.UI?.showNotice?.({
      id: 'nxtk-file-missing',
      title: t('noticeFileMissingTitle', 'This file is not available'),
      detail: t('noticeFileMissingDetail', 'Nexus says the file does not exist: it was removed or hidden, or the link is wrong. Pick another file on the mod\'s Files tab.'),
      ms: 15000,
      actions: filesUrl ? [{ label: t('btnOpenModFiles', 'Open the Files tab'), href: filesUrl }] : []
    });
  }

  function reportFailures(result, build, doc = (typeof document !== 'undefined' ? document : null)) {
    const failed = failuresOf(result);
    if (!failed.length) return;
    let variant = pageVariant(doc);
    // A file page where Nexus shows one of its notices instead of the download control (sign in,
    // moderation, an archived or unavailable file): Nexus says why, and nothing has changed.
    if (!variant && failed.every((entry) => entry.id === 'download-control')
      && doc?.querySelector?.('[id^="Notice"][id$="-title"]')) variant = 'site notice';
    if (variant === 'file not found') {
      window.NexusExt.NNW?.Logger?.info?.('This file page says the file does not exist (removed, hidden or a wrong link); nothing to download here.');
      notifyFileMissing(doc);
      return;
    }
    if (variant) {
      globalThis.NXTK?.queueDebugEntry?.('debug', `Nexus page check skipped on the ${result.label} (${variant}): ${failed.map((entry) => entry.id).join(', ')}`);
      return;
    }
    const signature = `${result.page}:${failed.map((entry) => entry.id).join(',')}`;
    const missing = failed.map((entry) => `${entry.label} (${entry.detail})`).join('; ');
    // The selector list goes to the report; the log line says what it means.
    window.NexusExt.NNW?.Logger?.warn?.(`Could not find ${failed.map((entry) => entry.label).join(', ')} on the ${result.label}. Nexus may have changed this page; its own buttons still work.`);
    if (alreadyReported(signature)) return;
    notifyDegraded(result, failed);
    const shape = pageShape(doc);
    globalThis.NXTK?.recordError?.({
      code: 'nexus_page_changed',
      context: `Nexus page check (${result.page})`,
      technicalMessage: [`missing: ${missing}`, shape, `Nexus build: ${build?.id || 'not detected'}`].filter(Boolean).join(' | ')
    });
  }

  // Run once the page has had time to render, and again before calling anything missing: Nexus builds
  // much of a page after load, and a check that fires early would report a change that is not there.
  function schedule() {
    const token = ++runToken;
    const key = navKey();
    const stale = () => token !== runToken || navKey() !== key;
    (async () => {
      await wait(SETTLE_MS);
      if (stale()) return;
      await window.NexusExt.NNW?.waitForDomSettled?.().catch?.(() => undefined);
      if (stale()) return;
      let result = runChecks();
      if (failuresOf(result).length) {
        await wait(RECHECK_MS);
        if (stale()) return;
        result = runChecks();
      }
      if (hasOnlyModShell(result)) {
        await wait(RECHECK_MS);
        if (stale()) return;
        await window.NexusExt.NNW?.waitForDomSettled?.().catch?.(() => undefined);
        if (stale()) return;
        result = runChecks();
      }
      buildRecord = await rememberBuild(detectBuild());
      if (stale()) return;
      lastResult = result ? { ...result, at: Date.now() } : null;
      if (result) reportFailures(result, buildRecord);
    })().catch(() => undefined);
  }

  function formatDay(at) {
    const date = new Date(Number(at));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '?';
  }

  function describeBuild(record) {
    if (!record?.id) return 'not detected on this page';
    let line = `${record.id} (seen since ${formatDay(record.since)}`;
    if (record.previous?.id) line += `; before that ${record.previous.id} from ${formatDay(record.previous.since)}`;
    return `${line})`;
  }

  // The report section. Empty when this tab has nothing to say.
  function describe(result = lastResult, record = buildRecord, now = Date.now()) {
    if (!result && !record?.id) return [];
    const lines = ['──────── Nexus page check ────────'];
    if (result) {
      const ago = Math.max(0, Math.round((now - Number(result.at || now)) / 1000));
      lines.push(`Page:   ${result.label} · checked ${ago}s ago`);
      if (result.skipped) lines.push(`Skipped: ${result.skipped}`);
      for (const entry of result.checks || []) {
        lines.push(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`);
      }
    } else {
      lines.push('Page:   not one the extension checks');
    }
    lines.push(`Nexus build: ${describeBuild(record)}`);
    return lines;
  }

  window.NexusExt.PageCheck = {
    configure,
    schedule,
    runChecks,
    detectBuild,
    rememberBuild,
    describe,
    reportFailures,
    pageVariant,
    pageShape,
    lastResult: () => lastResult
  };
})();
