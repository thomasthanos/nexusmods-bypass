// Download events and files: starts, the download popup, refused and same-named files, interrupts and
// terminals, cleanup, MO2 .meta, unnamed downloads and adopting a download after a worker restart.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  finishCallback, context, buildDownloadPath, NXTK, jobFailureCount, sanitizeNdcJobItem, readNdcJob,
  storageSetLocal, storageGetLocal, advanceNdcJob, processNdcJob, applyNdcDownloadTerminal, NDC_JOBS_KEY,
  NDC_QUEUE_HANDLERS, STORAGE_HISTORY_KEY, handleNdcDownloadTerminal
} from './helpers/background-harness.mjs';

// The wait after a file the queue did not download (NXTK.queueItemGapMs) is checked in
// background-queue-test.mjs; here it would only slow the suite down.
NXTK.queueItemGapMs = () => 0;

// One user action, one file: the worker drops a second start for the same game+file, and a start for a
// file the browser is already downloading (Nexus's own native download included).
async function downloadStartsAreDeduplicated() {
  const H = context.__DOWNLOAD_HANDLERS;
  const saved = global.chrome.downloads;
  const started = [];
  const startedRecords = new Map();
  let browserItems = [];
  global.chrome.downloads = {
    ...(saved || {}),
    download: (options, cb) => {
      started.push(options);
      const id = 100 + started.length;
      startedRecords.set(id, { id, state: 'in_progress', url: options.url });
      setTimeout(() => cb(id), 5);
    },
    search: (query, cb) => cb(Number.isInteger(query.id) ? [startedRecords.get(query.id)].filter(Boolean) : browserItems)
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

    context.__recentDownloadStarts.clear();
    browserItems = [{ ...browserItems[0], startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
    global.chrome.downloads.search = (query, cb) => cb(browserItems.filter((item) => (
      query.state ? item.state === query.state : Date.parse(item.startTime) > Date.parse(query.startedAfter)
    )));
    const longRunning = await H.DOWNLOAD_START(payload);
    assert.equal(longRunning.downloadId, 7, 'a ten-minute transfer is still reused after the worker forgets its starts');
    assert.equal(longRunning.duplicate, true);
    assert.equal(started.length, 2, 'an older active transfer does not start a second copy');

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

async function failedSingleDownloadsCanBeRetried() {
  const H = context.__DOWNLOAD_HANDLERS;
  const savedDownloads = global.chrome.downloads;
  const records = [];
  let starts = 0;
  let lookupError = false;
  const url = 'https://supporter-files.nexus-cdn.com/1704/77/File-77.7z';
  const payload = { url, filename: 'File-77.7z', fileId: '77', gameId: '1704' };
  global.chrome.downloads = {
    download: (_options, callback) => {
      const id = 901 + starts++;
      records.push({ id, url, state: 'in_progress', exists: false, filename: '/Downloads/File-77.7z', startTime: new Date().toISOString() });
      callback(id);
    },
    search: (query, callback) => {
      if (lookupError && Number.isInteger(query.id)) {
        global.chrome.runtime.lastError = { message: 'temporary search failure' };
        callback([]);
        global.chrome.runtime.lastError = null;
        return;
      }
      callback(records.filter((record) => Number.isInteger(query.id) ? record.id === query.id
        : query.state ? record.state === query.state : Date.parse(record.startTime) > Date.parse(query.startedAfter)));
    }
  };
  try {
    context.__recentDownloadStarts.clear();
    const first = await H.DOWNLOAD_START(payload);
    assert.equal((await H.DOWNLOAD_START(payload)).downloadId, first.downloadId,
      'an active transfer remains reusable before its file exists on disk');
    Object.assign(records[0], { state: 'interrupted', error: 'USER_CANCELED' });
    const retried = await Promise.all([H.DOWNLOAD_START(payload), H.DOWNLOAD_START(payload)]);
    assert.equal(starts, 2, 'simultaneous retries after cancellation start exactly one replacement');
    assert.notEqual(retried[0].downloadId, first.downloadId, 'a failed cached download cannot block a retry');
    assert.equal(retried[0].downloadId, retried[1].downloadId);

    Object.assign(records[1], { state: 'complete', exists: false });
    const restored = await H.DOWNLOAD_START(payload);
    assert.equal(starts, 3, 'deleting a completed file permits another download immediately');
    assert.notEqual(restored.downloadId, retried[0].downloadId);
    records.pop(); // The user erased the most recent browser download record.
    const missing = await H.DOWNLOAD_START(payload);
    assert.equal(starts, 4, 'an erased browser record cannot hold the retry back either');
    assert.notEqual(missing.downloadId, restored.downloadId);

    Object.assign(records.at(-1), { state: 'complete', exists: true });
    assert.equal((await H.DOWNLOAD_START(payload)).downloadId, missing.downloadId, 'an existing completed copy is still reused');
    lookupError = true;
    assert.equal((await H.DOWNLOAD_START(payload)).downloadId, missing.downloadId, 'a failed browser lookup does not authorize a duplicate');
    assert.equal(starts, 4);
    lookupError = false;
    records.at(-1).exists = false;
    context.__recentDownloadStarts.clear();
    await H.DOWNLOAD_START(payload);
    assert.equal(starts, 5, 'a worker restart also ignores deleted files returned by the browser search');
  } finally {
    global.chrome.downloads = savedDownloads;
    global.chrome.runtime.lastError = null;
    context.__recentDownloadStarts.clear();
  }
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
  // No collection run is active: a running job keeps the bubble hidden whatever the claims say.
  await context.storageSetLocal(context.__NDC_JOBS_KEY, {});
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

async function browserSecurityBlockIsNeverRetried() {
  const savedDownloads = global.chrome.downloads;
  const jobId = 'testjob-security-block';
  const downloadId = 919;
  let starts = 0;
  let resumes = 0;
  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId: 79 });
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
    global.chrome.downloads = {
      search: (_query, callback) => callback([{ id: downloadId, state: 'interrupted', error: 'FILE_VIRUS_INFECTED',
        paused: false, canResume: false, exists: false }]),
      cancel: (_id, callback) => callback(),
      download: (_request, callback) => { starts += 1; callback(920); },
      resume: (_id, callback) => { resumes += 1; callback(); }
    };
    await handleNdcDownloadTerminal(downloadId, 'interrupted', 'FILE_VIRUS_INFECTED');
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(starts, 0, 'a virus-blocked file is never downloaded again automatically');
    assert.equal(resumes, 0, 'the extension does not resume a security-blocked transfer');
    assert.equal(job.transferAttempts, 0);
    assert.equal(job.completed, 0);
    assert.equal(job.status, 'partial', 'the browser protection is reported as a failed file');
    assert.match(job.failed[0].code, /^FILE_VIRUS_INFECTED \[blocked\]$/);
    const log = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
    assert.equal(log.length, 1);
    assert.equal(log[0].code, 'queue_item_failed', 'a protection decision is not an extension crash');
    assert.equal(log[0].causeCode, 'FILE_VIRUS_INFECTED', 'the browser decision remains available for the safety explanation');
  } finally {
    global.chrome.downloads = savedDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
    await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  }
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

// Firefox's cancel fails for a download it no longer lists: one the user cleared from its list, or an
// id a browser restart numbered afresh. Retiring such a download never finished, and starting the
// collection again was refused with previous_download_not_retired. An unreadable list still refuses.
async function forgottenDownloadNeverBlocksARestart() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-firefox-forgotten';
  const downloadId = 915;
  const fileId = 75;
  const cancels = [];
  let listUnreadable = true;

  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId });
    global.chrome.downloads = {
      search: (_query, cb) => {
        if (listUnreadable) global.chrome.runtime.lastError = { message: 'Download list unavailable' };
        cb(listUnreadable ? undefined : []);
        global.chrome.runtime.lastError = null;
      },
      cancel: (id, cb) => {
        cancels.push(id);
        global.chrome.runtime.lastError = { message: `Invalid download id ${id}` };
        cb();
        global.chrome.runtime.lastError = null;
      }
    };

    await context.haltNdcJob(await readNdcJob(jobId), { notify: false });
    let job = await readNdcJob(jobId);
    assert.equal(job.status, 'stopped');
    assert.equal(job.retiringDownloadId, downloadId, 'while the download list cannot be read, the retirement stays open');
    assert.equal(await context.collectionRetirementBlocker('1704', `col-${fileId}`), 'download list unreadable',
      'and a new start waits for it, saying why');

    listUnreadable = false;
    assert.equal(await context.collectionRetirementBlocker('1704', `col-${fileId}`), '',
      'once the browser answers that it has no such download, nothing is left to retire');
    job = await readNdcJob(jobId);
    assert.equal(job.retiringDownloadId, undefined);
    assert.ok(cancels.every((id) => id === downloadId) && cancels.length >= 2, 'the cancel was still asked for each time');

    // What still blocks a start is named by its state, never its file: here a finished file that
    // could not be removed.
    await storageSetLocal(NDC_JOBS_KEY, { [jobId]: { ...job, retiringDownloadId: downloadId } });
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ id: downloadId, state: 'complete', exists: true, filename: 'C:\\dl\\Terminal 75.7z' }]),
      cancel: (_id, cb) => cb(),
      removeFile: (_id, cb) => {
        global.chrome.runtime.lastError = { message: 'Could not remove file' };
        cb();
        global.chrome.runtime.lastError = null;
      }
    };
    assert.equal(await context.collectionRetirementBlocker('1704', `col-${fileId}`), 'complete, file still there');
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
  }
}

// An erase callback can succeed while the follow-up browser lookup fails. That is not evidence
// that the resumable record is gone, so Stop must keep its retirement barrier until a readable lookup.
async function failedEraseConfirmationKeepsRetirement() {
  const previousDownloads = global.chrome.downloads;
  const jobId = 'testjob-erase-confirm-unreadable';
  const downloadId = 916;
  let eraseCalled = false;
  let readable = false;
  const record = {
    id: downloadId, state: 'interrupted', canResume: true,
    byExtensionId: 'test-extension-id', error: 'NETWORK_FAILED'
  };
  try {
    await seedTerminalRegressionJob({ jobId, downloadId, fileId: 76 });
    global.chrome.downloads = {
      search: (_query, callback) => {
        if (eraseCalled && !readable) global.chrome.runtime.lastError = { message: 'Download list unavailable' };
        callback(eraseCalled && !readable ? undefined : eraseCalled ? [] : [record]);
        global.chrome.runtime.lastError = null;
      },
      cancel: finishCallback,
      erase: (_query, callback) => { eraseCalled = true; callback([downloadId]); }
    };
    await context.haltNdcJob(await readNdcJob(jobId), { notify: false });
    let job = await readNdcJob(jobId);
    assert.equal(eraseCalled, true, 'the resumable attempt is asked to close');
    assert.equal(job.retiringDownloadId, downloadId,
      'an unreadable follow-up lookup cannot confirm that erase removed the old download');
    readable = true;
    assert.equal(await context.collectionRetirementBlocker('1704', 'col-76'), '',
      'a later readable empty result releases the retirement barrier');
    job = await readNdcJob(jobId);
    assert.equal(job.retiringDownloadId, undefined);
  } finally {
    global.chrome.downloads = previousDownloads;
    global.chrome.runtime.lastError = null;
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
    ['a download Firefox no longer lists never blocks a restart', forgottenDownloadNeverBlocksARestart],
    ['complete event requires a complete record', completeEventRequiresCompleteRecord],
    ['stop wins against terminal work', stopWinsAgainstInFlightTerminalWork]
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

    // Another extension can download the same Nexus file. Its explicit ownership wins over a
    // matching path, including for a legacy job that saved no activeDownloadPath.
    for (const [offset, activeDownloadPath] of [ourPath, undefined].entries()) {
      const foreignCompleteId = 10 + offset * 2;
      const foreignRunningId = foreignCompleteId + 1;
      records.set(foreignCompleteId, {
        id: foreignCompleteId, state: 'complete', url: ours, byExtensionId: 'some-other-extension',
        exists: true, fileSize: 4000000, totalBytes: 4000000, bytesReceived: 4000000
      });
      await seed({ activeDownloadId: foreignCompleteId, activeDownloadPath });
      await handleNdcDownloadTerminal(foreignCompleteId, 'complete', null);
      job = await readNdcJob(jobId);
      assert.equal(job.completed, 0, 'another extension\'s same-file download is not counted as ours');
      assert.ok(!canceled.includes(foreignCompleteId) && !removed.includes(foreignCompleteId), 'its terminal event cannot mutate that download');

      records.set(foreignRunningId, { id: foreignRunningId, state: 'in_progress', url: ours, byExtensionId: 'some-other-extension' });
      await seed({ activeDownloadId: foreignRunningId, activeDownloadPath });
      await NDC_QUEUE_HANDLERS.NDC_QUEUE_STOP({ jobId }, { tab: { id: 7 } });
      job = await readNdcJob(jobId);
      assert.ok(!canceled.includes(foreignRunningId) && !removed.includes(foreignRunningId), 'Stop respects another extension\'s explicit ownership');
      assert.equal(job.retiringDownloadId, undefined, 'a foreign record cannot block the queue retirement');
    }

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

// A small file can finish before the worker has saved what its Mod Organizer 2 .meta needs; the
// 'complete' event then found nothing and no .meta was written.
async function fastSingleDownloadStillGetsMo2Meta() {
  const N = context.NXTK;
  const H = context.__DOWNLOAD_HANDLERS;
  const savedDownloads = global.chrome.downloads;
  const savedSession = global.chrome.storage.session;
  const session = {};
  global.chrome.storage.session = {
    get: (key, cb) => cb(key in session ? { [key]: structuredClone(session[key]) } : {}),
    set: (items, cb) => setTimeout(() => { Object.assign(session, structuredClone(items)); if (cb) cb(); }, 30),
    remove: (key, cb) => { delete session[key]; if (cb) cb(); }
  };
  const started = [];
  const completions = [];
  global.chrome.downloads = {
    ...(savedDownloads || {}),
    download: (options, cb) => {
      started.push(options);
      const id = 950 + started.length;
      cb(id);
      // The file is already complete: the browser's event arrives before the .meta details are saved.
      if (!options.filename?.endsWith('.meta')) completions.push(context.writeSingleMo2Meta(id));
    },
    search: (query, cb) => cb([{ id: query.id, state: 'complete', filename: 'C:\\Users\\me\\Downloads\\Mods\\Tiny.7z' }])
  };
  try {
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS, WriteMo2Meta: true });
    context.__recentDownloadStarts.clear();
    await H.DOWNLOAD_START({ url: 'https://cf-files.nexus-cdn.com/1704/12604/Tiny.7z?md5=a', folder: 'Mods', filename: 'Tiny.7z',
      fileId: '35499', gameId: '1704', modName: 'Tiny', version: '1' },
    { url: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files', tab: { id: 3 } });
    await Promise.all(completions);
    const metas = started.filter((options) => options.filename?.endsWith('.meta'));
    assert.equal(metas.length, 1, 'a file that finished at once still gets its .meta');
    assert.equal(metas[0].filename, 'Mods/Tiny.7z.meta');
    assert.deepEqual(Object.keys(session), [], 'and nothing is left waiting');
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
    assert.equal(N.DEFAULTS.DownloadFolder, '', 'a new install leaves every file to the browser, as its own downloads');
    await storageSetLocal(N.SETTINGS_KEY, { ...N.DEFAULTS });
    await single(N.DEFAULTS.DownloadFolder);
    assert.equal(started.at(-1).filename, undefined, 'the default settings name no file');
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

// A file the browser had started when the worker stopped, before the job recorded it: the restart used
// to fetch a fresh link and start the same file again, leaving a "(1)" copy beside an orphan.
async function restartAdoptsADownloadStartedBeforeTheWorkerStopped() {
  const savedDownloads = global.chrome.downloads;
  const savedFetch = context.fetch;
  const jobId = 'testjob-adopt';
  const url = 'https://cf-files.nexus-cdn.com/1704/77/File-77.7z?md5=a&expires=1&user_id=2';
  const items = [{ fileId: 77, historyId: '1704:77', gameId: '1704', name: 'File-77.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/77', sizeKb: 10 }];
  const started = [];
  const fetched = [];
  let onDisk = [];
  const seed = (extra) => Promise.all([
    storageSetLocal(`nxtk_ndc_items:${jobId}`, items),
    storageSetLocal(NDC_JOBS_KEY, { [jobId]: {
      id: jobId, tabId: 7, gameId: '1704', collectionId: 'adopt', type: 'all', folder: '', itemCount: 1, index: 0,
      completed: 0, failed: [], skipped: [], status: 'running', activeDownloadId: null, createdAt: Date.now(),
      updatedAt: Date.now(), ...extra
    } })
  ]);
  global.chrome.downloads = {
    ...(savedDownloads || {}),
    download: (options, cb) => { started.push(options); cb(700 + started.length); },
    search: (query, cb) => cb(onDisk.filter((item) => query?.id === undefined || item.id === query.id))
  };
  context.fetch = async (target) => {
    fetched.push(String(target));
    const generator = String(target).includes('GenerateDownloadUrl');
    return { ok: true, status: 200, url: String(target), headers: { get: () => '' },
      text: async () => (generator ? JSON.stringify({ url }) : '<a href="/auth/sign_out">Log out</a>') };
  };
  try {
    // A normal start leaves no marker once the job has recorded its download.
    await seed();
    await advanceNdcJob(jobId);
    let job = await readNdcJob(jobId);
    assert.equal(job.activeDownloadId, 701);
    assert.equal(job.startingPath, undefined, 'the start marker is gone once the download is recorded');
    assert.equal(job.startingHost, undefined);
    assert.equal(job.startingAt, undefined);

    // The worker stopped between the browser starting the file and the job recording it.
    const marker = { startingHost: 'cf-files.nexus-cdn.com', startingPath: '/1704/77/file-77.7z', startingAt: Date.now() - 2000, startingIndex: 0 };
    const ours = { id: 655, url, finalUrl: url, state: 'in_progress', startTime: new Date().toISOString(),
      filename: 'C:\\Downloads\\File-77.7z', byExtensionId: 'test-extension-id' };
    started.length = 0;
    fetched.length = 0;
    onDisk = [ours];
    await seed(marker);
    await advanceNdcJob(jobId);
    job = await readNdcJob(jobId);
    assert.equal(started.length, 0, 'the file is not started a second time');
    assert.deepEqual(fetched, [], 'nor is a new link asked for');
    assert.equal(job.activeDownloadId, 655, 'the job takes over the download the browser already has');
    assert.equal(job.startingPath, undefined);
    assert.equal(job.startingHost, undefined);

    // Only a download this extension started, from the same host, is taken over. The same file
    // downloaded by hand from its Nexus page (no extension named), by another extension, or from
    // another host is left alone and the job starts its own copy.
    for (const [label, record] of [
      ['a download no extension started', { ...ours, id: 656, byExtensionId: undefined }],
      ['another extension\'s download', { ...ours, id: 657, byExtensionId: 'someone-else' }],
      ['the same path on another host', { ...ours, id: 658,
        url: 'https://premium-files.nexus-cdn.com/1704/77/File-77.7z?md5=a', finalUrl: 'https://premium-files.nexus-cdn.com/1704/77/File-77.7z?md5=a' }]
    ]) {
      started.length = 0;
      onDisk = [record];
      await seed(marker);
      await advanceNdcJob(jobId);
      job = await readNdcJob(jobId);
      assert.notEqual(job.activeDownloadId, record.id, `${label} is not taken over`);
      assert.equal(started.length, 1, `${label}: the job starts its own download`);
      assert.equal(job.startingHost, undefined, `${label}: the marker is dropped`);
    }

    // Nothing in the browser matches: the marker is dropped and the file is started as usual.
    started.length = 0;
    onDisk = [];
    await seed(marker);
    await advanceNdcJob(jobId);
    job = await readNdcJob(jobId);
    assert.equal(started.length, 1, 'with no such download, the file starts');
    assert.equal(job.startingPath, undefined);
  } finally {
    global.chrome.downloads = savedDownloads;
    context.fetch = savedFetch;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

Promise.resolve()
  .then(browserSecurityBlockIsNeverRetried)
  .then(failedSingleDownloadsCanBeRetried)
  .then(mo2MetaBesideCollectionFile)
  .then(singleDownloadGetsMo2Meta)
  .then(browserPlacesUnnamedDownloads)
  .then(refusedDownloadBehaviour)
  .then(sameNamedExistingFileIsNeverSwept)
  .then(typelessRunsAreStillRecorded)
  .then(badFilesAreNotLeftBehind)
  .then(resumingDownloadsAreNotAbandoned)
  .then(newRegressionCoverage)
  .then(failedEraseConfirmationKeepsRetirement)
  .then(terminalSideEffectsFinishBeforeTheNextDownload)
  .then(abandonedFilesAreRemoved)
  .then(downloadStartsAreDeduplicated)
  .then(downloadPopupFollowsBrowserRuns)
  .then(downloadPopupRespectsOtherExtensions)
  .then(terminalEventsSurviveAWorkerRestart)
  .then(reusedDownloadIdIsNeverTrusted)
  .then(restartAdoptsADownloadStartedBeforeTheWorkerStopped)
  .then(fastSingleDownloadStillGetsMo2Meta)
  .then(() => console.log('background.js download behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
