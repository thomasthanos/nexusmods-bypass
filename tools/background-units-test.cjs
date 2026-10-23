const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const noop = () => {};
const finishCallback = (_id, callback) => { if (callback) callback(); };
const listener = () => ({ addListener: noop });
const messageListeners = [];
const installedListeners = [];

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: (fn) => installedListeners.push(fn) }
  },
  storage: {
    local: (() => {
      const store = {};
      const copy = (value) => (value === undefined ? undefined : structuredClone(value));
      return {
        get: (keys, cb) => {
          if (keys === null || keys === undefined) return cb && cb(copy(store));
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const name of names) if (name in store) out[name] = copy(store[name]);
          cb && cb(out);
        },
        set: (items, cb) => { for (const [k, v] of Object.entries(items)) store[k] = copy(v); cb && cb(); },
        remove: (keys, cb) => {
          for (const name of (Array.isArray(keys) ? keys : [keys])) delete store[name];
          cb && cb();
        }
      };
    })()
  },
  tabs: { create: noop, remove: noop, sendMessage: noop },
  alarms: { create: noop, clear: noop }
};

async function debugLogAndAutoReports() {
  const N = context.NXTK;
  await context.__STORAGE_HANDLERS.DEBUG_LOG_APPEND({ entries: [
    { at: 1, level: 'info', page: 'mod', text: 'mail jane@example.com from /home/jane' },
    { at: 2, level: 'bogus', page: 'x'.repeat(50), text: 'ok' }
  ] });
  let log = await context.storageGetLocal(N.DEBUG_LOG_KEY, []);
  assert.equal(log.length, 2);
  assert.doesNotMatch(log[0].text, /jane/, 'debug lines are sanitized on the way in');
  assert.equal(log[1].level, 'info', 'unknown levels are normalized');
  assert.equal(log[1].page.length, 20);
  await context.__STORAGE_HANDLERS.DEBUG_LOG_APPEND({ entries: Array.from({ length: 100 }, (_, i) => ({ text: `l${i}` })) });
  for (let i = 0; i < 4; i += 1) await context.__STORAGE_HANDLERS.DEBUG_LOG_APPEND({ entries: Array.from({ length: 100 }, (_, j) => ({ text: `m${j}` })) });
  log = await context.storageGetLocal(N.DEBUG_LOG_KEY, []);
  assert.equal(log.length, N.MAX_DEBUG_ENTRIES, 'the ring buffer is capped');
  await context.__STORAGE_HANDLERS.DEBUG_LOG_CLEAR();
  assert.deepEqual(await context.storageGetLocal(N.DEBUG_LOG_KEY, null), []);

  assert.equal(N.DEFAULTS.AutoErrorReports, false, 'auto reports are off by default');
  const entry = N.buildErrorEntry({ code: 'request_failed', context: 'Loading x' });
  assert.equal(await context.maybeAutoReport(entry), false, 'off: nothing is queued');
  const reporter = vm.runInContext('autoReports', context);
  const previousEnqueue = reporter.enqueue;
  const recorded = [];
  reporter.enqueue = async (error) => { recorded.push(error.code); return false; };
  try {
    await context.__STORAGE_HANDLERS.ERROR_LOG_APPEND({ entry: { code: 'nexus_api_changed' } });
    await context.__recordQueueItemFailure({ gameId: 'skyrim', type: 'all' }, { fileId: 1 }, 'NETWORK_FAILED');
    context.recordBackgroundError('background test', new Error('boom'));
    await context.__writeQueues.get(N.ERROR_LOG_KEY);
    assert.deepEqual(recorded, ['nexus_api_changed', 'queue_item_failed', 'background_error'], 'all error writers use the reporting path once');
    // A listener failing on every event writes the log once, not once per event.
    for (let i = 0; i < 200; i += 1) context.recordBackgroundError('alarm storm', new Error('same failure'));
    await context.__writeQueues.get(N.ERROR_LOG_KEY);
    assert.deepEqual(recorded.slice(3), ['background_error'], 'a background error storm is held back at the source');
  } finally { reporter.enqueue = previousEnqueue; }
  const identityAt = Date.now();
  await context.appendErrorLogEntry(N.buildErrorEntry({ code: 'no_nmm_link', context: 'Identity merge', at: identityAt,
    url: 'https://www.nexusmods.com/x/mods/1', fileIdentity: { expectedId: '101', receivedId: '102' } }));
  await context.appendErrorLogEntry(N.buildErrorEntry({ code: 'no_nmm_link', context: 'Identity merge', at: identityAt + 1,
    url: 'https://www.nexusmods.com/x/mods/2', fileIdentity: { expectedId: '201', receivedId: '202' } }));
  let identityLog = await context.storageGetLocal(N.ERROR_LOG_KEY, []);
  assert.equal(identityLog.at(-1).fileIdentity.expectedId, '201', 'coalesced metadata belongs to the latest error');
  await context.appendErrorLogEntry(N.buildErrorEntry({ code: 'no_nmm_link', context: 'Identity merge', at: identityAt + 2 }));
  identityLog = await context.storageGetLocal(N.ERROR_LOG_KEY, []);
  assert.equal(identityLog.at(-1).fileIdentity, undefined, 'a new incident without IDs clears the stale pair');
  await context.armAutoReportPrompt();
  const sender = { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', tab: { id: 7 }, frameId: 0 };
  const claims = await Promise.all([context.claimAutoReportPrompt({}, sender), context.claimAutoReportPrompt({}, sender)]);
  assert.equal(claims.filter(Boolean).length, 1, 'only one tab gets the update invitation');
  await context.armAutoReportPrompt();
  assert.equal(await context.claimAutoReportPrompt({}, sender), false, 'later updates do not show it again');
  assert.equal(await context.claimAutoReportPrompt({}, { ...sender, frameId: 2 }), false, 'iframes do not claim it');

}

// The download bubble is hidden only for runs that download in the browser, and comes back at once
// when the last one ends. Progress events are coalesced into one storage pass.
async function downloadPopupFollowsBrowserRuns() {
  const decide = context.downloadUiShouldBeEnabled;
  const at = Date.now();
  assert.equal(decide({ setting: true, claims: {}, jobs: {} }), true, 'idle: shown');
  assert.equal(decide({ setting: true, claims: { 'a/b': { tabId: 1, at, method: 'browser' } }, jobs: {} }), false);
  assert.equal(decide({ setting: true, claims: { 'a/b': { tabId: 1, at, method: 'vortex' } }, jobs: {} }), true,
    'a Vortex run downloads nothing in the browser, so the bubble stays');
  assert.equal(decide({ setting: true, claims: {}, jobs: { j: { status: 'running' } } }), false);
  assert.equal(decide({ setting: false, claims: {}, jobs: { j: { status: 'running' } } }), true, 'setting off');
  const cleaned = context.cleanNdcClaims({ 'a/b': { tabId: 2, at, method: 'vortex' }, 'c/d': { tabId: 3, at } });
  assert.equal(cleaned['a/b'].method, 'vortex', 'the method survives the claim clean-up');
  assert.equal(cleaned['c/d'].method, 'browser', 'older claims count as browser runs');

  const calls = [];
  global.chrome.downloads = { ...(global.chrome.downloads || {}), setUiOptions: async (options) => { calls.push(options.enabled); } };
  await context.storageSetLocal(context.NXTK.SETTINGS_KEY, { ...context.NXTK.DEFAULTS, HideDownloadPopup: true });
  await context.storageSetLocal('nxtk_ndc_run_claims', { 'g/c': { tabId: 4, at: Date.now(), method: 'browser' } });
  for (let i = 0; i < 20; i += 1) context.syncDownloadUi();
  await new Promise((resolve) => setTimeout(resolve, 650));
  await context.syncDownloadUi({ immediate: true });
  assert.deepEqual(calls, [false], 'twenty progress events, one toggle');
  await context.storageSetLocal('nxtk_ndc_run_claims', {});
  await context.syncDownloadUi({ immediate: true });
  assert.deepEqual(calls, [false, true], 'released: shown again straight away');
}

async function downloadPopupRespectsOtherExtensions() {
  const savedDownloads = global.chrome.downloads;
  const savedAlarms = global.chrome.alarms;
  const savedRecord = context.recordBackgroundError;
  const calls = [];
  const errors = [];
  const alarms = [];
  const conflict = new Error('Another extension has disabled the download UI');
  let rejection = conflict;
  global.chrome.downloads = { ...savedDownloads, setUiOptions: async ({ enabled }) => {
    calls.push(enabled);
    if (rejection && (enabled || rejection !== conflict)) throw rejection;
  } };
  global.chrome.alarms = {
    ...savedAlarms,
    create: (name) => alarms.push(['create', name]),
    clear: (name) => alarms.push(['clear', name])
  };
  context.recordBackgroundError = (action, cause) => errors.push([action, cause.message]);
  try {
    vm.runInContext('downloadUiEnabled = null', context); // A fresh worker has no cached request.
    await context.syncDownloadUi({ immediate: true });
    await context.syncDownloadUi({ immediate: true });
    assert.deepEqual(errors, [], 'another extension retaining its UI restriction is not a task failure');
    assert.deepEqual(calls, [true], 'our restriction was released; queue events need not repeat the request');
    assert.deepEqual(alarms, [['clear', 'nxtk-download-ui']], 'the restoration alarm is cleared despite the conflict');

    await context.storageSetLocal('nxtk_ndc_run_claims', { 'g/c': { tabId: 4, at: Date.now(), method: 'browser' } });
    await context.syncDownloadUi({ immediate: true });
    await context.storageSetLocal('nxtk_ndc_run_claims', {});
    await context.syncDownloadUi({ immediate: true });
    await context.syncDownloadUi({ immediate: true });
    assert.deepEqual(calls, [true, false, true], 'a later collection can still hide and release our UI restriction');
    assert.deepEqual(alarms.slice(1), [['create', 'nxtk-download-ui'], ['clear', 'nxtk-download-ui']]);
    assert.deepEqual(errors, [], 'restoring after a collection also respects other extensions');

    vm.runInContext('downloadUiEnabled = null', context);
    await context.syncDownloadUi({ immediate: true });
    assert.equal(errors.length, 0, 'a worker restart handles the same conflict without a report');

    rejection = new Error('downloads.setUiOptions requires the "downloads.ui" permission');
    vm.runInContext('downloadUiEnabled = null', context);
    await context.syncDownloadUi({ immediate: true });
    assert.deepEqual(errors, [['download popup toggle', rejection.message]], 'unexpected enabling failures remain reportable');
    rejection = null;
    await context.syncDownloadUi({ immediate: true });
    assert.equal(calls.filter(Boolean).length, 5, 'an unexpected failure is retried rather than cached as success');

    // The known message is expected only when enabling; do not hide failures to disable the UI.
    global.chrome.downloads.setUiOptions = async () => { throw conflict; };
    await context.storageSetLocal('nxtk_ndc_run_claims', { 'g/c': { tabId: 4, at: Date.now(), method: 'browser' } });
    await context.syncDownloadUi({ immediate: true });
    assert.deepEqual(errors[1], ['download popup toggle', conflict.message]);
    global.chrome.downloads.setUiOptions = async ({ enabled }) => { calls.push(enabled); };
    await context.syncDownloadUi({ immediate: true });
    assert.equal(calls.at(-1), false, 'a failed hide is retried');
    await context.storageSetLocal('nxtk_ndc_run_claims', {});
    await context.syncDownloadUi({ immediate: true });

    delete global.chrome.downloads.setUiOptions;
    await context.syncDownloadUi({ immediate: true });
    assert.equal(errors.length, 2, 'browsers without the UI API remain supported');
  } finally {
    global.chrome.downloads = savedDownloads;
    global.chrome.alarms = savedAlarms;
    context.recordBackgroundError = savedRecord;
    await context.storageSetLocal('nxtk_ndc_run_claims', {});
  }
}

// One user action, one file: the worker drops a second start for the same game+file, and a start for a
// file the browser is already downloading (Nexus's own native download included).
async function downloadStartsAreDeduplicated() {
  const H = context.__DOWNLOAD_HANDLERS;
  const saved = global.chrome.downloads;
  const started = [];
  let browserItems = [];
  global.chrome.downloads = {
    ...(saved || {}),
    download: (options, cb) => { started.push(options); setTimeout(() => cb(100 + started.length), 5); },
    search: (_query, cb) => cb(browserItems)
  };
  try {
    const cdn = 'https://supporter-files.nexus-cdn.com/1704/12604/SkyUI_SDK_5_2-12604-5-2SE.7z?md5=a&expires=1';
    const payload = { url: cdn, folder: '', filename: 'SkyUI_SDK_5_2-12604-5-2SE.7z', fileId: '734848', gameId: '1704' };
    const [a, b] = await Promise.all([H.DOWNLOAD_START(payload), H.DOWNLOAD_START({ ...payload })]);
    assert.equal(started.length, 1, 'two simultaneous starts for one file make one download');
    assert.equal(a.downloadId, b.downloadId);
    assert.equal(b.duplicate, true);
    await H.DOWNLOAD_START({ ...payload, url: `${cdn}&again=1` });
    assert.equal(started.length, 1, 'a repeat within the window is dropped');
    await H.DOWNLOAD_START({ ...payload, fileId: '999', url: 'https://supporter-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z' , filename: 'SkyUI_5_2_SE-12604-5-2SE.7z' });
    assert.equal(started.length, 2, 'a different file still starts');

    context.__recentDownloadStarts.clear();
    browserItems = [{ id: 7, state: 'in_progress', url: 'https://cf-files.nexus-cdn.com/1704/12604/SkyUI_SDK_5_2-12604-5-2SE.7z?token=x', filename: 'C:\\Users\\u\\Downloads\\SkyUI_SDK_5_2-12604-5-2SE.7z', startTime: new Date().toISOString() }];
    const native = await H.DOWNLOAD_START(payload);
    assert.equal(native.duplicate, true, 'a file the browser is already downloading is not started again');
    assert.equal(native.downloadId, 7);
    assert.equal(started.length, 2);

    const find = context.findDuplicateDownload;
    const now = Date.now();
    assert.ok(find([{ id: 1, state: 'complete', filename: '/d/File (1).zip', url: 'https://x/a', startTime: new Date(now - 5000).toISOString() }], { url: 'https://y/b', filename: 'file.zip', now }), 'renamed copy counts');
    assert.equal(find([{ id: 1, state: 'complete', filename: '/d/file.zip', startTime: new Date(now - 120000).toISOString() }], { url: '', filename: 'file.zip', now }), null, 'outside the window is a new download');
    assert.equal(find([{ id: 1, state: 'interrupted', filename: '/d/file.zip', startTime: new Date(now).toISOString() }], { url: '', filename: 'file.zip', now }), null, 'a failed download does not block a retry');
  } finally {
    global.chrome.downloads = saved;
    context.__recentDownloadStarts.clear();
  }
}

const context = vm.createContext({ chrome: global.chrome, console, URL, Date, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, JSON, setTimeout, clearTimeout, isNaN, parseInt, AbortController, structuredClone, fetch: noop });
context.importScripts = (...paths) => {
  for (const path of paths) {
    vm.runInContext(fs.readFileSync(`src/${path}`, 'utf8'), context, { filename: `src/${path}` });
  }
};
const source = `${fs.readFileSync('src/background.js', 'utf8')}\n;globalThis.__NXTK = NXTK;globalThis.__STORAGE_HANDLERS = STORAGE_HANDLERS;globalThis.__NDC_JOBS_KEY = NDC_JOBS_KEY;globalThis.__writeQueues = writeQueues;globalThis.__NDC_QUEUE_HANDLERS = NDC_QUEUE_HANDLERS;globalThis.__STORAGE_HISTORY_KEY = STORAGE_HISTORY_KEY;globalThis.__MAX_NDC_JOB_ITEMS = MAX_NDC_JOB_ITEMS;globalThis.__DOWNLOAD_CONFLICT_ACTION = DOWNLOAD_CONFLICT_ACTION;globalThis.__MAX_TRACKED_FAILURES = MAX_TRACKED_FAILURES;globalThis.__recordJobFailure = recordJobFailure;globalThis.__jobFailureCount = jobFailureCount;globalThis.__verifyTransferSize = verifyTransferSize;globalThis.__settledInterruptedState = settledInterruptedState;globalThis.__discardAbandonedDownload = discardAbandonedDownload;globalThis.__handleNdcDownloadTerminal = handleNdcDownloadTerminal;globalThis.__recordQueueItemFailure = recordQueueItemFailure;globalThis.__DOWNLOAD_HANDLERS = DOWNLOAD_HANDLERS;globalThis.__recentDownloadStarts = recentDownloadStarts;`;
vm.runInContext(source, context, { filename: 'src/background.js' });

const { retryAfterMilliseconds, buildDownloadPath, downloadFolderOf, __NXTK: NXTK } = context;
const { __DOWNLOAD_CONFLICT_ACTION: DOWNLOAD_CONFLICT_ACTION, __MAX_TRACKED_FAILURES: MAX_TRACKED_FAILURES,
  __recordJobFailure: recordJobFailure, __jobFailureCount: jobFailureCount } = context;
const { classifyNexusResponse } = context;
const { isValidFileId, isValidHistoryId, ndcScopeKey, sanitizeNdcJobItem } = context;
const { mutateNdcJob, readNdcJob, saveNdcJob, storageSetLocal, storageGetLocal, enqueueStorageTask,
  advanceNdcJob, processNdcJob, appendErrorLogEntry, applyNdcDownloadTerminal, __verifyTransferSize: verifyTransferSize, __NDC_JOBS_KEY: NDC_JOBS_KEY, __writeQueues: writeQueues,
  __NDC_QUEUE_HANDLERS: NDC_QUEUE_HANDLERS, __STORAGE_HISTORY_KEY: STORAGE_HISTORY_KEY, __MAX_NDC_JOB_ITEMS: MAX_NDC_JOB_ITEMS } = context;
const { __handleNdcDownloadTerminal: handleNdcDownloadTerminal,
  __recordQueueItemFailure: recordQueueItemFailure } = context;

{
  const c = context.NXTK.classifyDownloadInterrupt;
  assert.deepEqual({ ...c('NETWORK_FAILED') }, { kind: 'transient', retries: 2 }, 'a dropped connection gets two more tries');
  assert.equal(c('SERVER_FORBIDDEN').kind, 'link', 'an expired link is retried with a fresh one');
  assert.equal(c('SERVER_FORBIDDEN').retries, 1);
  assert.equal(c('FILE_NO_SPACE').retries, 0, 'a full disk is not retried');
  assert.equal(c('FILE_VIRUS_INFECTED').kind, 'blocked');
  assert.equal(c('USER_CANCELED').retries, 0, 'a cancel by the user is respected');
  assert.equal(c('short_file (12 KB of 4 MB)').kind, 'size');
  assert.deepEqual({ ...c('') }, { kind: 'unknown', retries: 1 }, 'unknown keeps the old single retry');
}
{
  const trusted = context.isTrustedSender;
  assert.equal(trusted({ id: 'other', url: 'https://www.nexusmods.com/' }), false, 'another extension is refused');
  assert.equal(trusted({ id: 'test-extension-id', url: 'https://www.nexusmods.com/x' }), true, 'a Nexus page is trusted');
  assert.equal(trusted({ id: 'test-extension-id', url: 'https://evil.example/nexusmods.com/' }), false, 'another site is refused');
  assert.equal(trusted({ id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' }), true, 'the popup is trusted');
  assert.equal(trusted({ id: 'test-extension-id', tab: { id: 3 } }), false, 'a tab sender with no URL is refused');
  assert.equal(trusted({ id: 'test-extension-id' }), true, 'an extension context with no URL or tab is accepted');
}
assert.equal(retryAfterMilliseconds('', 1, () => 0), 30000, 'first strike backs off 30s');
assert.equal(retryAfterMilliseconds('', 2, () => 0), 60000, 'second strike doubles');
assert.equal(retryAfterMilliseconds('', 3, () => 0), 120000, 'third strike doubles again');
assert.equal(retryAfterMilliseconds(undefined, 4, () => 0), 240000, 'a missing header escalates like an empty one');
assert.equal(retryAfterMilliseconds('   ', 3, () => 0), 120000, 'a whitespace header counts as absent');
assert.equal(retryAfterMilliseconds('', 20, () => 0), 600000, 'the ladder is capped at 10 minutes');
{
  const jittered = retryAfterMilliseconds('', 1);
  assert.ok(jittered >= 30000 && jittered <= 36000, 'a computed backoff gets up to 20% jitter, never less');
  assert.equal(retryAfterMilliseconds('', 1, () => 1), 36000, 'and the jitter is capped at 20%');
  const d1 = context.NXTK.retryDelayMs(1, 1500, 15000, () => 0);
  const d3 = context.NXTK.retryDelayMs(3, 1500, 15000, () => 1);
  assert.equal(d1, 750, 'a first retry waits at least half the base');
  assert.equal(d3, 6000, 'retries grow exponentially');
  assert.equal(context.NXTK.retryDelayMs(10, 1500, 15000, () => 1), 15000, 'and are capped');
}
assert.equal(retryAfterMilliseconds('120', 1), 120000, 'an explicit Retry-After still wins');
assert.equal(retryAfterMilliseconds('0', 1), 30000, 'an explicit 0 still respects the alarm floor');

// Never 'overwrite': a collision must not destroy a file the user already had.
assert.equal(DOWNLOAD_CONFLICT_ACTION, 'uniquify', 'a download never overwrites what is there');
assert.equal((source.match(/conflictAction: DOWNLOAD_CONFLICT_ACTION,/g) || []).length, 1,
  'one request builder holds the value');
assert.equal((source.match(/chrome\.downloads\.download\(request,/g) || []).length, 2,
  'and both download call sites use it');

assert.equal(buildDownloadPath('NexusMods', 'A Mod.zip'), 'NexusMods/A Mod.zip');
assert.equal(buildDownloadPath('   ', 'A Mod.zip'), 'A Mod.zip', 'a blank folder saves to Downloads');
assert.equal(buildDownloadPath('../../etc', 'A Mod.zip'), 'etc/A Mod.zip', 'traversal is stripped');
const cappedPath = buildDownloadPath('n'.repeat(400), 'A Mod.zip');
assert.equal(cappedPath, `${'n'.repeat(100)}/A Mod.zip`,
  'an overlong folder is capped instead of failing the whole download');
assert.ok(!cappedPath.startsWith(' ') && !cappedPath.includes('  '), 'the capped folder stays clean');

// Chrome's own rule for each path segment (net::IsSafePortablePathComponent): no control, format or
// unsafe character anywhere, and no whitespace, dot or tilde at either end. A segment it refuses fails
// the download as "Invalid filename".
const chromeAcceptsSegment = (segment) => segment.length > 0
  && !/[\p{Cc}\p{Cf}"*/:<>?\\|]/u.test(segment)
  && !/^[\s.~]|[\s.~]$/u.test(segment);
for (const [folder, name] of [
  ['~Mods', '~Grass Overhaul~ 1.2.7z'],
  ['NexusMods', 'Better­Bodies.7z'],
  ['Mods​', 'Zero​Width‍.7z'],
  ['Bidi‮', '﻿BOM first.7z'],
  ['C1\u0085', 'Name\u009f.7z'],
  ['n'.repeat(99) + ' ~x', 'A Mod.zip'],
  ['Folder', `${'a'.repeat(250)} ~ tail`]
]) {
  const built = buildDownloadPath(folder, name);
  for (const segment of built.split('/')) {
    assert.ok(chromeAcceptsSegment(segment), `Chrome accepts every segment of ${JSON.stringify(built)}`);
  }
}
assert.equal(buildDownloadPath('~Mods', '~Grass Overhaul~ 1.2.7z'), 'Mods/Grass Overhaul~ 1.2.7z',
  'a tilde inside a name is kept; only the ends are tidied');
assert.equal(buildDownloadPath('NexusMods', 'clock$.7z'), 'NexusMods/_clock$.7z', 'Windows device names are escaped');

assert.equal(
  downloadFolderOf('C:\\Users\\Someone\\Downloads\\NexusMods\\A Mod.7z'),
  'C:\\Users\\Someone\\Downloads\\NexusMods',
  'the folder a file landed in is what the installer has to be pointed at'
);
assert.equal(downloadFolderOf('/home/someone/Downloads/NexusMods/A Mod.7z'), '/home/someone/Downloads/NexusMods');
assert.equal(downloadFolderOf('A Mod.7z'), '', 'a bare name has no folder to report');
assert.equal(downloadFolderOf(''), '');
assert.equal(downloadFolderOf(undefined), '');

assert.equal(NXTK.validateDownloadTarget('nxm://skyrim/mods/1/files/2?key=k&expires=1&user_id=3').ok, true);
assert.equal(NXTK.validateDownloadTarget('nxm://skyrim/mods/1/files/2').ok, false, 'unsigned nxm links are rejected');
assert.equal(NXTK.validateDownloadTarget('https://evil.example/x.zip', { method: 1 }).ok, false, 'off-host downloads are rejected');

const redact = (text) => NXTK.sanitizeDiagnosticText(text);
assert.match(redact('failed for key=abcdef123'), /key=\[redacted\]/, 'query secrets are redacted');
assert.match(redact('?code=oauth-grant-42 rejected'), /code=\[redacted\]/, 'an OAuth grant is redacted');
assert.match(redact('{"token": "abcdef"}'), /"token"\s*:\s*"\[redacted\]"/, 'JSON secrets are redacted');
assert.match(redact('{"state": "xyz"}'), /"state"\s*:\s*"\[redacted\]"/, 'a JSON OAuth state is redacted');
assert.match(redact('authorization: Bearer abcdef'), /authorization: \[redacted\]/, 'loose header secrets are redacted');
// "code" and "state" carry the diagnosis in our own log lines.
assert.equal(redact('code: no_download_url'), 'code: no_download_url', 'an error code survives redaction');
assert.equal(redact('state: interrupted'), 'state: interrupted', 'a download state survives redaction');

// The worker reads every Nexus answer through classifyNexusResponse, so its verdicts are what is pinned here.
const verdict = (response, text) => classifyNexusResponse(response, text)?.code || null;
assert.equal(verdict({}, '<title>Just a moment...</title>'), 'cloudflare');
assert.equal(verdict({}, '<div id="cf-browser-verification">'), 'cloudflare');
assert.equal(verdict({}, '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1">'), 'cloudflare');
assert.equal(verdict({}, '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/managed/v1">'), 'cloudflare');
assert.equal(
  verdict({}, '<a href="/auth/sign_out"></a><script>a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';</script>'),
  null,
  'Cloudflare\'s passive bot-check script on an ordinary page is not a challenge (#10)'
);
assert.equal(verdict({ cfMitigated: 'challenge' }, ''), 'cloudflare',
  'the Cf-Mitigated header alone is enough');
assert.notEqual(verdict({}, '<html><body>Skyrim Special Edition</body></html>'), 'cloudflare',
  'an ordinary mod page is not a challenge');
assert.notEqual(verdict({}, ''), 'cloudflare');

assert.equal(verdict(null, 'Your account has been temporarily suspended'), 'account_suspended');
assert.equal(verdict({}, 'too many requests from your account'), 'rate_limited',
  'a rate limit is not mislabeled as an account suspension');
assert.notEqual(verdict(null, '<html>a normal page</html>'), 'account_suspended');

// Queue policy shared by the worker and the page.
const bySize = (sizes) => [...NXTK.orderQueueBySize(sizes.map((size, index) => ({ size, index })), (item) => item.size)]
  .map((item) => item.index);
assert.deepEqual(bySize([500, 20, 0, 3, null, 20, -4, '7', NaN]), [3, 7, 1, 5, 0, 2, 4, 6, 8],
  'smallest first, equal sizes keep their order, and every unknown size goes last in its original order');
assert.equal(bySize([]).length, 0);
assert.equal(NXTK.orderQueueBySize(null, () => 1).length, 0, 'a missing list is an empty queue');
for (const code of ['mod_unavailable', 'file_not_found', 'moderation_hold', 'file_not_found (HTTP 404)']) {
  assert.notEqual(NXTK.queueSkipReason(code), '', `${code} is skipped`);
}
for (const code of ['request_failed', 'page_request_failed', 'requires_login', 'rate_limited', '']) {
  assert.equal(NXTK.queueSkipReason(code), '', `${code || 'no code'} is not a skip`);
}
assert.equal(NXTK.queueSkipReason('cloudflare', NXTK.CLOUDFLARE_SKIP_LIMIT - 1), 'cloudflare');
assert.equal(NXTK.queueSkipReason('cloudflare', NXTK.CLOUDFLARE_SKIP_LIMIT), '',
  'Cloudflare on file after file is no longer a skip');

assert.equal(isValidFileId('42'), true);
assert.equal(isValidFileId('0'), false);
assert.equal(isValidHistoryId('1704:42'), true);
assert.equal(isValidHistoryId('0:42'), false);
assert.equal(isValidHistoryId('1704:0x2a'), false);
const queueItem = sanitizeNdcJobItem({
  fileId: 42,
  historyId: '1704:42',
  gameId: 1704,
  name: 'A mod',
  pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/1?file_id=42',
  sizeKb: 10
});
assert.equal(queueItem.historyId, '1704:42', 'background jobs preserve the game-aware history ID');
assert.notEqual(
  ndcScopeKey('all', [{ gameId: 110, fileId: 42 }]),
  ndcScopeKey('all', [{ gameId: 1151, fileId: 42 }]),
  'queue scopes distinguish identical file IDs from different games'
);

// A modlist the importer accepts must not be refused by the queue that runs it.
const importerCeiling = Number(
  /const MAX_ARCHIVE_ENTRIES = (\d+)/.exec(fs.readFileSync('src/content/wabbajack-importer.js', 'utf8'))?.[1]
);
assert.ok(Number.isInteger(importerCeiling) && importerCeiling > 0, 'the importer ceiling must be readable');
assert.ok(
  MAX_NDC_JOB_ITEMS >= importerCeiling,
  `the queue accepts ${MAX_NDC_JOB_ITEMS} items but the importer can produce ${importerCeiling}`
);

async function jobStateBehaviour() {
  const jobId = 'testjob-000001';
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1', collectionId: 'c', type: 'all',
      itemCount: 10, index: 5, completed: 5, failed: [], status: 'running',
      activeDownloadId: 42, createdAt: Date.now(), updatedAt: Date.now()
    }
  });

  const stale = await readNdcJob(jobId);
  assert.equal(stale.index, 5);

  await mutateNdcJob(jobId, (current) => {
    current.index = 6;
    current.completed = 6;
    current.activeDownloadId = 99;
  });

  await mutateNdcJob(jobId, (current) => { current.tabId = 13; });

  const after = await readNdcJob(jobId);
  assert.equal(after.index, 6, 'a later targeted write must not roll index back');
  assert.equal(after.completed, 6, 'completed must not roll back either');
  assert.equal(after.activeDownloadId, 99, 'the in-flight download must not be orphaned');
  assert.equal(after.tabId, 13, 'the field that was actually mutated is applied');

  stale.tabId = 21;
  await saveNdcJob(stale);
  const clobbered = await readNdcJob(jobId);
  assert.equal(clobbered.index, 5, 'saveNdcJob still writes the whole snapshot, so it is not for read-modify-write');

  assert.equal(await mutateNdcJob('testjob-absent1', () => {}), null, 'mutating a missing job is a no-op');
}

async function writeQueueRelease() {
  const before = writeQueues.size;
  await enqueueStorageTask('nxtk_ndc_items:job-a', async () => 'a');
  await enqueueStorageTask('nxtk_ndc_items:job-b', async () => 'b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writeQueues.size, before, 'settled keys must be released');

  const order = [];
  const slow = enqueueStorageTask('k', async () => { await new Promise((r) => setTimeout(r, 5)); order.push(1); });
  const fast = enqueueStorageTask('k', async () => { order.push(2); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, [1, 2], 'tasks on one key stay serialised');
}

// A queue whose item list disappeared must fail loudly: reporting it as
// finished would clear the collection history for files never downloaded.
async function missingQueueItemsBehaviour() {
  const jobId = 'testjob-noitems';
  await storageSetLocal(STORAGE_HISTORY_KEY, { 1704: { 'a-collection': { all: ['42'] } } });
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: 'a-collection', type: 'all',
      itemCount: 3, index: 0, completed: 0, failed: [], status: 'running',
      activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
    }
  });

  assert.equal(await advanceNdcJob(jobId), null, 'a job without items cannot advance');
  const job = await readNdcJob(jobId);
  assert.equal(job.status, 'error', 'a lost item list must not be reported as a finished run');
  assert.equal(job.lastError, 'queue-items-missing');

  const history = await storageGetLocal(STORAGE_HISTORY_KEY, null);
  assert.deepEqual(history['1704']['a-collection'].all, ['42'],
    'the collection history must survive a job that lost its items');
}

async function reconnectScopeBehaviour() {
  context.fetch = async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    text: async () => '<title>Just a moment...</title>',
    headers: { get: () => '' }
  });

  const item = {
    fileId: 42,
    historyId: '1704:42',
    gameId: 1704,
    name: 'A mod',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/1',
    sizeKb: 10
  };
  const items = [item];
  const otherItems = [{ ...item, fileId: 43, historyId: '1704:43' }];
  const payload = {
    gameId: 'g1', collectionId: 'c1', type: 'all', items, folder: '', requestTimeout: 30000
  };

  // Paused so the handler does not kick off a background pass mid-assertion.
  const seed = async (jobId, scopeItems) => {
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: 'g1', collectionId: 'c1', type: 'all',
        scopeKey: ndcScopeKey('all', scopeItems.map(sanitizeNdcJobItem)),
        itemCount: scopeItems.length, index: 0, completed: 0, failed: [], status: 'paused',
        activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    return jobId;
  };

  const sameScope = await seed('testjob-scope001', items);
  const adopted = await NDC_QUEUE_HANDLERS.NDC_QUEUE_START(payload, { tab: { id: 7 } });
  assert.equal(adopted.adopted, true, 'an identical queue must reconnect instead of restarting');
  assert.equal(adopted.jobId, sameScope);

  const staleScope = await seed('testjob-scope002', otherItems);
  const restarted = await NDC_QUEUE_HANDLERS.NDC_QUEUE_START(payload, { tab: { id: 7 } });
  assert.notEqual(restarted.jobId, staleScope,
    'a queue holding different files must never be adopted, whatever the history type');
  assert.equal(restarted.adopted, undefined, 'the reply must not claim a reconnect');
  assert.equal((await readNdcJob(staleScope)).status, 'stopped', 'the superseded job is stopped');
}

// A repeating failure must not evict the history that explains it.
async function errorLogCollapsing() {
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  const entry = (overrides = {}) => NXTK.buildErrorEntry({
    code: 'no_download_url',
    context: 'Reading manual download page',
    action: 'collection run (queued by the download deck)',
    userMessage: 'Nexus Mods did not return a usable download link.',
    technicalMessage: 'resp HTTP 200, 4096B',
    stack: 'at getDownloadUrl (chrome-extension://abcdefghij/content/nnw.js:812:19)',
    ...overrides
  });

  await appendErrorLogEntry(entry());
  await appendErrorLogEntry(entry());
  await appendErrorLogEntry(entry({ technicalMessage: 'resp HTTP 200, 9999B' }));

  let log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(log.length, 1, 'the same fault stays one entry');
  assert.equal(log[0].count, 3, 'the repeats are counted');
  assert.equal(log[0].technicalMessage, 'resp HTTP 200, 9999B', 'the newest detail is kept');
  assert.ok(log[0].lastAt >= log[0].at, 'the last occurrence is recorded');
  assert.match(log[0].action, /collection run/, 'what the extension was doing is stored');
  assert.match(log[0].stack, /ext:\/\/content\/nnw\.js:812:19/, 'the extension origin is folded');
  assert.doesNotMatch(log[0].stack, /abcdefghij/, 'the install ID is not kept in stacks');

  await appendErrorLogEntry(entry({ code: 'cloudflare' }));
  log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(log.length, 2, 'a different code is its own entry');

  await storageSetLocal(NXTK.ERROR_LOG_KEY, [{ ...entry(), at: Date.now() - 60 * 60 * 1000 }]);
  await appendErrorLogEntry(entry());
  log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(log.length, 2, 'the same fault an hour later is a new entry');

  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  for (let index = 0; index < NXTK.MAX_LOGGED_ERRORS + 10; index += 1) {
    await appendErrorLogEntry(entry({ code: `code_${index}` }));
  }
  log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(log.length, NXTK.MAX_LOGGED_ERRORS, 'the log is still capped');
  assert.equal(log[log.length - 1].code, `code_${NXTK.MAX_LOGGED_ERRORS + 9}`, 'the newest entry survives');
}

// A file the browser refuses to start is one failed item, not a dead queue.
async function refusedDownloadBehaviour() {
  const jobId = 'testjob-refused1';
  const items = [1, 2].map((index) => ({
    fileId: index,
    historyId: String(index),
    gameId: '1704',
    name: `Mod ${index}.7z`,
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/1',
    sizeKb: 10
  }));
  await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: 'c', type: null,
      itemCount: items.length, index: 0, completed: 0, failed: [], status: 'running',
      activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
    }
  });

  const previousFetch = context.fetch;
  const previousDownloads = global.chrome.downloads;
  const previousSendMessage = global.chrome.tabs.sendMessage;
  const sent = [];
  context.fetch = async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    text: async () => '{"url":"https://premium-files.nexus-cdn.com/1/2/f.zip?key=k&expires=1&user_id=2"}',
    headers: { get: () => '' }
  });
  global.chrome.downloads = {
    download: (_options, cb) => {
      global.chrome.runtime.lastError = { message: 'user cancelled' };
      cb(undefined);
      global.chrome.runtime.lastError = null;
    },
    search: (_query, cb) => cb([]),
    cancel: finishCallback
  };
  global.chrome.tabs.sendMessage = (tabId, message, callback) => {
    sent.push({ tabId, message });
    if (callback) callback();
  };

  try {
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.notEqual(job.status, 'error', 'a refused start must not fail the whole job');
    assert.equal(job.status, 'partial', 'the queue works through the list and reports what failed');
    assert.equal(job.index, 2, 'both items were passed over rather than aborting at the first');
    assert.equal(job.failed.length, 2, 'each refusal is recorded against its file');
    assert.equal(job.failed[0].code, 'download_not_started');
    const failedProgress = sent.filter(({ message }) => (
      message?.type === 'NXT_NDC_PROGRESS' && message?.itemState === 'failed'
    ));
    assert.equal(failedProgress.length, 2, 'each refusal reaches the deck as a failed item');
    assert.ok(failedProgress.every(({ message }) => message.error === 'download_not_started'),
      'the deck receives the stable error code, not the browser-specific start error');
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
    global.chrome.tabs.sendMessage = previousSendMessage;
    global.chrome.runtime.lastError = null;
  }
}

// A filename is not an ownership token. An older valid file with the same name may belong to a
// different mod or run, so starting a new queue item must never sweep download history by path.
async function sameNamedExistingFileIsNeverSwept() {
  const previousFetch = context.fetch;
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-no-name-sweep';
  const item = {
    fileId: 31, historyId: '31', gameId: '1704', name: 'Shared Name.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/31', sizeKb: 10
  };

  try {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'same-name', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
        folder: 'NexusMods', activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    context.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => '{"url":"https://premium-files.nexus-cdn.com/1/2/f.7z?key=k&expires=1&user_id=2"}',
      headers: { get: () => '' }
    });
    const removed = [];
    global.chrome.downloads = {
      search: (_query, cb) => cb([{
        id: 77, state: 'complete', byExtensionId: 'test-extension-id',
        filename: 'C:\\Users\\u\\Downloads\\NexusMods\\Shared Name.7z'
      }]),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      download: (_options, cb) => cb(908),
      cancel: finishCallback
    };

    await advanceNdcJob(jobId);
    assert.deepStrictEqual(removed, [], 'an existing same-named file is left untouched');
    assert.equal((await readNdcJob(jobId)).activeDownloadId, 908, 'the new exact download id is tracked instead');
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
  }
}

async function classifiedRateLimitWaitsInsteadOfFailing() {
  const previousFetch = context.fetch;
  const jobId = 'testjob-rate-classifier';
  const rateLimitKey = 'nxtk_ndc_rate_limit';
  const item = {
    fileId: 32, historyId: '32', gameId: '1704', name: 'Rate limited.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/32', sizeKb: 10
  };

  try {
    await storageSetLocal(rateLimitKey, { until: 0 });
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'rate-classifier', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    let calls = 0;
    context.fetch = async (url) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        url: String(url),
        text: async () => calls === 1
          ? '<a href="/auth/sign_out">Log out</a><a data-download-url="x">Download</a>'
          : '<p>Too many requests from your account</p>',
        headers: { get: (name) => name === 'Retry-After' ? '1' : '' }
      };
    };

    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(calls, 2, 'the page and generated response both pass through the worker request path');
    assert.equal(job.status, 'running', 'a rate limit waits instead of blocking the job as an account fault');
    assert.equal(job.index, 0, 'the current file is retained for the later retry');
    assert.equal(jobFailureCount(job), 0, 'a wait is not recorded as a failed file');
    assert.ok(job.waitingUntil > Date.now(), 'the queue schedules a backoff');
  } finally {
    context.fetch = previousFetch;
    await storageSetLocal(rateLimitKey, { until: 0 });
  }
}

// Pausing or stopping with no queue running is an answer, not a fault. It used to
// write a background_error per press, so a bug report read as five failures.
async function expectedOutcomesStayOutOfTheLog() {
  await storageSetLocal(NDC_JOBS_KEY, {});
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(messageListeners.length, 1, 'the worker registers exactly one message listener');

  const send = (type) => new Promise((resolve) => {
    const handled = messageListeners[0](
      { type, payload: { gameId: 'g1', collectionId: 'c1' } },
      { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/abc', tab: { id: 7 } },
      resolve
    );
    assert.equal(handled, true, `${type} must answer asynchronously`);
  });

  for (const type of ['NDC_QUEUE_PAUSE', 'NDC_QUEUE_RESUME', 'NDC_QUEUE_STOP']) {
    const reply = await send(type);
    assert.equal(reply.ok, false, `${type} still tells the caller there was nothing to do`);
    assert.equal(reply.error, 'job-not-found');
  }

  await new Promise((resolve) => setTimeout(resolve, 10));
  const log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(log.length, 0, `nothing was logged (found ${log.length})`);

  const failing = await send('NDC_HISTORY_ADD');
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'invalid-history-type');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const afterReal = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(afterReal.length, 1, 'a genuine handler fault is still recorded');
  assert.equal(afterReal[0].context, 'NDC_HISTORY_ADD');
}

// Nexus's listed size and the size of the file it actually serves do not always agree. When
// they disagree the download is still finished, and treating that as a failure is what kept a
// mod out of history and made the next run fetch it all over again.
async function transferSizeVerdicts() {
  const previousDownloads = global.chrome.downloads;
  const record = (fields) => {
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ filename: 'C:\\Users\\x\\Downloads\\NexusMods\\mod.zip', ...fields }]),
      download: (_options, cb) => cb(1),
      cancel: finishCallback
    };
  };
  const tenMb = { sizeKb: 10 * 1024 };

  try {
    // Everything the server promised arrived. Nexus listing it as ten times larger is a
    // fault in the listing, not in the transfer.
    record({ bytesReceived: 1048576, totalBytes: 1048576, mime: 'application/zip' });
    let verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, false, 'a complete transfer is not a short one');
    assert.equal(verdict.folder, 'C:\\Users\\x\\Downloads\\NexusMods',
      'and where it landed is still reported, so the deck can name the folder');

    // The server said how big it was and stopped early. That is a real truncation.
    record({ bytesReceived: 1048576, totalBytes: 10485760, mime: 'application/zip' });
    verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, true, 'stopping short of the declared size is caught');
    assert.equal(verdict.code, 'short_file');
    assert.match(verdict.detail, /got 1048576 of 10485760 declared/, 'and the numbers are recorded');

    record({ bytesReceived: 0, totalBytes: 0, mime: 'application/zip' });
    assert.equal((await verifyTransferSize(1, tenMb)).code, 'empty_file', 'an empty file is refused');

    // A page served in place of the file: complete by HTTP, but not a mod.
    record({ bytesReceived: 4096, totalBytes: 4096, mime: 'text/html' });
    verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, true, 'an html page is not accepted as the mod');
    assert.equal(verdict.code, 'not_a_file');
    assert.match(verdict.detail, /text\/html/, 'and the content type is recorded');

    for (const mime of ['text/plain', 'application/json', 'application/xhtml+xml']) {
      record({ bytesReceived: 4096, totalBytes: 4096, mime });
      assert.equal((await verifyTransferSize(1, tenMb)).code, 'not_a_file', `${mime} is refused too`);
    }

    // The same shortfall, but it really is an archive: accepted, because only Nexus's number
    // disagrees and the alternative is failing a file that downloaded properly.
    record({ bytesReceived: 4096, totalBytes: 0, mime: 'application/x-7z-compressed' });
    assert.equal((await verifyTransferSize(1, tenMb)).suspicious, false,
      'an archive far smaller than the listing is still an archive');

    record({ bytesReceived: 1024, totalBytes: 0, mime: 'text/html' });
    assert.equal((await verifyTransferSize(1, { sizeKb: 32 })).suspicious, false,
      'a file below the ratio floor is left alone, as before');

    global.chrome.downloads = { search: (_query, cb) => cb([]), download: (_o, cb) => cb(1), cancel: finishCallback };
    assert.equal((await verifyTransferSize(1, tenMb)).suspicious, false,
      'a download that cannot be looked up is not condemned');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// Picking mods by hand, or downloading what changed between revisions, starts a run with no
// history bucket. Recording nothing for those runs is a second, independent reason a later
// "Skip Downloaded" fetches files that are already on disk.
async function typelessRunsAreStillRecorded() {
  const previousDownloads = global.chrome.downloads;
  const previousFetch = context.fetch;

  const run = async (jobId, type, items) => {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'col-9', type,
        itemCount: items.length, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: 700, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    const job = await readNdcJob(jobId);
    await applyNdcDownloadTerminal(job, 700, 'complete', '');
  };

  const mandatory = {
    fileId: 11, historyId: '11', gameId: '1704', name: 'Needed.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/11', sizeKb: 2048, optional: false
  };
  const optional = {
    fileId: 12, historyId: '12', gameId: '1704', name: 'Extra.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/12', sizeKb: 2048, optional: true
  };

  try {
    // The flag has to survive validation, or every file arrives looking mandatory and the
    // buckets above are filled from a value that was thrown away on the way in.
    const cleaned = sanitizeNdcJobItem({ ...optional });
    assert.equal(cleaned.optional, true, 'validation keeps an optional file optional');
    assert.equal(sanitizeNdcJobItem({ ...mandatory }).optional, false, 'and a required one required');
    assert.equal(sanitizeNdcJobItem({ ...mandatory, optional: 'yes' }).optional, false,
      'and only a real boolean counts');

    global.chrome.downloads = {
      // A complete transfer of exactly what the server declared.
      search: (_query, cb) => cb([{ state: 'complete', bytesReceived: 2097152, totalBytes: 2097152, mime: 'application/zip', filename: 'C:\\dl\\Needed.7z' }]),
      download: (_options, cb) => cb(700),
      cancel: finishCallback
    };
    context.fetch = async () => ({ ok: true, status: 200, url: '', text: async () => '{}', headers: { get: () => '' } });

    await run('testjob-hist-mandatory', null, [mandatory]);
    let history = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    let bucket = history['1704']?.['col-9'] || {};
    assert.deepStrictEqual([...(bucket.all || [])], ['11'], 'a typeless run records into all');
    assert.deepStrictEqual([...(bucket.mandatory || [])], ['11'], 'and into mandatory for a required file');
    assert.deepStrictEqual([...(bucket.optional || [])], [], 'without touching optional');

    await run('testjob-hist-optional', null, [optional]);
    history = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    bucket = history['1704']?.['col-9'] || {};
    assert.deepStrictEqual([...(bucket.all || [])].sort(), ['11', '12'], 'an optional file joins all too');
    assert.deepStrictEqual([...(bucket.optional || [])], ['12'], 'and goes to optional, not mandatory');
    assert.deepStrictEqual([...(bucket.mandatory || [])], ['11'], 'mandatory is left as it was');

    // A run that does have a bucket still writes only that one, as it always did.
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await run('testjob-hist-typed', 'mandatory', [optional]);
    history = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    bucket = history['1704']?.['col-9'] || {};
    assert.deepStrictEqual([...(bucket.mandatory || [])], ['12'], 'a typed run records its own bucket');
    assert.deepStrictEqual([...(bucket.all || [])], [], 'and no other');
  } finally {
    global.chrome.downloads = previousDownloads;
    context.fetch = previousFetch;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
  }
}

// A retry is saved under a new name rather than over the old one, so whatever was just
// judged unusable would otherwise keep the name a mod manager looks for.
async function badFilesAreNotLeftBehind() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-discard';
  const items = [{
    fileId: 21, historyId: '21', gameId: '1704', name: 'Truncated.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/21', sizeKb: 10240, optional: false
  }];

  const start = async () => {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'col-9', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: 810, transferAttempts: 0, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    return readNdcJob(jobId);
  };

  try {
    const removed = [];
    global.chrome.downloads = {
      // Stopped well short of what the server declared: a real truncation. A record for a
      // download that reached 'complete' carries state: 'complete' — the removal path reads it
      // so that a transfer which produced no file is never even offered to removeFile.
      search: (_query, cb) => cb([{ id: 810, state: 'complete', bytesReceived: 1024, totalBytes: 10485760, mime: 'application/zip', filename: 'C:\\dl\\Truncated.7z' }]),
      download: (_options, cb) => cb(810),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      cancel: finishCallback
    };

    await applyNdcDownloadTerminal(await start(), 810, 'complete', '');
    assert.deepStrictEqual(removed, [810], 'the unusable file is removed before the retry');
    let job = await readNdcJob(jobId);
    assert.equal(job.transferAttempts, 1, 'and the attempt is counted');
    assert.equal(job.index, 0, 'the queue stays on the same file');

    // A transfer that really died leaves no finished file, so there is nothing to remove.
    removed.length = 0;
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ id: 810, state: 'interrupted', canResume: false, paused: false, bytesReceived: 1024, totalBytes: 10485760, error: 'NETWORK_FAILED', filename: 'C:\\dl\\Truncated.7z' }]),
      download: (_options, cb) => cb(810),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      cancel: finishCallback
    };
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: { ...job, transferAttempts: 0, activeDownloadId: 810 }
    });
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 810, 'interrupted', 'NETWORK_FAILED');
    assert.deepStrictEqual(removed, [], 'nothing is removed for a transfer that never finished');

    // If the rejected complete file cannot be removed, starting a retry would create a second
    // uniquified copy while leaving the known-bad original in place. Fail this item safely.
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ id: 810, state: 'complete', bytesReceived: 1024, totalBytes: 10485760, mime: 'application/zip', filename: 'C:\\dl\\Truncated.7z' }]),
      download: (_options, cb) => cb(810),
      cancel: finishCallback
    };
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: { ...(await readNdcJob(jobId)), transferAttempts: 0, activeDownloadId: 810 }
    });
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 810, 'complete', '');
    job = await readNdcJob(jobId);
    assert.equal(job.transferAttempts, 0, 'a browser with no removeFile does not launch a duplicate');
    assert.equal(job.index, 1, 'the unsafe retry is failed and the queue moves past it');
    assert.match(job.failed[0].code, /cleanup_failed/, 'the report explains why no retry was attempted');
    assert.equal(job.index, 1, 'the unsafe retry is skipped');
    assert.equal(jobFailureCount(job), 1, 'the cleanup failure is reported as one failed item');
    assert.match(job.failed[0].code, /cleanup_failed/, 'the stored diagnosis explains why no retry ran');
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
  }
}

// From a Firefox 155 report: the deck logged "Downloading: B42 Inject" and "Retrying interrupted
// download: B42 Inject" in the same second, and Firefox's own panel then showed two completed
// copies. The first attempt was never lost — the browser resumed it — but the queue had already
// marked the id handled, so the real 'complete' that followed was dropped and a second copy was
// downloaded beside the first. An 'interrupted' has to be re-read before it is believed.
async function resumingDownloadsAreNotAbandoned() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-resume';
  const items = [{
    fileId: 42, historyId: '42', gameId: '1704', name: 'B42 Inject.7z',
    pageUrl: 'https://www.nexusmods.com/newvegas/mods/42', sizeKb: 163, optional: false
  }];

  const start = async (overrides = {}) => {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'col-1', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: 900, transferAttempts: 0,
        createdAt: Date.now(), updatedAt: Date.now(), ...overrides
      }
    });
    return readNdcJob(jobId);
  };

  try {
    // Exactly the reported shape: a transfer Firefox says it can resume, which then finishes.
    let reads = 0;
    const snapshots = [
      { id: 900, state: 'interrupted', paused: false, canResume: true, bytesReceived: 40000, totalBytes: 166716, fileSize: 0, filename: '/home/u/dl/B42 Inject.7z' },
      { id: 900, state: 'in_progress', paused: false, canResume: true, bytesReceived: 90000, totalBytes: 166716, fileSize: 0, filename: '/home/u/dl/B42 Inject.7z' }
    ];
    const removed = [];
    global.chrome.downloads = {
      search: (_query, cb) => cb([snapshots[Math.min(reads++, snapshots.length - 1)]]),
      download: (_options, cb) => cb(900),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      cancel: finishCallback
    };

    let job = await start();
    let next = await applyNdcDownloadTerminal(job, 900, 'interrupted', 'NS_ERROR_NET_PARTIAL_TRANSFER');
    assert.ok(reads > 1, 'the first interrupted snapshot is not taken as final');
    assert.equal(next, null, 'a download still running is not a terminal event');
    job = await readNdcJob(jobId);
    assert.equal(job.transferAttempts, 0, 'no retry is counted for a transfer that recovered');
    assert.equal(job.activeDownloadId, 900, 'and the queue keeps waiting on the same download');
    assert.equal(job.index, 0, 'the queue does not move on');
    assert.deepStrictEqual(removed, [], 'nothing is deleted from under a live transfer');

    // The genuine 'complete' that follows must still be accepted — this is the half that the
    // premature judgement used to swallow, because the id had already been marked handled.
    reads = 0;
    snapshots[0] = { id: 900, state: 'complete', paused: false, canResume: false, bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' };
    snapshots[1] = snapshots[0];
    next = await applyNdcDownloadTerminal(await readNdcJob(jobId), 900, 'complete', '');
    job = await readNdcJob(jobId);
    assert.equal(job.completed, 1, 'the download that finished is counted');
    assert.equal(job.index, 1, 'and the queue advances exactly once');
    assert.deepStrictEqual(removed, [], 'a file that arrived whole is never deleted');

    // A record that remains interrupted and cannot be resumed is terminal, as before.
    reads = 0;
    snapshots[0] = { id: 900, state: 'interrupted', paused: false, canResume: false, error: 'NETWORK_FAILED', bytesReceived: 1024, totalBytes: 166716, fileSize: 0, filename: '/home/u/dl/B42 Inject.7z' };
    snapshots[1] = snapshots[0];
    await start();
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 900, 'interrupted', 'NETWORK_FAILED');
    job = await readNdcJob(jobId);
    assert.equal(job.transferAttempts, 1, 'and it is retried');

    // A paused browser item normally keeps state=in_progress even though the event that led us
    // here said interrupted. The paused flag wins and the queue schedules a later reconciliation.
    reads = 0;
    const paused = { id: 900, state: 'in_progress', paused: true, canResume: true, bytesReceived: 40000, totalBytes: 166716, fileSize: 0, filename: '/home/u/dl/B42 Inject.7z' };
    snapshots[0] = paused;
    snapshots[1] = paused;
    await start();
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 900, 'interrupted', '');
    assert.ok(reads <= 6, `the settle loop is bounded (${reads} reads)`);
    job = await readNdcJob(jobId);
    assert.equal(job.transferAttempts, 0,
      'a transfer the browser can still resume is never replaced by a duplicate');
    assert.equal(job.activeDownloadId, 900, 'the queue keeps ownership of the resumable attempt');

    // An interrupted transfer that turns out to have finished is counted, not retried.
    reads = 0;
    snapshots[0] = { id: 900, state: 'interrupted', paused: false, canResume: true, bytesReceived: 166716, totalBytes: 166716, fileSize: 0, filename: '/home/u/dl/B42 Inject.7z' };
    snapshots[1] = { id: 900, state: 'complete', paused: false, canResume: false, bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' };
    await start();
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 900, 'interrupted', 'NS_ERROR_NET_PARTIAL_TRANSFER');
    job = await readNdcJob(jobId);
    assert.equal(job.completed, 1, 'a download that finished after the interrupt is counted');
    assert.equal(job.transferAttempts, 0, 'and never retried into a second copy');
    assert.deepStrictEqual(removed, [], 'nor is the file it produced deleted');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

async function seedTerminalRegressionJob({ jobId, downloadId, fileId }) {
  const item = {
    fileId,
    historyId: String(fileId),
    gameId: '1704',
    name: `Terminal ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/newvegas/mods/${fileId}`,
    sizeKb: 163,
    optional: false
  };
  await storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]);
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: `col-${fileId}`, type: 'all',
      itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
      activeDownloadId: downloadId, transferAttempts: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    }
  });
  await storageSetLocal(STORAGE_HISTORY_KEY, {});
  await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  return item;
}

// A recovered transfer produces a real complete event while the interrupted event is still being
// confirmed. Both events go through handleNdcDownloadTerminal in production, so the regression test
// must overlap those real handler calls rather than invoke applyNdcDownloadTerminal one after another.
async function concurrentTerminalSignalsAreAppliedOnce() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-terminal-race';
  const downloadId = 901;
  const fileId = 61;
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let reads = 0;
    const interrupted = {
      id: downloadId, state: 'interrupted', paused: false, canResume: true,
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 61.7z'
    };
    const complete = {
      id: downloadId, state: 'complete', paused: false, canResume: false,
      bytesReceived: 166912, totalBytes: 166912, fileSize: 166912,
      mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 61.7z'
    };
    global.chrome.downloads = {
      search: (_query, cb) => {
        const record = reads++ === 0 ? interrupted : complete;
        cb([record]);
        if (reads === 1) releaseFirstRead();
      },
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: finishCallback
    };

    const interruptedHandling = handleNdcDownloadTerminal(
      downloadId, 'interrupted', 'NS_ERROR_NET_PARTIAL_TRANSFER'
    );
    let barrierTimer;
    await Promise.race([
      firstRead,
      new Promise((_, reject) => {
        barrierTimer = setTimeout(() => reject(new Error('terminal race never reached its first read')), 1000);
      })
    ]).finally(() => clearTimeout(barrierTimer));
    const completeHandling = handleNdcDownloadTerminal(downloadId, 'complete', null);
    await Promise.all([interruptedHandling, completeHandling]);

    const job = await readNdcJob(jobId);
    const total = await storageGetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
    assert.deepStrictEqual(
      { completed: job?.completed, index: job?.index, total },
      { completed: 1, index: 1, total: 1 },
      'overlapping interrupted and complete signals apply one terminal completion'
    );
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// canResume is only a hint from the same record that delivered the premature interrupted state.
// Re-read even when it is false: Firefox may expose the complete record on the following query.
async function nonResumableInterruptGetsConfirmationRead() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-terminal-reread';
  const downloadId = 902;
  const fileId = 62;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let reads = 0;
    const snapshots = [
      {
        id: downloadId, state: 'interrupted', paused: false, canResume: false,
        error: 'NETWORK_FAILED', bytesReceived: 166912, totalBytes: 166912, fileSize: 0,
        filename: '/home/u/dl/Terminal 62.7z'
      },
      {
        id: downloadId, state: 'complete', paused: false, canResume: false,
        bytesReceived: 166912, totalBytes: 166912, fileSize: 166912,
        mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 62.7z'
      }
    ];
    global.chrome.downloads = {
      search: (_query, cb) => cb([snapshots[Math.min(reads++, snapshots.length - 1)]]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: finishCallback
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    const total = await storageGetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
    assert.deepStrictEqual(
      {
        reread: reads > 1,
        completed: job?.completed,
        index: job?.index,
        transferAttempts: job?.transferAttempts,
        total
      },
      { reread: true, completed: 1, index: 1, transferAttempts: 0, total: 1 },
      'a non-resumable interrupted snapshot is confirmed before retrying'
    );
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// A failed cancel means the worker has not proved that the old id is inert. Retrying anyway is
// the original duplicate bug with a slightly longer fuse: Firefox can still complete that id.
async function failedCancellationDefersRetry() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-cancel-confirm';
  const downloadId = 903;
  const fileId = 63;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let record = {
      id: downloadId, state: 'interrupted', paused: false, canResume: false,
      error: 'NETWORK_FAILED', bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 63.7z'
    };
    let cancels = 0;
    global.chrome.downloads = {
      search: (_query, cb) => cb([record]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: (_id, cb) => {
        cancels += 1;
        global.chrome.runtime.lastError = { message: 'download is not active' };
        cb();
        global.chrome.runtime.lastError = null;
      }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    let job = await readNdcJob(jobId);
    assert.equal(cancels, 1, 'the old attempt is explicitly canceled before any retry');
    assert.equal(job.activeDownloadId, downloadId, 'a failed cancel keeps ownership of the old id');
    assert.equal(job.transferAttempts, 0, 'no retry is launched without confirmed cancellation');

    record = {
      id: downloadId, state: 'complete', paused: false, canResume: false,
      bytesReceived: 166912, totalBytes: 166912, fileSize: 166912,
      mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 63.7z'
    };
    await handleNdcDownloadTerminal(downloadId, 'complete', null);
    job = await readNdcJob(jobId);
    assert.equal(job.completed, 1, 'a late completion of the retained id is accepted');
    assert.equal(job.transferAttempts, 0, 'and still never creates a duplicate retry');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

async function delayedCancelCompletionIsObserved() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-delayed-cancel';
  const downloadId = 909;
  const fileId = 69;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let record = {
      id: downloadId, state: 'interrupted', paused: false, canResume: false,
      error: 'NETWORK_FAILED', bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 69.7z'
    };
    global.chrome.downloads = {
      search: (_query, cb) => cb([record]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: (_id, cb) => {
        setTimeout(() => {
          record = {
            id: downloadId, state: 'complete', paused: false, canResume: false,
            bytesReceived: 166912, totalBytes: 166912, fileSize: 166912,
            mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 69.7z'
          };
          cb();
        }, 10);
      }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(job.completed, 1, 'completion that wins during cancel is accepted');
    assert.equal(job.transferAttempts, 0, 'the cancel callback is awaited before deciding to retry');
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

async function repeatedUncancelledInterruptFailsWithoutDuplicate() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-cancel-recheck';
  const downloadId = 906;
  const fileId = 66;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const interrupted = {
      id: downloadId, state: 'interrupted', paused: false, canResume: false,
      error: 'NETWORK_FAILED', bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 66.7z'
    };
    global.chrome.downloads = {
      search: (_query, cb) => cb([interrupted]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: (_id, cb) => {
        global.chrome.runtime.lastError = { message: 'download is not active' };
        cb();
        global.chrome.runtime.lastError = null;
      }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(job.activeDownloadId, null, 'a second separated terminal confirmation releases the old id');
    assert.equal(job.index, 1, 'the queue moves past an id it could not safely cancel');
    assert.equal(job.transferAttempts, 0, 'it never starts a duplicate-producing retry');
    assert.equal(job.failedTotal, 1, 'the file is reported as failed instead of silently skipped');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
  }
}

async function resumableInterruptIsActuallyResumed() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-explicit-resume';
  const downloadId = 904;
  const fileId = 64;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let record = {
      id: downloadId, state: 'interrupted', paused: false, canResume: true,
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 64.7z'
    };
    let resumes = 0;
    global.chrome.downloads = {
      search: (_query, cb) => cb([record]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: finishCallback,
      resume: (_id, cb) => {
        resumes += 1;
        record = { ...record, state: 'in_progress', canResume: false };
        cb();
      }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(resumes, 1, 'the queue asks the browser to resume a resumable interruption');
    assert.equal(job.activeDownloadId, downloadId, 'the resumed id remains the active attempt');
    assert.equal(job.transferAttempts, 0, 'resuming never consumes the duplicate-producing retry');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

async function stuckResumableInterruptFailsWithoutDuplicate() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-stuck-resume';
  const downloadId = 910;
  const fileId = 70;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const resumable = {
      id: downloadId, state: 'interrupted', paused: false, canResume: true,
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 70.7z'
    };
    let resumes = 0;
    global.chrome.downloads = {
      search: (_query, cb) => cb([resumable]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      resume: (_id, cb) => { resumes += 1; cb(); },
      cancel: (_id, cb) => {
        global.chrome.runtime.lastError = { message: 'download is not active' };
        cb();
        global.chrome.runtime.lastError = null;
      }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(resumes, 2, 'a later reconciliation retries the browser resume action');
    assert.equal(job.index, 1, 'a persistently stuck resumable item eventually leaves the queue');
    assert.equal(job.transferAttempts, 0, 'it is failed without creating a second download id');
    assert.equal(job.failedTotal, 1, 'the safe stop is visible as an item failure');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
  }
}

// chrome.downloads as Chrome implements it (downloads_api.cc): cancel only acts on a download in
// progress and answers success for any other all the same; resume restarts an interrupted one, which
// fails again before anything reads it while the connection is down; erase discards the partial file
// and drops the record.
function chromeLikeDownloads(initial, calls) {
  let record = { ...initial };
  const downloads = {
    record: () => record,
    search: (_query, cb) => cb(record ? [{ ...record }] : []),
    removeFile: (_id, cb) => {
      global.chrome.runtime.lastError = { message: 'Download must be complete' };
      cb();
      global.chrome.runtime.lastError = null;
    },
    download: (_options, cb) => cb(record?.id),
    resume: (_id, cb) => { calls.resume += 1; cb(); },
    cancel: (_id, cb) => {
      calls.cancel += 1;
      if (record?.state === 'in_progress') record = { ...record, state: 'interrupted', error: 'USER_CANCELED', canResume: false };
      cb();
    },
    erase: (query, cb) => {
      calls.erase += 1;
      const erased = record && record.id === query?.id ? [record.id] : [];
      if (erased.length) record = null;
      cb(erased);
    }
  };
  return downloads;
}

// Discord report E-0xl7ejg (Chrome 150): "NETWORK_FAILED [transient] cleanup_failed". A dropped
// connection left a resumable record that resuming could not revive, and Chrome's cancel does nothing
// to an interrupted download, so the record stayed resumable and the file failed with no retry.
async function stuckResumableInterruptIsClosedThenRetriedInChrome() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-chrome-stuck-resume';
  const downloadId = 911;
  const fileId = 71;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const calls = { resume: 0, cancel: 0, erase: 0 };
    const downloads = chromeLikeDownloads({
      id: downloadId, state: 'interrupted', paused: false, canResume: true, error: 'NETWORK_FAILED',
      byExtensionId: 'test-extension-id', bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      url: 'https://cf-files.nexusmods.com/cdn/1704/71/Terminal%2071.7z?md5=x&expires=1',
      filename: 'C:\\dl\\Terminal 71.7z'
    }, calls);
    global.chrome.downloads = downloads;

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    let job = await readNdcJob(jobId);
    assert.equal(job.activeDownloadId, downloadId, 'the first stuck resume keeps the id for a later look');
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    job = await readNdcJob(jobId);

    assert.equal(calls.resume, 2, 'each look tries the browser resume first');
    assert.equal(jobFailureCount(job), 0, `a transient drop is not failed outright (${JSON.stringify(job.failed)})`);
    assert.equal(downloads.record(), null, 'the old attempt is gone, so nothing can resume it beside the retry');
    assert.equal(job.transferAttempts, 1, 'the file gets a fresh attempt');
    assert.equal(job.index, 0, 'the queue stays on the same file');
    assert.equal(job.activeDownloadId, null, 'the old id is released for the retry');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
  }
}

// The close has to be proved, not assumed: an erase the browser refuses leaves the record resumable,
// and the file then fails as before rather than starting a second id beside it.
async function unconfirmedEraseStillFailsWithoutDuplicate() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-chrome-erase-refused';
  const downloadId = 912;
  const fileId = 72;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const calls = { resume: 0, cancel: 0, erase: 0 };
    const downloads = chromeLikeDownloads({
      id: downloadId, state: 'interrupted', paused: false, canResume: true, error: 'NETWORK_FAILED',
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0, filename: 'C:\\dl\\Terminal 72.7z'
    }, calls);
    downloads.erase = (_query, cb) => {
      calls.erase += 1;
      global.chrome.runtime.lastError = { message: 'erase refused' };
      cb();
      global.chrome.runtime.lastError = null;
    };
    global.chrome.downloads = downloads;

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(calls.erase, 1, 'the close is attempted');
    assert.equal(downloads.record()?.canResume, true, 'the record is still resumable');
    assert.equal(job.transferAttempts, 0, 'so no retry starts beside it');
    assert.equal(job.index, 1, 'and the file fails instead');
    assert.match(job.failed[0].code, /cleanup_failed/, 'naming why no retry ran');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
  }
}

// Firefox's cancel discards an interrupted download's partial data. Once it says the record can no
// longer resume, the file is retried, and nothing is erased.
async function cancelledStuckResumeIsRetriedInFirefox() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-firefox-stuck-resume';
  const downloadId = 913;
  const fileId = 73;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let record = {
      id: downloadId, state: 'interrupted', paused: false, canResume: true, error: 'NETWORK_FAILED',
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0, filename: '/home/u/dl/Terminal 73.7z'
    };
    let erases = 0;
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ ...record }]),
      download: (_options, cb) => cb(downloadId),
      resume: (_id, cb) => cb(),
      cancel: (_id, cb) => {
        record = { ...record, error: 'USER_CANCELED', canResume: false };
        cb();
      },
      erase: (_query, cb) => { erases += 1; cb([]); }
    };

    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(erases, 0, 'a cancel that closed the record is enough');
    assert.equal(jobFailureCount(job), 0, 'the file is not failed');
    assert.equal(job.transferAttempts, 1, 'it gets a fresh attempt');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// Stop has the same problem in Chrome: its cancel left an interrupted download resumable, so the
// retirement never finished and starting the collection again was refused.
async function stopRetiresStuckResumableDownloadInChrome() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-chrome-stop-resumable';
  const downloadId = 914;
  const fileId = 74;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const calls = { resume: 0, cancel: 0, erase: 0 };
    const downloads = chromeLikeDownloads({
      id: downloadId, state: 'interrupted', paused: false, canResume: true, error: 'NETWORK_FAILED',
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0, filename: 'C:\\dl\\Terminal 74.7z'
    }, calls);
    global.chrome.downloads = downloads;

    await context.haltNdcJob(await readNdcJob(jobId), { notify: false });
    const job = await readNdcJob(jobId);
    assert.equal(job.status, 'stopped');
    assert.equal(downloads.record(), null, 'the stopped attempt can no longer be resumed');
    assert.equal(job.retiringDownloadId, undefined, 'so its retirement is finished');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// A complete delta can arrive before downloads.search catches up. The queue may only count a
// success once the record itself says complete; an in-progress record must remain owned.
async function completeEventRequiresCompleteRecord() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-complete-confirm';
  const downloadId = 905;
  const fileId = 65;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    let reads = 0;
    const active = {
      id: downloadId, state: 'in_progress', paused: false, canResume: false,
      bytesReceived: 40000, totalBytes: 166912, fileSize: 0,
      filename: '/home/u/dl/Terminal 65.7z'
    };
    global.chrome.downloads = {
      search: (_query, cb) => { reads += 1; cb([active]); },
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: finishCallback
    };

    await handleNdcDownloadTerminal(downloadId, 'complete', null);
    const job = await readNdcJob(jobId);
    const total = await storageGetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
    assert.ok(reads > 1, 'a stale complete record is re-read');
    assert.equal(job.activeDownloadId, downloadId, 'an in-progress record remains active');
    assert.equal(job.completed, 0, 'it is not counted as complete early');
    assert.equal(job.transferAttempts, 0, 'nor misclassified as a short-file retry');
    assert.equal(total, 0, 'the global total is untouched');
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// Stop can land while a terminal handler is still reading the item. The final state change is a
// compare-and-set: once Stop clears ownership, the stale terminal work must have no side effects.
async function stopWinsAgainstInFlightTerminalWork() {
  const previousDownloads = global.chrome.downloads;
  const previousGet = global.chrome.storage.local.get;
  const jobId = 'testjob-terminal-stop';
  const downloadId = 907;
  const fileId = 67;
  let releaseItems;
  let reachedItems;
  const itemsReached = new Promise((resolve) => { reachedItems = resolve; });

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    const itemKey = `nxtk_ndc_items:${jobId}`;
    let held = false;
    global.chrome.storage.local.get = (keys, callback) => {
      if (!held && keys === itemKey) {
        held = true;
        previousGet.call(global.chrome.storage.local, keys, (value) => {
          reachedItems();
          new Promise((resolve) => { releaseItems = resolve; }).then(() => callback(value));
        });
        return;
      }
      previousGet.call(global.chrome.storage.local, keys, callback);
    };
    const complete = {
      id: downloadId, state: 'complete', paused: false, canResume: false,
      bytesReceived: 166912, totalBytes: 166912, fileSize: 166912,
      mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 67.7z'
    };
    global.chrome.downloads = {
      search: (_query, cb) => cb([complete]),
      removeFile: (_id, cb) => cb(),
      download: (_options, cb) => cb(downloadId),
      cancel: finishCallback
    };

    const terminal = handleNdcDownloadTerminal(downloadId, 'complete', null);
    let barrierTimer;
    await Promise.race([
      itemsReached,
      new Promise((_, reject) => {
        barrierTimer = setTimeout(() => reject(new Error('terminal handler never reached item read')), 1000);
      })
    ]).finally(() => clearTimeout(barrierTimer));
    await NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP({ jobId }, { tab: { id: 7 } });
    releaseItems();
    await terminal;

    const job = await readNdcJob(jobId);
    const history = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    const total = await storageGetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
    assert.deepStrictEqual(
      { status: job.status, active: job.activeDownloadId, index: job.index, completed: job.completed },
      { status: 'stopped', active: null, index: 0, completed: 0 },
      'the stopped job cannot be advanced by stale terminal work'
    );
    assert.deepStrictEqual(history, {}, 'no download history is written after Stop wins');
    assert.equal(total, 0, 'the global completed total is unchanged');
  } finally {
    if (releaseItems) releaseItems();
    global.chrome.storage.local.get = previousGet;
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// The public report code is intentionally broad, but its collapse identity must include the
// underlying queue failure and file. Exact repeats collapse; different diagnoses remain visible.
async function queueFailureLogKeepsDistinctFaults() {
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  try {
    const job = { gameId: '1704', type: 'all' };
    await Promise.all([
      recordQueueItemFailure(job, { fileId: 71 }, 'short_file'),
      recordQueueItemFailure(job, { fileId: 71 }, 'short_file'),
      recordQueueItemFailure(job, { fileId: 72 }, 'short_file'),
      recordQueueItemFailure(job, { fileId: 71 }, 'not_a_file')
    ]);

    const log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
    const queueFailures = log
      .filter((entry) => entry.code === 'queue_item_failed')
      .map((entry) => ({
        technicalMessage: entry.technicalMessage,
        count: Math.max(1, Number(entry.count) || 1)
      }))
      .sort((left, right) => left.technicalMessage.localeCompare(right.technicalMessage));
    assert.deepStrictEqual(queueFailures, [
      { technicalMessage: 'not_a_file | file 71 | game 1704 | all', count: 1 },
      { technicalMessage: 'short_file | file 71 | game 1704 | all', count: 2 },
      { technicalMessage: 'short_file | file 72 | game 1704 | all', count: 1 }
    ], 'queue log collapse identity includes the file and underlying failure code');
  } finally {
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  }
}

async function newRegressionCoverage() {
  const failures = [];
  for (const [name, test] of [
    ['concurrent terminal signals', concurrentTerminalSignalsAreAppliedOnce],
    ['non-resumable interrupted confirmation', nonResumableInterruptGetsConfirmationRead],
    ['failed cancellation defers retry', failedCancellationDefersRetry],
    ['delayed cancel completion is observed', delayedCancelCompletionIsObserved],
    ['repeated uncancelled interruption fails safely', repeatedUncancelledInterruptFailsWithoutDuplicate],
    ['resumable interruption is resumed', resumableInterruptIsActuallyResumed],
    ['stuck resumable interruption fails safely', stuckResumableInterruptFailsWithoutDuplicate],
    ['stuck resumable interruption is closed then retried in Chrome', stuckResumableInterruptIsClosedThenRetriedInChrome],
    ['unconfirmed erase still fails without a duplicate', unconfirmedEraseStillFailsWithoutDuplicate],
    ['cancelled stuck resume is retried in Firefox', cancelledStuckResumeIsRetriedInFirefox],
    ['stop retires a stuck resumable download in Chrome', stopRetiresStuckResumableDownloadInChrome],
    ['complete event requires a complete record', completeEventRequiresCompleteRecord],
    ['stop wins against terminal work', stopWinsAgainstInFlightTerminalWork],
    ['queue failure log identity', queueFailureLogKeepsDistinctFaults]
  ]) {
    try {
      await test();
    } catch (cause) {
      failures.push(`${name}: ${cause?.message || cause}`);
    }
  }
  if (failures.length) {
    throw new Error(`new background regressions:\n- ${failures.join('\n- ')}`);
  }
}

// The other half of the two-copies-on-disk report: whatever the extension stops waiting on has
// to be taken off disk, or the retry is uniquified to "Mod (1).7z" and the mod manager still
// finds the broken "Mod.7z" first. Only ever a download this extension started.
async function abandonedFilesAreRemoved() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-abandon';
  const items = [{
    fileId: 55, historyId: '55', gameId: '1704', name: 'Half.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/55', sizeKb: 10240, optional: false
  }];

  const start = async (overrides = {}) => {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'col-2', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: 700, transferAttempts: 0,
        createdAt: Date.now(), updatedAt: Date.now(), ...overrides
      }
    });
    return readNdcJob(jobId);
  };

  try {
    // An interrupted transfer that nevertheless left a finished file behind. Before the fix this
    // path could not delete anything at all — the discard was guarded by state === 'complete'.
    let removed = [];
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ id: 700, state: 'complete', byExtensionId: 'test-extension-id', bytesReceived: 1024, totalBytes: 10485760, fileSize: 1024, mime: 'application/zip', filename: 'C:\\dl\\NexusMods\\Half.7z' }]),
      download: (_options, cb) => cb(700),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      cancel: finishCallback
    };
    await start();
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 700, 'interrupted', 'NETWORK_FAILED');
    assert.deepStrictEqual(removed, [700],
      'a file left behind by an abandoned transfer is removed before the retry');

    // Giving up for good must not leave the bad copy under the name the mod manager reads.
    removed = [];
    await start({ transferAttempts: 1 });
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 700, 'interrupted', 'NETWORK_FAILED');
    const job = await readNdcJob(jobId);
    assert.equal(jobFailureCount(job), 1, 'the file is recorded as failed');
    assert.equal(job.index, 1, 'and the queue moves on');
    assert.deepStrictEqual(removed, [700], 'but what it left on disk goes with it');

    // A record another extension owns is never touched, whatever id we were handed.
    removed = [];
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ id: 700, state: 'complete', byExtensionId: 'some-other-extension', fileSize: 1024, filename: 'C:\\dl\\Half.7z' }]),
      download: (_options, cb) => cb(700),
      removeFile: (id, cb) => { removed.push(id); cb(); },
      cancel: finishCallback
    };
    await start();
    await applyNdcDownloadTerminal(await readNdcJob(jobId), 700, 'interrupted', 'NETWORK_FAILED');
    assert.deepStrictEqual(removed, [], 'a download this extension did not start is left alone');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// START writes the item payload before it publishes the job. A Stop in that window must cancel
// the start intent, rather than return job-not-found and let an invisible queue appear afterward.
async function stopCancelsAPendingStart() {
  const previousSet = global.chrome.storage.local.set;
  const previousDownloads = global.chrome.downloads;
  const gameId = 'pending-start-game';
  const collectionId = 'pending-start-collection';
  const startId = 'pending-start-intent-1';
  let releaseItems;
  let reachedItems;
  let startedDownloads = 0;
  const itemsReached = new Promise((resolve) => { reachedItems = resolve; });

  try {
    await storageSetLocal(NDC_JOBS_KEY, {});
    global.chrome.downloads = {
      search: (_query, cb) => cb([]),
      download: (_options, cb) => { startedDownloads += 1; cb(991); },
      cancel: finishCallback
    };
    let held = false;
    global.chrome.storage.local.set = (items, callback) => {
      const itemKey = Object.keys(items).find((key) => key.startsWith('nxtk_ndc_items:'));
      if (!held && itemKey) {
        held = true;
        reachedItems();
        new Promise((resolve) => { releaseItems = resolve; })
          .then(() => previousSet.call(global.chrome.storage.local, items, callback));
        return;
      }
      previousSet.call(global.chrome.storage.local, items, callback);
    };

    const payload = {
      gameId,
      collectionId,
      startId,
      type: 'all',
      folder: '',
      requestTimeout: 30000,
      items: [{
        fileId: 81, historyId: '81', gameId: '1704', name: 'Pending.7z',
        pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/81', sizeKb: 10
      }]
    };
    const starting = NDC_QUEUE_HANDLERS.NDC_QUEUE_START(payload, { tab: { id: 7 } });
    await itemsReached;
    const stopped = await NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP(
      { gameId, collectionId, startId },
      { tab: { id: 7 } }
    );
    assert.equal(stopped.stopped, true,
      'Stop acknowledges an in-flight start even before it has a job id');
    assert.equal(stopped.pending, true);
    releaseItems();
    const result = await starting;
    assert.equal(result.stopped, true, 'the canceled START reports that it did not create a run');
    assert.equal(startedDownloads, 0, 'no browser download starts after the early Stop');
    const jobs = await storageGetLocal(NDC_JOBS_KEY, {});
    assert.equal(Object.values(jobs).some((job) => job.gameId === gameId && job.collectionId === collectionId), false,
      'no ghost background job is published');
  } finally {
    if (releaseItems) releaseItems();
    global.chrome.storage.local.set = previousSet;
    global.chrome.downloads = previousDownloads;
  }
}

// Restart used to launch the replacement while the old downloads.download callback was still
// pending. Whichever callback won the race got the plain filename and the other got "(1)".
async function restartWaitsForAnInFlightStart() {
  const previousDownloads = global.chrome.downloads;
  const previousFetch = context.fetch;
  const oldJobId = 'testjob-restart-flight';
  const gameId = 'restart-flight-game';
  const collectionId = 'restart-flight-collection';
  const oldItem = {
    fileId: 82, historyId: '82', gameId: '1704', name: 'Old.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/82', sizeKb: 10
  };
  let releaseOldDownload;
  let reachedOldDownload;
  const oldDownloadReached = new Promise((resolve) => { reachedOldDownload = resolve; });
  const events = [];
  let downloadCalls = 0;

  try {
    await storageSetLocal(`nxtk_ndc_items:${oldJobId}`, [oldItem]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [oldJobId]: {
        id: oldJobId, tabId: 7, gameId, collectionId, type: 'all',
        scopeKey: ndcScopeKey('all', [oldItem]), itemCount: 1, index: 0, completed: 0,
        failed: [], status: 'running', activeDownloadId: null,
        createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    context.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => String(url).includes('GenerateDownloadUrl')
        ? '{"url":"https://premium-files.nexus-cdn.com/1/2/file.7z?key=k&expires=1&user_id=2"}'
        : '<a href="/auth/sign_out">Log out</a>',
      headers: { get: (name) => name === 'Content-Type' ? 'text/html' : '' }
    });
    global.chrome.downloads = {
      download: (_options, callback) => {
        downloadCalls += 1;
        events.push(`start:${downloadCalls}`);
        if (downloadCalls === 1) {
          reachedOldDownload();
          releaseOldDownload = () => callback(1001);
        } else {
          callback(1002);
        }
      },
      cancel: (id, callback) => { events.push(`cancel:${id}`); callback(); },
      search: ({ id }, callback) => callback([{
        id, state: 'interrupted', paused: false, canResume: false,
        bytesReceived: 0, totalBytes: 100, filename: `C:\\dl\\${id}.7z`
      }]),
      removeFile: (_id, callback) => callback()
    };

    const oldProcessing = processNdcJob(oldJobId);
    await oldDownloadReached;
    const replacement = NDC_QUEUE_HANDLERS.NDC_QUEUE_START({
      gameId,
      collectionId,
      startId: 'restart-flight-intent-1',
      restart: true,
      type: 'all',
      folder: '',
      requestTimeout: 30000,
      items: [{ ...oldItem, fileId: 83, historyId: '83', name: 'New.7z' }]
    }, { tab: { id: 7 } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(downloadCalls, 1, 'the replacement does not start before the old callback resolves');
    releaseOldDownload();
    await oldProcessing;
    const result = await replacement;
    assert.equal(downloadCalls, 2, 'the replacement starts after the old attempt is retired');
    assert.ok(events.indexOf('cancel:1001') < events.indexOf('start:2'),
      `the old id is canceled before the replacement (${events.join(', ')})`);
    assert.equal((await readNdcJob(result.jobId)).activeDownloadId, 1002,
      'the replacement owns only its own exact browser id');
  } finally {
    if (releaseOldDownload) releaseOldDownload();
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
  }
}

// A terminal event can happen while a paused worker is asleep. Resume must inspect that exact id
// instead of returning early merely because activeDownloadId is non-null.
async function resumeConsumesAMissedTerminal() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-resume-terminal';
  const downloadId = 1003;
  const item = {
    fileId: 84, historyId: '84', gameId: '1704', name: 'Finished while paused.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/84', sizeKb: 1,
    optional: false
  };

  try {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: 'resume-game', collectionId: 'resume-collection',
        type: null, itemCount: 1, index: 0, completed: 0, failed: [], status: 'paused',
        activeDownloadId: downloadId, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    global.chrome.downloads = {
      search: (_query, callback) => callback([{
        id: downloadId, state: 'complete', paused: false, canResume: false,
        bytesReceived: 1024, totalBytes: 1024, fileSize: 1024,
        mime: 'application/x-7z-compressed', filename: 'C:\\dl\\Finished while paused.7z'
      }]),
      cancel: finishCallback,
      removeFile: (_id, callback) => callback(),
      download: (_options, callback) => callback(1004)
    };

    const reply = await NDC_QUEUE_HANDLERS.NDC_QUEUE_RESUME({ jobId }, { tab: { id: 7 } });
    const job = await readNdcJob(jobId);
    assert.equal(reply.resumed, true);
    assert.equal(job.status, 'finished', 'Resume reconciles and finishes the already-complete id');
    assert.equal(job.completed, 1);
    assert.equal(job.index, 1);
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
  }
}

// The terminal CAS releases activeDownloadId before history/count writes finish. A status poll in
// that small window must not start the next file until those side effects are complete.
async function terminalSideEffectsFinishBeforeTheNextDownload() {
  const previousDownloads = global.chrome.downloads;
  const previousFetch = context.fetch;
  const previousSet = global.chrome.storage.local.set;
  const jobId = 'testjob-terminal-side-effects';
  const downloadId = 1005;
  const makeItem = (fileId) => ({
    fileId, historyId: String(fileId), gameId: '1704', name: `Side effect ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`,
    sizeKb: 1, optional: false
  });
  let releaseTotal;
  let reachedTotal;
  const totalReached = new Promise((resolve) => { reachedTotal = resolve; });
  let starts = 0;

  try {
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [makeItem(85), makeItem(86)]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: 'side-effect-game', collectionId: 'side-effect-collection',
        type: null, itemCount: 2, index: 0, completed: 0, failed: [], status: 'running',
        activeDownloadId: downloadId, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    let held = false;
    global.chrome.storage.local.set = (items, callback) => {
      if (!held && Object.hasOwn(items, NXTK.TOTAL_DOWNLOADS_KEY)) {
        held = true;
        previousSet.call(global.chrome.storage.local, items, () => {
          reachedTotal();
          new Promise((resolve) => { releaseTotal = resolve; }).then(() => callback?.());
        });
        return;
      }
      previousSet.call(global.chrome.storage.local, items, callback);
    };
    context.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => String(url).includes('GenerateDownloadUrl')
        ? '{"url":"https://premium-files.nexus-cdn.com/1/2/next.7z?key=k&expires=1&user_id=2"}'
        : '<a href="/auth/sign_out">Log out</a>',
      headers: { get: () => '' }
    });
    global.chrome.downloads = {
      search: ({ id }, callback) => callback([{
        id, state: 'complete', paused: false, canResume: false,
        bytesReceived: 1024, totalBytes: 1024, fileSize: 1024,
        mime: 'application/x-7z-compressed', filename: `C:\\dl\\${id}.7z`
      }]),
      download: (_options, callback) => { starts += 1; callback(1006); },
      cancel: finishCallback,
      removeFile: (_id, callback) => callback()
    };

    const terminal = handleNdcDownloadTerminal(downloadId, 'complete', null);
    await totalReached;
    await NDC_QUEUE_HANDLERS.NDC_QUEUE_STATUS({ jobId }, { tab: { id: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(starts, 0, 'a status nudge cannot overtake terminal history/count writes');
    releaseTotal();
    const nextJobId = await terminal;
    await processNdcJob(nextJobId);
    assert.equal(starts, 1, 'the next file starts once terminal side effects have finished');
  } finally {
    if (releaseTotal) releaseTotal();
    global.chrome.storage.local.set = previousSet;
    global.chrome.downloads = previousDownloads;
    context.fetch = previousFetch;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// A queue holds up to ten thousand files, so an early fault could write ten thousand records
// into a ten megabyte store. What is kept is capped; what is counted must not be.
function failureRecordsAreCapped() {
  assert.ok(MAX_TRACKED_FAILURES > 0 && MAX_TRACKED_FAILURES <= 200,
    `the cap is a sane size (${MAX_TRACKED_FAILURES})`);

  const job = { failed: [], failedTotal: 0 };
  for (let index = 0; index < MAX_TRACKED_FAILURES + 250; index += 1) {
    recordJobFailure(job, { fileId: index, code: 'short_file' });
  }
  assert.equal(job.failed.length, MAX_TRACKED_FAILURES, 'the stored list stops at the cap');
  assert.equal(jobFailureCount(job), MAX_TRACKED_FAILURES + 250, 'but the count keeps going');
  assert.equal(job.failed[0].fileId, 0, 'and the earliest failure is the one kept');
  assert.equal(job.failed[MAX_TRACKED_FAILURES - 1].fileId, MAX_TRACKED_FAILURES - 1,
    'in the order they happened');

  // A job written by an older version has no total, so the list length still answers for it.
  assert.equal(jobFailureCount({ failed: [{ fileId: 1 }, { fileId: 2 }] }), 2,
    'a job from before the cap is counted from its list');
  assert.equal(jobFailureCount({ failed: [] }), 0, 'an empty list is no failures');
  assert.equal(jobFailureCount({}), 0, 'and neither is a job with no list at all');
  assert.equal(jobFailureCount(null), 0, 'nor no job');

  // The first failure on a fresh job has to start the count from the list it inherits.
  const inherited = { failed: [{ fileId: 9, code: 'x' }] };
  recordJobFailure(inherited, { fileId: 10, code: 'y' });
  assert.equal(jobFailureCount(inherited), 2, 'a job upgraded mid-run does not lose its earlier failures');
}

// From issue #6, on Firefox: the record behind a just-fired 'complete' still held counters
// from a tenth of the way through the transfer, so a file that was whole on disk was reported
// as "got 16103 of 166716 declared" and failed. The record has to be allowed to settle.
async function staleRecordsAreNotJudged() {
  const previousDownloads = global.chrome.downloads;
  const item = { sizeKb: 163 };

  try {
    // Exactly what Firefox reported, then the settled truth one poll later.
    let reads = 0;
    const snapshots = [
      { bytesReceived: 16103, totalBytes: 166716, fileSize: 0, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' },
      { bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' }
    ];
    global.chrome.downloads = {
      search: (_query, cb) => { cb([snapshots[Math.min(reads++, snapshots.length - 1)]]); },
      download: (_options, cb) => cb(1),
      cancel: finishCallback
    };
    let verdict = await verifyTransferSize(1, item);
    assert.ok(reads > 1, 'the mid-transfer snapshot is not taken as final');
    assert.equal(verdict.suspicious, false, 'a file that is whole on disk is not called truncated');
    assert.match(verdict.detail, /got 166716 of 166716 declared/, 'and the settled numbers are reported');

    // The same shape for the second file in the report.
    reads = 0;
    snapshots[0] = { bytesReceived: 16111, totalBytes: 177780, fileSize: 0, mime: 'application/zip', filename: '/home/u/dl/B42 Inspect.zip' };
    snapshots[1] = { bytesReceived: 177780, totalBytes: 177780, fileSize: 177780, mime: 'application/zip', filename: '/home/u/dl/B42 Inspect.zip' };
    assert.equal((await verifyTransferSize(1, { sizeKb: 174 })).suspicious, false,
      'and for the zip that opened fine');

    // fileSize is preferred over a lagging bytesReceived.
    reads = 0;
    snapshots[0] = { bytesReceived: 16103, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/x/y.7z' };
    snapshots[1] = snapshots[0];
    verdict = await verifyTransferSize(1, item);
    assert.equal(reads, 1, 'a record with a final size on disk is settled at once');
    assert.equal(verdict.suspicious, false, 'and is judged by that size');

    // A transfer really cut short still fails, once the record has stopped moving.
    reads = 0;
    const stuck = { bytesReceived: 1024, totalBytes: 166716, fileSize: 1024, mime: 'application/zip', filename: '/x/y.zip' };
    snapshots[0] = stuck;
    snapshots[1] = stuck;
    verdict = await verifyTransferSize(1, item);
    assert.equal(verdict.suspicious, true, 'a genuinely truncated file is still refused');
    assert.equal(verdict.code, 'short_file');

    // A record that never settles is not waited on forever.
    reads = 0;
    const moving = { bytesReceived: 500, totalBytes: 166716, fileSize: 0, mime: 'application/zip', filename: '/x/y.zip' };
    snapshots[0] = moving;
    snapshots[1] = moving;
    await verifyTransferSize(1, item);
    assert.ok(reads <= 6, `the settle loop is bounded (${reads} reads)`);

    // A complete event can precede all counters, including totalBytes. Zero/unknown is not proof
    // of an empty file until the browser has had a chance to publish its final record.
    reads = 0;
    snapshots[0] = { state: 'complete', bytesReceived: 0, totalBytes: 0, fileSize: 0, mime: '', filename: '/x/y.7z' };
    snapshots[1] = { state: 'complete', bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/x/y.7z' };
    verdict = await verifyTransferSize(1, item);
    assert.ok(reads > 1, 'zero/unknown counters are re-read before they are called empty');
    assert.equal(verdict.suspicious, false, 'the final non-empty record wins');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// Settings reach storage inside their bounds whoever writes them; a value of the wrong type is
// still refused outright.
async function settingsPatchIsNormalized() {
  const send = (type, payload) => new Promise((resolve) => {
    messageListeners[0]({ type, payload }, { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/abc', tab: { id: 7 } }, resolve);
  });
  const previousSettings = await context.storageGetLocal(context.NXTK.SETTINGS_KEY, null);
  const promptKey = 'nxtk_auto_report_prompt_v1';
  const previousPrompt = await context.storageGetLocal(promptKey, null);
  try {
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, { AutoErrorReports: true, AutoReportDiagnostics: true });
    await send('SETTINGS_PATCH', { patch: { AutoErrorReports: false } });
    assert.equal((await context.storageGetLocal(context.NXTK.SETTINGS_KEY)).AutoReportDiagnostics, false,
      'an older settings page revoking basic consent also revokes extra diagnostics');
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, { AutoErrorReports: false, AutoReportDiagnostics: true });
    await send('SETTINGS_PATCH', { patch: { AutoErrorReports: true } });
    assert.equal((await context.storageGetLocal(context.NXTK.SETTINGS_KEY)).AutoReportDiagnostics, false,
      'basic re-enabling cannot revive stale extra consent');
  } finally {
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, previousSettings);
    await context.storageSetLocal(promptKey, previousPrompt);
  }
  let reply = await send('SETTINGS_PATCH', { patch: { NDC_pauseBetweenDownload: -30, RequestTimeout: 1 } });
  assert.equal(reply.ok, true, 'out-of-range numbers are accepted');
  assert.equal(reply.value.NDC_pauseBetweenDownload, 0, 'but stored inside their bounds');
  assert.equal(reply.value.RequestTimeout, 5000, 'including a timeout too short to be useful');
  reply = await send('SETTINGS_PATCH', { patch: { RequestTimeout: 'soon' } });
  assert.equal(reply.ok, false, 'a value of the wrong type is still refused');
  assert.match(reply.error, /invalid-settings-value:RequestTimeout/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
}

// A modlist deck cannot be reattached after a reload, so the popup lists every run the worker still
// holds. Finished runs are left out, and a run with no name falls back to its collection.
async function activeQueuesAreListed() {
  const job = (id, overrides) => ({
    id, tabId: 7, gameId: 'g', collectionId: 'a-collection', label: '', type: null,
    itemCount: 4, index: 1, completed: 1, failed: [], status: 'running',
    activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now(), ...overrides
  });
  await storageSetLocal(NDC_JOBS_KEY, {
    'testjob-list-first': job('testjob-list-first', {
      label: 'Some Modlist', collectionId: 'wj-Some-Modlist', createdAt: Date.now() - 50
    }),
    'testjob-list-done': job('testjob-list-done', { status: 'finished' }),
    'testjob-list-later': job('testjob-list-later', { status: 'paused', itemCount: 2, index: 0 })
  });
  try {
    const listed = [...await NDC_QUEUE_HANDLERS.NDC_QUEUE_LIST()];
    assert.deepStrictEqual(listed.map((entry) => entry.jobId), ['testjob-list-first', 'testjob-list-later'],
      'only runs still active are listed, oldest first');
    assert.equal(listed[0].label, 'Some Modlist', 'a modlist is named as it was imported');
    assert.equal(listed[1].label, 'a-collection', 'a run with no name falls back to its collection');
    assert.equal(listed[0].total, 4);
    assert.equal(listed[1].status, 'paused');
  } finally {
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

// onInstalled also fires for every update and every browser update. The old 1.5 MB/s default is
// migrated only for a copy that last ran before the migration existed; after that it is a choice.
async function speedMigrationOnlyRunsForOldCopies() {
  assert.equal(installedListeners.length, 1, 'the worker registers one install listener');
  const run = async (details, speed) => {
    await storageSetLocal(NXTK.SETTINGS_KEY, { ...NXTK.DEFAULTS, NDC_downloadSpeed: speed });
    installedListeners[0](details);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return (await storageGetLocal(NXTK.SETTINGS_KEY, {})).NDC_downloadSpeed;
  };
  assert.equal(await run({ reason: 'update', previousVersion: '2.3.9' }, 1.5), NXTK.DEFAULTS.NDC_downloadSpeed,
    'a copy from before the default changed is migrated');
  assert.equal(await run({ reason: 'update', previousVersion: '2.6.4' }, 1.5), 1.5,
    'a chosen 1.5 MB/s survives an update');
  assert.equal(await run({ reason: 'chrome_update' }, 1.5), 1.5, 'and a browser update');
  assert.equal(await run({ reason: 'update', previousVersion: '2.3.9' }, 2), 2, 'another speed is never touched');
}

// The worker used to read a generated response with a simpler reader of its own: it ignored which
// file a link belonged to and would take a Vortex resolver page as a browser download.
async function workerResolvesTheRequestedFile() {
  const previousFetch = context.fetch;
  const item = {
    fileId: 42, gameId: '1704', name: 'Wanted.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42'
  };
  const wanted = 'https://premium-files.nexus-cdn.com/1/42/wanted.7z?key=b&expires=1';
  const attribute = (fileId, url) => `<button main-file="${
    JSON.stringify({ fileId, downloadUrl: url }).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  }">Download</button>`;
  const serve = (generated) => {
    context.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => (String(url).includes('GenerateDownloadUrl')
        ? generated
        : '<a href="/auth/sign_out">Log out</a>'),
      headers: { get: () => '' }
    });
  };

  try {
    serve(attribute(43, 'https://premium-files.nexus-cdn.com/1/43/other.7z?key=a&expires=1') + attribute(42, wanted));
    let resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.ok, true, 'a files-tab response resolves in the worker');
    assert.equal(resolved.url, wanted, 'to the link of the file that was asked for, not the first one listed');

    serve(JSON.stringify({ vortexDownloadUrl: 'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl' }));
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.ok, false, 'a Vortex resolver page is never taken as the file');
    assert.equal(resolved.code, 'no_download_url');

    serve(JSON.stringify({ url: wanted }));
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.url, wanted, 'the plain generated JSON still resolves');

    // Bug report #7: a removed mod's page is one notice. A queued file of it fails as unavailable.
    const asked = [];
    context.fetch = async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        status: 200,
        url: String(url),
        text: async () => '<form action="https://users.nexusmods.com/auth/sign_out"></form>'
          + '<div id="Notice3354" class="info warning clearfix site-notice "><div class="info-content">'
          + '<h3 id="Notice3354-title">Removed by author</h3>'
          + '<p id="Notice3354-paragraph"> The mod you were looking for was removed by its author </p></div></div>',
        headers: { get: () => '' }
      };
    };
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.code, 'mod_unavailable', 'a removed mod is named as such in the worker too');
    assert.deepEqual(asked, [item.pageUrl], 'without asking the generator for a link');
  } finally {
    context.fetch = previousFetch;
  }
}

// A removed mod, a 404 page and one Cloudflare answer are each skipped, and the rest of the run
// still downloads. The skipped files come back by name when the run ends (#10 follow-up).
async function skippedModsDoNotStopTheQueue() {
  const jobId = 'testjob-skipped01';
  const page = (id) => `https://www.nexusmods.com/skyrimspecialedition/mods/${id}`;
  const items = [
    { fileId: 11, historyId: '11', gameId: '1704', name: 'Removed.7z', pageUrl: page(11), sizeKb: 10 },
    { fileId: 12, historyId: '12', gameId: '1704', name: 'Gone.7z', pageUrl: page(12), sizeKb: 10 },
    { fileId: 13, historyId: '13', gameId: '1704', name: 'Walled.7z', pageUrl: page(13), sizeKb: 10 },
    { fileId: 14, historyId: '14', gameId: '1704', name: 'Fine.7z', pageUrl: page(14), sizeKb: 10 }
  ];
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: 'skips', type: null,
      itemCount: items.length, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
      activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
    }
  });

  const previousFetch = context.fetch;
  const previousDownloads = global.chrome.downloads;
  const previousSendMessage = global.chrome.tabs.sendMessage;
  const sent = [];
  const asked = [];
  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  context.fetch = async (url) => {
    const target = String(url);
    asked.push(target);
    const reply = (status, text, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      url: target,
      text: async () => text,
      headers: { get: (name) => headers[name] || '' }
    });
    if (target === page(11)) {
      return reply(200, `${signedIn}<div id="Notice1" class="site-notice"><h3 id="Notice1-title">Removed by author</h3></div>`);
    }
    if (target === page(12)) return reply(404, '<html><body>Not found</body></html>');
    if (target === page(13)) return reply(403, '<html>challenge</html>', { 'Cf-Mitigated': 'challenge' });
    if (target === page(14)) return reply(200, signedIn);
    return reply(200, '{"url":"https://premium-files.nexus-cdn.com/1/14/fine.7z?key=k&expires=1&user_id=2"}');
  };
  // The one file that resolves is refused by the browser, so the run ends without a live download.
  global.chrome.downloads = {
    download: (_options, cb) => {
      global.chrome.runtime.lastError = { message: 'user cancelled' };
      cb(undefined);
      global.chrome.runtime.lastError = null;
    },
    search: (_query, cb) => cb([]),
    cancel: finishCallback
  };
  global.chrome.tabs.sendMessage = (tabId, message, callback) => {
    sent.push(message);
    if (callback) callback();
  };

  try {
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(job.status, 'partial', 'the run reaches the end instead of stopping');
    assert.equal(job.index, 4, 'every file was reached');
    assert.deepEqual(job.skipped.map(({ name, reason }) => [name, reason]), [
      ['Removed.7z', 'mod_unavailable'],
      ['Gone.7z', 'mod_unavailable'],
      ['Walled.7z', 'cloudflare']
    ], 'each skip names the file and why');
    assert.equal(job.skipped[0].pageUrl, page(11), 'and keeps its page for the summary link');
    assert.equal(jobFailureCount(job), 1, 'a skip is not counted as a failure');
    assert.equal(asked.filter((url) => url === page(11)).length, 1, 'a removed mod is asked for once, not retried');
    assert.equal(asked.filter((url) => url === page(12)).length, 1, 'so is a 404 page');

    const skippedEvents = sent.filter((message) => message.type === 'NXT_NDC_PROGRESS' && message.itemState === 'skipped');
    assert.deepEqual(skippedEvents.map((message) => message.error), ['mod_unavailable', 'mod_unavailable', 'cloudflare']);
    const done = sent.find((message) => message.type === 'NXT_NDC_DONE');
    assert.equal(done?.outcome, 'partial');
    assert.equal(done.skippedCount, 3, 'the end of the run carries the count');
    assert.deepEqual(done.skipped.map(({ name }) => name), ['Removed.7z', 'Gone.7z', 'Walled.7z'],
      'and the list the deck prints');

    const log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
    const skipLines = log.filter((entry) => /Removed|Gone|file 1[123]\b/.test(JSON.stringify(entry)));
    assert.ok(skipLines.every((entry) => !/mod_unavailable/.test(JSON.stringify(entry))),
      'a mod that is gone is not written up as a fault');
    assert.ok(log.some((entry) => /cloudflare/.test(JSON.stringify(entry))), 'a Cloudflare skip is');
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
    global.chrome.tabs.sendMessage = previousSendMessage;
    global.chrome.runtime.lastError = null;
  }
}

// Cloudflare on file after file is the whole site behind a check. The run stops there, instead of
// marking a thousand-mod collection as skipped, and a status poll still gets the skipped list.
async function cloudflareStreakStopsTheQueue() {
  const jobId = 'testjob-cfstreak1';
  const limit = NXTK.CLOUDFLARE_SKIP_LIMIT;
  const items = Array.from({ length: limit + 3 }, (_, index) => ({
    fileId: 60 + index, historyId: String(60 + index), gameId: '1704', name: `Walled ${index}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${60 + index}`, sizeKb: 10
  }));
  await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
  await storageSetLocal(NDC_JOBS_KEY, {
    [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: 'walled', type: 'all',
      itemCount: items.length, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
      activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
    }
  });
  const previousFetch = context.fetch;
  const previousSendMessage = global.chrome.tabs.sendMessage;
  const sent = [];
  let pages = 0;
  context.fetch = async (url) => {
    pages += 1;
    return {
      ok: false, status: 403, url: String(url), text: async () => '',
      headers: { get: (name) => (name === 'Cf-Mitigated' ? 'challenge' : '') }
    };
  };
  global.chrome.tabs.sendMessage = (_tabId, message, callback) => {
    sent.push(message);
    if (callback) callback();
  };
  try {
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(pages, limit + 1, 'the first answer past the limit is where the run stops');
    assert.equal(job.status, 'error');
    assert.equal(job.lastError, 'cloudflare', 'as a Cloudflare block the user can clear');
    assert.equal(job.skipped.length, limit, 'the files before it were skipped, not failed');
    const done = sent.find((message) => message.type === 'NXT_NDC_DONE');
    assert.equal(done?.outcome, 'cloudflare');
    assert.equal(done.skipped.length, limit, 'a stopped run still lists what it skipped');
    const status = await NDC_QUEUE_HANDLERS.NDC_QUEUE_STATUS({ jobId });
    assert.equal(status.skippedCount, limit);
    assert.equal(status.skipped.length, limit, 'so does a status poll');
  } finally {
    context.fetch = previousFetch;
    global.chrome.tabs.sendMessage = previousSendMessage;
  }
}

// "Sent to Vortex" lists are written beside the downloaded ones; nothing else new is accepted.
async function vortexSentHistoryIsAccepted() {
  const send = (type, payload) => new Promise((resolve) => {
    messageListeners[0](
      { type, payload },
      { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/abc', tab: { id: 7 } },
      resolve
    );
  });
  const base = { gameId: 'gv', collectionId: 'cv' };
  const added = await send('NDC_HISTORY_ADD', { ...base, type: 'vortexSent_all', fileId: 123 });
  assert.equal(added.ok, true, 'a vortexSent_all entry is accepted');
  assert.deepEqual([...added.value.collection.vortexSent_all], [123]);
  assert.equal(added.value.collection.all, undefined, 'and is not recorded as downloaded');
  const bogus = await send('NDC_HISTORY_ADD', { ...base, type: 'vortexSent_bogus', fileId: 1 });
  assert.equal(bogus.error, 'invalid-history-type', 'only the known types get a sent list');
  const cleared = await send('NDC_HISTORY_CLEAR_TYPE', { ...base, type: 'vortexSent_all' });
  assert.equal(cleared.ok, true);
  assert.deepEqual([...cleared.value.collection.vortexSent_all], [], 'Redownload can clear the sent list');
}

// Stress: a 2000-mod collection's history fits the storage quota and stays quick to write.
async function largeHistoryFitsTheQuota() {
  const send = (type, payload) => new Promise((resolve) => {
    messageListeners[0]({ type, payload }, { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/big', tab: { id: 7 } }, resolve);
  });
  const base = { gameId: 'gbig', collectionId: 'cbig' };
  const ids = Array.from({ length: 2000 }, (_, i) => 1000000 + i);
  const startedAt = Date.now();
  const set = await send('NDC_HISTORY_SET_COLLECTION', { ...base, lists: { all: ids } });
  assert.equal(set.ok, true, '2000 downloaded entries are accepted at once');
  for (const id of ids.slice(0, 2000)) {
    const added = await send('NDC_HISTORY_ADD', { ...base, type: 'vortexSent_all', fileId: id });
    assert.equal(added.ok, true);
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 20000, `2000 sequential history writes took ${elapsed} ms`);
  const history = await storageGetLocal(STORAGE_HISTORY_KEY, null);
  const collection = history.gbig.cbig;
  assert.equal(collection.all.length, 2000);
  assert.equal(collection.vortexSent_all.length, 2000);
  const bytes = Buffer.byteLength(JSON.stringify(history));
  // chrome.storage.local allows 10 MB without unlimitedStorage; one big collection must stay a tiny share.
  assert.ok(bytes < 200 * 1024, `history for 2x2000 ids is ${bytes} bytes`);
  const dup = await send('NDC_HISTORY_ADD', { ...base, type: 'vortexSent_all', fileId: ids[0] });
  assert.equal(dup.value.collection.vortexSent_all.length, 2000, 'a repeat id is not stored twice');
  await send('NDC_HISTORY_CLEAR_TYPE', { ...base, type: 'vortexSent_all' });
  await send('NDC_HISTORY_CLEAR_TYPE', { ...base, type: 'all' });
}

// The last check before a URL reaches chrome.downloads or Vortex. Each refusal names its reason, so a
// change that lets one through shows up as the reason it no longer gives.
function downloadTargetsAreRefused() {
  const browser = { method: 1 };
  const signed = 'nxm://skyrimspecialedition/mods/1/files/2?key=k&expires=1&user_id=3';
  const cdn = 'https://premium-files.nexus-cdn.com/1704/1/a.7z';
  for (const [url, options, detail] of [
    [cdn, browser, null],
    ['HTTPS://Premium-Files.NEXUS-CDN.com./1704/1/a.7z', browser, null],
    [signed, undefined, null],
    ['http://premium-files.nexus-cdn.com/1704/1/a.7z', browser, 'bad-protocol:http'],
    ['javascript:alert(1)//premium-files.nexus-cdn.com', browser, 'bad-protocol:javascript'],
    ['data:application/zip;base64,UEsDBA==', browser, 'bad-protocol:data'],
    ['blob:https://www.nexusmods.com/0b8f', browser, 'bad-protocol:blob'],
    ['file:///C:/Windows/System32/calc.exe', browser, 'bad-protocol:file'],
    ['ftp://premium-files.nexus-cdn.com/a.7z', browser, 'bad-protocol:ftp'],
    ['https://premium-files.nexus-cdn.com.evil.example/a.7z', browser, 'host-not-allowed:premium-files.nexus-cdn.com.evil.example'],
    ['https://evilnexus-cdn.com/a.7z', browser, 'host-not-allowed:evilnexus-cdn.com'],
    ['https://evil.example/premium-files.nexus-cdn.com/a.7z', browser, 'host-not-allowed:evil.example'],
    ['https://evil.example\\@premium-files.nexus-cdn.com/a.7z', browser, 'host-not-allowed:evil.example'],
    ['https://nexus-cdn.com@evil.example/a.7z', browser, 'embedded-credentials'],
    ['https://user:pass@premium-files.nexus-cdn.com/a.7z', browser, 'embedded-credentials'],
    [`${cdn}?${'a'.repeat(2100)}`, browser, 'too-long'],
    ['   ', browser, 'empty'],
    [null, browser, 'empty'],
    ['premium-files.nexus-cdn.com/a.7z', browser, 'not-a-url'],
    // Vortex takes only a signed nxm link, and Vortex is the default.
    [cdn, undefined, 'bad-protocol:https'],
    [cdn, { method: 0 }, 'bad-protocol:https'],
    [signed, browser, 'bad-protocol:nxm'],
    ['nxm://skyrimspecialedition/mods/1/files/2', undefined, 'missing-nxm-params:key,expires,user_id'],
    ['nxm://skyrimspecialedition/mods/1/files/2?key=&expires=1&user_id=3', undefined, 'missing-nxm-params:key'],
    ['nxm://me:pw@skyrimspecialedition/mods/1/files/2?key=k&expires=1&user_id=3', undefined, 'embedded-credentials']
  ]) {
    const verdict = NXTK.validateDownloadTarget(url, options);
    const label = `${String(url).slice(0, 72)} (${options?.method === 1 ? 'browser' : 'vortex'})`;
    if (detail === null) assert.equal(verdict.ok, true, `${label} is accepted`);
    else assert.deepEqual({ ok: verdict.ok, detail: verdict.detail }, { ok: false, detail }, `${label} is refused`);
  }
}

// What each Nexus answer means for a queued file, through the worker's own resolver. Cloudflare's
// passive bot-check script rides along on ordinary pages and is no challenge; a challenge is one
// whatever its status; and a bare status names the rest.
async function nexusAnswersAreClassified() {
  const previousFetch = context.fetch;
  const item = { fileId: 42, gameId: '1704', name: 'Wanted.7z', pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42' };
  const link = 'https://premium-files.nexus-cdn.com/1/42/wanted.7z?key=k&expires=1';
  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  const passive = '<script>a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';</script>';
  const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cvId:"3"};</script></body></html>';
  const answer = ({ status = 200, body = '', headers = {} } = {}) => ({
    ok: status >= 200 && status < 300, status, url: '', text: async () => body,
    headers: { get: (name) => headers[name] || '' }
  });
  const generated = { body: JSON.stringify({ url: link }) };
  try {
    for (const [label, page, generator, expected] of [
      ['the passive bot check on a signed-in page', { body: signedIn + passive }, generated, { ok: true, url: link }],
      ['the passive bot check on a page with no session markers', { body: `<html><body>Skyrim</body>${passive}</html>` }, generated, { ok: true, url: link }],
      ['a _cf_chl_opt challenge answered 403', { status: 403, body: challenge }, null, { ok: false, code: 'cloudflare' }],
      ['a _cf_chl_opt challenge answered 503', { status: 503, body: challenge }, null, { ok: false, code: 'cloudflare' }],
      ['a _cf_chl_opt challenge inside a signed-in 200', { body: `${signedIn}<script>window._cf_chl_opt={}</script>` }, null, { ok: false, code: 'cloudflare' }],
      ['Cf-Mitigated on an empty 403', { status: 403, headers: { 'Cf-Mitigated': 'challenge' } }, null, { ok: false, code: 'cloudflare' }],
      ['Cf-Mitigated on the generator', { body: signedIn }, { status: 403, headers: { 'Cf-Mitigated': 'challenge' } }, { ok: false, code: 'cloudflare' }],
      ['a plain 403', { status: 403, body: '<html>Forbidden</html>' }, null, { ok: false, code: 'page_request_failed', status: 403 }],
      ['a plain 503', { status: 503, body: '<html>Service Unavailable</html>' }, null, { ok: false, code: 'page_request_failed', status: 503 }],
      ['a 429 with Retry-After', { status: 429, headers: { 'Retry-After': '120' } }, null, { ok: false, code: 'rate_limited', status: 429, retryAfter: '120' }],
      ['a generator 429', { body: signedIn }, { status: 429, headers: { 'Retry-After': '30' } }, { ok: false, code: 'rate_limited', status: 429, retryAfter: '30' }],
      ['a generator sign-in error', { body: signedIn }, { status: 403, body: '{"code":"unauthenticated"}' }, { ok: false, code: 'requires_login' }],
      ['a 404 page', { status: 404 }, null, { ok: false, code: 'mod_unavailable' }],
      ['a generator 410', { body: signedIn }, { status: 410 }, { ok: false, code: 'file_not_found' }],
      ['a generator 503', { body: signedIn }, { status: 503 }, { ok: false, code: 'generate_failed', status: 503 }]
    ]) {
      const asked = [];
      context.fetch = async (url) => {
        asked.push(String(url));
        return answer(String(url).includes('GenerateDownloadUrl') ? generator : page);
      };
      const result = await context.resolveNdcBrowserUrl(item, 30000);
      const seen = Object.fromEntries(Object.keys(expected).map((key) => [key, result[key]]));
      assert.deepEqual(seen, expected, label);
      assert.equal(asked.length, generator ? 2 : 1, `${label}: ${generator ? 'the generator is asked once' : 'nothing more is asked'}`);
    }
  } finally {
    context.fetch = previousFetch;
  }
}

// Discord report from 3.1.4 (Firefox): a queued file failed as no_download_url with nothing about what
// Nexus answered. The failure now carries the shape of both answers, which three resolve attempts
// produced before the file was given up on.
async function queueNoLinkFailureSaysWhy() {
  const previousFetch = context.fetch;
  const previousDelay = NXTK.retryDelayMs;
  const jobId = 'testjob-no-link-detail';
  const item = {
    fileId: 77, historyId: '77', gameId: '1704', name: 'Pinned.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/77', sizeKb: 10
  };
  let generatorAsked = 0;
  try {
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'no-link', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
        activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    NXTK.retryDelayMs = () => 0;
    context.fetch = async (url) => {
      const generator = String(url).includes('GenerateDownloadUrl');
      if (generator) generatorAsked += 1;
      return {
        ok: true, status: 200, url: String(url),
        text: async () => (generator ? '{"url":""}' : '<!doctype html><html><body><a href="/auth/sign_out">Log out</a></body></html>'),
        headers: { get: () => '' }
      };
    };
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(generatorAsked, 3, 'three resolve attempts before the file is given up on');
    assert.deepEqual([...job.failed].map((entry) => entry.code), ['no_download_url']);
    const log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
    const entry = log.find((line) => line.code === 'queue_item_failed');
    assert.ok(entry, 'the failure is in the error log');
    assert.match(entry.technicalMessage,
      /^no_download_url \| generator HTTP 200: JSON \{url\}; url empty; no link in it \| page HTTP 200: HTML page; no link in it \| file 77/,
      'with what the generator and the page answered');
    assert.doesNotMatch(entry.technicalMessage, /ad timer/, 'with no saved setting (it is on by default) nothing is said');

    // With "Hide ads and Premium panels" off the deck writes no ad-timer cookie for the queue, and the
    // report says so: Nexus can hold a link back without it, which looks the same as no link.
    await storageSetLocal(NXTK.SETTINGS_KEY, { HidePremiumUpsells: false });
    const held = await context.resolveNdcBrowserUrl(item, 30000);
    assert.match(held.detail, / \| ad timer cookie off$/);
    await storageSetLocal(NXTK.SETTINGS_KEY, { HidePremiumUpsells: true });
    assert.doesNotMatch((await context.resolveNdcBrowserUrl(item, 30000)).detail, /ad timer/);
  } finally {
    context.fetch = previousFetch;
    NXTK.retryDelayMs = previousDelay;
    await storageSetLocal(NDC_JOBS_KEY, {});
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  }
}

// A dropped connection is waited out on the same file, on an alarm, with the deck told it is the
// connection; failing the file and moving on failed every file after it within seconds. Only when every
// wait has run out does the run stop, with one error. A link request that gets no answer while the page
// did answer is that request's own failure and stays one.
async function queueWaitsOutLostConnection() {
  const previousFetch = context.fetch;
  const previousDelay = NXTK.retryDelayMs;
  const savedAlarms = global.chrome.alarms;
  const savedSendMessage = global.chrome.tabs.sendMessage;
  const savedDownloads = global.chrome.downloads;
  const jobId = 'testjob-connection';
  const items = [77, 78].map((fileId) => ({
    fileId, historyId: String(fileId), gameId: '1704', name: `File ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`, sizeKb: 10
  }));
  const seed = (extra = {}) => Promise.all([
    storageSetLocal(`nxtk_ndc_items:${jobId}`, items),
    storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'connection', type: 'all',
        itemCount: items.length, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
        activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now(), ...extra
      }
    })
  ]);
  const alarms = [];
  const events = [];
  const asked = [];
  let reachable = { page: false, generator: false };
  try {
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
    NXTK.retryDelayMs = () => 0;
    global.chrome.alarms = { create: (name, info) => alarms.push([name, info.when]), clear: () => {} };
    global.chrome.tabs.sendMessage = (_tabId, message, callback) => {
      events.push(JSON.parse(JSON.stringify(message)));
      if (callback) callback();
    };
    global.chrome.downloads = { ...savedDownloads, download: (_options, cb) => setTimeout(() => cb(501), 1), search: (_query, cb) => cb([]) };
    context.fetch = async (url) => {
      const generator = String(url).includes('GenerateDownloadUrl');
      asked.push(generator ? 'generator' : String(url).replace(/.*\/mods\//, 'page '));
      if (!reachable[generator ? 'generator' : 'page']) throw new TypeError('Failed to fetch');
      return {
        ok: true, status: 200, url: String(url),
        text: async () => (generator
          ? '{"url":"https://cf-files.nexus-cdn.com/1704/77/File-77.7z?md5=a&expires=1&user_id=2"}'
          : '<!doctype html><html><body><a href="/auth/sign_out">Log out</a></body></html>'),
        headers: { get: () => '' }
      };
    };

    await seed();
    await advanceNdcJob(jobId);
    let job = await readNdcJob(jobId);
    assert.deepEqual(asked, ['page 77', 'page 77', 'page 77'], 'the quick retries run first, all on the first file');
    assert.equal(job.status, 'running', 'a lost connection does not end the run');
    assert.equal(job.index, 0, 'nor move it past the file');
    assert.deepEqual([...job.failed], [], 'and the file is not counted as failed');
    assert.equal(job.networkStrikes, 1);
    assert.ok(job.waitingUntil >= Date.now() + 29000, 'the first wait is at least 30 s');
    assert.deepEqual(alarms.at(-1), [`nxtk-ndc-job:${jobId}`, job.waitingUntil], 'and runs on an alarm, so the worker may sleep');
    const waiting = events.filter((event) => event.type === 'NXT_NDC_WAITING');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].reason, 'network', 'the deck is told it is the connection, not a rate limit');
    assert.equal(waiting[0].until, job.waitingUntil);
    assert.equal((await storageGetLocal(NXTK.ERROR_LOG_KEY, [])).length, 0, 'waiting is not a fault');

    // The alarm fires with the connection back: the same file starts, and the count of waits resets.
    reachable = { page: true, generator: true };
    asked.length = 0;
    await mutateNdcJob(jobId, (current) => { current.waitingUntil = Date.now() - 1; });
    await advanceNdcJob(jobId);
    job = await readNdcJob(jobId);
    assert.deepEqual(asked, ['page 77', 'generator'], 'the waited-on file is asked for again');
    assert.equal(job.activeDownloadId, 501, 'and it starts');
    assert.equal(job.index, 0);
    assert.equal(job.networkStrikes, 0, 'an answer from Nexus resets the waits');
    assert.equal(job.waitingUntil, 0);

    // Still unreachable after the last wait: the run stops on that file, with one error that says so.
    reachable = { page: false, generator: false };
    asked.length = 0;
    events.length = 0;
    await seed({ networkStrikes: NXTK.NETWORK_WAIT_MAX_STRIKES });
    await advanceNdcJob(jobId);
    job = await readNdcJob(jobId);
    assert.deepEqual(asked, ['page 77', 'page 77', 'page 77'], 'the next file is never asked for');
    assert.equal(job.status, 'error');
    assert.equal(job.lastError, 'network_error');
    assert.equal(job.index, 0, 'starting again picks the same file up first');
    assert.deepEqual([...job.failed].map((entry) => entry.code), ['network_error']);
    const done = events.filter((event) => event.type === 'NXT_NDC_DONE');
    assert.equal(done.length, 1);
    assert.equal(done[0].outcome, 'error');
    assert.equal(done[0].error, 'network_error');
    const log = (await storageGetLocal(NXTK.ERROR_LOG_KEY, [])).filter((line) => line.code === 'queue_item_failed');
    assert.equal(log.length, 1, 'one error for the whole outage');
    assert.match(log[0].technicalMessage, /^network_error \| page: Failed to fetch after \d+ms \| file 77/);

    // The page answered but the link request did not: that request is the problem, and the file fails.
    reachable = { page: true, generator: false };
    asked.length = 0;
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
    await seed();
    await advanceNdcJob(jobId);
    job = await readNdcJob(jobId);
    assert.equal(asked.filter((step) => step === 'generator').length, 6, 'three attempts at each file\'s link');
    assert.deepEqual([...job.failed].map((entry) => entry.code), ['generate_failed', 'generate_failed'],
      'each file fails on its own, without a connection wait');
    assert.equal(job.status, 'partial');
    assert.ok(!job.networkStrikes);
    const failure = (await storageGetLocal(NXTK.ERROR_LOG_KEY, [])).find((line) => line.code === 'queue_item_failed');
    assert.match(failure.technicalMessage, /^generate_failed \| generator: Failed to fetch after \d+ms \| file 77/);
  } finally {
    context.fetch = previousFetch;
    NXTK.retryDelayMs = previousDelay;
    global.chrome.alarms = savedAlarms;
    global.chrome.tabs.sendMessage = savedSendMessage;
    global.chrome.downloads = savedDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  }
}

// Firefox numbers downloads afresh in every browser session, so after a restart the id a job saved can
// name somebody else's download. That download is never counted as the job's file, and never cancelled
// or deleted; the job's own download counts as lost and gets a fresh try.
async function reusedDownloadIdIsNeverTrusted() {
  const previousFetch = context.fetch;
  const savedDownloads = global.chrome.downloads;
  const jobId = 'testjob-reused-id';
  const item = {
    fileId: 4242, historyId: '4242', gameId: '1704', name: 'Ours.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/4242', sizeKb: 10
  };
  const ours = 'https://premium-files.nexus-cdn.com/1704/4242/Ours%20Main.7z';
  const ourPath = '/1704/4242/ours main.7z';
  const records = new Map();
  const canceled = [];
  const removed = [];
  let nextId = 50;
  const seed = (extra) => Promise.all([
    storageSetLocal(`nxtk_ndc_items:${jobId}`, [item]),
    storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'reused', type: 'all',
        itemCount: 1, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
        createdAt: Date.now(), updatedAt: Date.now(), ...extra
      }
    })
  ]);
  try {
    context.fetch = async (url) => ({
      ok: true, status: 200, url: String(url),
      text: async () => (String(url).includes('GenerateDownloadUrl')
        ? `{"url":"${ours}?md5=a&expires=1"}`
        : '<!doctype html><html><body><a href="/auth/sign_out">Log out</a></body></html>'),
      headers: { get: () => '' }
    });
    global.chrome.downloads = {
      ...savedDownloads,
      download: (options, cb) => {
        const id = nextId++;
        records.set(id, { id, state: 'in_progress', url: options.url, filename: '' });
        setTimeout(() => cb(id), 1);
      },
      search: (query, cb) => cb(records.has(query.id) ? [structuredClone(records.get(query.id))] : []),
      cancel: (id, cb) => { canceled.push(id); if (cb) cb(); },
      removeFile: (id, cb) => { removed.push(id); if (cb) cb(); },
      resume: (_id, cb) => { if (cb) cb(); }
    };

    // After the restart, id 3 is the user's own finished download.
    records.set(3, {
      id: 3, state: 'complete', url: 'https://bank.example/statement.pdf', filename: '/home/u/statement.pdf',
      exists: true, fileSize: 4000000, totalBytes: 4000000, bytesReceived: 4000000
    });
    await seed({ activeDownloadId: 3, activeDownloadPath: ourPath });
    await context.reconcileNdcJob(jobId);
    let job = await readNdcJob(jobId);
    assert.equal(job.completed, 0, 'somebody else\'s finished download is not counted as this file');
    const history = await storageGetLocal(STORAGE_HISTORY_KEY, {});
    assert.ok(!(history?.['1704']?.reused?.all || []).includes('4242'), 'nor written to the download history');
    assert.deepEqual(canceled, [], 'it is not cancelled');
    assert.deepEqual(removed, [], 'and its file is not deleted');
    assert.equal(job.activeDownloadId, 50, 'the file gets a fresh download of its own');
    assert.equal(job.activeDownloadPath, ourPath, 'whose link path is saved with it');

    // Stop while the saved id names somebody else's running download leaves that download alone.
    records.set(9, { id: 9, state: 'in_progress', url: 'https://video.example/v.mp4' });
    await seed({ activeDownloadId: 9, activeDownloadPath: ourPath });
    await NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP({ jobId }, { tab: { id: 7 } });
    job = await readNdcJob(jobId);
    assert.equal(job.status, 'stopped');
    assert.ok(!canceled.includes(9) && !removed.includes(9), 'Stop never cancels or deletes somebody else\'s download');
    assert.equal(job.retiringDownloadId, undefined, 'and has nothing left to retire');

    // The job's own download, under its own id, is still stopped as before.
    records.set(50, { id: 50, state: 'in_progress', url: `${ours}?md5=a&expires=1` });
    await seed({ activeDownloadId: 50, activeDownloadPath: ourPath });
    await NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP({ jobId }, { tab: { id: 7 } });
    assert.ok(canceled.includes(50), 'its own download is cancelled on Stop');
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = savedDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

// A full disk fails every file after the first one too, each after asking Nexus for a link, so the
// run stops on that file with one error that says what to do, and starting again picks it up.
async function fullDiskStopsTheRun() {
  const previousFetch = context.fetch;
  const savedDownloads = global.chrome.downloads;
  const savedSendMessage = global.chrome.tabs.sendMessage;
  const jobId = 'testjob-disk-full';
  const items = [61, 62, 63].map((fileId) => ({
    fileId, historyId: String(fileId), gameId: '1704', name: `File ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`, sizeKb: 10
  }));
  const records = new Map();
  const events = [];
  let generatorAsked = 0;
  try {
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'disk-full', type: 'all',
        itemCount: items.length, index: 0, completed: 0, failed: [], skipped: [], status: 'running',
        activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    context.fetch = async (url) => {
      const generator = String(url).includes('GenerateDownloadUrl');
      if (generator) generatorAsked += 1;
      return {
        ok: true, status: 200, url: String(url),
        text: async () => (generator
          ? '{"url":"https://cf-files.nexus-cdn.com/1704/61/File-61.7z?md5=a&expires=1"}'
          : '<!doctype html><html><body><a href="/auth/sign_out">Log out</a></body></html>'),
        headers: { get: () => '' }
      };
    };
    global.chrome.downloads = {
      ...savedDownloads,
      download: (options, cb) => {
        const id = 9700 + records.size;
        records.set(id, { id, state: 'interrupted', error: 'FILE_NO_SPACE', canResume: false, url: options.url });
        setTimeout(() => cb(id), 1);
      },
      search: (query, cb) => cb(records.has(query.id) ? [structuredClone(records.get(query.id))] : []),
      cancel: (_id, cb) => { if (cb) cb(); },
      removeFile: (_id, cb) => { if (cb) cb(); },
      resume: (_id, cb) => { if (cb) cb(); }
    };
    global.chrome.tabs.sendMessage = (_tabId, message, callback) => {
      events.push(JSON.parse(JSON.stringify(message)));
      if (callback) callback();
    };

    await advanceNdcJob(jobId);
    let job = await readNdcJob(jobId);
    assert.equal(job.activeDownloadId, 9700);
    const next = await handleNdcDownloadTerminal(9700, 'interrupted', 'FILE_NO_SPACE');
    assert.equal(next, null, 'nothing more is started');
    job = await readNdcJob(jobId);
    assert.equal(job.status, 'error', 'the run stops');
    assert.equal(job.lastError, 'save_failed');
    assert.equal(job.index, 0, 'on the file that could not be saved, so starting again picks it up');
    assert.equal(generatorAsked, 1, 'no link is asked for the files after it');
    const done = events.filter((event) => event.type === 'NXT_NDC_DONE');
    assert.equal(done.length, 1);
    assert.equal(done[0].error, 'save_failed', 'the deck is told why, in words it has');
    const log = (await storageGetLocal(NXTK.ERROR_LOG_KEY, [])).filter((line) => line.code === 'queue_item_failed');
    assert.equal(log.length, 1, 'one error for the run');
    assert.equal(log[0].causeCode, 'save_failed');
    assert.match(log[0].technicalMessage, /^save_failed \| FILE_NO_SPACE \[disk\] \| file 61/);
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = savedDownloads;
    global.chrome.tabs.sendMessage = savedSendMessage;
    await storageSetLocal(NDC_JOBS_KEY, {});
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  }
}

// A page asks the worker for a bundle; the worker adds exactly that bundle's packaged files to the
// document that asked. A page left or reloaded before its bundle arrived is no fault and is not logged;
// any other refusal is.
async function bundleLoadsAreTargetedAndQuiet() {
  const savedScripting = global.chrome.scripting;
  const savedRecord = context.recordBackgroundError;
  const injected = [];
  const recorded = [];
  let failure = null;
  global.chrome.scripting = {
    executeScript: async (options) => {
      injected.push(JSON.parse(JSON.stringify(options)));
      if (failure) throw new Error(failure);
      return [];
    }
  };
  context.recordBackgroundError = (action, cause) => recorded.push(`${action}: ${String(cause?.message || cause)}`);
  const page = { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', tab: { id: 7 }, frameId: 0, documentId: 'DOC-1' };
  // Replies come from the worker's realm; JSON gives them this realm's prototypes for deepEqual.
  const ask = (bundle, sender = page) => new Promise((resolve) => {
    const reply = (value) => resolve(JSON.parse(JSON.stringify(value)));
    if (messageListeners[0]({ type: 'LOAD_BUNDLE', bundle }, sender, reply) !== true) resolve('no answer');
  });
  try {
    assert.deepEqual(await ask('settings'), { ok: true });
    assert.deepEqual(injected.pop(), { target: { tabId: 7, documentIds: ['DOC-1'] }, files: ['content/ui-settings.js'] },
      'the document that asked gets exactly the bundle files');
    await ask('wabbajack', { ...page, documentId: undefined, frameId: 3 });
    assert.deepEqual(injected.pop().target, { tabId: 7, frameIds: [3] }, 'without a document id, the frame that asked');

    for (const gone of ['Frame with ID 0 was removed.', 'No frame with id 3 in tab 7.', 'No document with id DOC-1 in tab 7.',
      'No tab with id: 7.', 'The tab was closed.']) {
      failure = gone;
      const reply = await ask('collection');
      assert.equal(reply.ok, false, `${gone} is answered`);
      assert.equal(reply.error, gone);
    }
    assert.deepEqual(recorded, [], 'a page that went away before its bundle arrived is not a fault');
    failure = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.';
    assert.equal((await ask('collection')).ok, false);
    assert.equal(recorded.length, 1, 'any other refusal is recorded');
    failure = null;

    const before = injected.length;
    for (const [bundle, sender, error] of [
      ['constructor', page, 'unknown-bundle'],
      ['../manifest.json', page, 'unknown-bundle'],
      ['settings', { ...page, tab: undefined }, 'bundle-needs-a-nexus-page'],
      ['settings', { ...page, url: 'chrome-extension://test-extension-id/popup/popup.html' }, 'bundle-needs-a-nexus-page']
    ]) {
      assert.deepEqual(await ask(bundle, sender), { ok: false, error }, `${bundle} for ${sender.url}`);
    }
    assert.equal(await ask('settings', { ...page, id: 'another-extension' }), 'no answer', 'another extension is not answered');
    assert.equal(injected.length, before, 'none of those reached a page');
  } finally {
    global.chrome.scripting = savedScripting;
    context.recordBackgroundError = savedRecord;
  }
}

// A restarted worker has lost its download-to-job map. A terminal event for a job's active download is
// still matched through storage; one for a download this extension never started changes nothing and
// is not kept for later.
async function terminalEventsSurviveAWorkerRestart() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-restart-terminal';
  const downloadId = 1201;
  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId: 71 });
    vm.runInContext('ndcDownloadJobs.clear(); pendingTerminalDownloads.clear();', context);
    global.chrome.downloads = {
      search: ({ id }, callback) => callback(id === downloadId ? [{
        id, state: 'complete', paused: false, canResume: false, bytesReceived: 166912, totalBytes: 166912,
        fileSize: 166912, mime: 'application/x-7z-compressed', filename: '/home/u/dl/Terminal 71.7z'
      }] : []),
      removeFile: (_id, callback) => callback(),
      download: () => assert.fail('a finished one-file run starts nothing'),
      cancel: finishCallback
    };
    const before = JSON.stringify(await readNdcJob(jobId));
    assert.equal(await handleNdcDownloadTerminal(999999, 'complete', null), null);
    assert.equal(await handleNdcDownloadTerminal(999999, 'interrupted', 'USER_CANCELED'), null);
    assert.equal(JSON.stringify(await readNdcJob(jobId)), before, 'a download the queue never started changes nothing');
    assert.equal(vm.runInContext('pendingTerminalDownloads.size', context), 0, 'and is not remembered as an early terminal');

    await handleNdcDownloadTerminal(downloadId, 'complete', null);
    const job = await readNdcJob(jobId);
    assert.deepEqual({ completed: job.completed, index: job.index, active: job.activeDownloadId ?? null },
      { completed: 1, index: 1, active: null }, 'the active download is found through storage');
  } finally {
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(STORAGE_HISTORY_KEY, {});
    await storageSetLocal(NXTK.TOTAL_DOWNLOADS_KEY, 0);
  }
}

// Two tabs pressing Resume at once: one transition, one download.
async function concurrentResumesStartOneDownload() {
  const previousDownloads = global.chrome.downloads;
  const previousFetch = context.fetch;
  const jobId = 'testjob-double-resume';
  const items = [91, 92].map((fileId) => ({
    fileId, historyId: String(fileId), gameId: '1704', name: `Resume ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`, sizeKb: 10
  }));
  let started = 0;
  try {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, items);
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: 'resume-game', collectionId: 'resume-twice', type: 'all',
        itemCount: 2, index: 0, completed: 0, failed: [], status: 'paused', activeDownloadId: null,
        createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    context.fetch = async (url) => ({
      ok: true, status: 200, url: String(url),
      text: async () => (String(url).includes('GenerateDownloadUrl')
        ? '{"url":"https://premium-files.nexus-cdn.com/1/91/resume.7z?key=k&expires=1&user_id=2"}'
        : '<a href="/auth/sign_out">Log out</a>'),
      headers: { get: () => '' }
    });
    global.chrome.downloads = {
      download: (_options, callback) => { started += 1; callback(1300 + started); },
      search: ({ id }, callback) => callback([{ id, state: 'in_progress', paused: false, bytesReceived: 1, totalBytes: 10240 }]),
      cancel: finishCallback
    };
    const replies = await Promise.all([
      NDC_QUEUE_HANDLERS.NDC_QUEUE_RESUME({ jobId }, { tab: { id: 7 } }),
      NDC_QUEUE_HANDLERS.NDC_QUEUE_RESUME({ jobId }, { tab: { id: 8 } })
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const job = await readNdcJob(jobId);
    assert.ok(replies.every((reply) => reply.resumed === true), 'both presses see a running job');
    assert.equal(started, 1, 'one download for two presses');
    assert.deepEqual({ status: job.status, active: job.activeDownloadId }, { status: 'running', active: 1301 });
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

// Pause, Resume and Stop pressed together, in any order the storage queue applies them: Stop is final,
// the download in flight is cancelled, and nothing new starts.
async function controlStormEndsStopped() {
  const previousDownloads = global.chrome.downloads;
  const previousFetch = context.fetch;
  const jobId = 'testjob-control-storm';
  const downloadId = 1401;
  const cancelled = [];
  let started = 0;
  try {
    await storageSetLocal(`nxtk_ndc_items:${jobId}`, [91, 92, 93].map((fileId) => ({
      fileId, historyId: String(fileId), gameId: '1704', name: `Storm ${fileId}.7z`,
      pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`, sizeKb: 10
    })));
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: {
        id: jobId, tabId: 7, gameId: 'storm-game', collectionId: 'storm', type: 'all',
        itemCount: 3, index: 0, completed: 0, failed: [], status: 'running', activeDownloadId: downloadId,
        createdAt: Date.now(), updatedAt: Date.now()
      }
    });
    context.fetch = async () => assert.fail('a stopped run asks Nexus for nothing');
    global.chrome.downloads = {
      download: () => { started += 1; },
      search: ({ id }, callback) => callback([{ id, state: 'in_progress', paused: false, bytesReceived: 1, totalBytes: 10240 }]),
      cancel: (id, callback) => { cancelled.push(id); callback?.(); },
      removeFile: (_id, callback) => callback?.()
    };
    const tab = { tab: { id: 7 } };
    await Promise.all([
      NDC_QUEUE_HANDLERS.NDC_QUEUE_PAUSE({ jobId }, tab),
      NDC_QUEUE_HANDLERS.NDC_QUEUE_RESUME({ jobId }, tab),
      NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP({ jobId }, tab),
      NDC_QUEUE_HANDLERS.NDC_QUEUE_RESUME({ jobId }, tab).catch((cause) => cause.message),
      NDC_QUEUE_HANDLERS.NDC_QUEUE_PAUSE({ jobId }, tab).catch((cause) => cause.message)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const job = await readNdcJob(jobId);
    assert.equal(job?.status, 'stopped', 'Stop is final');
    assert.equal(job?.activeDownloadId ?? null, null, 'no download is left attached');
    assert.ok(cancelled.includes(downloadId), 'the download in flight is cancelled');
    assert.equal(started, 0, 'and nothing new starts');
  } finally {
    context.fetch = previousFetch;
    global.chrome.downloads = previousDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

// A failed read must stop a write, never replace the stored value with the empty fallback.
async function failedReadNeverOverwrites() {
  const N = context.NXTK;
  await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, HideDownloadPopup: true });
  const realGet = global.chrome.storage.local.get;
  global.chrome.storage.local.get = (keys, cb) => {
    global.chrome.runtime.lastError = { message: 'read failed' };
    cb && cb({});
    global.chrome.runtime.lastError = null;
  };
  try {
    await assert.rejects(context.__STORAGE_HANDLERS.SETTINGS_PATCH({ patch: { HideDownloadPopup: false } }), /read failed/);
  } finally {
    global.chrome.storage.local.get = realGet;
  }
  assert.equal((await storageGetLocal(N.SETTINGS_KEY, null)).HideDownloadPopup, true, 'the saved setting survives');
}

// Single mods and collections name a file the same way: the name in the link when it has a known extension.
function downloadNameFromLink() {
  const name = context.NXTK.downloadNameFromUrl;
  assert.equal(name('https://supporter-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z?token=x'), 'SkyUI_5_2_SE-12604-5-2SE.7z');
  assert.equal(name('https://cf-files.nexus-cdn.com/1704/x/Some%20Mod.zip'), 'Some Mod.zip');
  assert.equal(name('https://cf-files.nexus-cdn.com/1704/x/download'), '', 'no known extension means no name from the link');
  assert.equal(name('not a url'), '');
  const item = context.sanitizeNdcJobItem({ fileId: 12604, gameId: '1704', name: 'Main file.7z', modName: 'SkyUI', pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604' });
  assert.equal(item.modName, 'SkyUI', 'a collection item keeps its mod name for the fallback file name');
  assert.equal(item.domain, 'skyrimspecialedition', 'the game comes from the mod page address');
}

// The .meta is opt-in and sits beside the finished file, under the name that file has on disk.
async function mo2MetaBesideCollectionFile() {
  const N = context.NXTK;
  const text = context.mo2MetaText({ domain: 'skyrimspecialedition', modId: '12604', fileId: '5', modName: 'SkyUI', version: '5.2' });
  assert.match(text, /^\[General\]\ngameName=SkyrimSE\nmodid=12604\nfileid=5\nname=SkyUI\nmodName=SkyUI\nversion=5\.2\n/);
  assert.match(context.mo2MetaText({ domain: 'newvegas', modId: '1', fileId: '2', modName: 'M', version: '1' }), /^gameName=FalloutNV$/m,
    'a game goes by Mod Organizer 2\'s own name for it');
  const injected = context.mo2MetaText({ domain: 'skyrimspecialedition', modId: '12604', fileId: '5', modName: 'SkyUI\ninstalled=true', version: '5.2\r\n' });
  assert.doesNotMatch(injected, /^installed=true$/m, 'a line break in a name never adds a key of its own');
  assert.match(injected, /^name=SkyUI installed=true\nmodName=SkyUI installed=true\nversion=5\.2\n/m);
  const item = { modId: '12604', fileId: '5', domain: 'skyrimspecialedition', modName: 'SkyUI', version: '5.2' };
  const saved = global.chrome.downloads;
  const started = [];
  global.chrome.downloads = { download: (options, cb) => { started.push(options); cb(started.length); } };
  try {
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: false });
    await context.writeMo2Meta(item, 'Collection/SkyUI.7z', '/Users/me/Downloads/Collection/SkyUI (1).7z');
    assert.equal(started.length, 0, 'nothing is written unless the setting is on');
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: true });
    await context.writeMo2Meta(item, 'Collection/SkyUI.7z', '/Users/me/Downloads/Collection/SkyUI (1).7z');
    assert.equal(started[0].filename, 'Collection/SkyUI (1).7z.meta', 'the meta follows the name on disk');
    assert.equal(started[0].conflictAction, 'overwrite');
    assert.match(decodeURIComponent(started[0].url), /modid=12604/);
  } finally {
    global.chrome.downloads = saved;
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS });
  }
}

// E-1u4nb29: a mod saved from its page in the browser and installed with Mod Organizer 2 had no
// description, and MO2's Nexus link did not open its page. With WriteMo2Meta on, a single download gets
// the .meta a collection file gets, once it has finished.
async function singleDownloadGetsMo2Meta() {
  const N = context.NXTK;
  const H = context.__DOWNLOAD_HANDLERS;
  const savedDownloads = global.chrome.downloads;
  const savedSession = global.chrome.storage.session;
  const session = {};
  global.chrome.storage.session = {
    get: (key, cb) => cb(key in session ? { [key]: structuredClone(session[key]) } : {}),
    set: (items, cb) => { Object.assign(session, structuredClone(items)); if (cb) cb(); },
    remove: (key, cb) => { delete session[key]; if (cb) cb(); }
  };
  const started = [];
  const onDisk = new Map();
  global.chrome.downloads = {
    ...(savedDownloads || {}),
    download: (options, cb) => { started.push(options); cb(900 + started.length); },
    search: (query, cb) => cb(onDisk.has(query?.id) ? [{ id: query.id, state: 'complete', filename: onDisk.get(query.id) }] : [])
  };
  const page = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35407';
  const start = (fileId, sender = { url: page, tab: { id: 3 } }) => {
    context.__recentDownloadStarts.clear();
    return H.DOWNLOAD_START({ url: `https://cf-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z?md5=a&n=${fileId}`,
      folder: 'Mods', filename: 'SkyUI_5_2_SE-12604-5-2SE.7z', fileId, gameId: '1704', modName: 'SkyUI', version: '5.2SE' }, sender);
  };
  const metas = () => started.filter((options) => options.filename.endsWith('.meta'));
  try {
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: false });
    const off = await start('35407');
    assert.deepEqual(Object.keys(session), [], 'off: nothing is kept for later either');
    onDisk.set(off.downloadId, 'C:\\Users\\me\\Downloads\\Mods\\SkyUI_5_2_SE-12604-5-2SE.7z');
    await context.writeSingleMo2Meta(off.downloadId);
    assert.equal(metas().length, 0, 'off: the file and nothing else');

    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: true });
    const on = await start('35408');
    assert.equal(metas().length, 0, 'nothing is written while the file is still downloading');
    onDisk.set(on.downloadId, 'C:\\Users\\me\\Downloads\\Mods\\SkyUI_5_2_SE-12604-5-2SE (1).7z');
    await context.writeSingleMo2Meta(on.downloadId);
    assert.equal(metas().length, 1);
    assert.equal(metas()[0].filename, 'Mods/SkyUI_5_2_SE-12604-5-2SE (1).7z.meta', 'beside the file, under the name it has on disk');
    const text = decodeURIComponent(metas()[0].url.slice(metas()[0].url.indexOf(',') + 1));
    assert.match(text, /^\[General\]\ngameName=SkyrimSE\nmodid=12604\nfileid=35408\nname=SkyUI\nmodName=SkyUI\nversion=5\.2SE\n/);
    await context.writeSingleMo2Meta(on.downloadId);
    assert.equal(metas().length, 1, 'once per download');

    // Game and mod come from the page that asked: another site, or a Nexus page that is not a mod's, gets none.
    for (const url of ['https://example.com/skyrimspecialedition/mods/12604', 'https://www.nexusmods.com/skyrimspecialedition/collections/abc']) {
      const other = await start('35409', { url, tab: { id: 3 } });
      onDisk.set(other.downloadId, 'C:\\Users\\me\\Downloads\\Mods\\other.7z');
      await context.writeSingleMo2Meta(other.downloadId);
    }
    assert.equal(metas().length, 1, 'no .meta for a request from anywhere else');
    // A download that fails leaves nothing waiting.
    const failed = await start('35410');
    assert.equal(Object.keys(session).length, 1);
    await context.forgetSingleMo2Meta(failed.downloadId);
    assert.deepEqual(Object.keys(session), [], 'nothing is left waiting');
  } finally {
    global.chrome.downloads = savedDownloads;
    global.chrome.storage.session = savedSession;
    context.__recentDownloadStarts.clear();
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS });
  }
}

// Issue #34 (Opera): with no folder set, files went to C:\Users\…\Downloads while the browser's own
// downloads went to D:\mods. A file the extension names is always put in the browser's download
// location, so a file whose link carries its name is now left to the browser to place; and "D:\mods"
// typed as the folder no longer becomes a folder "D mods" there.
async function browserPlacesUnnamedDownloads() {
  const N = context.NXTK;
  const H = context.__DOWNLOAD_HANDLERS;
  const savedDownloads = global.chrome.downloads;
  const started = [];
  global.chrome.downloads = {
    ...(savedDownloads || {}),
    download: (options, cb) => { started.push(options); cb(34000 + started.length); },
    search: (_query, cb) => cb([])
  };
  const cdn = 'https://cf-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z?md5=a&expires=1';
  const single = (folder, extra = {}) => {
    context.__recentDownloadStarts.clear();
    return H.DOWNLOAD_START({ url: cdn, folder, filename: 'SkyUI_5_2_SE-12604-5-2SE.7z', fileId: '35407', gameId: '1704', ...extra },
      { url: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', tab: { id: 3 } });
  };
  try {
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: false });
    const placed = await single('');
    assert.deepEqual({ ...started.at(-1) }, { url: cdn, conflictAction: 'uniquify', saveAs: false },
      'no folder: no name either, so the browser saves it where it saves its own downloads');
    assert.equal(placed.filename, 'SkyUI_5_2_SE-12604-5-2SE.7z');
    await single('NexusMods');
    assert.equal(started.at(-1).filename, 'NexusMods/SkyUI_5_2_SE-12604-5-2SE.7z', 'a folder is still one inside the download location');
    for (const typed of ['D:\\mods', 'd:/mods', 'C:', '\\\\server\\share\\mods', '/home/me/mods', '~/mods', '%USERPROFILE%\\mods']) {
      await single(typed);
      assert.equal(started.at(-1).filename, undefined, `${typed} is not a folder in the download location: the browser places the file`);
    }
    const unnamed = 'https://cf-files.nexus-cdn.com/1704/12604/download?md5=a';
    await single('', { url: unnamed, filename: 'SkyUI-35407' });
    assert.equal(started.at(-1).filename, 'SkyUI-35407.zip', 'a link without a usable name still gets one');
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: true });
    await single('');
    assert.equal(started.at(-1).filename, 'SkyUI_5_2_SE-12604-5-2SE.7z', 'a Mod Organizer 2 .meta needs the file where it can be written beside it');
    await context.forgetSingleMo2Meta(started.length + 34000);

    // Collections follow the same rule.
    const item = { fileId: '35407', name: 'Main', modName: 'SkyUI' };
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: false });
    const fromCollection = await context.startNdcDownload({ id: 'job-34', folder: '' }, item, cdn);
    assert.equal(started.at(-1).filename, undefined);
    assert.equal(started.at(-1).saveAs, false, 'never a save dialog per collection file in Firefox');
    assert.equal(fromCollection.filename, '', 'where the browser put it is learnt from the finished download');
    const inFolder = await context.startNdcDownload({ id: 'job-34', folder: 'Collection' }, item, cdn);
    assert.equal(inFolder.filename, 'Collection/SkyUI_5_2_SE-12604-5-2SE.7z');

    assert.equal(context.buildDownloadPath('D:\\mods', 'A Mod.zip'), 'A Mod.zip', 'a full path is no folder');
    assert.equal(N.isFullFolderPath('~Mods'), false, 'a name that starts with a tilde is a folder name');
    assert.equal(N.isFullFolderPath('NexusMods'), false);
    assert.equal(N.normalizeSetting('DownloadFolder', 'D:\\mods'), undefined, 'a full path is not stored');
    assert.equal(N.normalizeSetting('DownloadFolder', 'Mods'), 'Mods');
    assert.equal(N.normalizeSetting('DownloadFolder', ''), '', 'empty is stored: the browser places each file');
  } finally {
    global.chrome.downloads = savedDownloads;
    context.__recentDownloadStarts.clear();
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS });
  }
}

jobStateBehaviour()
  .then(writeQueueRelease)
  .then(failedReadNeverOverwrites)
  .then(downloadNameFromLink)
  .then(mo2MetaBesideCollectionFile)
  .then(singleDownloadGetsMo2Meta)
  .then(browserPlacesUnnamedDownloads)
  .then(missingQueueItemsBehaviour)
  .then(reconnectScopeBehaviour)
  .then(errorLogCollapsing)
  .then(refusedDownloadBehaviour)
  .then(sameNamedExistingFileIsNeverSwept)
  .then(classifiedRateLimitWaitsInsteadOfFailing)
  .then(skippedModsDoNotStopTheQueue)
  .then(cloudflareStreakStopsTheQueue)
  .then(expectedOutcomesStayOutOfTheLog)
  .then(transferSizeVerdicts)
  .then(staleRecordsAreNotJudged)
  .then(typelessRunsAreStillRecorded)
  .then(badFilesAreNotLeftBehind)
  .then(resumingDownloadsAreNotAbandoned)
  .then(newRegressionCoverage)
  .then(stopCancelsAPendingStart)
  .then(restartWaitsForAnInFlightStart)
  .then(resumeConsumesAMissedTerminal)
  .then(terminalSideEffectsFinishBeforeTheNextDownload)
  .then(abandonedFilesAreRemoved)
  .then(settingsPatchIsNormalized)
  .then(activeQueuesAreListed)
  .then(speedMigrationOnlyRunsForOldCopies)
  .then(workerResolvesTheRequestedFile)
  .then(failureRecordsAreCapped)
  .then(debugLogAndAutoReports)
  .then(downloadStartsAreDeduplicated)
  .then(downloadPopupFollowsBrowserRuns)
  .then(downloadPopupRespectsOtherExtensions)
  .then(vortexSentHistoryIsAccepted)
  .then(largeHistoryFitsTheQuota)
  .then(downloadTargetsAreRefused)
  .then(nexusAnswersAreClassified)
  .then(bundleLoadsAreTargetedAndQuiet)
  .then(terminalEventsSurviveAWorkerRestart)
  .then(concurrentResumesStartOneDownload)
  .then(controlStormEndsStopped)
  .then(queueNoLinkFailureSaysWhy)
  .then(queueWaitsOutLostConnection)
  .then(reusedDownloadIdIsNeverTrusted)
  .then(fullDiskStopsTheRun)
  .then(() => console.log('background.js unit behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
