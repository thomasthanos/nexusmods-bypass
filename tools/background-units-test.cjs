const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const noop = () => {};
const finishCallback = (_id, callback) => { if (callback) callback(); };
const listener = () => ({ addListener: noop });
const messageListeners = [];

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: listener()
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

const context = vm.createContext({ chrome: global.chrome, console, URL, Date, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, JSON, setTimeout, clearTimeout, isNaN, parseInt, AbortController, structuredClone, fetch: noop });
context.importScripts = (...paths) => {
  for (const path of paths) {
    vm.runInContext(fs.readFileSync(`src/${path}`, 'utf8'), context, { filename: `src/${path}` });
  }
};
const source = `${fs.readFileSync('src/background.js', 'utf8')}\n;globalThis.__NXTK = NXTK;globalThis.__NDC_JOBS_KEY = NDC_JOBS_KEY;globalThis.__writeQueues = writeQueues;globalThis.__NDC_QUEUE_HANDLERS = NDC_QUEUE_HANDLERS;globalThis.__STORAGE_HISTORY_KEY = STORAGE_HISTORY_KEY;globalThis.__MAX_NDC_JOB_ITEMS = MAX_NDC_JOB_ITEMS;globalThis.__DOWNLOAD_CONFLICT_ACTION = DOWNLOAD_CONFLICT_ACTION;globalThis.__MAX_TRACKED_FAILURES = MAX_TRACKED_FAILURES;globalThis.__recordJobFailure = recordJobFailure;globalThis.__jobFailureCount = jobFailureCount;globalThis.__verifyTransferSize = verifyTransferSize;globalThis.__settledInterruptedState = settledInterruptedState;globalThis.__discardAbandonedDownload = discardAbandonedDownload;globalThis.__handleNdcDownloadTerminal = handleNdcDownloadTerminal;globalThis.__recordQueueItemFailure = recordQueueItemFailure;`;
vm.runInContext(source, context, { filename: 'src/background.js' });

const { retryAfterMilliseconds, buildDownloadPath, downloadFolderOf, __NXTK: NXTK } = context;
const { __DOWNLOAD_CONFLICT_ACTION: DOWNLOAD_CONFLICT_ACTION, __MAX_TRACKED_FAILURES: MAX_TRACKED_FAILURES,
  __recordJobFailure: recordJobFailure, __jobFailureCount: jobFailureCount } = context;
const { classifyNexusResponse, responseLooksChallenged, responseLooksSuspended } = context;
const { isValidFileId, isValidHistoryId, ndcScopeKey, sanitizeNdcJobItem } = context;
const { mutateNdcJob, readNdcJob, saveNdcJob, storageSetLocal, storageGetLocal, enqueueStorageTask,
  advanceNdcJob, processNdcJob, appendErrorLogEntry, applyNdcDownloadTerminal, __verifyTransferSize: verifyTransferSize, __NDC_JOBS_KEY: NDC_JOBS_KEY, __writeQueues: writeQueues,
  __NDC_QUEUE_HANDLERS: NDC_QUEUE_HANDLERS, __STORAGE_HISTORY_KEY: STORAGE_HISTORY_KEY, __MAX_NDC_JOB_ITEMS: MAX_NDC_JOB_ITEMS } = context;
const { __handleNdcDownloadTerminal: handleNdcDownloadTerminal,
  __recordQueueItemFailure: recordQueueItemFailure } = context;

assert.equal(retryAfterMilliseconds('', 1), 30000, 'first strike backs off 30s');
assert.equal(retryAfterMilliseconds('', 2), 60000, 'second strike doubles');
assert.equal(retryAfterMilliseconds('', 3), 120000, 'third strike doubles again');
assert.equal(retryAfterMilliseconds(undefined, 4), 240000, 'a missing header escalates like an empty one');
assert.equal(retryAfterMilliseconds('   ', 3), 120000, 'a whitespace header counts as absent');
assert.equal(retryAfterMilliseconds('', 20), 600000, 'the ladder is capped at 10 minutes');
assert.equal(retryAfterMilliseconds('120', 1), 120000, 'an explicit Retry-After still wins');
assert.equal(retryAfterMilliseconds('0', 1), 30000, 'an explicit 0 still respects the alarm floor');

// Never 'overwrite': a collision must not destroy a file the user already had.
assert.equal(DOWNLOAD_CONFLICT_ACTION, 'uniquify', 'a download never overwrites what is there');
assert.equal((source.match(/conflictAction: DOWNLOAD_CONFLICT_ACTION,/g) || []).length, 2,
  'and both download call sites use the one value');

assert.equal(buildDownloadPath('NexusMods', 'A Mod.zip'), 'NexusMods/A Mod.zip');
assert.equal(buildDownloadPath('   ', 'A Mod.zip'), 'A Mod.zip', 'a blank folder saves to Downloads');
assert.equal(buildDownloadPath('../../etc', 'A Mod.zip'), 'etc/A Mod.zip', 'traversal is stripped');
const cappedPath = buildDownloadPath('n'.repeat(400), 'A Mod.zip');
assert.equal(cappedPath, `${'n'.repeat(100)}/A Mod.zip`,
  'an overlong folder is capped instead of failing the whole download');
assert.ok(!cappedPath.startsWith(' ') && !cappedPath.includes('  '), 'the capped folder stays clean');

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

assert.equal(responseLooksChallenged({}, '<title>Just a moment...</title>'), true);
assert.equal(responseLooksChallenged({}, '<div id="cf-browser-verification">'), true);
assert.equal(responseLooksChallenged({}, '<script src="/cdn-cgi/challenge-platform/x.js">'), true);
assert.equal(responseLooksChallenged({ cfMitigated: 'challenge' }, ''), true,
  'the Cf-Mitigated header alone is enough');
assert.equal(responseLooksChallenged({}, '<html><body>Skyrim Special Edition</body></html>'), false,
  'an ordinary mod page is not a challenge');
assert.equal(responseLooksChallenged({}, ''), false);

assert.equal(responseLooksSuspended('Your account has been temporarily suspended'), true);
assert.equal(responseLooksSuspended('too many requests from your account'), false,
  'a rate limit is not mislabeled as an account suspension');
assert.equal(classifyNexusResponse({}, 'too many requests from your account')?.code, 'rate_limited');
assert.equal(responseLooksSuspended('<html>a normal page</html>'), false);

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
      { id: 'test-extension-id', tab: { id: 7 } },
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

jobStateBehaviour()
  .then(writeQueueRelease)
  .then(missingQueueItemsBehaviour)
  .then(reconnectScopeBehaviour)
  .then(errorLogCollapsing)
  .then(refusedDownloadBehaviour)
  .then(sameNamedExistingFileIsNeverSwept)
  .then(classifiedRateLimitWaitsInsteadOfFailing)
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
  .then(failureRecordsAreCapped)
  .then(() => console.log('background.js unit behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
