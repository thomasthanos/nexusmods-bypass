// The debug log, automatic error reports and the error log.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  messageListeners, context, NXTK, storageSetLocal, storageGetLocal, appendErrorLogEntry, NDC_JOBS_KEY,
  recordQueueItemFailure
} from './helpers/background-harness.mjs';

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

async function debugClearWaitsForPendingAppends() {
  const S = context.__STORAGE_HANDLERS;
  const realGet = global.chrome.storage.local.get;
  await storageSetLocal(NXTK.DEBUG_LOG_KEY, [{ text: 'before clear' }]);
  let releaseRead;
  let startedRead;
  const reading = new Promise((resolve) => { startedRead = resolve; });
  global.chrome.storage.local.get = (key, callback) => {
    if (key !== NXTK.DEBUG_LOG_KEY || releaseRead) return realGet(key, callback);
    realGet(key, (snapshot) => {
      releaseRead = () => callback(snapshot);
      startedRead();
    });
  };
  try {
    const append = S.DEBUG_LOG_APPEND({ entries: [{ text: 'append already pending' }] });
    await reading;
    const clear = S.DEBUG_LOG_CLEAR();
    // Let the clear reach its write if it is not serialized with the pending append.
    await Promise.resolve();
    releaseRead();
    await Promise.all([append, clear]);
    assert.deepEqual(await storageGetLocal(NXTK.DEBUG_LOG_KEY, null), [],
      'clearing the log also clears an append that was already pending');

    await Promise.all([
      S.DEBUG_LOG_CLEAR(),
      S.DEBUG_LOG_APPEND({ entries: [{ text: 'after clear' }] })
    ]);
    const log = await storageGetLocal(NXTK.DEBUG_LOG_KEY, []);
    assert.deepEqual(log.map((line) => line.text), ['after clear'], 'a later append survives the clear');
  } finally {
    releaseRead?.();
    global.chrome.storage.local.get = realGet;
  }
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

// Pausing or stopping with no queue running is an answer, not a fault. It used to
// write a background_error per press, so a bug report read as five failures.
async function expectedOutcomesStayOutOfTheLog() {
  await storageSetLocal(NDC_JOBS_KEY, {});
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(messageListeners.length, 1, 'the worker registers exactly one message listener');

  const send = (type, payload = {}) => new Promise((resolve) => {
    const handled = messageListeners[0](
      { type, payload: { gameId: 'g1', collectionId: 'c1', ...payload } },
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

  const savedDownloads = global.chrome.downloads;
  const jobId = 'testjob-retirement-answer';
  try {
    await storageSetLocal(NDC_JOBS_KEY, {
      [jobId]: { id: jobId, gameId: 'g1', collectionId: 'c1', status: 'stopped', itemCount: 1,
        retiringDownloadId: 918, createdAt: Date.now(), updatedAt: Date.now() }
    });
    global.chrome.downloads = {
      search: (_query, callback) => callback([{ id: 918, state: 'complete', exists: true }]),
      cancel: (_id, callback) => callback(),
      removeFile: (_id, callback) => {
        global.chrome.runtime.lastError = { message: 'File cannot be removed' };
        callback();
        global.chrome.runtime.lastError = null;
      }
    };
    const blocked = await send('NDC_QUEUE_START', { items: [{ fileId: 42, gameId: '1704', name: 'Wanted.7z',
      pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42' }] });
    assert.equal(blocked.ok, false, 'a new run still cannot replace an unretired download');
    assert.equal(blocked.error, 'previous_download_not_retired (complete, file still there)',
      'the caller keeps the reason it must wait');
    await context.__writeQueues.get(NXTK.ERROR_LOG_KEY);
    assert.equal((await storageGetLocal(NXTK.ERROR_LOG_KEY, [])).length, 0,
      'the intentional safety refusal is not reported as a critical background crash');
    assert.equal((await storageGetLocal(NDC_JOBS_KEY, {}))[jobId].retiringDownloadId, 918,
      'the refusal keeps ownership of the unretired file');
  } finally {
    global.chrome.downloads = savedDownloads;
    global.chrome.runtime.lastError = null;
    await storageSetLocal(NDC_JOBS_KEY, {});
  }

  const failing = await send('NDC_HISTORY_ADD');
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'invalid-history-type');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const afterReal = await storageGetLocal(NXTK.ERROR_LOG_KEY, []);
  assert.equal(afterReal.length, 1, 'a genuine handler fault is still recorded');
  assert.equal(afterReal[0].context, 'NDC_HISTORY_ADD');
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

Promise.resolve()
  .then(errorLogCollapsing)
  .then(expectedOutcomesStayOutOfTheLog)
  .then(debugLogAndAutoReports)
  .then(debugClearWaitsForPendingAppends)
  .then(queueFailureLogKeepsDistinctFaults)
  .then(() => console.log('background.js report behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
