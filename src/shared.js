(function () {
  'use strict';

  const SETTINGS_KEY = 'nxtk_settings';
  const ERROR_LOG_KEY = 'nxtk_error_log';
  const MAX_LOGGED_ERRORS = 50;
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

  const RATING_STAR_PATH = 'M12 2.6l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.7l-5.88 3.01 '
    + '1.12-6.55L2.48 9.52l6.58-.96z';

  // Decoration only: the caller marks the container aria-hidden, and the link text names the store.
  function ratingStarsMarkup(size) {
    const px = Number(size) > 0 ? Math.round(Number(size)) : 14;
    return Array.from({ length: 5 }, () =>
      `<svg viewBox="0 0 24 24" width="${px}" height="${px}"><path d="${RATING_STAR_PATH}"/></svg>`).join('');
  }

  // The popup and the deck ask in the same words, at the same milestones, for the same listing.
  async function prepareRatingPrompt() {
    const total = await readTotalDownloads();
    const milestone = await dueRatingMilestone(total);
    if (!milestone) return null;
    const listing = getStoreListing();
    return {
      milestone,
      listing,
      copy: t('ratingPromptCount', [String(milestone)],
        `${milestone} files downloaded. A short review helps other modders find this.`),
      reviewText: t('ratingCta', [listing.name], `Rate on ${listing.name}`),
      starText: t('ratingStarCta', null, 'Star on GitHub'),
      starUrl: GITHUB_REPO_URL
    };
  }

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

  // Bounds every writer applies, so a value typed into a field never reaches storage out of range.
  const SETTING_LIMITS = Object.freeze({
    CloseTabDelay: Object.freeze({ min: 0, max: 60000, integer: true }),
    RequestTimeout: Object.freeze({ min: 5000, max: 120000, integer: true }),
    NDC_pauseBetweenDownload: Object.freeze({ min: 0, max: 600, integer: true }),
    NDC_downloadSpeed: Object.freeze({ min: 0.1, max: 1000 }),
    NDC_downloadMethod: Object.freeze({ min: 0, max: 1, integer: true }),
    DownloadFolder: Object.freeze({ maxLength: 100 })
  });

  // The stored form of a setting, or undefined when the value cannot be stored at all.
  function normalizeSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return undefined;
    if (typeof value !== typeof DEFAULTS[key]) return undefined;
    const limits = SETTING_LIMITS[key];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return undefined;
      if (!limits) return value;
      const rounded = limits.integer ? Math.round(value) : value;
      return Math.min(Math.max(rounded, limits.min), limits.max);
    }
    if (typeof value === 'string' && limits?.maxLength) return value.slice(0, limits.maxLength);
    return value;
  }

  const ARCHIVE_FILE_EXTENSIONS = Object.freeze([
    'zip', '7z', 'rar', '001', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'lzma',
    'exe', 'msi', 'jar', 'fomod', 'omod', 'esp', 'esm', 'esl', 'dll'
  ]);
  const DOWNLOAD_FILE_EXTENSIONS = Object.freeze([
    ...ARCHIVE_FILE_EXTENSIONS,
    'txt', 'pdf', 'json', 'xml', 'ini', 'cfg'
  ]);

  const RATE_LIMIT_BASE_SECONDS = 30;
  const RATE_LIMIT_MAX_SECONDS = 10 * 60;
  const RATE_LIMIT_MAX_STRIKES = 6;

  // Seconds a Retry-After header asks for, or null when there is no usable header.
  function parseRetryAfterSeconds(raw) {
    const header = String(raw ?? '').trim();
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
    const asDate = Date.parse(header);
    return Number.isNaN(asDate) ? null : Math.max(0, Math.round((asDate - Date.now()) / 1000));
  }

  function rateLimitBackoffSeconds(strike) {
    const step = Math.max(0, (Number(strike) || 1) - 1);
    return Math.min(RATE_LIMIT_BASE_SECONDS * Math.pow(2, step), RATE_LIMIT_MAX_SECONDS);
  }

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
    // Closing the tab is only ever a Vortex step, so reporting its state next to a browser
    // download reads as a setting being off when the setting does not apply at all.
    if (source.method === 'vortex') {
      if (source.autoClose === true) parts.push('tab auto-close armed');
      if (source.autoClose === false) parts.push('tab auto-close off');
    }
    if (source.fallbackActive) parts.push('after a Cloudflare fallback');
    return parts.join(' · ');
  }

  // One shape for every log entry, whichever context writes it, with every free-text field redacted.
  function buildErrorEntry(error, fallbackCode = 'request_failed') {
    return {
      at: Date.now(),
      code: String(error?.code || fallbackCode),
      status: Number.isInteger(error?.status) ? error.status : null,
      context: sanitizeDiagnosticText(error?.context, 300),
      action: sanitizeDiagnosticText(error?.action, 200),
      userMessage: String(error?.userMessage || ''),
      technicalMessage: sanitizeDiagnosticText(error?.technicalMessage, 600),
      stack: sanitizeDiagnosticText(error?.stack, 1500),
      url: sanitizeUrlForReport(error?.url)
    };
  }

  function recordError(error) {
    const entry = buildErrorEntry({
      ...error,
      action: describeActivity(),
      url: typeof location !== 'undefined' && location?.href ? location.href : ''
    });
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'ERROR_LOG_APPEND', payload: { entry } }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
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
    ERROR_LOG_KEY,
    MAX_LOGGED_ERRORS,
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
    prepareRatingPrompt,
    ratingStarsMarkup,
    DEFAULTS,
    normalizeSetting,
    ARCHIVE_FILE_EXTENSIONS,
    DOWNLOAD_FILE_EXTENSIONS,
    RATE_LIMIT_MAX_SECONDS,
    RATE_LIMIT_MAX_STRIKES,
    parseRetryAfterSeconds,
    rateLimitBackoffSeconds,
    escapeHtml,
    sanitizeUrlForReport,
    sanitizeDiagnosticText,
    validateDownloadTarget,
    isSafeNexusPageUrl,
    buildErrorEntry,
    recordError,
    setActivity,
    noteActivity,
    describeActivity,
    describeActivityTrail,
    bumpTotalDownloads,
    readTotalDownloads,
    copyText,
    t,
    tPlural,
    setForceEnglish,
    applyI18nTo
  };
})();
