(function () {
  'use strict';

  const SETTINGS_KEY = 'nxtk_settings';
  const ERROR_LOG_KEY = 'nxtk_error_log';
  const TOTAL_DOWNLOADS_KEY = 'nxtk_total_downloads';
  const RATING_PROMPT_KEY = 'nxtk_rating_prompted';
  const RATING_STATE_KEY = 'nxtk_rating_state';
  const GITHUB_REPO_URL = 'https://github.com/thomasthanos/nexusmods-bypass';
  const ISSUE_NEW_URL = `${GITHUB_REPO_URL}/issues/new`;
  const REPORT_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new/choose`;
  const TROUBLESHOOTING_URL = `${GITHUB_REPO_URL}#-troubleshooting`;
  // Each store issues its own extension id, so the id is what says where a copy came from —
  // and that is the only listing where its rating can be left. The browser running it says
  // nothing: Edge installs from the Chrome Web Store just as happily as from its own.
  const STORE_LISTINGS = {
    chrome: {
      id: 'chfghiknjhpcncpcjopglefnckckdlpj',
      name: 'Chrome Web Store',
      reviewUrl: 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj/reviews'
    },
    edge: {
      id: 'hcjpcnajmkanhodhpkoinodjbkeolgaa',
      name: 'Edge Add-ons',
      reviewUrl: 'https://microsoftedge.microsoft.com/addons/detail/hcjpcnajmkanhodhpkoinodjbkeolgaa'
    },
    firefox: {
      id: '',
      name: 'Firefox Add-ons',
      reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/nexusmods-bypass/reviews/'
    }
  };

  function getStoreListing() {
    try {
      // The Firefox package is built with this marker; no other package carries it.
      if (chrome.runtime.getManifest().browser_specific_settings?.gecko) return STORE_LISTINGS.firefox;
      const id = chrome.runtime.id;
      for (const listing of Object.values(STORE_LISTINGS)) {
        if (listing.id && listing.id === id) return listing;
      }
    } catch (_) {
    }
    // An unpacked or sideloaded copy has an id of its own, which belongs to no listing.
    return STORE_LISTINGS.chrome;
  }

  function getStoreReviewUrl() {
    return getStoreListing().reviewUrl;
  }

  // Asked at download milestones rather than once and never again, because someone who has
  // used this a thousand times has more reason to say something than someone who has used it
  // twenty-five times. The gaps widen so it never becomes a nag, a dismissal only clears the
  // milestone it was shown for, and following either link ends it for good.
  const RATING_MILESTONES = [25, 120, 500, 1500];
  const RATING_MIN_GAP_MS = 21 * 24 * 60 * 60 * 1000;

  function readRatingState() {
    return new Promise((resolve) => {
      // Anything unreadable resolves as settled, so a storage fault can never nag.
      const settled = { done: true, cleared: 0, askedAt: 0 };
      try {
        if (!chrome?.runtime?.id) {
          resolve(settled);
          return;
        }
        chrome.storage.local.get([RATING_STATE_KEY, RATING_PROMPT_KEY], (result) => {
          if (chrome.runtime.lastError) {
            resolve(settled);
            return;
          }
          const state = result?.[RATING_STATE_KEY];
          if (state && typeof state === 'object') {
            resolve({
              done: state.done === true,
              cleared: Number(state.cleared) || 0,
              askedAt: Number(state.askedAt) || 0
            });
            return;
          }
          // Already asked once under the old rule. That counts as the first milestone, and
          // the gap runs from now, so an upgrade never produces an ask straight away.
          if (result?.[RATING_PROMPT_KEY]) {
            resolve({ done: false, cleared: RATING_MILESTONES[0], askedAt: Date.now() });
            return;
          }
          resolve({ done: false, cleared: 0, askedAt: 0 });
        });
      } catch (_) {
        resolve(settled);
      }
    });
  }

  function writeRatingState(state) {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.storage.local.set({ [RATING_STATE_KEY]: state }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
    }
  }

  // The milestone that has come due, or 0 when there is nothing to ask about.
  function ratingMilestoneDue(total, state) {
    if (!state || state.done) return 0;
    const count = Number(total) || 0;
    let due = 0;
    for (const milestone of RATING_MILESTONES) {
      if (count >= milestone && milestone > state.cleared) due = milestone;
    }
    if (!due) return 0;
    if (state.askedAt && Date.now() - state.askedAt < RATING_MIN_GAP_MS) return 0;
    return due;
  }

  function dueRatingMilestone(total) {
    return readRatingState().then((state) => ratingMilestoneDue(total, state));
  }

  function markRatingAsked(milestone) {
    readRatingState().then((state) => {
      writeRatingState({
        done: state.done,
        cleared: Math.max(state.cleared, Number(milestone) || 0),
        askedAt: Date.now()
      });
    });
  }

  function markRatingSettled() {
    readRatingState().then((state) => {
      writeRatingState({ done: true, cleared: state.cleared, askedAt: Date.now() });
    });
  }
  const MAX_ISSUE_URL_CHARS = 7000;

  const DEFAULTS = {
    AutoStartDownload: true,
    AutoCloseTab: true,
    SkipRequirements: true,
    ShowAlertsOnError: true,
    HandleArchivedFiles: true,
    CloudflareFallback: true,
    HidePremiumUpsells: true,
    DebugLogs: false,
    DownloadFolder: 'NexusMods',
    CloseTabDelay: 3000,
    RequestTimeout: 30000,
    NDC_pauseBetweenDownload: 5,
    NDC_downloadSpeed: 3.2,
    ForceEnglish: false,
    NDC_downloadMethod: 0,
    WabbajackImport: false
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const SENSITIVE_PARAM_NAMES = [
    'key',
    'expires',
    'user_id',
    'token',
    'access_token',
    'refresh_token',
    'auth',
    'authorization',
    'session',
    'session_id',
    'signature',
    'api_key',
    'download_key',
    'code',
    'state',
    'password',
    'cookie',
  ];
  const REDACTED = '[redacted]';
  const SENSITIVE_NAME_GROUP = SENSITIVE_PARAM_NAMES
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');

  // "code" and "state" are ordinary words in a log line; as keys the stricter rules still redact them.
  const AMBIGUOUS_PARAM_NAMES = new Set(['code', 'state']);
  const LOOSE_SENSITIVE_NAME_GROUP = SENSITIVE_PARAM_NAMES
    .filter((name) => !AMBIGUOUS_PARAM_NAMES.has(name))
    .sort((a, b) => b.length - a.length)
    .join('|');

  const SENSITIVE_PATTERNS = [
    new RegExp('\\b(' + SENSITIVE_NAME_GROUP + ')(=|%3D)([^&\\s"\'<>]+)', 'gi'),
    new RegExp('(["\'])(' + SENSITIVE_NAME_GROUP + ')\\1(\\s*:\\s*)(["\'])([^"\']*)\\4', 'gi'),
    new RegExp('\\b(' + LOOSE_SENSITIVE_NAME_GROUP + ')(\\s*:\\s*)([^,;}"\'<>\\r\\n]+)', 'gi'),
  ];

  function redactSensitiveValues(value) {
    let text = String(value ?? '');
    if (!text) return text;
    text = text.replace(SENSITIVE_PATTERNS[0], (_m, name, sep) => name + sep + REDACTED);
    text = text.replace(SENSITIVE_PATTERNS[1], (_m, q1, name, sep, q2) => q1 + name + q1 + sep + q2 + REDACTED + q2);
    text = text.replace(SENSITIVE_PATTERNS[2], (_m, name, sep) => name + sep + REDACTED);
    return text;
  }

  const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;
  const EXTENSION_ORIGIN_PATTERN = /(?:chrome|moz|safari-web|ms-browser)-extension:\/\/[a-z0-9._-]+\//gi;

  function sanitizeUrlForReport(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    if (!URL_SHAPE.test(raw)) return redactSensitiveValues(raw.split(/[?#]/)[0]).slice(0, 160);
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'nxm:') {
        return 'nxm://' + parsed.hostname + parsed.pathname + ' (query removed)';
      }
      const fileId = parsed.searchParams.get('file_id');
      const base = parsed.protocol + '//' + parsed.host + parsed.pathname;
      return base + (fileId && /^\d{1,12}$/.test(fileId) ? '?file_id=' + fileId : '');
    } catch (_) {
      return redactSensitiveValues(raw.split(/[?#]/)[0]).slice(0, 160);
    }
  }

  // Remove credentials and query secrets before diagnostics are shared.
  function sanitizeDiagnosticText(value, maxLength = 1500) {
    let text = String(value ?? '');
    if (!text) return text;
    text = text.replace(EXTENSION_ORIGIN_PATTERN, 'ext://');
    text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrlForReport(match));
    text = redactSensitiveValues(text);
    return text.slice(0, maxLength);
  }

  const DOWNLOAD_METHOD_VORTEX = 0;
  const MAX_DOWNLOAD_URL_CHARS = 2048;
  const NEXUS_SITE_HOSTS = ['nexusmods.com'];
  const NEXUS_FILE_HOSTS = ['nexusmods.com', 'nexus-cdn.com'];

  function normalizeHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host.endsWith('.') ? host.slice(0, -1) : host;
  }

  function hostMatches(hostname, apexList) {
    const host = normalizeHostname(hostname);
    return apexList.some((apex) => host === apex || host.endsWith('.' + apex));
  }

  function validateDownloadTarget(url, { method = DOWNLOAD_METHOD_VORTEX } = {}) {
    const raw = String(url ?? '').trim();
    if (!raw) return { ok: false, detail: 'empty' };
    if (raw.length > MAX_DOWNLOAD_URL_CHARS) return { ok: false, detail: 'too-long' };

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return { ok: false, detail: 'not-a-url' };
    }

    if (parsed.username || parsed.password) return { ok: false, detail: 'embedded-credentials' };

    if (method === DOWNLOAD_METHOD_VORTEX) {
      if (parsed.protocol !== 'nxm:') return { ok: false, detail: 'bad-protocol:' + parsed.protocol.replace(':', '') };
      const missing = ['key', 'expires', 'user_id'].filter((name) => !parsed.searchParams.get(name));
      if (missing.length) return { ok: false, detail: 'missing-nxm-params:' + missing.join(',') };
      return { ok: true, url: raw, hostname: normalizeHostname(parsed.hostname) };
    }

    if (parsed.protocol !== 'https:') return { ok: false, detail: 'bad-protocol:' + parsed.protocol.replace(':', '') };
    if (!hostMatches(parsed.hostname, NEXUS_FILE_HOSTS)) {
      return { ok: false, detail: 'host-not-allowed:' + normalizeHostname(parsed.hostname) };
    }
    return { ok: true, url: raw, hostname: normalizeHostname(parsed.hostname) };
  }

  function isSafeNexusPageUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw || raw.length > MAX_DOWNLOAD_URL_CHARS) return false;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.username || parsed.password) return false;
      return hostMatches(parsed.hostname, NEXUS_SITE_HOSTS);
    } catch (_) {
      return false;
    }
  }

  const TRIGGER_LABELS = {
    manual: 'manual (you clicked a download button)',
    automatic: 'automatic (started by the extension)',
    collection: 'collection run (queued by the download deck)',
    fallback: 'Cloudflare fallback (handed back to the native Nexus button)',
    popup: 'popup action'
  };

  const METHOD_LABELS = {
    vortex: 'Vortex handoff (nxm:)',
    browser: 'browser download',
    native: 'native Nexus control'
  };

  let activity = {};

  const MAX_TRAIL_ENTRIES = 8;
  const MAX_TRAIL_CHARS = 90;
  const activityTrail = [];

  function trailText(args) {
    const parts = (Array.isArray(args) ? args : [args]).map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      if (value && typeof value === 'object') return String(value.code || value.message || '');
      return String(value ?? '');
    });
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  // The console setting never reaches the person reading a report; this does.
  function noteActivity(level, args) {
    const text = sanitizeDiagnosticText(trailText(args), MAX_TRAIL_CHARS);
    if (!text) return;
    activityTrail.push({ at: Date.now(), level: String(level || 'info'), text });
    while (activityTrail.length > MAX_TRAIL_ENTRIES) activityTrail.shift();
  }

  function describeActivityTrail() {
    if (!activityTrail.length) return [];
    const lines = ['──────── Leading up to it ────────'];
    for (const entry of activityTrail) {
      const time = new Date(entry.at).toLocaleTimeString('en-GB');
      lines.push(`${time} ${entry.level.padEnd(5)} ${entry.text}`);
    }
    return lines;
  }

  function setActivity(patch) {
    if (!patch || typeof patch !== 'object') return;
    activity = { ...activity, ...patch, at: Date.now() };
  }

  function describeActivity(source = activity) {
    if (!source || !source.trigger) return '';
    const parts = [TRIGGER_LABELS[source.trigger] || String(source.trigger)];
    if (source.method) parts.push(METHOD_LABELS[source.method] || String(source.method));
    if (source.fileId) parts.push('file ' + String(source.fileId).slice(0, 12));
    if (source.attempt) parts.push('attempt ' + source.attempt);
    if (source.autoClose === true) parts.push('tab auto-close armed');
    if (source.autoClose === false) parts.push('tab auto-close off');
    if (source.fallbackActive) parts.push('after a Cloudflare fallback');
    return parts.join(' · ');
  }

  function recordError(error) {
    const entry = {
      at: Date.now(),
      code: String(error?.code || 'request_failed'),
      status: Number.isInteger(error?.status) ? error.status : null,
      context: sanitizeDiagnosticText(error?.context, 300),
      userMessage: String(error?.userMessage || ''),
      technicalMessage: sanitizeDiagnosticText(error?.technicalMessage, 600),
      stack: sanitizeDiagnosticText(error?.stack, 1500),
      url: typeof location !== 'undefined' && location?.href ? sanitizeUrlForReport(location.href) : ''
    };
    const action = describeActivity();
    if (action) entry.action = sanitizeDiagnosticText(action, 200);
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'ERROR_LOG_APPEND', payload: { entry } }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
    }
  }

  function getErrorLog() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve([]);
          return;
        }
        chrome.storage.local.get(ERROR_LOG_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(Array.isArray(result?.[ERROR_LOG_KEY]) ? result[ERROR_LOG_KEY] : []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  function getStoredSettings() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve({ ...DEFAULTS });
          return;
        }
        chrome.storage.local.get(SETTINGS_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULTS });
            return;
          }
          resolve({ ...DEFAULTS, ...(result?.[SETTINGS_KEY] || {}) });
        });
      } catch (_) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function shortHash(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = (((hash << 5) + hash) ^ text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36).padStart(7, '0').slice(-7);
  }

  // Only the file and position are kept, so the same fault gives the same ID everywhere.
  function errorFingerprint(error) {
    if (!error) return '';
    const frame = String(error.stack || '')
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.match(/([\w.-]+\.js):(\d+):(\d+)/))
      .find(Boolean);
    return shortHash([
      String(error.code || ''),
      String(error.context || ''),
      frame ? `${frame[1]}:${frame[2]}` : ''
    ].join('|'));
  }

  function relativeTime(at) {
    const elapsed = Date.now() - (Number(at) || 0);
    if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
    const seconds = Math.round(elapsed / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  }

  function entryRepeatCount(entry) {
    return Math.max(1, Number(entry?.count) || 1);
  }

  const DIGEST_CODE_LIMIT = 8;

  function describeErrorDigest(errors) {
    if (!errors.length) return [];
    const totals = new Map();
    for (const entry of errors) {
      const code = String(entry.code || 'request_failed');
      const seen = totals.get(code) || { code, total: 0, lastAt: 0 };
      seen.total += entryRepeatCount(entry);
      seen.lastAt = Math.max(seen.lastAt, Number(entry.lastAt || entry.at) || 0);
      totals.set(code, seen);
    }
    const ranked = [...totals.values()].sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);
    const lines = ['──────── What went wrong ────────'];
    for (const item of ranked.slice(0, DIGEST_CODE_LIMIT)) {
      lines.push(`${String(item.total).padStart(4)} × ${item.code.padEnd(20)} last ${relativeTime(item.lastAt)}`);
    }
    if (ranked.length > DIGEST_CODE_LIMIT) {
      lines.push(`     … and ${ranked.length - DIGEST_CODE_LIMIT} other code(s)`);
    }
    return lines;
  }

  function describeLoggedError(entry) {
    const lines = [];
    const status = entry.status ? ` (HTTP ${entry.status})` : '';
    const repeats = entryRepeatCount(entry);
    lines.push(`[${new Date(entry.at).toLocaleString('en-GB')}] ${entry.code}${status}${repeats > 1 ? ` ×${repeats}` : ''}`);
    if (repeats > 1 && entry.lastAt) {
      lines.push(`    last:    ${new Date(entry.lastAt).toLocaleString('en-GB')} (${relativeTime(entry.lastAt)})`);
    }
    if (entry.action) lines.push(`    action:  ${sanitizeDiagnosticText(entry.action, 200)}`);
    if (entry.context) lines.push(`    context: ${sanitizeDiagnosticText(entry.context, 300)}`);
    if (entry.userMessage) lines.push(`    ${sanitizeDiagnosticText(entry.userMessage, 300)}`);
    if (entry.technicalMessage) lines.push(`    technical: ${sanitizeDiagnosticText(entry.technicalMessage, 600)}`);
    if (entry.stack) {
      lines.push(`    stack: ${sanitizeDiagnosticText(entry.stack, 1500).split('\n').join('\n           ')}`);
    }
    if (entry.url) lines.push(`    page: ${sanitizeUrlForReport(entry.url)}`);
    return lines;
  }

  const GREASE_BRAND = /not.*a.*brand/i;

  const UA_BROWSERS = [
    [/\bEdg(?:e|A|iOS)?\/([\d.]+)/, 'Microsoft Edge'],
    [/\bOPR\/([\d.]+)/, 'Opera'],
    [/\bVivaldi\/([\d.]+)/, 'Vivaldi'],
    [/\bFirefox\/([\d.]+)/, 'Firefox'],
    [/\bChrome\/([\d.]+)/, 'Chrome'],
    [/\bVersion\/([\d.]+).*\bSafari\//, 'Safari']
  ];

  function parseUserAgent(ua) {
    let browser = '';
    for (const [pattern, name] of UA_BROWSERS) {
      const hit = ua.match(pattern);
      if (hit) { browser = `${name} ${hit[1]}`; break; }
    }
    let os = '';
    let hit;
    if ((hit = ua.match(/Windows NT ([\d.]+)/))) {
      os = hit[1] === '10.0' ? 'Windows 10 or 11' : `Windows NT ${hit[1]}`;
    } else if ((hit = ua.match(/Mac OS X ([\d_.]+)/))) {
      os = `macOS ${hit[1].replace(/_/g, '.')}`;
    } else if ((hit = ua.match(/Android ([\d.]+)/))) {
      os = `Android ${hit[1]}`;
    } else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux|X11/.test(ua)) os = 'Linux';
    return { browser, os };
  }

  function describePlatform(platform, version) {
    if (!platform) return '';
    if (!version) return platform;
    if (platform !== 'Windows') return `${platform} ${version}`;
    const major = parseInt(String(version).split('.')[0], 10);
    if (!Number.isFinite(major)) return 'Windows';
    if (major >= 13) return `Windows 11 (${version})`;
    if (major >= 1) return `Windows 10 (${version})`;
    return `Windows 8.1 or older (${version})`;
  }

  async function describeBrowser() {
    if (typeof navigator === 'undefined') return { browser: '(unavailable)', ua: '' };
    const ua = String(navigator.userAgent || '');
    const parsed = parseUserAgent(ua);
    const out = { browser: parsed.browser, os: parsed.os, cpu: '', ua };

    const uad = navigator.userAgentData;
    if (!uad) return out;

    let hints = {};
    try {
      hints = await Promise.race([
        uad.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']),
        new Promise((resolve) => setTimeout(resolve, 500, null))
      ]) || {};
    } catch (_) { }

    const brands = (hints.fullVersionList || uad.brands || [])
      .filter((entry) => entry?.brand && !GREASE_BRAND.test(entry.brand));
    const product = brands.find((entry) => entry.brand !== 'Chromium') || brands[0];
    if (product) {
      out.browser = `${product.brand} ${product.version}`;
      const core = brands.find((entry) => entry.brand === 'Chromium');
      if (core && core.version !== product.version) out.browser += ` (Chromium ${core.version})`;
    }

    const platform = describePlatform(uad.platform, hints.platformVersion);
    if (platform) out.os = platform;
    if (hints.architecture) {
      out.cpu = hints.architecture + (hints.bitness ? ` ${hints.bitness}-bit` : '');
    }
    if (uad.mobile) out.cpu = out.cpu ? `${out.cpu}, mobile` : 'mobile';
    return out;
  }

  async function describeReportHeader(manifest, { includeUserAgent = true } = {}) {
    const { browser, os, cpu, ua } = await cachedBrowser();
    const lines = [
      `Date:      ${new Date().toISOString()} (local: ${new Date().toLocaleString('en-GB')})`,
      `Extension: ${manifest.name} v${manifest.version}`,
      `Browser:   ${browser || '(unrecognized)'}`
    ];
    if (os) lines.push(`OS:        ${os}${cpu ? `, ${cpu}` : ''}`);

    let language = typeof navigator !== 'undefined' ? navigator.language || '' : '';
    try {
      const ui = chrome.i18n.getUILanguage();
      if (ui) language = language && ui !== language ? `${language} (UI: ${ui})` : ui;
    } catch (_) { }
    lines.push(`Language:  ${language || '(unknown)'}`);

    if (typeof location !== 'undefined' && location?.href) {
      lines.push(`Page:      ${sanitizeUrlForReport(location.href)}`);
    }
    if (includeUserAgent && ua) lines.push(`UA:        ${ua}`);
    return lines;
  }

  function describeCurrentError(currentError, stackLimit = 1500) {
    const lines = ['──────── Current error ────────'];
    lines.push(`Code:      ${currentError.code || 'request_failed'}`);
    const currentAction = describeActivity(currentError.action ? { trigger: currentError.action } : activity);
    if (currentAction) lines.push(`Action:    ${currentAction}`);
    if (Number.isInteger(currentError.status)) lines.push(`HTTP:      ${currentError.status}`);
    if (currentError.context) lines.push(`Context:   ${sanitizeDiagnosticText(currentError.context, 300)}`);
    lines.push(`Message:   ${sanitizeDiagnosticText(currentError.userMessage, 300) || '(none)'}`);
    if (currentError.recovery) lines.push(`Recovery:  ${sanitizeDiagnosticText(currentError.recovery, 300)}`);
    if (currentError.technicalMessage) {
      lines.push(`Technical: ${sanitizeDiagnosticText(currentError.technicalMessage, 600)}`);
    }
    if (currentError.stack) {
      lines.push('Stack:');
      sanitizeDiagnosticText(currentError.stack, stackLimit).split('\n').forEach((l) => lines.push(`    ${l}`));
    }
    return lines;
  }

  function describeSettings(cfg) {
    const lines = ['──────── Settings ────────'];
    for (const [key, value] of Object.entries(cfg)) {
      let line = `${key}: ${sanitizeDiagnosticText(value, 120)}`;
      if (key === 'DownloadFolder') {
        const folder = String(value ?? '');
        line = `${key}: ${folder ? `(set, ${folder.length} characters)` : '(empty — saves straight to Downloads)'}`;
      }
      if (key === 'NDC_downloadMethod') {
        line += value === 0 ? ' (Vortex)' : value === 1 ? ' (Browser)' : '';
      }
      lines.push(line);
    }
    return lines;
  }

  function describePageContext() {
    try {
      if (typeof document === 'undefined' || typeof location === 'undefined') return null;
      if (!/(^|\.)nexusmods\.com$/.test(location.hostname)) return null;
      const has = (sel) => { try { return !!document.querySelector(sel); } catch (_) { return false; } };
      const newUi = has('.next-container') || has('[data-testid="user-link-avatar"]');
      const signOut = has('a[href*="/auth/sign_out"]');
      const profileMenu = has('#profile-menu, [data-testid="profile-image"]');
      const loginButton = Array.from(document.querySelectorAll('header button, header a, nav button, nav a'))
        .some((el) => /^\s*(?:log|sign)\s*in\s*$/i.test((el.textContent || '').trim()));
      return [
        '──────── Page context ────────',
        `Nexus UI:   ${newUi ? 'new (React / next-container)' : 'classic'}`,
        `Auth hints: sign_out=${signOut ? 'present' : 'absent'}, profile-menu=${profileMenu ? 'present' : 'absent'}, login-button=${loginButton ? 'present' : 'absent'}`
      ];
    } catch (_) {
      return null;
    }
  }

  function readTotalDownloads() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.storage.local.get(TOTAL_DOWNLOADS_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          const value = Number(result?.[TOTAL_DOWNLOADS_KEY]);
          resolve(Number.isFinite(value) ? value : 0);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function readFallbackMarker() {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const raw = sessionStorage.getItem('nxtk_cloudflare_native_fallback');
      if (!raw) return null;
      const marker = JSON.parse(raw);
      const left = Number(marker?.expiresAt) - Date.now();
      return [
        marker?.isNMM ? 'Vortex' : 'browser',
        marker?.fileId ? 'file ' + String(marker.fileId).slice(0, 12) : '',
        marker?.autoStartPending === false ? 'already handed over' : 'still waiting to hand over',
        Number.isFinite(left) ? (left > 0 ? Math.round(left / 1000) + 's left' : 'expired') : ''
      ].filter(Boolean).join(' · ');
    } catch (_) {
      return null;
    }
  }

  async function describeSession(errorCount) {
    const lines = ['──────── Session ────────'];
    const total = await cachedTotalDownloads();
    lines.push(`Downloads counted: ${total === null ? '(unavailable)' : total}`);
    lines.push(`Errors in log:     ${errorCount}`);

    const action = describeActivity();
    lines.push(`Last action:       ${action || '(none recorded this page)'}`);

    const marker = readFallbackMarker();
    lines.push(`Cloudflare fallback: ${marker || 'not active'}`);
    return lines;
  }

  let reportCache = null;

  async function cachedSettings() {
    if (reportCache && 'cfg' in reportCache) return reportCache.cfg;
    const value = await getStoredSettings();
    if (reportCache) reportCache.cfg = value;
    return value;
  }

  async function cachedErrorLog() {
    if (reportCache && 'errors' in reportCache) return reportCache.errors;
    const value = await getErrorLog();
    if (reportCache) reportCache.errors = value;
    return value;
  }

  async function cachedBrowser() {
    if (reportCache && 'browser' in reportCache) return reportCache.browser;
    const value = await describeBrowser();
    if (reportCache) reportCache.browser = value;
    return value;
  }

  async function cachedTotalDownloads() {
    if (reportCache && 'total' in reportCache) return reportCache.total;
    const value = await readTotalDownloads();
    if (reportCache) reportCache.total = value;
    return value;
  }

  async function buildBugReport(currentError = null) {
    const cfg = await cachedSettings();
    const errors = await cachedErrorLog();
    const manifest = chrome.runtime.getManifest();

    const lines = [
      '════════ NEXUSMODS BYPASS — BUG REPORT ════════',
      ...await describeReportHeader(manifest)
    ];

    const fingerprint = errorFingerprint(currentError || errors[errors.length - 1]);
    if (fingerprint) lines.push(`Report ID: ${fingerprint} (same fault, same ID)`);

    const pageContext = describePageContext();
    if (pageContext) {
      lines.push('');
      lines.push(...pageContext);
    }

    if (currentError) {
      lines.push('');
      lines.push(...describeCurrentError(currentError));
    }

    const digest = describeErrorDigest(errors);
    if (digest.length) {
      lines.push('');
      lines.push(...digest);
    }

    const trail = describeActivityTrail();
    if (trail.length) {
      lines.push('');
      lines.push(...trail);
    }

    lines.push('');
    lines.push(...await describeSession(errors.length));

    lines.push('');
    lines.push(...describeSettings(cfg));

    lines.push('');
    lines.push(`──────── Recent errors (${errors.length}) ────────`);
    if (!errors.length) {
      lines.push('(no errors recorded)');
    }
    for (const entry of errors) {
      lines.push('');
      lines.push(...describeLoggedError(entry));
    }

    lines.push('');
    lines.push('════════ END OF REPORT ════════');
    return lines.join('\n');
  }

  async function buildCompactBugReport(currentError = null, { maxEntries = 3, stackChars = 300 } = {}) {
    const cfg = await cachedSettings();
    const errors = await cachedErrorLog();
    const manifest = chrome.runtime.getManifest();
    const recent = (maxEntries > 0 ? errors.slice(-maxEntries) : []).map((entry) => ({
      ...entry,
      stack: stackChars > 0 ? String(entry.stack || '').slice(0, stackChars) : ''
    }));

    const lines = await describeReportHeader(manifest, { includeUserAgent: false });

    const fingerprint = errorFingerprint(currentError || errors[errors.length - 1]);
    if (fingerprint) lines.push(`Report ID: ${fingerprint} (same fault, same ID)`);

    const pageContext = describePageContext();
    if (pageContext) {
      lines.push('');
      lines.push(...pageContext);
    }

    if (currentError) {
      lines.push('');
      lines.push(...describeCurrentError(currentError, 300));
    }

    const digest = describeErrorDigest(errors);
    if (digest.length) {
      lines.push('');
      lines.push(...digest);
    }

    const trail = describeActivityTrail();
    if (trail.length) {
      lines.push('');
      lines.push(...trail);
    }

    lines.push('');
    lines.push(...await describeSession(errors.length));

    lines.push('');
    lines.push(...describeSettings(cfg));

    lines.push('');
    lines.push(`──────── Last ${recent.length} of ${errors.length} logged errors ────────`);
    if (!recent.length) lines.push('(no errors recorded)');
    for (const entry of recent) {
      lines.push('');
      lines.push(...describeLoggedError(entry));
    }
    const dropped = errors.length - recent.length;
    if (dropped > 0) {
      lines.push('');
      lines.push(`(${dropped} older log entr${dropped === 1 ? 'y was' : 'ies were'} left out so this fits the form. The complete report is on the reporter's clipboard.)`);
    }
    return lines.join('\n');
  }

  function buildIssueUrl(title, report, browser = '') {
    const url = new URL(ISSUE_NEW_URL);
    url.searchParams.set('template', 'nexus_bug_report.yml');
    url.searchParams.set('title', title);
    url.searchParams.set('report', report);
    if (browser) url.searchParams.set('browser', browser);
    return url.href;
  }

  const REPORT_REDUCTION_STEPS = [
    { maxEntries: 12, stackChars: 900 },
    { maxEntries: 20, stackChars: 0 },
    { maxEntries: 10, stackChars: 0 },
    { maxEntries: 5, stackChars: 0 },
    { maxEntries: 2, stackChars: 0 },
    { maxEntries: 0, stackChars: 0 }
  ];

  async function buildReportIssueUrl(currentError = null, { fullReport = null } = {}) {
    const ownsCache = !reportCache;
    if (ownsCache) reportCache = {};
    let report = fullReport || '';
    try {
      const title = currentError
        ? `[Bug] ${currentError.code || 'error'} — ${sanitizeDiagnosticText(currentError.userMessage, 60)}`
        : '[Bug] ';
      const { browser } = await cachedBrowser();
      const fits = (candidate) => buildIssueUrl(title, candidate, browser).length <= MAX_ISSUE_URL_CHARS;

      report = fullReport || await buildBugReport(currentError);
      if (fits(report)) return { url: buildIssueUrl(title, report, browser), complete: true, report };

      for (const step of REPORT_REDUCTION_STEPS) {
        const reduced = await buildCompactBugReport(currentError, step);
        if (fits(reduced)) return { url: buildIssueUrl(title, reduced, browser), complete: false, report };
      }

      return { url: buildIssueUrl(title, '', browser), complete: false, report };
    } catch (_) {
      return { url: REPORT_ISSUE_URL, complete: false, report };
    } finally {
      if (ownsCache) reportCache = null;
    }
  }

  function bumpTotalDownloads() {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'TOTAL_DOWNLOADS_INCREMENT', payload: {} }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) { }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  let forceEnglish = false;

  function setForceEnglish(value) {
    forceEnglish = !!value;
  }

  try {
    if (chrome?.runtime?.id) {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        if (chrome.runtime.lastError) return;
        const stored = result?.[SETTINGS_KEY];
        if (stored && 'ForceEnglish' in stored) setForceEnglish(stored.ForceEnglish);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes?.[SETTINGS_KEY]) return;
        const next = changes[SETTINGS_KEY].newValue;
        setForceEnglish(next ? next.ForceEnglish : DEFAULTS.ForceEnglish);
      });
    }
  } catch (_) {
  }

  function t(key, substitutions = null, fallback = '') {
    if (forceEnglish) return fallback;
    try {
      const message = chrome.i18n.getMessage(key, substitutions || undefined);
      if (message) return message;
    } catch (_) {
    }
    return fallback;
  }

  function tPlural(baseKey, count, fallback = '', substitutions = null) {
    const n = Number(count) || 0;
    const args = substitutions || [String(n)];
    let category = 'other';
    try {
      const locale = chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : 'en';
      category = new Intl.PluralRules(locale).select(n);
    } catch (_) {
      category = 'other';
    }
    return t(`${baseKey}_${category}`, args, '')
      || t(`${baseKey}_other`, args, '')
      || fallback;
  }

  const I18N_ATTRIBUTES = [
    ['[data-i18n-title]', 'i18nTitle', 'title'],
    ['[data-i18n-aria-label]', 'i18nAriaLabel', 'aria-label'],
    ['[data-i18n-placeholder]', 'i18nPlaceholder', 'placeholder']
  ];

  const bakedText = new WeakMap();
  const bakedAttrs = new WeakMap();

  function applyI18nTo(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    try {
      root.querySelectorAll('[data-i18n]').forEach((el) => {
        if (!bakedText.has(el)) bakedText.set(el, el.textContent);
        if (forceEnglish) {
          el.textContent = bakedText.get(el);
          return;
        }
        const message = t(el.dataset.i18n);
        if (message) el.textContent = message;
      });
      for (const [selector, datasetKey, attribute] of I18N_ATTRIBUTES) {
        root.querySelectorAll(selector).forEach((el) => {
          let saved = bakedAttrs.get(el);
          if (!saved) bakedAttrs.set(el, (saved = {}));
          if (!(attribute in saved)) saved[attribute] = el.getAttribute(attribute);
          if (forceEnglish) {
            if (saved[attribute] != null) el.setAttribute(attribute, saved[attribute]);
            return;
          }
          const message = t(el.dataset[datasetKey]);
          if (message) el.setAttribute(attribute, message);
        });
      }
    } catch (_) {
    }
  }

  globalThis.NXTK = {
    SETTINGS_KEY,
    TOTAL_DOWNLOADS_KEY,
    RATING_PROMPT_KEY,
    GITHUB_REPO_URL,
    ISSUE_NEW_URL,
    REPORT_ISSUE_URL,
    TROUBLESHOOTING_URL,
    getStoreReviewUrl,
    getStoreListing,
    dueRatingMilestone,
    ratingMilestoneDue,
    markRatingAsked,
    markRatingSettled,
    RATING_MILESTONES,
    DEFAULTS,
    escapeHtml,
    sanitizeUrlForReport,
    sanitizeDiagnosticText,
    validateDownloadTarget,
    isSafeNexusPageUrl,
    recordError,
    setActivity,
    noteActivity,
    describeActivity,
    buildBugReport,
    buildReportIssueUrl,
    bumpTotalDownloads,
    copyText,
    t,
    tPlural,
    setForceEnglish,
    applyI18nTo
  };
})();
