// Checks that a Nexus page still has what the extension finds its way by: the game id, the mod section,
// the download control for a file, the spot the collection deck goes into, and a way to tell whether
// someone is signed in. When Nexus changes its site, one of these is usually the first thing to go, and
// until now that showed only as a feature quietly doing nothing. A check that keeps failing is logged
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

  const DOWNLOAD_CONTROL_SELECTORS = ['#slowDownloadButton', '[data-download-url]'];

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
    return {
      result: check('sign-in', 'sign-in state', false,
        'neither the profile menu nor a log-in control was found'),
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
    isCollectionRoute = deps.isCollectionRoute
  } = {}) {
    const page = pageTypeOf(doc, loc, isCollectionRoute);
    if (!page) return null;
    const base = { page, label: PAGE_LABELS[page] || page, url: navKey(loc) };
    if (isChallengeDocument(doc)) return { ...base, skipped: 'Cloudflare check on screen', checks: [] };

    const checks = [];
    const signIn = signInCheck(doc, auth);
    checks.push(signIn.result);

    if (page === 'collection') {
      let host = null;
      try {
        host = typeof findCollectionHost === 'function' ? findCollectionHost() : null;
      } catch (_) { }
      checks.push(check('deck-spot', 'spot for the collection panel', !!host?.container,
        host?.container ? (host.legacy ? 'classic layout' : 'next-container') : 'findCollectionHost found nothing'));
    }

    if (page === 'mod' || page === 'mod-file') {
      let gameId = '';
      try {
        gameId = String(nnw?.getGameId?.(loc.href) || '');
      } catch (_) { }
      checks.push(check('game-id', 'game id', /^\d+$/.test(gameId), gameId || 'no numeric game id on the page'));
      checks.push(check('mod-section', 'mod section', !!doc.getElementById?.('section'), '#section'));
    }

    if (page === 'mod-file' && !signIn.signedOut) checks.push(downloadControlCheck(doc, loc, nnw));

    return { ...base, skipped: '', checks };
  }

  const failuresOf = (result) => (result?.checks || []).filter((entry) => !entry.ok);

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

  function reportFailures(result, build) {
    const failed = failuresOf(result);
    if (!failed.length) return;
    const signature = `${result.page}:${failed.map((entry) => entry.id).join(',')}`;
    const missing = failed.map((entry) => `${entry.label} (${entry.detail})`).join('; ');
    window.NexusExt.NNW?.Logger?.warn?.(`Nexus page check failed on the ${result.label}: ${missing}`);
    if (alreadyReported(signature)) return;
    globalThis.NXTK?.recordError?.({
      code: 'nexus_page_changed',
      context: `Nexus page check (${result.label})`,
      technicalMessage: `missing: ${missing} | Nexus build: ${build?.id || 'not detected'}`
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
    lastResult: () => lastResult
  };
})();
