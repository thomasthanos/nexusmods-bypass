// The bug report the "Report a bug" buttons put into GitHub's issue form. The popup loads it after
// shared.js; a Nexus Mods page asks for it only when a report may be needed (loadBundle in content/ui.js).
(function () {
  'use strict';

  const NXTK = globalThis.NXTK;
  if (!NXTK || typeof NXTK.buildReportIssueUrl === 'function') return;

  const {
    SETTINGS_KEY,
    ERROR_LOG_KEY,
    ISSUE_NEW_URL,
    REPORT_ISSUE_URL,
    DEFAULTS,
    sanitizeDiagnosticText,
    sanitizeUrlForReport,
    describeActivity,
    describeActivityTrail,
    readTotalDownloads
  } = NXTK;

  const MAX_ISSUE_URL_CHARS = 7000;

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
    const currentAction = describeActivity(currentError.action ? { trigger: currentError.action } : undefined);
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

  // The full report is what the reporter copies; the compact one is cut down step by step until the
  // issue URL fits. One builder, so the two can never disagree about what they contain.
  async function buildReport(currentError = null, { compact = false, maxEntries = 3, stackChars = 300 } = {}) {
    const cfg = await cachedSettings();
    const errors = await cachedErrorLog();
    const manifest = chrome.runtime.getManifest();

    const header = await describeReportHeader(manifest, { includeUserAgent: !compact });
    const lines = compact ? header : ['════════ NEXUSMODS BYPASS — BUG REPORT ════════', ...header];

    const fingerprint = errorFingerprint(currentError || errors[errors.length - 1]);
    if (fingerprint) lines.push(`Report ID: ${fingerprint} (same fault, same ID)`);

    const pageContext = describePageContext();
    if (pageContext) {
      lines.push('');
      lines.push(...pageContext);
    }

    if (currentError) {
      lines.push('');
      lines.push(...describeCurrentError(currentError, compact ? 300 : 1500));
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
    if (!compact) {
      lines.push(`──────── Recent errors (${errors.length}) ────────`);
      if (!errors.length) lines.push('(no errors recorded)');
      for (const entry of errors) {
        lines.push('');
        lines.push(...describeLoggedError(entry));
      }
      lines.push('');
      lines.push('════════ END OF REPORT ════════');
      return lines.join('\n');
    }

    const recent = (maxEntries > 0 ? errors.slice(-maxEntries) : []).map((entry) => ({
      ...entry,
      stack: stackChars > 0 ? String(entry.stack || '').slice(0, stackChars) : ''
    }));
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

  function buildBugReport(currentError = null) {
    return buildReport(currentError);
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
        const reduced = await buildReport(currentError, { compact: true, ...step });
        if (fits(reduced)) return { url: buildIssueUrl(title, reduced, browser), complete: false, report };
      }

      return { url: buildIssueUrl(title, '', browser), complete: false, report };
    } catch (_) {
      return { url: REPORT_ISSUE_URL, complete: false, report };
    } finally {
      if (ownsCache) reportCache = null;
    }
  }

  Object.assign(NXTK, { buildBugReport, buildReportIssueUrl });
})();
