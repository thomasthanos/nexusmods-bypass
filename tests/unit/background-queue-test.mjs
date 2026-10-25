// Collection jobs: job state and its write queue, start, stop and resume, outages, rate limits, Cloudflare
// streaks, full disks, history and restarts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  noop, finishCallback, messageListeners, context, NXTK, jobFailureCount, ndcScopeKey, sanitizeNdcJobItem,
  mutateNdcJob, readNdcJob, saveNdcJob, storageSetLocal, storageGetLocal, enqueueStorageTask, advanceNdcJob,
  processNdcJob, NDC_JOBS_KEY, writeQueues, NDC_QUEUE_HANDLERS, STORAGE_HISTORY_KEY,
  handleNdcDownloadTerminal
} from './helpers/background-harness.mjs';

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

// A Nexus outage (502/503/504) failed each queued file after three quick tries, so a few minutes of
// downtime marched the run through the whole collection. It is now waited out like a lost connection.
async function queueWaitsOutAServerOutage() {
  const previousFetch = context.fetch;
  const previousDelay = NXTK.retryDelayMs;
  const savedAlarms = global.chrome.alarms;
  const savedSendMessage = global.chrome.tabs.sendMessage;
  const jobId = 'testjob-outage';
  const items = [88, 89].map((fileId) => ({ fileId, historyId: String(fileId), gameId: '1704', name: `File ${fileId}.7z`,
    pageUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}`, sizeKb: 10 }));
  const events = [];
  try {
    NXTK.retryDelayMs = () => 0;
    global.chrome.alarms = { create: noop, clear: noop };
    global.chrome.tabs.sendMessage = (_tabId, message, callback) => { events.push(JSON.parse(JSON.stringify(message))); if (callback) callback(); };
    context.fetch = async (url) => ({ ok: false, status: 503, url: String(url), text: async () => 'Service Unavailable', headers: { get: () => '' } });
    await Promise.all([
      storageSetLocal(`nxtk_ndc_items:${jobId}`, items),
      storageSetLocal(NDC_JOBS_KEY, { [jobId]: {
        id: jobId, tabId: 7, gameId: '1704', collectionId: 'outage', type: 'all', itemCount: 2, index: 0, completed: 0,
        failed: [], skipped: [], status: 'running', activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now()
      } })
    ]);
    await advanceNdcJob(jobId);
    const job = await readNdcJob(jobId);
    assert.equal(job.status, 'running', 'an outage does not end the run');
    assert.equal(job.index, 0, 'nor move it past the file');
    assert.deepEqual([...job.failed], [], 'and the file is not counted as failed');
    assert.equal(job.networkStrikes, 1);
    assert.ok(job.waitingUntil > Date.now(), 'the run waits on an alarm');
    assert.equal(events.filter((event) => event.type === 'NXT_NDC_WAITING').at(-1)?.reason, 'network');

    // When the waits run out, the run stops with the outage as its reason.
    await saveNdcJob({ ...job, networkStrikes: NXTK.NETWORK_WAIT_MAX_STRIKES, waitingUntil: 0 });
    await advanceNdcJob(jobId);
    const stopped = await readNdcJob(jobId);
    assert.equal(stopped.status, 'error');
    assert.equal(stopped.lastError, 'server_error');
    assert.equal(events.filter((event) => event.type === 'NXT_NDC_DONE').at(-1)?.error, 'server_error');
  } finally {
    context.fetch = previousFetch;
    NXTK.retryDelayMs = previousDelay;
    global.chrome.alarms = savedAlarms;
    global.chrome.tabs.sendMessage = savedSendMessage;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
  assert.equal(context.connectionFailureCode({ status: 0, error: 'timed out' }), 'timeout', 'a request the timer cut off is a timeout');
  assert.equal(context.connectionFailureCode({ status: 0, error: 'Failed to fetch' }), 'network_error');
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

// One job whose reconcile throws used to end the loop before the 5-minute alarm was set again, so
// every other stuck job lost its recovery, and the failure was discarded unseen.
async function reconcileSurvivesAFailingJob() {
  const savedReconcile = context.reconcileNdcJob;
  const savedRecord = context.recordBackgroundError;
  const savedAlarms = global.chrome.alarms;
  const savedDownloads = global.chrome.downloads;
  const reconciled = [];
  const recorded = [];
  const alarms = [];
  try {
    global.chrome.downloads = { ...(savedDownloads || {}), download: noop, search: (_q, cb) => cb([]) };
    global.chrome.alarms = { create: (name, info) => alarms.push([name, info]), clear: noop };
    context.recordBackgroundError = (where, cause) => recorded.push([where, String(cause?.message || cause)]);
    context.reconcileNdcJob = async (id) => {
      reconciled.push(id);
      if (id === 'testjob-broken') throw new Error('storage read failed');
    };
    const base = { gameId: 'g', type: 'all', itemCount: 1, index: 0, completed: 0, failed: [], status: 'running',
      activeDownloadId: null, createdAt: Date.now(), updatedAt: Date.now() };
    await storageSetLocal(NDC_JOBS_KEY, {
      'testjob-broken': { ...base, id: 'testjob-broken', collectionId: 'c1' },
      'testjob-fine': { ...base, id: 'testjob-fine', collectionId: 'c2' }
    });
    await context.reconcileNdcJobs();
    assert.deepEqual(reconciled.sort(), ['testjob-broken', 'testjob-fine'], 'every running job is reconciled');
    assert.ok(alarms.some(([name]) => name === 'nxtk-reconcile'), 'the reconcile alarm is armed again');
    assert.ok(recorded.some(([, message]) => /storage read failed/.test(message)), 'and the failure is recorded');
  } finally {
    context.reconcileNdcJob = savedReconcile;
    context.recordBackgroundError = savedRecord;
    global.chrome.alarms = savedAlarms;
    global.chrome.downloads = savedDownloads;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }
}

// Importing files into the download history while that collection's queue is running: the page used
// to read the history, merge, then replace the lists, so an id the queue added in between was lost
// and that file downloaded again next run. The worker now merges inside its own write queue.
async function historyImportMergesWithRunningQueue() {
  const S = context.__STORAGE_HANDLERS;
  const branch = { gameId: 'g-merge', collectionId: 'c-merge' };
  await storageSetLocal(STORAGE_HISTORY_KEY, { 'g-merge': { 'c-merge': { all: ['1704:1'], mandatory: [], optional: [] } } });
  await Promise.all([
    S.NDC_HISTORY_ADD({ ...branch, type: 'all', fileId: '1704:2' }),
    S.NDC_HISTORY_MERGE({ ...branch, lists: { all: ['1704:3', 'bad id'], mandatory: ['1704:3'] } })
  ]);
  const stored = (await storageGetLocal(STORAGE_HISTORY_KEY, {}))['g-merge']['c-merge'];
  assert.deepEqual([...stored.all].sort(), ['1704:1', '1704:2', '1704:3'], 'the queue\'s entry and the imported one both survive');
  assert.deepEqual([...stored.mandatory], ['1704:3']);
  assert.deepEqual([...stored.optional], [], 'a type the import does not name is left as it was');
  await assert.rejects(
    () => S.NDC_HISTORY_MERGE({ ...branch, lists: { all: Array.from({ length: 10000 }, (_, i) => `1704:${i + 10}`) } }),
    /history-too-large/, 'the merged list keeps the history cap');
  await assert.rejects(() => S.NDC_HISTORY_MERGE({ ...branch, lists: null }), /invalid-lists/);
  const page = fs.readFileSync('src/content/ui-collection.js', 'utf8');
  const importer = page.slice(page.indexOf("$('#nxtk-import-mods')"), page.indexOf("$('#nxtk-import-info')"));
  assert.match(importer, /mergeCollectionHistory\(/, 'the import asks the worker to merge');
  assert.doesNotMatch(importer, /getHistory\(/, 'and no longer reads the history to replace it');
}

// A tab that hits a rate limit tells the worker's queue, which must keep the later of the two waits:
// the tab's own read-then-write could replace the queue's longer wait with a shorter one.
async function rateLimitFromATabKeepsTheLongerWait() {
  const S = context.__STORAGE_HANDLERS;
  const key = 'nxtk_ndc_rate_limit';
  const now = Date.now();
  await storageSetLocal(key, { until: now + 120000 });
  await S.NDC_RATE_LIMIT_PUBLISH({ until: now + 60000 });
  assert.equal((await storageGetLocal(key, null)).until, now + 120000, 'a shorter wait never replaces a longer one');
  await S.NDC_RATE_LIMIT_PUBLISH({ until: now + 300000 });
  assert.equal((await storageGetLocal(key, null)).until, now + 300000, 'a longer one does');
  await S.NDC_RATE_LIMIT_PUBLISH({ until: now + 10 * 3600 * 1000 });
  assert.ok((await storageGetLocal(key, null)).until <= Date.now() + 3600 * 1000, 'a page cannot hold the queue for more than an hour');
  await S.NDC_RATE_LIMIT_PUBLISH({ until: 'soon' });
  await storageSetLocal(key, { until: 0 });
  const storage = fs.readFileSync('src/content/storage.js', 'utf8');
  assert.match(storage.slice(storage.indexOf('async function saveRateLimit')), /NDC_RATE_LIMIT_PUBLISH/, 'tabs publish through the worker');
}

// A history at its cap is a limit the user reached, not a fault in the extension: it is answered,
// not reported as a critical background error.
async function historyLimitIsNotACrash() {
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  const reply = await new Promise((resolve) => messageListeners[0](
    { type: 'NDC_HISTORY_SET_COLLECTION', payload: { gameId: 'g1', collectionId: 'c1', lists: { all: Array.from({ length: 10001 }, (_, i) => String(i + 1)) } } },
    { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/abc', tab: { id: 7 } },
    resolve
  ));
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'history-too-large');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await storageGetLocal(NXTK.ERROR_LOG_KEY, []), [], 'nothing was logged');
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

// Issue #34: a full path saved by an older version reaches the collection queue as well. It must not
// become a folder "D mods" there, as it no longer does for a single download.
async function queueIgnoresFullPathFolders() {
  const savedFetch = context.fetch;
  context.fetch = async (url) => ({
    ok: true, status: 200, url: String(url), text: async () => '<title>Just a moment...</title>', headers: { get: () => '' }
  });
  const cases = [['D:\\mods', ''], ['\\\\server\\share', ''], ['~/mods', ''], ['/home/me/mods', ''], ['%USERPROFILE%\\mods', ''],
    ['Collection', 'Collection']];
  try {
    for (const [index, [typed, expected]] of cases.entries()) {
      const item = { fileId: 3400 + index, historyId: `1704:${3400 + index}`, gameId: 1704, name: 'A mod',
        pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', sizeKb: 10 };
      const started = await NDC_QUEUE_HANDLERS.NDC_QUEUE_START({
        gameId: 'g34', collectionId: `c34-${index}`, type: 'all', items: [item], folder: typed, requestTimeout: 30000
      }, { tab: { id: 34 } });
      const job = await readNdcJob(started.jobId);
      assert.equal(job.folder, expected, `${typed} is ${expected ? 'a folder' : 'no folder'} for a collection queue`);
    }
  } finally {
    context.fetch = savedFetch;
  }
}

Promise.resolve()
  .then(jobStateBehaviour)
  .then(writeQueueRelease)
  .then(queueIgnoresFullPathFolders)
  .then(failedReadNeverOverwrites)
  .then(missingQueueItemsBehaviour)
  .then(reconnectScopeBehaviour)
  .then(classifiedRateLimitWaitsInsteadOfFailing)
  .then(skippedModsDoNotStopTheQueue)
  .then(cloudflareStreakStopsTheQueue)
  .then(stopCancelsAPendingStart)
  .then(restartWaitsForAnInFlightStart)
  .then(resumeConsumesAMissedTerminal)
  .then(activeQueuesAreListed)
  .then(vortexSentHistoryIsAccepted)
  .then(largeHistoryFitsTheQuota)
  .then(concurrentResumesStartOneDownload)
  .then(controlStormEndsStopped)
  .then(queueNoLinkFailureSaysWhy)
  .then(queueWaitsOutLostConnection)
  .then(fullDiskStopsTheRun)
  .then(historyImportMergesWithRunningQueue)
  .then(rateLimitFromATabKeepsTheLongerWait)
  .then(queueWaitsOutAServerOutage)
  .then(reconcileSurvivesAFailingJob)
  .then(historyLimitIsNotACrash)
  .then(() => console.log('background.js queue behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
