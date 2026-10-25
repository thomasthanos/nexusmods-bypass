// background.js as the worker suites test it: the chrome API is mocked, the worker runs in a vm context, and
// the internals the suites check are exported. Each suite runs in its own process, so each loads its own
// copy of the worker and its storage.
import fs from 'node:fs';
import vm from 'node:vm';

export const noop = () => {};
export const finishCallback = (_id, callback) => { if (callback) callback(); };
export const listener = () => ({ addListener: noop });
export const messageListeners = [];
export const installedListeners = [];

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

export const context = vm.createContext({ chrome: global.chrome, console, URL, Date, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, JSON, setTimeout, clearTimeout, isNaN, parseInt, AbortController, structuredClone, fetch: noop });
context.importScripts = (...paths) => {
  for (const path of paths) {
    vm.runInContext(fs.readFileSync(`src/${path}`, 'utf8'), context, { filename: `src/${path}` });
  }
};
export const source = `${fs.readFileSync('src/background.js', 'utf8')}\n;globalThis.__NXTK = NXTK;globalThis.__STORAGE_HANDLERS = STORAGE_HANDLERS;globalThis.__NDC_JOBS_KEY = NDC_JOBS_KEY;globalThis.__writeQueues = writeQueues;globalThis.__NDC_QUEUE_HANDLERS = NDC_QUEUE_HANDLERS;globalThis.__STORAGE_HISTORY_KEY = STORAGE_HISTORY_KEY;globalThis.__MAX_NDC_JOB_ITEMS = MAX_NDC_JOB_ITEMS;globalThis.__DOWNLOAD_CONFLICT_ACTION = DOWNLOAD_CONFLICT_ACTION;globalThis.__MAX_TRACKED_FAILURES = MAX_TRACKED_FAILURES;globalThis.__recordJobFailure = recordJobFailure;globalThis.__jobFailureCount = jobFailureCount;globalThis.__verifyTransferSize = verifyTransferSize;globalThis.__settledInterruptedState = settledInterruptedState;globalThis.__discardAbandonedDownload = discardAbandonedDownload;globalThis.__handleNdcDownloadTerminal = handleNdcDownloadTerminal;globalThis.__recordQueueItemFailure = recordQueueItemFailure;globalThis.__DOWNLOAD_HANDLERS = DOWNLOAD_HANDLERS;globalThis.__recentDownloadStarts = recentDownloadStarts;`;
vm.runInContext(source, context, { filename: 'src/background.js' });

export const { retryAfterMilliseconds, buildDownloadPath, downloadFolderOf, __NXTK: NXTK } = context;
export const { __DOWNLOAD_CONFLICT_ACTION: DOWNLOAD_CONFLICT_ACTION, __MAX_TRACKED_FAILURES: MAX_TRACKED_FAILURES,
  __recordJobFailure: recordJobFailure, __jobFailureCount: jobFailureCount } = context;
export const { classifyNexusResponse } = context;
export const { isValidFileId, isValidHistoryId, ndcScopeKey, sanitizeNdcJobItem } = context;
export const { mutateNdcJob, readNdcJob, saveNdcJob, storageSetLocal, storageGetLocal, enqueueStorageTask,
  advanceNdcJob, processNdcJob, appendErrorLogEntry, applyNdcDownloadTerminal, __verifyTransferSize: verifyTransferSize, __NDC_JOBS_KEY: NDC_JOBS_KEY, __writeQueues: writeQueues,
  __NDC_QUEUE_HANDLERS: NDC_QUEUE_HANDLERS, __STORAGE_HISTORY_KEY: STORAGE_HISTORY_KEY, __MAX_NDC_JOB_ITEMS: MAX_NDC_JOB_ITEMS } = context;
export const { __handleNdcDownloadTerminal: handleNdcDownloadTerminal,
  __recordQueueItemFailure: recordQueueItemFailure } = context;
