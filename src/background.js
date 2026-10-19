// shared.js holds the settings defaults, redaction and download-target rules the pages use;
// loading that same file here is what keeps the worker from drifting away from them.
if (typeof importScripts === 'function') {
  if (!globalThis.NXTK) importScripts('shared.js');
  if (!globalThis.NXTKResponseClassifier) importScripts('response-classifier.js');
  if (!globalThis.NXTKDownloadParser) importScripts('download-url-parser.js');
  if (!globalThis.NXTKAutoReports) importScripts('auto-reports.js');
}

const NXTK = globalThis.NXTK;
if (!NXTK?.validateDownloadTarget) throw new Error('shared-not-loaded');

const RESPONSE_CLASSIFIER = globalThis.NXTKResponseClassifier;
if (!RESPONSE_CLASSIFIER) throw new Error('response-classifier-not-loaded');

const DOWNLOAD_PARSER = globalThis.NXTKDownloadParser;
if (!DOWNLOAD_PARSER) throw new Error('download-url-parser-not-loaded');

const LEGACY_SETTINGS_KEYS = ['PlayErrorSound', 'ErrorSoundUrl', 'QuietSiteErrors', 'HideDownloadBar'];

const LEGACY_SPEED_DEFAULT = 1.5;
// A copy updating from 2.4.2 or later already went through this migration on an earlier update.
const LEGACY_SPEED_LAST_VERSION = '2.4.2';

function isVersionBefore(version, reference) {
  const parse = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(version);
  const right = parse(reference);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference < 0;
  }
  return false;
}

function getRuntimeError() {
  try {
    return chrome.runtime.lastError?.message || '';
  } catch (_) {
    return 'The extension context is no longer available.';
  }
}

// The worker's own storms (an alarm or listener failing on every event) are held back the same way
// pages hold back theirs (NXTK.recordError).
const admitBackgroundError = NXTK.createErrorThrottle();

function recordBackgroundError(context, cause) {
  const entry = NXTK.buildErrorEntry({
    code: 'background_error',
    context,
    userMessage: 'A background extension task failed.',
    technicalMessage: String(cause?.message || cause || ''),
    stack: String(cause?.stack || '')
  });
  if (!admitBackgroundError(entry)) return;
  appendErrorLogEntry(entry).catch(() => undefined);
}

const STORAGE_HISTORY_KEY = 'nxtk_ndc_history';
const HISTORY_TYPES = new Set(['all', 'mandatory', 'optional']);
// "Sent to Vortex" lists live beside the downloaded ones and never cause a skip.
const VORTEX_SENT_HISTORY_TYPES = new Set([...HISTORY_TYPES].map((type) => NXTK.vortexSentType(type)));
const isWritableHistoryType = (type) => HISTORY_TYPES.has(type) || VORTEX_SENT_HISTORY_TYPES.has(type);
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

// Code, context, status and where it was thrown: unhandled rejections all share one code and context,
// so without the frame a second, different bug was folded into the first one's entry.
function errorEntrySignature(entry) {
  return [
    String(entry?.code || ''),
    String(entry?.context || ''),
    Number.isInteger(entry?.status) ? String(entry.status) : '',
    NXTK.stackFrameOf(entry)
  ].join('|');
}

// Reports are opt-in. The persisted queue survives worker suspension and marks delivery only
// after the relay confirms it; repeated faults are grouped without delaying distinct new bugs.
const autoReports = new globalThis.NXTKAutoReports.Reporter({
  kit: NXTK, read: storageGetLocal, write: storageSetLocal, api: chrome
});

function maybeAutoReport(entry) {
  return autoReports.enqueue(entry);
}

const AUTO_REPORT_PROMPT_KEY = 'nxtk_auto_report_prompt_v1';

async function armAutoReportPrompt() {
  return enqueueStorageTask(AUTO_REPORT_PROMPT_KEY, async () => {
    const seen = await storageGetLocal(AUTO_REPORT_PROMPT_KEY, null);
    const settings = await storageGetLocal(NXTK.SETTINGS_KEY, null);
    if (seen?.shown || !NXTK.RELAY_CONFIGURED) return;
    if (settings?.AutoErrorReports) {
      await storageSetLocal(AUTO_REPORT_PROMPT_KEY, { pending: false, shown: true });
      return;
    }
    await storageSetLocal(AUTO_REPORT_PROMPT_KEY, { pending: true, shown: false });
  });
}

async function claimAutoReportPrompt(_payload, sender) {
  // A single visible Nexus tab claims the invitation, even when several load together.
  if (typeof sender?.tab?.id !== 'number' || sender.frameId > 0
    || !NXTK.isNexusPageUrl(sender.url)) return false;
  return enqueueStorageTask(AUTO_REPORT_PROMPT_KEY, async () => {
    const prompt = await storageGetLocal(AUTO_REPORT_PROMPT_KEY, null);
    const settings = await storageGetLocal(NXTK.SETTINGS_KEY, null);
    if (!prompt?.pending || prompt.shown || settings?.AutoErrorReports || !NXTK.RELAY_CONFIGURED) return false;
    await storageSetLocal(AUTO_REPORT_PROMPT_KEY, { pending: false, shown: true });
    return true;
  });
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
      if (entry.fileIdentity) log[index].fileIdentity = entry.fileIdentity;
      else delete log[index].fileIdentity;
      await storageSetLocal(NXTK.ERROR_LOG_KEY, log);
      await maybeAutoReport(entry).catch(() => undefined);
      return log.length;
    }

    log.push(entry);
    while (log.length > NXTK.MAX_LOGGED_ERRORS) log.shift();
    await storageSetLocal(NXTK.ERROR_LOG_KEY, log);
    await maybeAutoReport(entry).catch(() => undefined);
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
  AUTO_REPORT_PROMPT_CLAIM: claimAutoReportPrompt,
  async SETTINGS_PATCH(payload) {
    const patch = payload?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid-settings-patch');
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error('empty-settings-patch');
    const normalized = {};
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(NXTK.DEFAULTS, key)) throw new Error(`unknown-settings-key:${key}`);
      const value = NXTK.normalizeSetting(key, patch[key]);
      if (value === undefined) throw new Error(`invalid-settings-value:${key}`);
      normalized[key] = value;
    }
    return enqueueStorageTask(NXTK.SETTINGS_KEY, async () => {
      const stored = await storageGetLocal(NXTK.SETTINGS_KEY, null);
      const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      const next = { ...NXTK.DEFAULTS, ...base, ...normalized };
      const enablingBasicReports = base.AutoErrorReports !== true && normalized.AutoErrorReports === true;
      if (next.AutoErrorReports !== true || (enablingBasicReports && normalized.AutoReportDiagnostics !== true)) {
        next.AutoReportDiagnostics = false;
      }
      await storageSetLocal(NXTK.SETTINGS_KEY, next);
      if (normalized.AutoErrorReports === true) {
        await enqueueStorageTask(AUTO_REPORT_PROMPT_KEY, () => storageSetLocal(AUTO_REPORT_PROMPT_KEY, { pending: false, shown: true }));
      }
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
    const built = NXTK.buildErrorEntry(entry, 'background_error');
    const result = await appendErrorLogEntry(built);
    return result;
  },

  // The opt-in debug ring buffer (see NXTK.setDebugLogging). Entries are re-sanitized here, so a
  // caller cannot store anything a report would not be allowed to carry.
  async DEBUG_LOG_APPEND(payload) {
    const incoming = Array.isArray(payload?.entries) ? payload.entries.slice(-100) : [];
    if (!incoming.length) return { ok: true };
    return enqueueStorageTask(NXTK.DEBUG_LOG_KEY, async () => {
      const stored = await storageGetLocal(NXTK.DEBUG_LOG_KEY, []);
      const log = Array.isArray(stored) ? stored : [];
      for (const raw of incoming) {
        log.push({
          at: Number(raw?.at) || Date.now(),
          level: ['debug', 'info', 'warn', 'error'].includes(raw?.level) ? raw.level : 'info',
          page: String(raw?.page || '').slice(0, 20),
          text: NXTK.sanitizeDiagnosticText(raw?.text, 400)
        });
      }
      const trimmed = log.slice(-NXTK.MAX_DEBUG_ENTRIES);
      await storageSetLocal(NXTK.DEBUG_LOG_KEY, trimmed);
      return { ok: true, count: trimmed.length };
    });
  },

  async DEBUG_LOG_CLEAR() {
    await storageSetLocal(NXTK.DEBUG_LOG_KEY, []);
    return { ok: true };
  },

  async NDC_HISTORY_ADD(payload) {
    const { type, fileId } = payload || {};
    if (!isWritableHistoryType(type)) throw new Error('invalid-history-type');
    if (!isValidHistoryId(fileId)) throw new Error('invalid-file-id');
    return mutateHistory(payload, (collection) => {
      const list = readHistoryList(collection, type);
      if (list.length >= MAX_HISTORY_IDS) throw new Error('history-too-large');
      collection[type] = [...new Set([...list, fileId])];
    });
  },

  async NDC_HISTORY_CLEAR_TYPE(payload) {
    const { type } = payload || {};
    if (!isWritableHistoryType(type)) throw new Error('invalid-history-type');
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

// Chrome refuses a download path with a control or format character anywhere in a segment (a soft
// hyphen, a zero-width or direction mark, a byte-order mark), or with whitespace, a dot or a tilde at
// either end of one, and the download fails as "Invalid filename" (net::IsSafePortablePathComponent).
function trimSegmentEnds(segment) {
  return segment.replace(/^[\s.~]+|[\s.~]+$/gu, '');
}

function sanitizePathSegment(value, { allowDots = true } = {}) {
  let segment = String(value ?? '')
    .replace(/[\\/]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!allowDots) segment = segment.replace(/\./g, '');
  segment = segment
    .split(' ')
    .filter((token) => token && !/^\.+$/.test(token))
    .join(' ');
  segment = trimSegmentEnds(segment);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\..*)?$/i.test(segment)) segment = `_${segment}`;
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
  // Capping can cut a name or folder just before a space or a tilde, so the ends are tidied again.
  const name = trimSegmentEnds(capFileName(sanitizePathSegment(rawName))) || 'nexus-download';
  const dir = trimSegmentEnds(sanitizePathSegment(folder, { allowDots: false }).slice(0, MAX_DOWNLOAD_DIR_CHARS));
  return dir ? `${dir}/${name}` : name;
}

const DOWNLOAD_CONFLICT_ACTION = 'uniquify';

const DOWNLOAD_EXTENSIONS = new Set(NXTK.DOWNLOAD_FILE_EXTENSIONS);

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

// One user action, one file on disk. Every browser download a page asks for is checked here, in the
// one place every tab and every (possibly orphaned) content script shares: the same game+file within
// the window, or a download the browser already has for the same file (Nexus's own native download
// started in parallel included), is not started again.
const DOWNLOAD_DEDUPE_WINDOW_MS = 60 * 1000;
const recentDownloadStarts = new Map();

function downloadFileKey(payload) {
  const fileId = String(payload?.fileId || '').trim();
  if (!/^\d{1,12}$/.test(fileId)) return '';
  const gameId = String(payload?.gameId || '').trim();
  return `${/^\d{1,12}$/.test(gameId) ? gameId : '?'}:${fileId}`;
}

function urlPathKey(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.host}${decodeURIComponent(parsed.pathname)}`.toLowerCase();
  } catch (_) {
    return '';
  }
}

function downloadBaseName(value) {
  const name = String(value || '').split(/[\\/]/).pop() || '';
  // "file (1).zip" is the browser's rename of a second copy of "file.zip".
  return name.replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();
}

// The browser's own download that is the same file, if one is in progress or started in the window.
function findDuplicateDownload(items, { url, filename, now = Date.now(), windowMs = DOWNLOAD_DEDUPE_WINDOW_MS }) {
  const wantedPath = urlPathKey(url);
  const wantedName = downloadBaseName(filename);
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.state === 'interrupted' || item.error) continue;
    const started = Date.parse(item.startTime || '') || 0;
    const recent = item.state === 'in_progress' || (started && now - started <= windowMs);
    if (!recent) continue;
    const samePath = wantedPath && [item.url, item.finalUrl].some((u) => urlPathKey(u) === wantedPath);
    const sameName = wantedName && wantedName.length > 4 && downloadBaseName(item.filename) === wantedName;
    if (samePath || sameName) return item;
  }
  return null;
}

function searchRecentDownloads(now) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.search({ startedAfter: new Date(now - DOWNLOAD_DEDUPE_WINDOW_MS).toISOString() }, (items) => {
        resolve(getRuntimeError() ? [] : (items || []));
      });
    } catch (_) {
      resolve([]);
    }
  });
}

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
    const now = Date.now();
    for (const [key, entry] of recentDownloadStarts) {
      if (now - entry.at > DOWNLOAD_DEDUPE_WINDOW_MS) recentDownloadStarts.delete(key);
    }
    const fileKey = downloadFileKey(payload);
    const previous = fileKey ? recentDownloadStarts.get(fileKey) : null;
    if (previous) {
      // Started (or starting) already: hand back the same result instead of a second file.
      const earlier = await previous.result.catch(() => null);
      if (earlier) return { ...earlier, duplicate: true };
    }
    // Registered before anything is awaited, so two requests arriving together share one start.
    const result = (async () => {
      const existing = findDuplicateDownload(await searchRecentDownloads(now), { url: verdict.url, filename: requestedName, now });
      if (existing) return { downloadId: existing.id, filename: existing.filename || filename, duplicate: true };
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
    })();
    if (fileKey) {
      recentDownloadStarts.set(fileKey, { at: now, result });
      result.catch(() => recentDownloadStarts.delete(fileKey));
    }
    return result;
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
  // Progress only needs the debounced check; a finished, stopped or failed job gives the popup back now.
  syncDownloadUi({ immediate: type === 'NXT_NDC_DONE' });
  const targets = new Set();
  if (Number.isInteger(job?.tabId) && job.tabId >= 0) targets.add(job.tabId);
  for (const tabId of alsoTabIds) {
    if (Number.isInteger(tabId) && tabId >= 0) targets.add(tabId);
  }
  if (!targets.size) return;

  const message = {
    type,
    jobId: job.id,
    startId: job.startId || null,
    gameId: job.gameId,
    collectionId: job.collectionId,
    status: job.status,
    index: job.index,
    total: ndcJobItemCount(job),
    completed: job.completed,
    failedCount: jobFailureCount(job),
    skippedCount: jobSkipCount(job),
    ...extra
  };
  for (const tabId of targets) {
    try {
      chrome.tabs.sendMessage(tabId, message, () => void getRuntimeError());
    } catch (_) { }
  }
}

function classifyNexusResponse(response, text) {
  return RESPONSE_CLASSIFIER.classify({
    text,
    finalUrl: response?.url || '',
    cfMitigated: response?.cfMitigated || '',
    contentType: response?.contentType || ''
  });
}

async function fetchNdcResponse(url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = NXTK.normalizeSetting('RequestTimeout', Number(timeoutMs) || NXTK.DEFAULTS.RequestTimeout);
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
  const startedAt = Date.now();
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
    return {
      ok: false,
      status: 0,
      text: '',
      url,
      error: timedOut ? 'timed out' : String(cause?.message || cause),
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A request that got no HTTP answer at all, in words a report can carry: what failed, after how long,
// and whether the browser itself knew it was offline.
function connectionFailureDetail(step, response) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false ? '; browser offline' : '';
  return `${step}: ${response.error || 'no answer'} after ${Number(response.elapsedMs) || 0}ms${offline}`;
}

const MIN_NDC_ALARM_DELAY_MS = 30000;

function retryAfterMilliseconds(raw, strike = 1, random = Math.random) {
  const seconds = NXTK.parseRetryAfterSeconds(raw);
  if (seconds !== null) return Math.max(MIN_NDC_ALARM_DELAY_MS, seconds * 1000);
  return NXTK.withJitter(NXTK.rateLimitBackoffSeconds(strike) * 1000, random);
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
  // No answer at all from the file's page means Nexus cannot be reached, not that this file is bad:
  // advanceNdcJob waits for the connection on this same file instead of failing it.
  if (page.status === 0) return { ...ndcResolveFailure('network_error', page), detail: connectionFailureDetail('page', page) };
  const pageIssue = classifyNexusResponse(page, page.text);
  if (pageIssue) return { ok: false, code: pageIssue.code };
  if (page.status === 404 || page.status === 410) return ndcResolveFailure('mod_unavailable', page);
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
  if (generated.status === 404 || generated.status === 410) return ndcResolveFailure('file_not_found', generated);
  if (!generated.ok) {
    const failure = ndcResolveFailure(generated.status === 429 ? 'rate_limited' : 'generate_failed', generated);
    // The page answered a moment ago, so a link request with no answer is that request's own fault
    // (blocked, or cut off), and stays a failure of this file.
    return generated.status === 0 ? { ...failure, detail: connectionFailureDetail('generator', generated) } : failure;
  }

  // Scoped to this file, so a response that lists several files cannot hand back another one's link.
  const found = DOWNLOAD_PARSER.findDownloadLink(generated.text, { mode: 'browser', fileId: item.fileId });
  // The parser applies the same rules; they are checked again because this is the last stop before
  // the URL reaches chrome.downloads.
  const verdict = NXTK.validateDownloadTarget(found?.url, { method: 1 });
  if (!verdict.ok) {
    // What both answers looked like, never their content, so a report says why there was no link.
    const shape = (response) => DOWNLOAD_PARSER.explainMissingLink(response.text, { mode: 'browser', fileId: item.fileId });
    // The deck tab writes the ad-timer cookie for the queue only while "Hide ads and Premium panels" is
    // on; without it Nexus can hold the link back, which looks the same as no link (see nnw.js).
    const settings = await storageGetLocal(NXTK.SETTINGS_KEY, null);
    return {
      ok: false,
      code: 'no_download_url',
      detail: [
        `generator HTTP ${generated.status}: ${found ? `link refused (${verdict.detail})` : shape(generated)}`,
        `page HTTP ${page.status}: ${shape(page)}`,
        settings?.HidePremiumUpsells === false ? 'ad timer cookie off' : ''
      ].filter(Boolean).join(' | ')
    };
  }
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
  if (job.type && !jobFailureCount(job) && !jobSkipCount(job)) {
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
      current.status = jobFailureCount(current) || jobSkipCount(current) ? 'partial' : 'finished';
      current.activeDownloadId = null;
      current.finishedAt = Date.now();
      bumpNdcControl(current);
    }
  );
  if (!transition.applied) return transition.job || job;
  job = transition.job;
  clearNdcJobAlarm(job.id);
  notifyNdcJob(job, 'NXT_NDC_DONE', {
    outcome: job.status,
    folder: job.landedIn || '',
    skipped: jobSkippedList(job)
  });
  dropNdcJobItems(job.id);
  return job;
}

const NDC_RESOLVE_RETRY_DELAY_MS = 1500;
const NDC_RESOLVE_RETRY_MAX_MS = 15000;
const NDC_RESOLVE_MAX_ATTEMPTS = 3;
const NDC_TRANSFER_RETRY_BASE_MS = 2000;
const NDC_TRANSFER_RETRY_MAX_MS = 20000;
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

// The compare-and-set guard behind every transition in advanceNdcJob: work that began on an
// earlier item, or before a Stop or a new download, must not move the queue.
function idleOnItem(index) {
  return (current) => current.status === 'running'
    && current.activeDownloadId === null
    && Number(current.index || 0) === index;
}

// Nexus could not be reached for this file even after the quick retries. Failing it and moving on
// failed every file after it as well, within seconds, so the run waits on this same file instead, with
// growing alarms (NXTK.networkWaitMs). When the waits run out it stops with one error, and starting it
// again carries on from the download history.
async function waitForNdcConnection(job, item, startIndex, resolved) {
  let waitingUntil = 0;
  const transition = await mutateNdcJobIf(
    job.id,
    idleOnItem(startIndex),
    (current) => {
      current.resolveAttempts = 0;
      const strikes = Number(current.networkStrikes || 0) + 1;
      if (strikes > NXTK.NETWORK_WAIT_MAX_STRIKES) {
        current.status = 'error';
        current.lastError = 'network_error';
        current.networkStrikes = 0;
        current.waitingUntil = 0;
        recordJobFailure(current, { fileId: item.fileId, code: 'network_error' });
        bumpNdcControl(current);
        return;
      }
      current.networkStrikes = strikes;
      current.waitingUntil = Date.now() + NXTK.networkWaitMs(strikes);
      waitingUntil = current.waitingUntil;
    }
  );
  if (!transition.applied) return null;
  job = transition.job;
  if (!waitingUntil) {
    clearNdcJobAlarm(job.id);
    notifyNdcJob(job, 'NXT_NDC_DONE', {
      outcome: 'error',
      error: 'network_error',
      itemName: item.name,
      skipped: jobSkippedList(job)
    });
    dropNdcJobItems(job.id);
    await recordQueueItemFailure(job, item, 'network_error', resolved.detail);
    return null;
  }
  scheduleNdcJobAlarm(job.id, waitingUntil);
  notifyNdcJob(job, 'NXT_NDC_WAITING', {
    itemName: item.name,
    until: waitingUntil,
    reason: 'network'
  });
  return null;
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
        idleOnItem(waitingIndex),
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

    // Any answer from Nexus means the connection is back, so a later drop starts its waits afresh.
    if (resolved.code !== 'network_error' && Number(job.networkStrikes || 0) > 0) {
      const transition = await mutateNdcJobIf(
        job.id,
        idleOnItem(startIndex),
        (current) => { current.networkStrikes = 0; }
      );
      if (!transition.applied) return null;
      job = transition.job;
    }

    if (!resolved.ok) {
      if (resolved.code === 'rate_limited') {
        let waitingUntil = 0;
        const transition = await mutateNdcJobIf(
          job.id,
          idleOnItem(startIndex),
          (current) => {
            current.rateLimitStrikes = Math.min(Number(current.rateLimitStrikes || 0) + 1, NXTK.RATE_LIMIT_MAX_STRIKES);
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

      // A gone mod, or one Cloudflare answer, is skipped at once and the queue moves on. Cloudflare on
      // several files running falls through to the stop below, as a check the user has to complete.
      const skipReason = NXTK.queueSkipReason(resolved.code, job.cloudflareStrikes);
      if (skipReason) {
        const transition = await mutateNdcJobIf(
          job.id,
          idleOnItem(startIndex),
          (current) => {
            recordJobSkip(current, item, skipReason);
            current.cloudflareStrikes = skipReason === 'cloudflare'
              ? Number(current.cloudflareStrikes || 0) + 1
              : 0;
            current.resolveAttempts = 0;
            current.index = Number(current.index || 0) + 1;
          }
        );
        if (!transition.applied) return null;
        job = transition.job;
        notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
          itemName: item.name,
          itemState: 'skipped',
          error: skipReason
        });
        // A mod that is gone is the mod's state, not a fault, so only a Cloudflare skip is worth a
        // line in the bug report.
        if (skipReason === 'cloudflare') await recordQueueItemFailure(job, item, 'cloudflare', 'skipped');
        continue;
      }

      if (BLOCKING_RESOLVE_CODES.has(resolved.code)) {
        const transition = await mutateNdcJobIf(
          job.id,
          idleOnItem(startIndex),
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
        notifyNdcJob(job, 'NXT_NDC_DONE', {
          outcome: resolved.code,
          itemName: item.name,
          skipped: jobSkippedList(job)
        });
        dropNdcJobItems(job.id);
        await recordQueueItemFailure(job, item, resolved.code);
        return null;
      }
      const attempts = Number(job.resolveAttempts || 0) + 1;
      if (attempts < NDC_RESOLVE_MAX_ATTEMPTS) {
        const transition = await mutateNdcJobIf(
          job.id,
          idleOnItem(startIndex),
          (current) => { current.resolveAttempts = attempts; }
        );
        if (!transition.applied) return null;
        await waitMs(NXTK.retryDelayMs(attempts, NDC_RESOLVE_RETRY_DELAY_MS, NDC_RESOLVE_RETRY_MAX_MS));
        continue;
      }
      if (resolved.code === 'network_error') return waitForNdcConnection(job, item, startIndex, resolved);
      const failureCode = resolved.code || 'request_failed';
      const transition = await mutateNdcJobIf(
        job.id,
        idleOnItem(startIndex),
        (current) => {
          recordJobFailure(current, { fileId: item.fileId, code: failureCode });
          current.resolveAttempts = 0;
          current.cloudflareStrikes = 0;
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
      await recordQueueItemFailure(job, item, failureCode,
        resolved.detail || (resolved.status ? `HTTP ${resolved.status}` : ''));
      continue;
    }

    // One file the browser refuses to start must not take the rest of the queue
    // down with it: record it and move on, the way a failed resolve does.
    let started;
    try {
      started = await startNdcDownload(job, item, resolved.url);
    } catch (cause) {
      const transition = await mutateNdcJobIf(
        job.id,
        idleOnItem(startIndex),
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

    const startedPath = downloadUrlPath(resolved.url);
    const claim = await mutateNdcJobIf(
      jobId,
      idleOnItem(startIndex),
      (current) => {
        current.activeDownloadId = started.downloadId;
        current.activeDownloadPath = startedPath;
        current.rateLimitStrikes = 0;
        current.cloudflareStrikes = 0;
        current.waitingUntil = 0;
        current.resolveAttempts = 0;
        delete current.interruptConfirmations;
      }
    );
    const afterStart = claim.job;
    if (!claim.applied || !afterStart) {
      ndcDownloadJobs.delete(started.downloadId);
      pendingTerminalDownloads.delete(started.downloadId);
      await setNdcRetirement(jobId, started.downloadId, startedPath);
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
      itemState: 'started',
      itemSizeKb: item.sizeKb || 0
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
        if (Number.isInteger(failedDownloadId)) retireActiveDownload(current, failedDownloadId);
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

// What the UI needs to name a skipped file: its name, its page and why. Bounded like failures.
function recordJobSkip(current, item, reason) {
  if (!Array.isArray(current.skipped)) current.skipped = [];
  current.skippedTotal = Number(current.skippedTotal || current.skipped.length || 0) + 1;
  if (current.skipped.length < NXTK.MAX_TRACKED_SKIPS) {
    current.skipped.push({
      fileId: item.fileId,
      name: String(item.name || '').slice(0, 300),
      pageUrl: String(item.pageUrl || ''),
      reason
    });
  }
}

function jobSkipCount(job) {
  const total = Number(job?.skippedTotal);
  if (Number.isFinite(total) && total >= 0) return total;
  return Array.isArray(job?.skipped) ? job.skipped.length : 0;
}

function jobSkippedList(job) {
  return Array.isArray(job?.skipped) ? job.skipped.slice(0, NXTK.MAX_TRACKED_SKIPS) : [];
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

// Resolves true once the browser confirms the action. Firefox may answer through the returned
// promise rather than the callback, so whichever arrives first decides.
function controlDownload(method, target) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome.downloads?.[method] !== 'function') return resolve(false);
      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        resolve(ok);
      };
      const pending = chrome.downloads[method](target, () => done(!getRuntimeError()));
      if (pending && typeof pending.then === 'function') pending.then(() => done(true), () => done(false));
    } catch (_) {
      resolve(false);
    }
  });
}

function cancelDownload(downloadId) {
  return controlDownload('cancel', downloadId);
}

function resumeDownload(downloadId) {
  return controlDownload('resume', downloadId);
}

function isResumableInterrupt(record) {
  return record?.state === 'interrupted' && record.canResume === true && record.paused !== true;
}

// Firefox's cancel discards an interrupted download's partial data. Chrome's only acts on a download
// in progress: an interrupted one is left resumable, and the callback reports success all the same,
// so the user could still resume it from the downloads page beside a retry. Erasing it is what Chrome
// honours there: the partial file is discarded and the record is gone, so nothing can resume it.
// True only once the record is confirmed gone.
async function eraseResumableDownload(downloadId, record) {
  if (!isResumableInterrupt(record) || !downloadWasStartedHere(record)) return false;
  if (!await controlDownload('erase', { id: downloadId })) return false;
  return !await searchDownload(downloadId);
}

// Only ever a download this worker started: every id reaching here came out of our own
// chrome.downloads.download call, and where the browser attributes the record we re-check it.
// A record that names another extension is never touched.
function downloadWasStartedHere(record) {
  const owner = String(record?.byExtensionId || '');
  return !owner || owner === chrome.runtime?.id;
}

// What tells a job's own download apart: the path of the link it was started from. Firefox numbers
// downloads afresh in every browser session and gives the ones it reloads no byExtensionId, so after a
// restart the id a job saved can name somebody else's download, which was then counted as this file,
// or cancelled and deleted by Stop. A job saved by an older version has no path, and its id is trusted
// as before.
function downloadUrlPath(url) {
  let path = '';
  try {
    path = new URL(String(url || '')).pathname;
  } catch (_) {
    return '';
  }
  try {
    path = decodeURIComponent(path);
  } catch (_) { }
  return path.toLowerCase();
}

// Only a record that names a different link counts as somebody else's; one with no link to compare
// is trusted, as before.
function isSomeoneElsesDownload(record, expectedPath) {
  const recordPath = downloadUrlPath(record?.url);
  return !!expectedPath && !!recordPath && recordPath !== expectedPath;
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

async function retireNdcDownload(downloadId, expectedPath = '') {
  if (!Number.isInteger(downloadId)) return true;
  // Nothing of this job's is left under that id: it is not cancelled, and its file is not touched.
  if (expectedPath && isSomeoneElsesDownload(await searchDownload(downloadId), expectedPath)) return true;
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
  // Chrome's cancel left it resumable (see eraseResumableDownload).
  if (isResumableInterrupt(record)) return eraseResumableDownload(downloadId, record);
  if (record.state === 'in_progress' || record.paused === true || record.canResume === true) return false;
  // The bug that motivated this fix reports an interrupted/non-resumable snapshot and then carries
  // on. Only a successful cancel is strong enough to permit a replacement download.
  return canceled;
}

// Inside a job mutation: the download being let go is retired along with the link path it came from.
function retireActiveDownload(current, downloadId) {
  current.retiringDownloadId = downloadId;
  if (current.activeDownloadPath) current.retiringDownloadPath = current.activeDownloadPath;
  else delete current.retiringDownloadPath;
}

async function setNdcRetirement(jobId, downloadId, downloadPath = '') {
  return mutateNdcJobIf(
    jobId,
    (current) => !!current,
    (current) => {
      current.retiringDownloadId = downloadId;
      if (downloadPath) current.retiringDownloadPath = downloadPath;
      else delete current.retiringDownloadPath;
    }
  );
}

async function clearNdcRetirement(jobId, downloadId) {
  return mutateNdcJobIf(
    jobId,
    (current) => current.retiringDownloadId === downloadId,
    (current) => {
      delete current.retiringDownloadId;
      delete current.retiringDownloadPath;
    }
  );
}

async function finishNdcRetirement(jobId, downloadId) {
  if (!Number.isInteger(downloadId)) return true;
  const job = await readNdcJob(jobId);
  const expectedPath = job?.retiringDownloadId === downloadId ? String(job.retiringDownloadPath || '') : '';
  if (!await retireNdcDownload(downloadId, expectedPath)) return false;
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
    causeCode: rootCode,
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
  // Firefox after a restart: the id names somebody else's download now. That record is never
  // counted, resumed, cancelled or deleted, and this job's own download is treated as lost.
  const reused = !!job.activeDownloadPath
    && isSomeoneElsesDownload(await searchDownload(downloadId), job.activeDownloadPath);
  if (reused) {
    state = 'interrupted';
    error = 'download-record-missing';
  }
  // Confirmed before it is believed, and before the id is marked handled: a download still running
  // is not terminal at all, and marking it handled here is what made the real 'complete' that
  // followed get dropped on the floor while a retry ran beside it.
  let confirmedState = state;
  let confirmedRecord = null;
  let retryAllowed = true;
  let resumeGaveUp = false;
  if (state === 'interrupted' && !reused) {
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
        // Repeated resume attempts left the same resumable record behind. It is closed below before
        // any retry, so no second id can ever run beside this one; one that stays resumable fails.
        settled = { state: 'interrupted', record: settled.record };
        resumeGaveUp = true;
      }
    }
    confirmedState = settled.state;
    confirmedRecord = settled.record;
    if (confirmedState === 'complete') error = null;

    // Before retrying, explicitly close the old attempt. The cancel callback only runs once the
    // browser says that id is canceled, complete, interrupted or gone. If it completed in the
    // meantime, accept that exact attempt instead of launching a duplicate.
    if (confirmedState === 'interrupted') {
      let canceled = await cancelDownload(downloadId);
      let afterCancel = await searchDownload(downloadId);
      if (resumeGaveUp && isResumableInterrupt(afterCancel)) {
        // Chrome's cancel left it resumable (see eraseResumableDownload).
        if (await eraseResumableDownload(downloadId, afterCancel)) {
          canceled = true;
          afterCancel = null;
        } else {
          retryAllowed = false;
        }
      }
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
  // How many fresh attempts a failure earns depends on why it failed: a dropped connection is worth
  // two more tries, a full disk or a browser block none.
  const interrupt = effectiveState === 'complete' ? null : NXTK.classifyDownloadInterrupt(effectiveError);
  let plannedOutcome = effectiveState === 'complete'
    ? 'complete'
    : (retryAllowed && expectedTransferAttempts < interrupt.retries ? 'retrying' : 'failed');
  if (plannedOutcome === 'failed' && interrupt && interrupt.kind !== 'unknown' && effectiveError
    && !String(effectiveError).includes(`[${interrupt.kind}]`)) {
    effectiveError = `${effectiveError} [${interrupt.kind}]`;
  }
  // A full disk, or a folder the browser cannot write to, fails every file after this one as well,
  // each after asking Nexus for a link. The run stops on this file instead, so starting it again once
  // there is room picks up here.
  const cannotSave = plannedOutcome === 'failed' && /\bFILE_(?:NO_SPACE|ACCESS_DENIED)\b/i.test(String(effectiveError || ''));

  // A rejected complete file must be gone before activeDownloadId is released; otherwise the
  // retry is forced into a uniquified "(1)" name. The terminalNdcJobs lock around this handler
  // keeps status/restart nudges behind the remaining post-commit history work.
  if (plannedOutcome !== 'complete' && !reused) {
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
      } else if (cannotSave) {
        recordJobFailure(current, { fileId: item.fileId, code: effectiveError });
        current.transferAttempts = 0;
        current.status = 'error';
        current.lastError = 'save_failed';
        bumpNdcControl(current);
      } else {
        recordJobFailure(current, { fileId: item.fileId, code: effectiveError || 'interrupted' });
        current.transferAttempts = 0;
        current.index = Number(current.index || 0) + 1;
      }
    }
  );
  if (!transition.applied || !outcome) return null;
  job = transition.job;
  if (cannotSave) {
    handledTerminalDownloads.add(downloadId);
    pendingTerminalDownloads.delete(downloadId);
    ndcDownloadJobs.delete(downloadId);
    clearNdcJobAlarm(job.id);
    notifyNdcJob(job, 'NXT_NDC_DONE', {
      outcome: 'error',
      error: 'save_failed',
      itemName: item.name,
      skipped: jobSkippedList(job)
    });
    dropNdcJobItems(job.id);
    await recordQueueItemFailure(job, item, 'save_failed', effectiveError);
    return null;
  }

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
      itemState: 'complete',
      itemSizeKb: item.sizeKb || 0
    });
  } else {
    if (outcome === 'retrying') {
      notifyNdcJob(job, 'NXT_NDC_PROGRESS', {
        itemName: item.name,
        itemState: 'retrying',
        error: effectiveError || 'interrupted'
      });
      // Back off before asking Nexus for the file again, so a flaky connection is not hammered.
      await waitMs(NXTK.retryDelayMs(Number(job.transferAttempts || 1), NDC_TRANSFER_RETRY_BASE_MS, NDC_TRANSFER_RETRY_MAX_MS));
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

async function haltNdcJob(job, { notify = true, notifyTabIds = [] } = {}) {
  let activeDownloadId = null;
  const transition = await mutateNdcJobIf(
    job.id,
    (current) => ndcJobIsActive(current),
    (current) => {
      activeDownloadId = current.activeDownloadId;
      current.status = 'stopped';
      current.activeDownloadId = null;
      if (Number.isInteger(activeDownloadId)) retireActiveDownload(current, activeDownloadId);
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
  if (notify) notifyNdcJob(job, 'NXT_NDC_DONE', { outcome: 'stopped' }, notifyTabIds);
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

// Chrome's download bubble opens for every file, which on a long collection run is noise. With
// HideDownloadPopup on, it is switched off while any collection run is active (a page-driven run
// holds a claim; a background queue has a running job) and switched back on as soon as none is.
// Firefox has no downloads.setUiOptions, so this is a no-op there.
function downloadUiShouldBeEnabled({ setting, claims, jobs }) {
  if (!setting) return true;
  // A Vortex run hands nxm:// links to Vortex and downloads nothing in the browser, so it never hides
  // the bubble (that would only hide the user's own unrelated downloads).
  const claimed = Object.values(claims || {}).some((claim) => claim?.method !== 'vortex');
  const running = Object.values(jobs || {}).some((job) => job?.status === 'running');
  return !(claimed || running);
}

const DOWNLOAD_UI_ALARM = 'nxtk-download-ui';
// Our last applied preference, not the global visibility: other extensions may also hide the UI.
let downloadUiEnabled = null;
let downloadUiSync = Promise.resolve();
let downloadUiTimer = null;
// Called on every queue event and claim renewal; one storage pass per half second is plenty.
function syncDownloadUi({ immediate = false } = {}) {
  if (immediate) {
    clearTimeout(downloadUiTimer);
    downloadUiTimer = null;
    return runDownloadUiSync();
  }
  if (downloadUiTimer) return downloadUiSync;
  downloadUiTimer = setTimeout(() => {
    downloadUiTimer = null;
    runDownloadUiSync();
  }, 500);
  return downloadUiSync;
}
function runDownloadUiSync() {
  downloadUiSync = downloadUiSync.then(async () => {
    if (typeof chrome.downloads?.setUiOptions !== 'function') return;
    let enabled = true;
    try {
      const settings = { ...NXTK.DEFAULTS, ...(await storageGetLocal(NXTK.SETTINGS_KEY, null) || {}) };
      enabled = downloadUiShouldBeEnabled({
        setting: !!settings.HideDownloadPopup,
        claims: cleanNdcClaims(await storageGetLocal(NDC_CLAIM_KEY, null)),
        jobs: await readNdcJobs()
      });
    } catch (_) {
      enabled = true;
    }
    if (enabled === downloadUiEnabled) return;
    try {
      await chrome.downloads.setUiOptions({ enabled });
    } catch (cause) {
      // Chromium releases our restriction before checking whether another extension still hides
      // the UI. That specific enabling rejection means our work is done; it is not a task failure
      // and retrying cannot override the other extension. All other failures remain reportable.
      if (!enabled || String(cause?.message || cause || '') !== 'Another extension has disabled the download UI') {
        recordBackgroundError('download popup toggle', cause);
        return;
      }
    }
    downloadUiEnabled = enabled;
    // While it is off, re-check every minute so a run that ended without a release (a crashed
    // or closed tab, whose claim simply expires) still gives the popup back.
    try {
      if (!enabled) chrome.alarms?.create?.(DOWNLOAD_UI_ALARM, { delayInMinutes: 1 });
      else chrome.alarms?.clear?.(DOWNLOAD_UI_ALARM);
    } catch (_) {
    }
  }).catch(() => undefined);
  return downloadUiSync;
}

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
    claims[key] = { tabId, at, method: claim?.method === 'vortex' ? 'vortex' : 'browser' };
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
      // Replaced, not stopped by the reader, so no tab is told the collection stopped. The old
      // worker pass and its terminal work are waited out before the replacement may start.
      await haltNdcJob(existing, { notify: false });
      const oldProcessing = ndcProcessingJobs.get(existing.id);
      if (oldProcessing) await oldProcessing.catch(() => undefined);
      await waitForNdcTerminalJob(existing.id);
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
      startId: startToken.id || null,
      label: String(payload?.label || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      folder: sanitizePathSegment(payload?.folder, { allowDots: false }),
      requestTimeout: NXTK.normalizeSetting('RequestTimeout', Number(payload?.requestTimeout) || NXTK.DEFAULTS.RequestTimeout),
      itemCount: items.length,
      index: 0,
      completed: 0,
      failed: [],
      skipped: [],
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
      skippedCount: jobSkipCount(job),
      skipped: jobSkippedList(job),
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

  // Every run the worker is still holding. A modlist deck cannot be reattached after a reload,
  // so the popup is where such a run can still be seen and stopped.
  async NDC_QUEUE_LIST() {
    const jobs = await readNdcJobs();
    return Object.values(jobs)
      .filter(ndcJobIsActive)
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .map((job) => ({
        jobId: job.id,
        label: String(job.label || job.collectionId || ''),
        status: job.status,
        index: Math.max(0, Number(job.index) || 0),
        total: ndcJobItemCount(job),
        completed: Number(job.completed) || 0,
        failedCount: jobFailureCount(job),
        waitingUntil: Number(job.waitingUntil) || 0
      }));
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
      claims[key] = { tabId, at: Date.now(), method: payload?.method === 'vortex' ? 'vortex' : 'browser' };
      await storageSetLocal(NDC_CLAIM_KEY, claims);
      syncDownloadUi();
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
      syncDownloadUi({ immediate: true });
      return { released: true };
    });
  }
};

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes?.[NXTK.SETTINGS_KEY]) {
      syncDownloadUi();
      const { oldValue, newValue } = changes[NXTK.SETTINGS_KEY];
      if (!newValue?.AutoErrorReports || (oldValue?.AutoReportDiagnostics && !newValue?.AutoReportDiagnostics)) {
        autoReports.stop().catch(() => undefined);
      }
    }
  });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    const name = String(alarm?.name || '');
    if (name === globalThis.NXTKAutoReports.ALARM) {
      autoReports.flush().catch(() => undefined);
      return;
    }
    if (name === DOWNLOAD_UI_ALARM) {
      downloadUiEnabled = null;
      syncDownloadUi();
      return;
    }
    if (name === 'nxtk-reconcile') {
      reconcileNdcJobs().catch(() => {});
      // An expired claim (its tab crashed or closed) or a finished job puts the popup back.
      syncDownloadUi();
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
    // A record that is somebody else's download (Firefox renumbers downloads after a restart) means
    // this job's own download is gone, however that other one is doing.
    if (!record || isSomeoneElsesDownload(record, job.activeDownloadPath)
      || record.state === 'complete' || record.state === 'interrupted') {
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
    if (job.status === 'running') {
      runningCount++;
      await reconcileNdcJob(job.id);
      continue;
    }
    // Keep the global reconciliation alarm alive even for a stopped job: Stop promised not
    // to leave an attempt that can later resume beside a future run.
    if (Number.isInteger(job.retiringDownloadId)
      && !await finishNdcRetirement(job.id, job.retiringDownloadId)) {
      runningCount++;
    }
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



// Every worker start migrates and reconciles once. Sweeping item lists whose job is gone reads
// the whole store, so it waits for that pass and only runs on browser startup and on install.
const ndcBoot = migrateNdcJobItems()
  .then(() => reconcileNdcJobs())
  .catch((cause) => recordBackgroundError('reconcile collection jobs', cause));

function pruneAfterBoot(context) {
  ndcBoot
    .then(() => pruneOrphanedNdcItems())
    .catch((cause) => recordBackgroundError(context, cause));
}

autoReports.flush().catch(() => undefined);
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('unhandledrejection', (event) => recordBackgroundError('Unhandled background promise', event.reason));
  globalThis.addEventListener('error', (event) => recordBackgroundError('Uncaught background exception', event.error || event.message));
}

if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => { pruneAfterBoot('prune on startup'); syncDownloadUi({ immediate: true }); });
}

const TRUSTED_SENDER_URL = /^https:\/\/(?:[\w-]+\.)*nexusmods\.com\//i;

// Answers, not faults: pausing or stopping when no queue is running is a normal
// thing for a reader to do and must not fill the error log.
const EXPECTED_HANDLER_OUTCOMES = new Set(['job-not-found']);

function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // A content script always reports the page it runs in. A sender without a URL is accepted only when
  // it is not attached to a tab (the extension's own worker or popup on browsers that omit the URL).
  if (!sender.url) return !sender.tab;
  if (sender.url.startsWith(chrome.runtime.getURL(''))) return true;
  return TRUSTED_SENDER_URL.test(sender.url);
}

// The parts of the page script only some pages use. A Nexus Mods page asks for one the first time it needs
// it (loadBundle in content/ui.js) and gets exactly these packaged files added to the frame that asked —
// never a file the page names itself, and never a page outside nexusmods.com.
const CONTENT_BUNDLES = {
  report: ['report.js'],
  settings: ['content/ui-settings.js'],
  collection: ['content/ndc.js', 'content/ui-collection.js'],
  wabbajack: ['content/zip-reader.js', 'content/wabbajack-importer.js', 'content/ui-wabbajack.js']
};

async function injectContentBundle(name, sender) {
  const files = Object.prototype.hasOwnProperty.call(CONTENT_BUNDLES, name) ? CONTENT_BUNDLES[name] : null;
  if (!files) throw new Error('unknown-bundle');
  if (typeof sender?.tab?.id !== 'number' || !TRUSTED_SENDER_URL.test(String(sender.url || ''))) {
    throw new Error('bundle-needs-a-nexus-page');
  }
  // Addressing the document keeps a tab that navigated meanwhile from receiving files meant for the page it
  // left. Where the browser does not say which document asked, the frame is addressed instead.
  const target = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [Number.isInteger(sender.frameId) ? sender.frameId : 0] };
  await chrome.scripting.executeScript({ target, files });
}

// The page that asked for the bundle was left or reloaded before it arrived. Nobody is waiting for
// it, so this is not a fault worth a line in the bug report.
const BUNDLE_TARGET_GONE = /frame with id \d+ was removed|no (?:frame|document) with id|no tab with id|tab was closed/i;

// Reject untrusted senders before any privileged action.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;

  if (msg?.type === 'LOAD_BUNDLE') {
    injectContentBundle(msg.bundle, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((cause) => {
        const error = String(cause?.message || cause || 'bundle-load-failed');
        if (!BUNDLE_TARGET_GONE.test(error)) recordBackgroundError('LOAD_BUNDLE', error);
        sendResponse({ ok: false, error });
      });
    return true;
  }

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

  // The report page: preview, send, copy or open as a GitHub issue. Opened from the popup and from
  // error dialogs on Nexus pages (content scripts cannot open extension pages themselves).
  if (msg?.type === 'OPEN_REPORT_PAGE') {
    const error = msg.error && typeof msg.error === 'object'
      ? NXTK.buildErrorEntry({ ...msg.error, url: sender.tab ? sender.url : msg.error.url }) : null;
    const hash = error ? `#${encodeURIComponent(JSON.stringify(error))}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('report-page/report.html') + hash }, () => {
      const error = getRuntimeError();
      sendResponse(error ? { ok: false, error } : { ok: true });
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
  // An update or reload mid-run restarts the worker with no memory of the download-popup state.
  syncDownloadUi({ immediate: true });
  if (details?.reason === 'update') armAutoReportPrompt().catch(() => undefined);
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') }, () => {
      const error = getRuntimeError();
      if (error) recordBackgroundError('onInstalled welcome', error);
    });
  }

  try {
    chrome.storage.local.remove(RETIRED_STORAGE_KEYS, () => void getRuntimeError());
  } catch (_) { }
  pruneAfterBoot('prune on install');

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
      // onInstalled also fires for every update and every browser update. Past the migration,
      // 1.5 MB/s is a speed somebody chose, and it used to be reset each of those times.
      const hasStaleSpeed = details?.reason === 'update'
        && isVersionBefore(details.previousVersion, LEGACY_SPEED_LAST_VERSION)
        && Number(stored.NDC_downloadSpeed) === LEGACY_SPEED_DEFAULT;
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
