if (!globalThis.NXTKResponseClassifier && typeof importScripts === 'function') {
  importScripts('response-classifier.js');
}

const RESPONSE_CLASSIFIER = globalThis.NXTKResponseClassifier;
if (!RESPONSE_CLASSIFIER) throw new Error('response-classifier-not-loaded');

const NXTK = (() => {
  const SETTINGS_KEY = 'nxtk_settings';
  const ERROR_LOG_KEY = 'nxtk_error_log';
  const MAX_LOGGED_ERRORS = 50;
  const TOTAL_DOWNLOADS_KEY = 'nxtk_total_downloads';
  const ISSUE_NEW_URL = 'https://github.com/thomasthanos/nexusmods-bypass/issues/new';
  const REPORT_ISSUE_URL = `${ISSUE_NEW_URL}/choose`;
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

  function sanitizeDiagnosticText(value, maxLength = 1500) {
    let text = String(value ?? '');
    if (!text) return text;
    text = text.replace(EXTENSION_ORIGIN_PATTERN, 'ext://');
    text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrlForReport(match));
    text = redactSensitiveValues(text);
    return text.slice(0, maxLength);
  }

  function buildErrorEntry(error) {
    return {
      at: Date.now(),
      code: String(error?.code || 'background_error'),
      status: Number.isInteger(error?.status) ? error.status : null,
      context: sanitizeDiagnosticText(error?.context, 300),
      action: sanitizeDiagnosticText(error?.action, 200),
      userMessage: String(error?.userMessage || ''),
      technicalMessage: sanitizeDiagnosticText(error?.technicalMessage, 600),
      stack: sanitizeDiagnosticText(error?.stack, 1500),
      url: String(error?.url || '')
    };
  }

  function normalizeHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host.endsWith('.') ? host.slice(0, -1) : host;
  }

  function hostMatches(hostname, apex) {
    const host = normalizeHostname(hostname);
    return host === apex || host.endsWith(`.${apex}`);
  }

  function validateDownloadTarget(url, { method = 0 } = {}) {
    const raw = String(url ?? '').trim();
    if (!raw) return { ok: false, detail: 'empty' };
    if (raw.length > 2048) return { ok: false, detail: 'too-long' };

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return { ok: false, detail: 'not-a-url' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, detail: 'embedded-credentials' };
    }
    if (method === 0) {
      if (parsed.protocol !== 'nxm:') {
        return { ok: false, detail: `bad-protocol:${parsed.protocol.replace(':', '')}` };
      }
      const missing = ['key', 'expires', 'user_id'].filter((name) => !parsed.searchParams.get(name));
      return missing.length
        ? { ok: false, detail: `missing-nxm-params:${missing.join(',')}` }
        : { ok: true, url: raw, hostname: normalizeHostname(parsed.hostname) };
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, detail: `bad-protocol:${parsed.protocol.replace(':', '')}` };
    }
    if (!hostMatches(parsed.hostname, 'nexusmods.com') && !hostMatches(parsed.hostname, 'nexus-cdn.com')) {
      return { ok: false, detail: `host-not-allowed:${normalizeHostname(parsed.hostname)}` };
    }
    return { ok: true, url: raw, hostname: normalizeHostname(parsed.hostname) };
  }

  return {
    SETTINGS_KEY,
    ERROR_LOG_KEY,
    MAX_LOGGED_ERRORS,
    TOTAL_DOWNLOADS_KEY,
    ISSUE_NEW_URL,
    REPORT_ISSUE_URL,
    DEFAULTS,
    buildErrorEntry,
    sanitizeDiagnosticText,
    validateDownloadTarget
  };
})();

const LEGACY_SETTINGS_KEYS = ['PlayErrorSound', 'ErrorSoundUrl', 'QuietSiteErrors', 'HideDownloadBar'];

const LEGACY_SPEED_DEFAULT = 1.5;

function getRuntimeError() {
  try {
    return chrome.runtime.lastError?.message || '';
  } catch (_) {
    return 'The extension context is no longer available.';
  }
}

function recordBackgroundError(context, cause) {
  appendErrorLogEntry(NXTK.buildErrorEntry({
    code: 'background_error',
    context,
    userMessage: 'A background extension task failed.',
    technicalMessage: String(cause?.message || cause || ''),
    stack: String(cause?.stack || '')
  })).catch(() => undefined);
}

const STORAGE_HISTORY_KEY = 'nxtk_ndc_history';
const HISTORY_TYPES = new Set(['all', 'mandatory', 'optional']);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_HISTORY_IDS = 10000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Serialize storage writes per key to prevent lost updates.
const writeQueues = new Map();

function enqueueStorageTask(storageKey, task) {
  const previous = writeQueues.get(storageKey) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(() => undefined, () => undefined);
  writeQueues.set(storageKey, settled);

  settled.then(() => {
    if (writeQueues.get(storageKey) === settled) writeQueues.delete(storageKey);
  });
  return next;
}

function storageGetLocal(key, fallback) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (result) => {
        if (getRuntimeError()) return resolve(fallback);
        const value = result ? result[key] : undefined;
        resolve(value === undefined ? fallback : value);
      });
    } catch (_) {
      resolve(fallback);
    }
  });
}

function storageSetLocal(key, value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        const error = getRuntimeError();
        if (error) return reject(new Error(error));
        resolve(true);
      });
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}

const ERROR_LOG_REPEAT_WINDOW_MS = 30 * 60 * 1000;

function errorEntrySignature(entry) {
  return [
    String(entry?.code || ''),
    String(entry?.context || ''),
    Number.isInteger(entry?.status) ? String(entry.status) : ''
  ].join('|');
}

function appendErrorLogEntry(entry) {
  return enqueueStorageTask(NXTK.ERROR_LOG_KEY, async () => {
    const stored = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
    const log = Array.isArray(stored) ? stored : [];
    const signature = errorEntrySignature(entry);

    // Counted in place: a retry loop would otherwise push the whole log out.
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const candidate = log[index];
      if (errorEntrySignature(candidate) !== signature) continue;
      const lastAt = Number(candidate.lastAt || candidate.at) || 0;
      if (entry.at - lastAt > ERROR_LOG_REPEAT_WINDOW_MS) break;
      log[index] = {
        ...candidate,
        count: Math.max(1, Number(candidate.count) || 1) + 1,
        lastAt: entry.at,
        userMessage: entry.userMessage || candidate.userMessage,
        technicalMessage: entry.technicalMessage || candidate.technicalMessage,
        stack: entry.stack || candidate.stack,
        action: entry.action || candidate.action,
        url: entry.url || candidate.url
      };
      await storageSetLocal(NXTK.ERROR_LOG_KEY, log);
      return log.length;
    }

    log.push(entry);
    while (log.length > NXTK.MAX_LOGGED_ERRORS) log.shift();
    await storageSetLocal(NXTK.ERROR_LOG_KEY, log);
    return log.length;
  });
}

function isSafeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && !FORBIDDEN_KEYS.has(value);
}

function isValidFileId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value < 1e12;
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number < 1e12;
}

function isValidHistoryId(value) {
  if (isValidFileId(value)) return true;
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 2 && parts.every(isValidFileId);
}

function historyBranch(history, gameId, collectionId) {
  const root = Object.assign(Object.create(null), history || {});
  const game = Object.assign(Object.create(null), root[gameId] || {});
  const collection = Object.assign(Object.create(null), game[collectionId] || {});
  root[gameId] = game;
  game[collectionId] = collection;
  return { root, collection };
}

function readHistoryList(collection, type) {
  return Array.isArray(collection[type]) ? collection[type] : [];
}

async function mutateHistory(payload, mutate) {
  const { gameId, collectionId } = payload || {};
  if (!isSafeId(gameId) || !isSafeId(collectionId)) throw new Error('invalid-collection-identifier');
  return enqueueStorageTask(STORAGE_HISTORY_KEY, async () => {
    const stored = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    const { root, collection } = historyBranch(stored, gameId, collectionId);
    mutate(collection);
    await storageSetLocal(STORAGE_HISTORY_KEY, root);
    return { gameId, collectionId, collection: { ...collection } };
  });
}

const STORAGE_HANDLERS = {
  async SETTINGS_PATCH(payload) {
    const patch = payload?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid-settings-patch');
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error('empty-settings-patch');
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(NXTK.DEFAULTS, key)) throw new Error(`unknown-settings-key:${key}`);
      if (typeof patch[key] !== typeof NXTK.DEFAULTS[key]) throw new Error(`invalid-settings-value:${key}`);
    }
    return enqueueStorageTask(NXTK.SETTINGS_KEY, async () => {
      const stored = await storageGetLocal(NXTK.SETTINGS_KEY, null);
      const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      const next = { ...NXTK.DEFAULTS, ...base, ...patch };
      await storageSetLocal(NXTK.SETTINGS_KEY, next);
      return next;
    });
  },

  async SETTINGS_RESET() {

    return enqueueStorageTask(NXTK.SETTINGS_KEY, async () => {
      const next = { ...NXTK.DEFAULTS };
      await storageSetLocal(NXTK.SETTINGS_KEY, next);
      return next;
    });
  },

  async ERROR_LOG_APPEND(payload) {
    const entry = payload?.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid-error-entry');
    return appendErrorLogEntry(NXTK.buildErrorEntry(entry));
  },

  async NDC_HISTORY_ADD(payload) {
    const { type, fileId } = payload || {};
    if (!HISTORY_TYPES.has(type)) throw new Error('invalid-history-type');
    if (!isValidHistoryId(fileId)) throw new Error('invalid-file-id');
    return mutateHistory(payload, (collection) => {
      const list = readHistoryList(collection, type);
      if (list.length >= MAX_HISTORY_IDS) throw new Error('history-too-large');
      collection[type] = [...new Set([...list, fileId])];
    });
  },

  async NDC_HISTORY_CLEAR_TYPE(payload) {
    const { type } = payload || {};
    if (!HISTORY_TYPES.has(type)) throw new Error('invalid-history-type');
    return mutateHistory(payload, (collection) => {
      collection[type] = [];
    });
  },

  async NDC_HISTORY_SET_COLLECTION(payload) {
    const lists = payload?.lists;
    if (!lists || typeof lists !== 'object') throw new Error('invalid-lists');
    const cleaned = Object.create(null);
    for (const type of HISTORY_TYPES) {
      const raw = Array.isArray(lists[type]) ? lists[type] : [];
      if (raw.length > MAX_HISTORY_IDS) throw new Error('history-too-large');
      cleaned[type] = [...new Set(raw.filter(isValidHistoryId))];
    }
    return mutateHistory(payload, (collection) => {
      for (const type of HISTORY_TYPES) collection[type] = cleaned[type];
    });
  },

  async TOTAL_DOWNLOADS_INCREMENT() {
    return enqueueStorageTask(NXTK.TOTAL_DOWNLOADS_KEY, async () => {
      const count = Number(await storageGetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0)) || 0;
      const next = count + 1;
      await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, next);
      return next;
    });
  }
};

const MAX_DOWNLOAD_NAME_CHARS = 150;

function hasDownloadsApi() {
  try {
    return !!(chrome.downloads && chrome.downloads.download);
  } catch (_) {
    return false;
  }
}

function restoreBrowserDownloadUi() {
  try {
    if (typeof chrome.downloads?.setUiOptions !== 'function') return;
    const pending = chrome.downloads.setUiOptions({ enabled: true });
    pending?.catch?.((cause) => {
      recordBackgroundError('restore download UI', cause);
    });
  } catch (cause) {
    recordBackgroundError('restore download UI', cause);
  }
}

restoreBrowserDownloadUi();

function sanitizePathSegment(value, { allowDots = true } = {}) {
  let segment = String(value ?? '')
    .replace(/[\\/]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!allowDots) segment = segment.replace(/\./g, '');
  segment = segment
    .split(' ')
    .filter((token) => token && !/^\.+$/.test(token))
    .join(' ');
  segment = segment.replace(/^\.+/, '').trim();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) segment = `_${segment}`;
  return segment;
}

function capFileName(name) {
  if (name.length <= MAX_DOWNLOAD_NAME_CHARS) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 12) return name.slice(0, MAX_DOWNLOAD_NAME_CHARS);
  const ext = name.slice(dot);
  return name.slice(0, MAX_DOWNLOAD_NAME_CHARS - ext.length) + ext;
}

const MAX_DOWNLOAD_DIR_CHARS = 100;

// Sanitize both user-controlled path segments before downloading.
function buildDownloadPath(folder, rawName) {
  const name = capFileName(sanitizePathSegment(rawName)) || 'nexus-download';
  const dir = sanitizePathSegment(folder, { allowDots: false })
    .slice(0, MAX_DOWNLOAD_DIR_CHARS)
    .trim();
  return dir ? `${dir}/${name}` : name;
}

const DOWNLOAD_CONFLICT_ACTION = 'uniquify';

const DOWNLOAD_EXTENSIONS = new Set([
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'lzma', '001',
  'exe', 'msi', 'jar', 'fomod', 'omod',
  'txt', 'pdf', 'json', 'xml', 'ini', 'cfg',
  'esp', 'esm', 'esl', 'dll'
]);

function extractDownloadExtension(value) {
  let candidate = String(value || '').trim();
  try {
    const parsed = new URL(candidate);
    candidate = decodeURIComponent(parsed.pathname.split('/').pop() || '');
  } catch (_) {
    candidate = candidate.split(/[?#]/, 1)[0];
  }
  const match = candidate.match(/\.([a-z0-9]{1,8})$/i);
  if (!match) return '';
  const extension = match[1].toLowerCase();
  return DOWNLOAD_EXTENSIONS.has(extension) ? `.${extension}` : '';
}

function hasFileExtension(name) {
  return !!extractDownloadExtension(name);
}

function withFallbackExtension(name, fallbackExtension) {
  const cleanName = String(name || '').trim();
  if (!cleanName || hasFileExtension(cleanName)) return cleanName;
  const extension = String(fallbackExtension || '').trim().toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? cleanName + extension : cleanName;
}

const RETIRED_STORAGE_KEYS = ['nxtk_managed_downloads', 'nxtk_download_ui_default_reset'];

const DOWNLOAD_HANDLERS = {
  async DOWNLOAD_START(payload) {
    if (!hasDownloadsApi()) throw new Error('no-permission');
    const url = String(payload?.url || '');
    const verdict = NXTK.validateDownloadTarget(url, { method: 1 });
    if (!verdict.ok) throw new Error(`unsafe-target:${verdict.detail}`);

    const requestedName = withFallbackExtension(
      payload?.filename || 'nexus-download',
      extractDownloadExtension(verdict.url) || payload?.fallbackExtension || '.zip'
    );
    const filename = buildDownloadPath(payload?.folder, requestedName);
    const downloadId = await new Promise((resolve, reject) => {
      const options = {
        url: verdict.url,
        filename,
        conflictAction: DOWNLOAD_CONFLICT_ACTION,
        saveAs: false
      };
      chrome.downloads.download(options, (id) => {
        const error = getRuntimeError();
        if (error || id === undefined) return reject(new Error(error || 'download_not_started'));
        resolve(id);
      });
    });
    return { downloadId, filename };
  }
};

const NDC_JOBS_KEY = 'nxtk_background_ndc_jobs';
const NDC_RATE_LIMIT_KEY = 'nxtk_ndc_rate_limit';
const NDC_ALARM_PREFIX = 'nxtk-ndc-job:';
// Matches the importer's own ceiling so nothing it can read is refused here.
// A queue this size costs about 2 MB of the 10 MB storage quota.
const MAX_NDC_JOB_ITEMS = 10000;
const MAX_NDC_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_NDC_ACTIVE_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// One promise per job, rather than only a boolean, lets Restart wait until an old in-flight
// downloads.download callback has been observed and canceled before the replacement can start.
const ndcProcessingJobs = new Map();
const ndcDownloadJobs = new Map();

function makeNdcJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function ndcScopeKey(type, items) {
  const ids = items.map((item) => `${item.gameId}:${item.fileId}`).sort();
  const text = `${type ?? 'null'}|${ids.join(',')}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (((hash << 5) + hash) ^ text.charCodeAt(index)) >>> 0;
  }
  return `${type ?? 'null'}:${ids.length}:${hash.toString(36)}`;
}

function sanitizeNdcJobItem(raw) {
  const fileId = raw?.fileId;
  const historyId = raw?.historyId ?? fileId;
  const gameId = String(raw?.gameId ?? '').trim();
  const name = String(raw?.name || '').trim().slice(0, 300);
  const pageUrl = String(raw?.pageUrl || '').trim();
  const rawSize = Number(raw?.sizeKb);
  const sizeKb = Number.isFinite(rawSize) && rawSize > 0 && rawSize < 1e9 ? Math.round(rawSize) : 0;
  if (!isValidFileId(fileId) || !isValidHistoryId(historyId)
    || !/^\d{1,12}$/.test(gameId) || !name || !pageUrl) return null;

  try {
    const parsed = new URL(pageUrl);
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
    if (parsed.protocol !== 'https:' || (host !== 'nexusmods.com' && host !== 'www.nexusmods.com')) return null;
    if (!/^\/[^/]+\/mods\/\d+$/i.test(parsed.pathname)) return null;
  } catch (_) {
    return null;
  }

  return { fileId, historyId, gameId, name, pageUrl, sizeKb, optional: raw?.optional === true };
}

const SHORT_TRANSFER_RATIO = 0.5;
const MIN_EXPECTED_BYTES_FOR_RATIO = 64 * 1024;

function downloadFolderOf(filename) {
  const full = String(filename || '').trim();
  const cut = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
  return cut > 0 ? full.slice(0, cut) : '';
}

const DOCUMENT_MIME_PATTERN = /^(?:text\/|application\/(?:json|xml|xhtml))/i;
const SETTLE_ATTEMPTS = 6;
const SETTLE_DELAY_MS = 120;
const INTERRUPTED_RECHECK_MS = 30000;
const INTERRUPTED_CONFIRMATIONS_BEFORE_FAILURE = 2;

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The record behind a just-fired 'complete' can still carry mid-transfer counters, so it is
// re-read until it stops looking in flight. Judging a finished file on that first snapshot is
// how a complete download gets reported as truncated.
function recordLooksSettled(record) {
  if (!record) return false;
  if (record.state && record.state !== 'complete') return false;
  if (Number(record.fileSize) > 0) return true;
  const declared = Number(record.totalBytes);
  const received = Number(record.bytesReceived) || 0;
  if (declared > 0) return received >= declared;
  // A just-fired complete event can briefly expose zero/unknown counters. A real empty file
  // stays that way and is rejected after the bounded settle loop.
  return received > 0;
}

async function settledDownloadRecord(downloadId) {
  let record = await searchDownload(downloadId);
  for (let attempt = 1; attempt < SETTLE_ATTEMPTS && !recordLooksSettled(record); attempt += 1) {
    await waitMs(SETTLE_DELAY_MS);
    record = await searchDownload(downloadId);
  }
  return record;
}

// The 'interrupted' delta is no more trustworthy than the 'complete' one was. Firefox fires it for a
// transfer it goes on to resume and finish by itself; acting on that first snapshot retries a file
// that was never lost, and the abandoned attempt then completes beside the retry under a uniquified
// name. A record that is paused, or that the browser says it can resume, has not settled yet.
async function settledInterruptedState(downloadId) {
  let record = await searchDownload(downloadId);
  // The delta and the first search result can disagree in either direction. Give every
  // interrupted snapshot the same bounded grace period instead of trusting canResume, which
  // Firefox may update separately from state.
  for (let attempt = 1;
    attempt < SETTLE_ATTEMPTS && (!record || record.state === 'interrupted');
    attempt += 1) {
    await waitMs(SETTLE_DELAY_MS);
    record = await searchDownload(downloadId);
  }
  if (!record) return { state: 'interrupted', record: null };
  if (record.state === 'complete') return { state: 'complete', record };
  if (record.paused === true) return { state: 'paused', record };
  if (record.state === 'in_progress') return { state: 'in_progress', record };
  if (record.canResume === true) return { state: 'resumable', record };
  return { state: 'interrupted', record };
}

async function verifyTransferSize(downloadId, item, confirmedRecord = null) {
  const record = confirmedRecord || await settledDownloadRecord(downloadId);
  if (!record) return { suspicious: false, actualBytes: null, expectedBytes: 0 };

  const onDisk = Number(record.fileSize);
  const actualBytes = onDisk > 0 ? onDisk : Number(record.bytesReceived) || 0;
  const declaredBytes = Number(record.totalBytes) || 0;
  const expectedBytes = Number(item?.sizeKb) > 0 ? Math.round(Number(item.sizeKb) * 1024) : 0;
  const folder = downloadFolderOf(record.filename);
  const detail = `got ${actualBytes}`
    + (declaredBytes ? ` of ${declaredBytes} declared` : ', nothing declared')
    + (expectedBytes ? `, Nexus listed ${expectedBytes}` : '')
    + (record.mime ? `, ${String(record.mime).slice(0, 40)}` : '');

  if (actualBytes === 0) {
    return { suspicious: true, code: 'empty_file', actualBytes, expectedBytes, folder, detail };
  }
  if (declaredBytes > 0 && actualBytes < declaredBytes) {
    return { suspicious: true, code: 'short_file', actualBytes, expectedBytes, folder, detail };
  }
  if (expectedBytes >= MIN_EXPECTED_BYTES_FOR_RATIO
    && actualBytes < expectedBytes * SHORT_TRANSFER_RATIO
    && DOCUMENT_MIME_PATTERN.test(String(record.mime || ''))) {
    return { suspicious: true, code: 'not_a_file', actualBytes, expectedBytes, folder, detail };
  }
  return { suspicious: false, actualBytes, expectedBytes, folder, detail };
}

const NDC_ITEMS_KEY_PREFIX = 'nxtk_ndc_items:';
const ndcItemsCache = new Map();

function ndcItemsKey(jobId) {
  return `${NDC_ITEMS_KEY_PREFIX}${jobId}`;
}

function ndcJobItemCount(job) {
  const count = Number(job?.itemCount);
  if (Number.isInteger(count) && count > 0) return count;
  return Array.isArray(job?.items) ? job.items.length : 0;
}

async function readNdcJobItems(job) {
  if (!job) return [];
  if (Array.isArray(job.items) && job.items.length) return job.items;
  const cached = ndcItemsCache.get(job.id);
  if (cached) return cached;
  const stored = await storageGetLocal(ndcItemsKey(job.id), null);
  const items = Array.isArray(stored) ? stored : [];
  if (items.length) ndcItemsCache.set(job.id, items);
  return items;
}

async function writeNdcJobItems(jobId, items) {
  ndcItemsCache.set(jobId, items);
  await enqueueStorageTask(ndcItemsKey(jobId), () => storageSetLocal(ndcItemsKey(jobId), items));
}

function dropNdcJobItems(jobId) {
  ndcItemsCache.delete(jobId);
  try {
    chrome.storage.local.remove(ndcItemsKey(jobId), () => void getRuntimeError());
  } catch (_) { }
}

function cleanNdcJobs(stored) {
  const jobs = Object.create(null);
  const now = Date.now();
  if (!stored || typeof stored !== 'object') return jobs;
  for (const [jobId, job] of Object.entries(stored)) {
    if (!/^[a-z0-9-]{8,80}$/i.test(jobId) || !job || typeof job !== 'object') continue;
    if (!ndcJobItemCount(job)) continue;
    const touchedAt = Number(job.updatedAt || job.createdAt);
    if (!Number.isFinite(touchedAt)) continue;
    const maxAge = ndcJobIsActive(job) ? MAX_NDC_ACTIVE_JOB_AGE_MS : MAX_NDC_JOB_AGE_MS;
    if (now - touchedAt > maxAge) continue;
    jobs[jobId] = job;
  }
  return jobs;
}

async function readNdcJobs() {
  return cleanNdcJobs(await storageGetLocal(NDC_JOBS_KEY, Object.create(null)));
}

async function readNdcJob(jobId) {
  const jobs = await readNdcJobs();
  return jobs[jobId] || null;
}

function bumpNdcControl(job) {
  job.controlVersion = Number(job.controlVersion || 0) + 1;
  return job;
}

async function saveNdcJob(job) {
  job.updatedAt = Date.now();
  await enqueueStorageTask(NDC_JOBS_KEY, async () => {
    const jobs = await readNdcJobs();
    const stored = jobs[job.id];
    if (stored && Number(stored.controlVersion || 0) > Number(job.controlVersion || 0)) {
      job.status = stored.status;
      job.controlVersion = stored.controlVersion;
    }
    jobs[job.id] = job;
    await storageSetLocal(NDC_JOBS_KEY, jobs);
  });
  
  try {
    if (job.status === 'running' && chrome.alarms?.create) {
      chrome.alarms.create('nxtk-reconcile', { delayInMinutes: 5 });
    } else if (job.status !== 'running') {
      reconcileNdcJobs().catch(() => {});
    }
  } catch (_) { }

  return job;
}

async function mutateNdcJobIf(jobId, guard, mutate) {
  let result = { applied: false, job: null };
  await enqueueStorageTask(NDC_JOBS_KEY, async () => {
    const jobs = await readNdcJobs();
    const job = jobs[jobId];
    if (!job) return;
    if (!guard(job)) {
      result = { applied: false, job };
      return;
    }
    mutate(job);
    job.updatedAt = Date.now();
    jobs[jobId] = job;
    await storageSetLocal(NDC_JOBS_KEY, jobs);
    result = { applied: true, job };
  });
  return result;
}

async function mutateNdcJob(jobId, mutate) {
  const result = await mutateNdcJobIf(jobId, () => true, mutate);
  return result.job;
}

function ndcJobIsActive(job) {
  return !!job && (job.status === 'running' || job.status === 'paused');
}

async function findActiveNdcJobForCollection(gameId, collectionId) {
  const jobs = await readNdcJobs();
  return Object.values(jobs).find(
    (job) => ndcJobIsActive(job) && job.gameId === gameId && job.collectionId === collectionId
  ) || null;
}

async function findNdcJobByDownloadId(downloadId) {
  const cachedJobId = ndcDownloadJobs.get(downloadId);
  if (cachedJobId) {
    const cachedJob = await readNdcJob(cachedJobId);
    if (cachedJob?.activeDownloadId === downloadId) return cachedJob;
  }
  const jobs = await readNdcJobs();
  return Object.values(jobs).find((job) => job?.activeDownloadId === downloadId) || null;
}

function tabExists(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId) || tabId < 0) return resolve(false);
    try {
      chrome.tabs.get(tabId, (tab) => resolve(!getRuntimeError() && !!tab));
    } catch (_) {
      resolve(false);
    }
  });
}

async function claimNdcJobOwnership(job, tabId) {
  if (job.tabId === tabId) return job;
  if (await tabExists(job.tabId)) return job;
  return (await mutateNdcJob(job.id, (current) => { current.tabId = tabId; })) || job;
}

function notifyNdcJob(job, type, extra = {}, alsoTabIds = []) {
  const targets = new Set();
  if (Number.isInteger(job?.tabId) && job.tabId >= 0) targets.add(job.tabId);
  for (const tabId of alsoTabIds) {
    if (Number.isInteger(tabId) && tabId >= 0) targets.add(tabId);
  }
  if (!targets.size) return;

  const message = {
    type,
    jobId: job.id,
    gameId: job.gameId,
    collectionId: job.collectionId,
    status: job.status,
    index: job.index,
    total: ndcJobItemCount(job),
    completed: job.completed,
    failedCount: jobFailureCount(job),
    ...extra
  };
  for (const tabId of targets) {
    try {
      chrome.tabs.sendMessage(tabId, message, () => void getRuntimeError());
    } catch (_) { }
  }
}

function decodeBackgroundDownloadValue(value) {
  return String(value || '')
    .trim()
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .trim();
}

function findBackgroundDownloadUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const text = decodeBackgroundDownloadValue(value);
    try {
      const fromJson = findBackgroundDownloadUrl(JSON.parse(text));
      if (fromJson) return fromJson;
    } catch (_) { }
    const patterns = [
      /id=["']dl_link["'][^>]*value=["']([^"']+)["']/i,
      /data-download-url=["']([^"']+)["']/i,
      /const\s+downloadUrl\s*=\s*["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return decodeBackgroundDownloadValue(match[1] || match[0]);
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'downloadUrl', 'vortexDownloadUrl', 'nmmDownloadUrl']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return decodeBackgroundDownloadValue(value[key]);
    }
  }
  for (const key of ['data', 'html', 'links', 'downloadLinks']) {
    const nested = findBackgroundDownloadUrl(value[key]);
    if (nested) return nested;
  }
  return '';
}

function classifyNexusResponse(response, text) {
  return RESPONSE_CLASSIFIER.classify({
    text,
    finalUrl: response?.url || '',
    cfMitigated: response?.cfMitigated || '',
    contentType: response?.contentType || ''
  });
}

function responseLooksLoggedOut(response, text) {
  return classifyNexusResponse(response, text)?.code === 'requires_login';
}

function responseLooksChallenged(response, text) {
  return classifyNexusResponse(response, text)?.code === 'cloudflare';
}

function responseLooksSuspended(text) {
  return classifyNexusResponse(null, text)?.code === 'account_suspended';
}

function responseLooksUnavailable(text) {
  return classifyNexusResponse(null, text)?.code === 'mod_unavailable';
}

async function fetchNdcResponse(url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 5000), 120000);
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const response = await fetch(url, { ...options, signal: controller?.signal || options?.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status || 0,
      text,
      url: response.url || url,
      retryAfter: response.headers?.get?.('Retry-After') || '',
      cfMitigated: response.headers?.get?.('Cf-Mitigated') || '',
      contentType: response.headers?.get?.('Content-Type') || ''
    };
  } catch (cause) {
    return { ok: false, status: 0, text: '', url, error: String(cause?.message || cause) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MIN_NDC_ALARM_DELAY_MS = 30000;

function retryAfterMilliseconds(raw, strike = 1) {

  const header = String(raw ?? '').trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(MIN_NDC_ALARM_DELAY_MS, seconds * 1000);
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) return Math.max(MIN_NDC_ALARM_DELAY_MS, asDate - Date.now());
  }
  return Math.min(30000 * Math.pow(2, Math.max(0, strike - 1)), 10 * 60 * 1000);
}

async function readSharedRateLimitUntil() {
  const stored = await storageGetLocal(NDC_RATE_LIMIT_KEY, null);
  const until = Number(stored?.until);
  return Number.isFinite(until) ? until : 0;
}

async function publishSharedRateLimit(until) {
  if (!Number.isFinite(until) || until <= Date.now()) return;
  await enqueueStorageTask(NDC_RATE_LIMIT_KEY, async () => {
    const current = await readSharedRateLimitUntil();
    if (until <= current) return;
    await storageSetLocal(NDC_RATE_LIMIT_KEY, { until });
  });
}

const pendingTerminalDownloads = new Map();
const MAX_PENDING_TERMINALS = 200;

function rememberEarlyTerminal(downloadId, state, error) {
  pendingTerminalDownloads.set(downloadId, { state, error, at: Date.now() });
  while (pendingTerminalDownloads.size > MAX_PENDING_TERMINALS) {
    const oldest = pendingTerminalDownloads.keys().next().value;
    pendingTerminalDownloads.delete(oldest);
  }
}

function cleanPendingTerminals() {
  const cutoff = Date.now() - 3600000; // 1 hour
  for (const [id, entry] of pendingTerminalDownloads) {
    if (entry.at && entry.at < cutoff) pendingTerminalDownloads.delete(id);
  }
}

function scheduleNdcJobAlarm(jobId, when) {
  try {
    chrome.alarms.create(`${NDC_ALARM_PREFIX}${jobId}`, {
      when: Math.max(Number(when) || 0, Date.now() + MIN_NDC_ALARM_DELAY_MS)
    });
  } catch (_) { }
}

function clearNdcJobAlarm(jobId) {
  try {
    chrome.alarms.clear(`${NDC_ALARM_PREFIX}${jobId}`, () => void getRuntimeError());
  } catch (_) { }
}

function ndcResolveFailure(code, response) {
  return {
    ok: false,
    code,
    status: response?.status || 0,
    retryAfter: response?.retryAfter || ''
  };
}

async function resolveNdcBrowserUrl(item, timeoutMs) {
  const page = await fetchNdcResponse(item.pageUrl, {
    method: 'GET',
    credentials: 'include'
  }, timeoutMs);
  const pageIssue = classifyNexusResponse(page, page.text);
  if (pageIssue) return { ok: false, code: pageIssue.code };
  if (!page.ok) return ndcResolveFailure(page.status === 429 ? 'rate_limited' : 'page_request_failed', page);

  const generated = await fetchNdcResponse(
    'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl',
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: `fid=${encodeURIComponent(item.fileId)}&game_id=${encodeURIComponent(item.gameId)}`
    },
    timeoutMs
  );
  const generatedIssue = classifyNexusResponse(generated, generated.text);
  if (generatedIssue) return { ok: false, code: generatedIssue.code };
  if (!generated.ok) {
    return ndcResolveFailure(generated.status === 429 ? 'rate_limited' : 'generate_failed', generated);
  }

  const url = findBackgroundDownloadUrl(generated.text);
  const verdict = NXTK.validateDownloadTarget(url, { method: 1 });
  if (!verdict.ok) return { ok: false, code: 'no_download_url' };
  return { ok: true, url: verdict.url };
}

async function startNdcDownload(job, item, url) {
  const requestedName = withFallbackExtension(
    item.name || 'nexus-download',
    extractDownloadExtension(url) || '.zip'
  );
  const filename = buildDownloadPath(job.folder, requestedName);
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      conflictAction: DOWNLOAD_CONFLICT_ACTION,
      saveAs: false
    }, (id) => {
      const error = getRuntimeError();
      if (error || id === undefined) return reject(new Error(error || 'download_not_started'));
      ndcDownloadJobs.set(id, job.id);
      resolve(id);
    });
  });
  return { downloadId, filename };
}

async function finishNdcJob(job) {
  const eligibility = await mutateNdcJobIf(
    job.id,
    (current) => current.status === 'running'
      && current.activeDownloadId === null
      && Number(current.index || 0) >= ndcJobItemCount(current),
    () => {}
  );
  if (!eligibility.applied) return eligibility.job || job;
  job = eligibility.job;

  // Keep the job discoverable as running until its successful-run history cleanup is complete.
  // A concurrent Restart then stops this job and waits for its processing promise before the new
  // run can add history, instead of letting this late clear erase the new run's entries.
  if (job.type && !jobFailureCount(job)) {
    await STORAGE_HANDLERS.NDC_HISTORY_CLEAR_TYPE({
      gameId: job.gameId,
      collectionId: job.collectionId,
      type: job.type
    });
  }

  const transition = await mutateNdcJobIf(
    job.id,
    (current) => current.status === 'running'
      && current.activeDownloadId === null
      && Number(current.index || 0) >= ndcJobItemCount(current),
    (current) => {
      current.status = jobFailureCount(current) ? 'partial' : 'finished';
      current.activeDownloadId = null;
      current.finishedAt = Date.now();
      bumpNdcControl(current);
    }
  );
  if (!transition.applied) return transition.job || job;
  job = transition.job;
  clearNdcJobAlarm(job.id);
  notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: job.status, folder: job.landedIn || '' });
  dropNdcJobItems(job.id);
  return job;
}

const NDC_RESOLVE_RETRY_DELAY_MS = 1500;
const BLOCKING_RESOLVE_CODES = new Set(['requires_login', 'cloudflare', 'account_suspended']);

// Never finish here: that would report success and clear history for files never downloaded.
function ndcJobItemsAreMissing(job, items) {
  return !items.length && ndcJobItemCount(job) > 0;
}

async function abandonNdcJobWithoutItems(job) {
  const expectedDownloadId = job.activeDownloadId;
  const expectedIndex = Number(job.index || 0);
  const transition = await mutateNdcJobIf(
    job.id,
    (current) => ndcJobIsActive(current)
      && current.activeDownloadId === expectedDownloadId
      && Number(current.index || 0) === expectedIndex,
    (current) => {
      current.status = 'error';
      current.lastError = 'queue-items-missing';
      current.activeDownloadId = null;
      delete current.interruptConfirmations;
      bumpNdcControl(current);
    }
  );
  if (!transition.applied) return null;
  job = transition.job;
  clearNdcJobAlarm(job.id);
  notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: 'error', error: 'queue-items-missing' });
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function advanceNdcJob(jobId) {
  for (;;) {
    if (terminalNdcJobs.has(jobId)) return null;
    let job = await readNdcJob(jobId);
    if (!job || job.status !== 'running' || job.activeDownloadId !== null) return null;
    if (Number.isInteger(job.retiringDownloadId)) {
      if (!await finishNdcRetirement(job.id, job.retiringDownloadId)) {
        scheduleNdcJobAlarm(job.id, Date.now() + INTERRUPTED_RECHECK_MS);
        return null;
      }
      job = await readNdcJob(jobId);
      if (!job || job.status !== 'running' || job.activeDownloadId !== null) return null;
    }
    const items = await readNdcJobItems(job);
    if (ndcJobItemsAreMissing(job, items)) return abandonNdcJobWithoutItems(job);
    if (job.index >= items.length) {
      await finishNdcJob(job);
      return null;
    }

    const sharedUntil = await readSharedRateLimitUntil();
    if (sharedUntil > Date.now()) {
      const waitingIndex = Number(job.index || 0);
      const transition = await mutateNdcJobIf(
        job.id,
        (current) => current.status === 'running'
          && current.activeDownloadId === null
          && Number(current.index || 0) === waitingIndex,
        (current) => { current.waitingUntil = sharedUntil; }
      );
      if (!transition.applied) return null;
      job = transition.job;
      scheduleNdcJobAlarm(job.id, sharedUntil);
      notifyNdcJob(job, 'NXT_NDC_WAITING', {
        itemName: items[waitingIndex]?.name || '',
        until: sharedUntil,
        reason: 'rate_limited'
      });
      return null;
    }

    const startIndex = job.index;
    const item = items[startIndex];
    const resolved = await resolveNdcBrowserUrl(item, job.requestTimeout);

    job = await readNdcJob(jobId);
    if (!job || job.status !== 'running' || job.activeDownloadId !== null) return null;
    if (job.index !== startIndex) continue;

    if (!resolved.ok) {
      if (resolved.code === 'rate_limited') {
        let waitingUntil = 0;
        const transition = await mutateNdcJobIf(
          job.id,
          (current) => current.status === 'running'
            && current.activeDownloadId === null
            && Number(current.index || 0) === startIndex,
          (current) => {
            current.rateLimitStrikes = Math.min(Number(current.rateLimitStrikes || 0) + 1, 6);
            current.waitingUntil = Date.now()
              + retryAfterMilliseconds(resolved.retryAfter, current.rateLimitStrikes);
            waitingUntil = current.waitingUntil;
          }
        );
        if (!transition.applied) return null;
        job = transition.job;
        scheduleNdcJobAlarm(job.id, waitingUntil);
        notifyNdcJob(job, 'NXT_NDC_WAITING', {
          itemName: item.name,
          until: waitingUntil,
          reason: 'rate_limited'
        });
        await publishSharedRateLimit(waitingUntil);
        return null;
      }

      if (BLOCKING_RESOLVE_CODES.has(resolved.code)) {
        const transition = await mutateNdcJobIf(
          job.id,
          (current) => current.status === 'running'
            && current.activeDownloadId === null
            && Number(current.index || 0) === startIndex,
          (current) => {
            current.status = resolved.code === 'requires_login' ? 'requires_login' : 'error';
            current.lastError = resolved.code;
            recordJobFailure(current, { fileId: item.fileId, code: resolved.code });
            bumpNdcControl(current);
          }
        );
        if (!transition.applied) return null;
        job = transition.job;
        clearNdcJobAlarm(job.id);
        notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: resolved.code, itemName: item.name });
        dropNdcJobItems(job.id);
        await recordQueueItemFailure(job, item, resolved.code);
        return null;
      }
      const attempts = Number(job.resolveAttempts || 0) + 1;
      if (attempts < 2) {
        const transition = await mutateNdcJobIf(
          job.id,
          (current) => current.status === 'running'
            && current.activeDownloadId === null
            && Number(current.index || 0) === startIndex,
          (current) => { current.resolveAttempts = attempts; }
        );
        if (!transition.applied) return null;
        await sleep(NDC_RESOLVE_RETRY_DELAY_MS);
        continue;
      }
      const failureCode = resolved.code || 'request_failed';
      const transition = await mutateNdcJobIf(
        job.id,
        (current) => current.status === 'running'
          && current.activeDownloadId === null
          && Number(current.index || 0) === startIndex,
        (current) => {
          recordJobFailure(current, { fileId: item.fileId, code: failureCode });
          current.resolveAttempts = 0;
          current.index = Number(current.index || 0) + 1;
        }
      );
      if (!transition.applied) return null;
      job = transition.job;
      notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
        itemName: item.name,
        itemState: 'failed',
        error: failureCode
      });
      await recordQueueItemFailure(job, item, failureCode);
      continue;
    }

    job.rateLimitStrikes = 0;
    job.waitingUntil = 0;
    job.resolveAttempts = 0;

    // One file the browser refuses to start must not take the rest of the queue
    // down with it: record it and move on, the way a failed resolve does.
    let started;
    try {
      started = await startNdcDownload(job, item, resolved.url);
    } catch (cause) {
      const transition = await mutateNdcJobIf(
        job.id,
        (current) => current.status === 'running'
          && current.activeDownloadId === null
          && Number(current.index || 0) === startIndex,
        (current) => {
          recordJobFailure(current, { fileId: item.fileId, code: 'download_not_started' });
          current.rateLimitStrikes = 0;
          current.waitingUntil = 0;
          current.resolveAttempts = 0;
          current.index = Number(current.index || 0) + 1;
        }
      );
      if (!transition.applied) return null;
      job = transition.job;
      notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
        itemName: item.name,
        itemState: 'failed',
        error: 'download_not_started'
      });
      await recordQueueItemFailure(job, item, 'download_not_started', cause?.message || cause);
      continue;
    }

    const claim = await mutateNdcJobIf(
      jobId,
      (current) => current.status === 'running'
        && current.activeDownloadId === null
        && Number(current.index || 0) === startIndex,
      (current) => {
        current.activeDownloadId = started.downloadId;
        current.rateLimitStrikes = 0;
        current.waitingUntil = 0;
        current.resolveAttempts = 0;
        delete current.interruptConfirmations;
      }
    );
    const afterStart = claim.job;
    if (!claim.applied || !afterStart) {
      ndcDownloadJobs.delete(started.downloadId);
      pendingTerminalDownloads.delete(started.downloadId);
      await setNdcRetirement(jobId, started.downloadId);
      const retired = await finishNdcRetirement(jobId, started.downloadId);
      if (!retired) {
        recordBackgroundError(
          'collection replacement safety',
          new Error(`download ${started.downloadId} could not be retired`)
        );
      }
      return null;
    }
    notifyNdcJob(afterStart, 'NXT_NDC_PROGRESS', {
      itemName: item.name,
      itemState: 'started'
    });

    const early = pendingTerminalDownloads.get(started.downloadId);
    if (early) {
      pendingTerminalDownloads.delete(started.downloadId);
      return { downloadId: started.downloadId, state: early.state, error: early.error };
    }
    return null;
  }
}

async function failNdcJob(jobId, cause, context = 'background collection queue') {
  let lastError = 'collection queue failed';
  let failedDownloadId = null;
  try {
    lastError = NXTK.sanitizeDiagnosticText(cause?.message || cause, 300);
  } catch (_) { }
  let transition = { applied: false, job: null };
  try {
    transition = await mutateNdcJobIf(
      jobId,
      (current) => ndcJobIsActive(current),
      (current) => {
        failedDownloadId = current.activeDownloadId;
        current.status = 'error';
        current.lastError = lastError;
        current.activeDownloadId = null;
        if (Number.isInteger(failedDownloadId)) current.retiringDownloadId = failedDownloadId;
        delete current.interruptConfirmations;
        bumpNdcControl(current);
      }
    );
  } catch (_) { }
  if (transition.applied) {
    const job = transition.job;
    clearNdcJobAlarm(job.id);
    if (Number.isInteger(failedDownloadId)) {
      ndcDownloadJobs.delete(failedDownloadId);
      pendingTerminalDownloads.delete(failedDownloadId);
      await finishNdcRetirement(job.id, failedDownloadId);
    }
    try {
      notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: 'error', error: job.lastError });
    } catch (_) { }
    dropNdcJobItems(job.id);
  }
  recordBackgroundError(context, cause);
}

function processNdcJob(jobId) {
  const running = ndcProcessingJobs.get(jobId);
  if (running) return running;

  const work = (async () => {
    let currentId = jobId;
    while (currentId) {
      let replay = null;
      try {
        replay = await advanceNdcJob(currentId);
      } catch (cause) {
        await failNdcJob(currentId, cause);
        break;
      }
      if (!replay) break;
      const nextId = await handleNdcDownloadTerminal(replay.downloadId, replay.state, replay.error);
      currentId = nextId === currentId ? currentId : null;
    }
  })();
  const task = work.finally(() => {
    if (ndcProcessingJobs.get(jobId) === task) ndcProcessingJobs.delete(jobId);
  });
  ndcProcessingJobs.set(jobId, task);
  return task;
}

const handledTerminalDownloads = new Set();
const terminalDownloadTasks = new Map();
const terminalNdcJobs = new Map();

function handleNdcDownloadTerminal(downloadId, state, error) {
  const previous = terminalDownloadTasks.get(downloadId) || Promise.resolve(null);
  const task = previous
    .catch(() => null)
    .then(() => handleNdcDownloadTerminalUnlocked(downloadId, state, error));
  terminalDownloadTasks.set(downloadId, task);
  return task.finally(() => {
    if (terminalDownloadTasks.get(downloadId) === task) terminalDownloadTasks.delete(downloadId);
  });
}

async function handleNdcDownloadTerminalUnlocked(downloadId, state, error) {
  if (handledTerminalDownloads.has(downloadId)) return null;

  const job = await findNdcJobByDownloadId(downloadId);
  if (!job || job.activeDownloadId !== downloadId) {
    if (ndcDownloadJobs.has(downloadId)) rememberEarlyTerminal(downloadId, state, error);
    return null;
  }

  try {
    terminalNdcJobs.set(job.id, downloadId);
    return await applyNdcDownloadTerminal(job, downloadId, state, error);
  } catch (cause) {
    await failNdcJob(job.id, cause, 'collection download terminal');
    return null;
  } finally {
    if (terminalNdcJobs.get(job.id) === downloadId) terminalNdcJobs.delete(job.id);
  }
}

async function waitForNdcTerminalJob(jobId) {
  const downloadId = terminalNdcJobs.get(jobId);
  if (!Number.isInteger(downloadId)) return;
  const task = terminalDownloadTasks.get(downloadId);
  if (task) await task.catch(() => undefined);
}

async function waitForNdcCollectionWork(gameId, collectionId) {
  const jobs = await readNdcJobs();
  for (const job of Object.values(jobs)) {
    if (job.gameId !== gameId || job.collectionId !== collectionId) continue;
    const processing = ndcProcessingJobs.get(job.id);
    if (processing) await processing.catch(() => undefined);
    await waitForNdcTerminalJob(job.id);
  }
}

const MAX_TRACKED_FAILURES = 50;

function recordJobFailure(current, entry) {
  if (!Array.isArray(current.failed)) current.failed = [];
  current.failedTotal = Number(current.failedTotal || current.failed.length || 0) + 1;
  if (current.failed.length < MAX_TRACKED_FAILURES) current.failed.push(entry);
}

function jobFailureCount(job) {
  const total = Number(job?.failedTotal);
  if (Number.isFinite(total) && total >= 0) return total;
  return Array.isArray(job?.failed) ? job.failed.length : 0;
}

function discardDownloadedFile(downloadId) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome.downloads?.removeFile !== 'function') return resolve(false);
      chrome.downloads.removeFile(downloadId, () => resolve(!getRuntimeError()));
    } catch (_) {
      resolve(false);
    }
  });
}

function cancelDownload(downloadId) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome.downloads?.cancel !== 'function') return resolve(false);
      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        resolve(ok);
      };
      const pending = chrome.downloads.cancel(downloadId, () => done(!getRuntimeError()));
      if (pending && typeof pending.then === 'function') pending.then(() => done(true), () => done(false));
    } catch (_) {
      resolve(false);
    }
  });
}

function resumeDownload(downloadId) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome.downloads?.resume !== 'function') return resolve(false);
      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        resolve(ok);
      };
      const pending = chrome.downloads.resume(downloadId, () => done(!getRuntimeError()));
      if (pending && typeof pending.then === 'function') pending.then(() => done(true), () => done(false));
    } catch (_) {
      resolve(false);
    }
  });
}

// Only ever a download this worker started: every id reaching here came out of our own
// chrome.downloads.download call, and where the browser attributes the record we re-check it.
// A record that names another extension is never touched.
function downloadWasStartedHere(record) {
  const owner = String(record?.byExtensionId || '');
  return !owner || owner === chrome.runtime?.id;
}

// The file the extension is about to stop waiting on. removeFile only acts on a download that
// finished, so a transfer that produced nothing is left alone by the API itself; the record is
// read first so an unfinished one does not even reach it.
async function discardAbandonedDownload(downloadId, record = null) {
  if (!Number.isInteger(downloadId)) return false;
  const item = record || await searchDownload(downloadId);
  if (!item || item.state !== 'complete' || !downloadWasStartedHere(item)) return false;
  if (item.exists === false) return true;
  if (await discardDownloadedFile(downloadId)) return true;
  const refreshed = await searchDownload(downloadId);
  return refreshed?.state === 'complete'
    && refreshed.exists === false
    && downloadWasStartedHere(refreshed);
}

async function retireNdcDownload(downloadId) {
  if (!Number.isInteger(downloadId)) return true;
  const canceled = await cancelDownload(downloadId);
  let record = await searchDownload(downloadId);
  for (let attempt = 1;
    attempt < SETTLE_ATTEMPTS
      && record
      && (record.state === 'in_progress' || record.paused === true || record.canResume === true);
    attempt += 1) {
    await waitMs(SETTLE_DELAY_MS);
    record = await searchDownload(downloadId);
  }
  if (record?.state === 'complete') return discardAbandonedDownload(downloadId, record);
  if (!record) return canceled;
  if (record.state === 'in_progress' || record.paused === true || record.canResume === true) return false;
  // The bug that motivated this fix reports an interrupted/non-resumable snapshot and then carries
  // on. Only a successful cancel is strong enough to permit a replacement download.
  return canceled;
}

async function setNdcRetirement(jobId, downloadId) {
  return mutateNdcJobIf(
    jobId,
    (current) => !!current,
    (current) => { current.retiringDownloadId = downloadId; }
  );
}

async function clearNdcRetirement(jobId, downloadId) {
  return mutateNdcJobIf(
    jobId,
    (current) => current.retiringDownloadId === downloadId,
    (current) => { delete current.retiringDownloadId; }
  );
}

async function finishNdcRetirement(jobId, downloadId) {
  if (!Number.isInteger(downloadId)) return true;
  if (!await retireNdcDownload(downloadId)) return false;
  await clearNdcRetirement(jobId, downloadId);
  return true;
}

async function clearCollectionRetirements(gameId, collectionId) {
  const jobs = await readNdcJobs();
  for (const job of Object.values(jobs)) {
    if (job.gameId !== gameId || job.collectionId !== collectionId) continue;
    const downloadId = job.retiringDownloadId;
    if (!Number.isInteger(downloadId)) continue;
    if (!await finishNdcRetirement(job.id, downloadId)) return false;
  }
  return true;
}

function recordQueueItemFailure(job, item, code, detail = '') {
  const rawCode = String(code || 'request_failed');
  const rootCode = rawCode.split(/[\s(]/, 1)[0] || 'request_failed';
  const fileId = String(item?.fileId ?? '?');
  const gameId = String(job?.gameId ?? '?');
  const runType = String(job?.type || 'selection');
  return appendErrorLogEntry(NXTK.buildErrorEntry({
    code: 'queue_item_failed',
    context: `Downloading queued file ${fileId} for game ${gameId} (${rootCode}, ${runType})`,
    userMessage: 'A file in the collection queue could not be downloaded.',
    technicalMessage: [rawCode, detail, `file ${fileId}`, `game ${gameId}`, runType]
      .filter(Boolean)
      .join(' | ')
  }));
}

function historyTypesFor(job, item) {
  if (job?.type) return [job.type];
  return ['all', item?.optional === true ? 'optional' : 'mandatory'];
}

async function retainUnconfirmedInterrupt(jobId, downloadId) {
  let shouldDefer = true;
  const transition = await mutateNdcJobIf(
    jobId,
    (current) => current.status === 'running' && current.activeDownloadId === downloadId,
    (current) => {
      const confirmations = Number(current.interruptConfirmations || 0) + 1;
      if (confirmations >= INTERRUPTED_CONFIRMATIONS_BEFORE_FAILURE) {
        delete current.interruptConfirmations;
        shouldDefer = false;
      } else {
        current.interruptConfirmations = confirmations;
      }
    }
  );
  if (transition.applied && shouldDefer) {
    scheduleNdcJobAlarm(jobId, Date.now() + INTERRUPTED_RECHECK_MS);
  }
  return !transition.applied || shouldDefer;
}

async function retainLiveDownload(jobId, downloadId, { recheck = false } = {}) {
  const transition = await mutateNdcJobIf(
    jobId,
    (current) => current.status === 'running' && current.activeDownloadId === downloadId,
    (current) => { delete current.interruptConfirmations; }
  );
  if (transition.applied && recheck) scheduleNdcJobAlarm(jobId, Date.now() + INTERRUPTED_RECHECK_MS);
  return transition.applied;
}

async function applyNdcDownloadTerminal(job, downloadId, state, error) {
  // Confirmed before it is believed, and before the id is marked handled: a download still running
  // is not terminal at all, and marking it handled here is what made the real 'complete' that
  // followed get dropped on the floor while a retry ran beside it.
  let confirmedState = state;
  let confirmedRecord = null;
  let retryAllowed = true;
  if (state === 'interrupted') {
    let settled = await settledInterruptedState(downloadId);
    if (settled.state === 'in_progress') {
      await retainLiveDownload(job.id, downloadId);
      return null;
    }
    if (settled.state === 'paused') {
      await retainLiveDownload(job.id, downloadId, { recheck: true });
      return null;
    }
    if (settled.state === 'resumable') {
      await resumeDownload(downloadId);
      settled = await settledInterruptedState(downloadId);
      if (settled.state === 'complete') {
        error = null;
      } else if (settled.state === 'in_progress' || settled.state === 'paused') {
        await retainLiveDownload(job.id, downloadId, { recheck: settled.state === 'paused' });
        return null;
      } else if (settled.state === 'resumable') {
        if (await retainUnconfirmedInterrupt(job.id, downloadId)) return null;
        // Repeated resume attempts left the same resumable record behind. Do not launch a second
        // id that the user could later run beside this one; report the item and move on safely.
        settled = { state: 'interrupted', record: settled.record };
        retryAllowed = false;
      }
    }
    confirmedState = settled.state;
    confirmedRecord = settled.record;
    if (confirmedState === 'complete') error = null;

    // Before retrying, explicitly close the old attempt. The cancel callback only runs once the
    // browser says that id is canceled, complete, interrupted or gone. If it completed in the
    // meantime, accept that exact attempt instead of launching a duplicate.
    if (confirmedState === 'interrupted') {
      const canceled = await cancelDownload(downloadId);
      const afterCancel = await searchDownload(downloadId);
      if (afterCancel?.state === 'complete') {
        confirmedState = 'complete';
        confirmedRecord = afterCancel;
        error = null;
      } else if (afterCancel?.state === 'in_progress'
        || afterCancel?.paused === true
        || (afterCancel?.canResume === true && retryAllowed)) {
        await retainLiveDownload(job.id, downloadId, { recheck: afterCancel?.state !== 'in_progress' });
        return null;
      } else {
        confirmedRecord = afterCancel || confirmedRecord;
        if (!canceled && retryAllowed) {
          if (await retainUnconfirmedInterrupt(job.id, downloadId)) return null;
          // Two separated observations make this a real failure, but an unsuccessful cancel
          // still does not authorize a second download. Move on instead of risking two copies.
          retryAllowed = false;
        }
      }
    }
  }

  if (confirmedState === 'complete') {
    const completeRecord = await settledDownloadRecord(downloadId);
    if (!completeRecord || completeRecord.state !== 'complete') {
      await retainLiveDownload(job.id, downloadId, { recheck: true });
      return null;
    }
    confirmedRecord = completeRecord;
  }

  const latestJob = await readNdcJob(job.id);
  if (!latestJob || !ndcJobIsActive(latestJob) || latestJob.activeDownloadId !== downloadId) return null;
  job = latestJob;

  const items = await readNdcJobItems(job);
  if (ndcJobItemsAreMissing(job, items)) return abandonNdcJobWithoutItems(job);
  const item = items[job.index];
  if (!item) {
    await finishNdcJob(job);
    return null;
  }

  let effectiveState = confirmedState;
  let effectiveError = error;
  let landedIn = '';
  if (confirmedState === 'complete') {
    const check = await verifyTransferSize(downloadId, item, confirmedRecord);
    landedIn = check.folder || '';
    if (check.suspicious) {
      effectiveState = 'interrupted';
      effectiveError = check.detail ? `${check.code} (${check.detail})` : check.code;
    }
  }

  const expectedTransferAttempts = Number(job.transferAttempts || 0);
  let plannedOutcome = effectiveState === 'complete'
    ? 'complete'
    : (retryAllowed && expectedTransferAttempts < 1 ? 'retrying' : 'failed');

  // A rejected complete file must be gone before activeDownloadId is released; otherwise the
  // retry is forced into a uniquified "(1)" name. The terminalNdcJobs lock around this handler
  // keeps status/restart nudges behind the remaining post-commit history work.
  if (plannedOutcome !== 'complete') {
    const discarded = await discardAbandonedDownload(downloadId, confirmedRecord);
    const latestArtifact = discarded ? null : await searchDownload(downloadId);
    const unsafeToReplace = !discarded && (
      (latestArtifact?.state === 'complete' && latestArtifact.exists !== false)
      || latestArtifact?.state === 'in_progress'
      || latestArtifact?.paused === true
      || latestArtifact?.canResume === true
    );
    if (unsafeToReplace) {
      retryAllowed = false;
      plannedOutcome = 'failed';
      effectiveError = `${effectiveError || 'interrupted'} cleanup_failed`;
    }
  }

  const expectedIndex = Number(job.index || 0);
  let outcome = '';
  const transition = await mutateNdcJobIf(
    job.id,
    (current) => ndcJobIsActive(current)
      && current.activeDownloadId === downloadId
      && Number(current.index || 0) === expectedIndex,
    (current) => {
      current.activeDownloadId = null;
      delete current.interruptConfirmations;
      outcome = plannedOutcome;
      if (plannedOutcome === 'complete') {
        current.completed = Number(current.completed || 0) + 1;
        current.transferAttempts = 0;
        current.index = Number(current.index || 0) + 1;
        if (landedIn) current.landedIn = landedIn;
      } else if (plannedOutcome === 'retrying') {
        current.transferAttempts = Number(current.transferAttempts || 0) + 1;
      } else {
        recordJobFailure(current, { fileId: item.fileId, code: effectiveError || 'interrupted' });
        current.transferAttempts = 0;
        current.index = Number(current.index || 0) + 1;
      }
    }
  );
  if (!transition.applied || !outcome) return null;
  job = transition.job;

  handledTerminalDownloads.add(downloadId);
  pendingTerminalDownloads.delete(downloadId);
  if (handledTerminalDownloads.size > 1000) {
    for (const id of handledTerminalDownloads) {
      handledTerminalDownloads.delete(id);
      if (handledTerminalDownloads.size <= 500) break;
    }
  }
  ndcDownloadJobs.delete(downloadId);

  if (outcome === 'complete') {
    for (const historyType of historyTypesFor(job, item)) {
      await STORAGE_HANDLERS.NDC_HISTORY_ADD({
        gameId: job.gameId,
        collectionId: job.collectionId,
        type: historyType,
        fileId: item.historyId ?? item.fileId
      });
    }
    await STORAGE_HANDLERS.TOTAL_DOWNLOADS_INCREMENT();
    notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
      itemName: item.name,
      itemState: 'complete'
    });
  } else {
    if (outcome === 'retrying') {
      notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
        itemName: item.name,
        itemState: 'retrying',
        error: effectiveError || 'interrupted'
      });
    } else {
      await recordQueueItemFailure(job, item, effectiveError || 'interrupted');
      notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
        itemName: item.name,
        itemState: 'failed',
        error: effectiveError || 'interrupted'
      });
    }
  }

  const afterEffects = await readNdcJob(job.id);
  return afterEffects?.status === 'running' ? job.id : null;
}

async function haltNdcJob(job, { notifyTabIds = [] } = {}) {
  let activeDownloadId = null;
  const transition = await mutateNdcJobIf(
    job.id,
    (current) => ndcJobIsActive(current),
    (current) => {
      activeDownloadId = current.activeDownloadId;
      current.status = 'stopped';
      current.activeDownloadId = null;
      if (Number.isInteger(activeDownloadId)) current.retiringDownloadId = activeDownloadId;
      delete current.interruptConfirmations;
      bumpNdcControl(current);
    }
  );
  job = transition.job || job;
  clearNdcJobAlarm(job.id);
  if (Number.isInteger(activeDownloadId)) {
    ndcDownloadJobs.delete(activeDownloadId);
    pendingTerminalDownloads.delete(activeDownloadId);
    await finishNdcRetirement(job.id, activeDownloadId);
  }
  notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: 'stopped' }, notifyTabIds);
  dropNdcJobItems(job.id);
  return job;
}

async function stopNdcJobsForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const jobs = await readNdcJobs();
  for (const job of Object.values(jobs)) {
    if (!ndcJobIsActive(job) || job.tabId !== tabId) continue;
    await haltNdcJob(job);
  }
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    stopNdcJobsForTab(tabId).catch((cause) => recordBackgroundError('owner tab closed', cause));
  });
}

const NDC_CLAIM_KEY = 'nxtk_ndc_run_claims';
const NDC_CLAIM_TTL_MS = 45000;

function cleanNdcClaims(stored) {
  const claims = Object.create(null);
  const now = Date.now();
  if (!stored || typeof stored !== 'object') return claims;
  for (const [key, claim] of Object.entries(stored)) {
    if (typeof key !== 'string' || !key.includes('/') || FORBIDDEN_KEYS.has(key)) continue;
    const tabId = Number(claim?.tabId);
    const at = Number(claim?.at);
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isFinite(at)) continue;
    if (now - at > NDC_CLAIM_TTL_MS) continue;
    claims[key] = { tabId, at };
  }
  return claims;
}

async function resolveNdcJob(payload) {
  const jobId = String(payload?.jobId || '');
  if (jobId) {
    const job = await readNdcJob(jobId);
    if (job) return job;
  }
  const gameId = String(payload?.gameId || '');
  const collectionId = String(payload?.collectionId || '');
  if (!isSafeId(gameId) || !isSafeId(collectionId)) return null;
  return findActiveNdcJobForCollection(gameId, collectionId);
}

const pendingNdcStarts = new Map();
const pendingNdcStartsByScope = new Map();
const canceledNdcStarts = new Map();
const ndcStartQueues = new Map();
const NDC_START_INTENT_TTL_MS = 2 * 60 * 1000;

function cleanNdcStartIntents() {
  const cutoff = Date.now() - NDC_START_INTENT_TTL_MS;
  for (const [startId, entry] of canceledNdcStarts) {
    if (Number(entry?.at || 0) < cutoff) canceledNdcStarts.delete(startId);
  }
}

function ndcStartId(payload) {
  const value = String(payload?.startId || '');
  return isSafeId(value) ? value : '';
}

function registerNdcStart(payload, gameId, collectionId) {
  cleanNdcStartIntents();
  const startId = ndcStartId(payload);
  const canceled = startId ? canceledNdcStarts.get(startId) : null;
  const scope = `${gameId}/${collectionId}`;
  const token = {
    id: startId,
    scope,
    gameId,
    collectionId,
    canceled: !!canceled && canceled.gameId === gameId && canceled.collectionId === collectionId
  };
  if (startId) pendingNdcStarts.set(startId, token);
  const scoped = pendingNdcStartsByScope.get(scope) || new Set();
  scoped.add(token);
  pendingNdcStartsByScope.set(scope, scoped);
  return token;
}

function cancelNdcStart(payload) {
  cleanNdcStartIntents();
  const startId = ndcStartId(payload);
  const gameId = String(payload?.gameId || '');
  const collectionId = String(payload?.collectionId || '');
  if (startId) {
    const token = pendingNdcStarts.get(startId);
    if (token && token.gameId === gameId && token.collectionId === collectionId) token.canceled = true;
    canceledNdcStarts.set(startId, { gameId, collectionId, at: Date.now() });
    return true;
  }
  const scoped = pendingNdcStartsByScope.get(`${gameId}/${collectionId}`);
  if (!scoped?.size) return false;
  for (const token of scoped) token.canceled = true;
  return true;
}

function releaseNdcStart(token) {
  if (!token) return;
  if (token.id && pendingNdcStarts.get(token.id) === token) pendingNdcStarts.delete(token.id);
  if (token.id) canceledNdcStarts.delete(token.id);
  const scoped = pendingNdcStartsByScope.get(token.scope);
  if (scoped) {
    scoped.delete(token);
    if (!scoped.size) pendingNdcStartsByScope.delete(token.scope);
  }
}

async function acquireNdcStartLock(scope) {
  const previous = ndcStartQueues.get(scope) || Promise.resolve();
  let releaseHold;
  const hold = new Promise((resolve) => { releaseHold = resolve; });
  const tail = previous.catch(() => undefined).then(() => hold);
  ndcStartQueues.set(scope, tail);
  await previous.catch(() => undefined);
  return () => {
    releaseHold();
    tail.finally(() => {
      if (ndcStartQueues.get(scope) === tail) ndcStartQueues.delete(scope);
    });
  };
}

const NDC_QUEUE_HANDLERS = {
  async NDC_QUEUE_START(payload, sender) {
    const tabId = Number(sender?.tab?.id);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('missing-tab');
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length || rawItems.length > MAX_NDC_JOB_ITEMS) throw new Error('invalid-job-size');
    const items = rawItems.map(sanitizeNdcJobItem);
    if (items.some((item) => !item)) throw new Error('invalid-job-item');
    const type = payload?.type === null || payload?.type === undefined ? null : payload.type;
    if (type !== null && !HISTORY_TYPES.has(type)) throw new Error('invalid-history-type');
    const gameId = String(payload?.gameId || '');
    const collectionId = String(payload?.collectionId || '');
    if (!isSafeId(gameId) || !isSafeId(collectionId)) throw new Error('invalid-collection-identifier');

    const startToken = registerNdcStart(payload, gameId, collectionId);
    const releaseStartLock = await acquireNdcStartLock(`${gameId}/${collectionId}`);
    try {
      if (startToken?.canceled) return { stopped: true };

    const scopeKey = ndcScopeKey(type, items);
    let existing = await findActiveNdcJobForCollection(gameId, collectionId);
    if (startToken?.canceled) return { stopped: true };
    const isReconnect = !!existing
      && !payload?.restart
      && existing.type === type
      && existing.scopeKey === scopeKey;
    if (isReconnect) {

      existing = (await mutateNdcJob(existing.id, (current) => { current.tabId = tabId; })) || existing;
      if (existing.status === 'running') {
        reconcileNdcJob(existing.id).catch((cause) => recordBackgroundError('resume adopted job', cause));
      }
      return {
        jobId: existing.id,
        total: ndcJobItemCount(existing),
        index: existing.index,
        completed: existing.completed,
        status: existing.status,
        adopted: true
      };
    }

    if (existing) {
      const supersededJobId = existing.id;
      let supersededDownloadId = null;
      const transition = await mutateNdcJobIf(
        existing.id,
        (current) => ndcJobIsActive(current),
        (current) => {
          supersededDownloadId = current.activeDownloadId;
          current.status = 'stopped';
          current.activeDownloadId = null;
          if (Number.isInteger(supersededDownloadId)) current.retiringDownloadId = supersededDownloadId;
          delete current.interruptConfirmations;
          bumpNdcControl(current);
        }
      );
      existing = transition.job || existing;
      clearNdcJobAlarm(existing.id);
      if (Number.isInteger(supersededDownloadId)) {
        ndcDownloadJobs.delete(supersededDownloadId);
        pendingTerminalDownloads.delete(supersededDownloadId);
        await finishNdcRetirement(existing.id, supersededDownloadId);
      }
      const oldProcessing = ndcProcessingJobs.get(supersededJobId);
      if (oldProcessing) await oldProcessing.catch(() => undefined);
      await waitForNdcTerminalJob(supersededJobId);
      dropNdcJobItems(existing.id);
    }

    if (startToken?.canceled) return { stopped: true };
    await waitForNdcCollectionWork(gameId, collectionId);
    if (startToken?.canceled) return { stopped: true };
    if (!await clearCollectionRetirements(gameId, collectionId)) {
      throw new Error('previous_download_not_retired');
    }

    const jobId = makeNdcJobId();
    await writeNdcJobItems(jobId, items);
    if (startToken?.canceled) {
      dropNdcJobItems(jobId);
      return { stopped: true };
    }
    const job = {
      id: jobId,
      tabId,
      gameId,
      collectionId,
      type,
      scopeKey,
      folder: sanitizePathSegment(payload?.folder, { allowDots: false }),
      requestTimeout: Math.min(Math.max(Number(payload?.requestTimeout) || 30000, 5000), 120000),
      itemCount: items.length,
      index: 0,
      completed: 0,
      failed: [],
      status: 'running',
      activeDownloadId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await saveNdcJob(job);
    if (startToken?.canceled) {
      await haltNdcJob(job, { notifyTabIds: [tabId] });
      return { jobId: job.id, total: items.length, stopped: true };
    }
    await processNdcJob(job.id);
    return { jobId: job.id, total: items.length };
    } finally {
      releaseStartLock();
      releaseNdcStart(startToken);
    }
  },

  async NDC_QUEUE_STATUS(payload) {
    const job = await resolveNdcJob(payload);
    if (!job) return null;

    if (job.status === 'running') {
      reconcileNdcJob(job.id).catch((cause) => recordBackgroundError('status nudge', cause));
    }
    return {
      jobId: job.id,
      status: job.status,
      index: job.index,
      total: ndcJobItemCount(job),
      completed: job.completed,
      failedCount: jobFailureCount(job),
      waitingUntil: Number(job.waitingUntil) || 0,
      lastError: String(job.lastError || '')
    };
  },

  async NDC_QUEUE_ATTACH(payload, sender) {
    const tabId = Number(sender?.tab?.id);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('missing-tab');
    const gameId = String(payload?.gameId || '');
    const collectionId = String(payload?.collectionId || '');
    if (!isSafeId(gameId) || !isSafeId(collectionId)) throw new Error('invalid-collection-identifier');

    const found = await findActiveNdcJobForCollection(gameId, collectionId);
    if (!found) return null;

    const job = await claimNdcJobOwnership(found, tabId);

    if (job.status === 'running') {
      reconcileNdcJob(job.id).catch((cause) => recordBackgroundError('attach nudge', cause));
    }

    return {
      jobId: job.id,
      status: job.status,
      index: job.index,
      total: ndcJobItemCount(job),
      completed: job.completed,
      failedCount: jobFailureCount(job),
      type: job.type
    };
  },

  async NDC_QUEUE_STOP(payload, sender) {
    const canceledPendingStart = cancelNdcStart(payload);
    const job = await resolveNdcJob(payload);
    if (!job) {
      if (canceledPendingStart) return { stopped: true, pending: true };
      throw new Error('job-not-found');
    }
    await haltNdcJob(job, { notifyTabIds: [Number(sender?.tab?.id)] });
    return { stopped: true };
  },

  async NDC_QUEUE_PAUSE(payload) {
    let job = await resolveNdcJob(payload);
    if (!job) throw new Error('job-not-found');
    const transition = await mutateNdcJobIf(
      job.id,
      (current) => current.status === 'running',
      (current) => {
        current.status = 'paused';
        bumpNdcControl(current);
      }
    );
    job = transition.job || job;
    notifyNdcJob(job, 'NXT_NDC_STATE');
    return { paused: job.status === 'paused' };
  },

  async NDC_QUEUE_RESUME(payload) {
    let job = await resolveNdcJob(payload);
    if (!job) throw new Error('job-not-found');
    const transition = await mutateNdcJobIf(
      job.id,
      (current) => current.status === 'paused',
      (current) => {
        current.status = 'running';
        bumpNdcControl(current);
      }
    );
    job = transition.job || job;
    notifyNdcJob(job, 'NXT_NDC_STATE');
    // A paused job can have finished or interrupted while the worker was asleep. Reconcile the
    // browser record first; processNdcJob alone intentionally refuses to touch an active id.
    if (job.status === 'running') await reconcileNdcJob(job.id);
    return { resumed: job.status === 'running' };
  },

  async NDC_RUN_CLAIM(payload, sender) {
    const tabId = Number(sender?.tab?.id);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('missing-tab');
    const gameId = String(payload?.gameId || '');
    const collectionId = String(payload?.collectionId || '');
    if (!isSafeId(gameId) || !isSafeId(collectionId)) throw new Error('invalid-collection-identifier');

    const liveJob = await findActiveNdcJobForCollection(gameId, collectionId);
    if (liveJob && liveJob.tabId !== tabId) {
      return { granted: false, heldBy: liveJob.tabId, reason: 'background-job' };
    }

    return enqueueStorageTask(NDC_CLAIM_KEY, async () => {
      const claims = cleanNdcClaims(await storageGetLocal(NDC_CLAIM_KEY, null));
      const key = `${gameId}/${collectionId}`;
      const held = claims[key];
      if (held && held.tabId !== tabId) return { granted: false, heldBy: held.tabId, reason: 'lease' };
      claims[key] = { tabId, at: Date.now() };
      await storageSetLocal(NDC_CLAIM_KEY, claims);
      return { granted: true };
    });
  },

  async NDC_RUN_RELEASE(payload, sender) {
    const tabId = Number(sender?.tab?.id);
    const gameId = String(payload?.gameId || '');
    const collectionId = String(payload?.collectionId || '');
    if (!isSafeId(gameId) || !isSafeId(collectionId)) return { released: false };

    return enqueueStorageTask(NDC_CLAIM_KEY, async () => {
      const claims = cleanNdcClaims(await storageGetLocal(NDC_CLAIM_KEY, null));
      const key = `${gameId}/${collectionId}`;
      if (!claims[key] || claims[key].tabId !== tabId) return { released: false };
      delete claims[key];
      await storageSetLocal(NDC_CLAIM_KEY, claims);
      return { released: true };
    });
  }
};

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    const name = String(alarm?.name || '');
    if (name === 'nxtk-reconcile') {
      reconcileNdcJobs().catch(() => {});
      cleanPendingTerminals();
      return;
    }
    if (!name.startsWith(NDC_ALARM_PREFIX)) return;
    reconcileNdcJob(name.slice(NDC_ALARM_PREFIX.length))
      .catch((cause) => recordBackgroundError('collection queue alarm', cause));
  });
}

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    const downloadId = Number(delta?.id);
    const state = String(delta?.state?.current || '');
    if (!Number.isInteger(downloadId) || !['complete', 'interrupted'].includes(state)) return;

    handleNdcDownloadTerminal(downloadId, state, delta?.error?.current || null)
      .then((nextJobId) => (nextJobId ? processNdcJob(nextJobId) : undefined))
      .catch((cause) => recordBackgroundError('collection download terminal', cause));
  });
}

function searchDownload(downloadId) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (getRuntimeError()) return resolve(null);
        resolve(Array.isArray(results) && results.length ? results[0] : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function reconcileNdcJob(jobId) {
  if (terminalNdcJobs.has(jobId)) return;
  let job = await readNdcJob(jobId);
  if (!job || job.status !== 'running') return;

  if (Number.isInteger(job.retiringDownloadId)) {
    if (!await finishNdcRetirement(job.id, job.retiringDownloadId)) {
      scheduleNdcJobAlarm(job.id, Date.now() + INTERRUPTED_RECHECK_MS);
      return;
    }
    job = await readNdcJob(jobId);
    if (!job || job.status !== 'running') return;
  }

  if (Number.isInteger(job.activeDownloadId)) {
    const record = await searchDownload(job.activeDownloadId);
    if (!record || record.state === 'complete' || record.state === 'interrupted') {
      const nextJobId = await handleNdcDownloadTerminal(
        job.activeDownloadId,
        record?.state || 'interrupted',
        record?.error || (record ? null : 'download-record-missing')
      );
      if (nextJobId) await processNdcJob(nextJobId);
    }
    return;
  }

  const waitingUntil = Number(job.waitingUntil) || 0;
  if (waitingUntil > Date.now()) {
    scheduleNdcJobAlarm(job.id, waitingUntil);
    return;
  }
  await processNdcJob(job.id);
}

async function reconcileNdcJobs() {
  if (!hasDownloadsApi()) return;
  const jobs = await readNdcJobs();
  let runningCount = 0;

  for (const job of Object.values(jobs)) {
    if (Number.isInteger(job.retiringDownloadId)) {
      if (!await finishNdcRetirement(job.id, job.retiringDownloadId)) {
        // Keep the global reconciliation alarm alive even for a stopped job: Stop promised not
        // to leave an attempt that can later resume beside a future run.
        runningCount++;
        if (job.status === 'running') {
          scheduleNdcJobAlarm(job.id, Date.now() + INTERRUPTED_RECHECK_MS);
        }
        continue;
      }
    }
    if (job.status !== 'running') continue;
    runningCount++;

    if (Number.isInteger(job.activeDownloadId)) {
      const record = await searchDownload(job.activeDownloadId);
      if (!record) {
        const nextJobId = await handleNdcDownloadTerminal(job.activeDownloadId, 'interrupted', 'download-record-missing');
        if (nextJobId) await processNdcJob(nextJobId);
        continue;
      }
      if (record.state === 'complete' || record.state === 'interrupted') {
        const nextJobId = await handleNdcDownloadTerminal(job.activeDownloadId, record.state, record.error || null);
        if (nextJobId) await processNdcJob(nextJobId);
      }
      continue;
    }

    const waitingUntil = Number(job.waitingUntil) || 0;
    if (waitingUntil > Date.now()) {
      scheduleNdcJobAlarm(job.id, waitingUntil);
      continue;
    }

    await processNdcJob(job.id);
  }

  try {
    if (runningCount === 0 && chrome.alarms?.clear) {
      chrome.alarms.clear('nxtk-reconcile');
    } else if (runningCount > 0 && chrome.alarms?.create) {
      chrome.alarms.create('nxtk-reconcile', { delayInMinutes: 5 });
    }
  } catch (_) { }
}

async function migrateNdcJobItems() {
  const stored = await storageGetLocal(NDC_JOBS_KEY, null);
  if (!stored || typeof stored !== 'object') return;
  const legacy = Object.entries(stored).filter(([, job]) => Array.isArray(job?.items) && job.items.length);
  if (!legacy.length) return;

  for (const [jobId, job] of legacy) await writeNdcJobItems(jobId, job.items);

  await enqueueStorageTask(NDC_JOBS_KEY, async () => {
    const current = await storageGetLocal(NDC_JOBS_KEY, null);
    if (!current || typeof current !== 'object') return;
    const next = Object.create(null);
    for (const [jobId, job] of Object.entries(current)) {
      if (!job || typeof job !== 'object') continue;
      if (!Array.isArray(job.items)) {
        next[jobId] = job;
        continue;
      }
      const { items, ...cursor } = job;
      cursor.itemCount = items.length;
      next[jobId] = cursor;
    }
    await storageSetLocal(NDC_JOBS_KEY, next);
  });
}

async function pruneOrphanedNdcItems() {
  const jobs = await readNdcJobs();
  const all = await new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (result) => resolve(getRuntimeError() ? null : result));
    } catch (_) {
      resolve(null);
    }
  });
  if (!all) return;
  const stale = Object.keys(all).filter((key) => (
    key.startsWith(NDC_ITEMS_KEY_PREFIX) && !jobs[key.slice(NDC_ITEMS_KEY_PREFIX.length)]
  ));
  if (!stale.length) return;
  for (const key of stale) ndcItemsCache.delete(key.slice(NDC_ITEMS_KEY_PREFIX.length));
  try {
    chrome.storage.local.remove(stale, () => void getRuntimeError());
  } catch (_) { }
}



migrateNdcJobItems()
  .then(() => reconcileNdcJobs())
  .catch((cause) => recordBackgroundError('reconcile collection jobs', cause));

if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    migrateNdcJobItems()
      .then(() => pruneOrphanedNdcItems())
      .then(() => reconcileNdcJobs())
      .catch((cause) => recordBackgroundError('reconcile on startup', cause));
  });
}

const TRUSTED_SENDER_URL = /^https:\/\/(?:[\w-]+\.)*nexusmods\.com\//i;

// Answers, not faults: pausing or stopping when no queue is running is a normal
// thing for a reader to do and must not fill the error log.
const EXPECTED_HANDLER_OUTCOMES = new Set(['job-not-found']);

function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.url) return true;
  if (sender.url.startsWith(chrome.runtime.getURL(''))) return true;
  return TRUSTED_SENDER_URL.test(sender.url);
}

// Reject untrusted senders before any privileged action.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;

  if (msg?.type === 'OPEN_REPORT_ISSUE') {
    const url = typeof msg.url === 'string' && msg.url.startsWith(NXTK.ISSUE_NEW_URL)
      ? msg.url
      : NXTK.REPORT_ISSUE_URL;
    chrome.tabs.create({ url }, (tab) => {
      const error = getRuntimeError();
      if (error) {
        recordBackgroundError('OPEN_REPORT_ISSUE', error);
        sendResponse({ ok: false, error });
        return;
      }
      sendResponse({ ok: true, tabId: tab?.id || null });
    });
    return true;
  }

  if (msg?.type === 'CLOSE_TAB') {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: 'No tab is available to close.' });
      return false;
    }
    chrome.tabs.remove(sender.tab.id, () => void getRuntimeError());
    sendResponse({ ok: true });
    return false;
  }

  const storageHandler = STORAGE_HANDLERS[msg?.type]
    || DOWNLOAD_HANDLERS[msg?.type]
    || NDC_QUEUE_HANDLERS[msg?.type];
  if (storageHandler) {
    storageHandler(msg.payload, sender)
      .then((value) => sendResponse({ ok: true, value, error: null }))
      .catch((cause) => {
        const message = String(cause?.message || cause || 'storage-mutation-failed');
        if (!EXPECTED_HANDLER_OUTCOMES.has(message)) recordBackgroundError(msg.type, message);
        sendResponse({ ok: false, value: null, error: message });
      });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') }, () => {
      const error = getRuntimeError();
      if (error) recordBackgroundError('onInstalled welcome', error);
    });
  }

  try {
    chrome.storage.local.remove(RETIRED_STORAGE_KEYS, () => void getRuntimeError());
  } catch (_) { }

  chrome.storage.local.get(NXTK.SETTINGS_KEY, (result) => {
    const readError = getRuntimeError();
    if (readError) {
      recordBackgroundError('onInstalled read', readError);
      return;
    }

    const stored = result?.[NXTK.SETTINGS_KEY];
    let next;
    if (stored) {
      const hasLegacyKeys = LEGACY_SETTINGS_KEYS.some((key) => key in stored);
      const hasStaleSpeed = Number(stored.NDC_downloadSpeed) === LEGACY_SPEED_DEFAULT;
      if (!hasLegacyKeys && !hasStaleSpeed) return;
      next = { ...stored };
      LEGACY_SETTINGS_KEYS.forEach((key) => delete next[key]);
      if (hasStaleSpeed) next.NDC_downloadSpeed = NXTK.DEFAULTS.NDC_downloadSpeed;
    } else {
      next = { ...NXTK.DEFAULTS };
    }

    chrome.storage.local.set({ [NXTK.SETTINGS_KEY]: next }, () => {
      const writeError = getRuntimeError();
      if (writeError) recordBackgroundError('onInstalled write', writeError);
    });
  });
});
