const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The queue policy is the real one from shared.js; shared.js needs no browser to load.
const shared = vm.createContext({ console, URL, Intl });
vm.runInContext(fs.readFileSync('src/shared.js', 'utf8'), shared, { filename: 'src/shared.js' });

global.window = globalThis;
global.document = {};
global.NXTK = {
  escapeHtml: (value) => String(value ?? ''),
  t: (_key, _substitutions, fallback) => fallback,
  tPlural: (_key, _count, fallback) => fallback,
  setActivity: () => {},
  bumpTotalDownloads: () => {},
  validateDownloadTarget: () => ({ ok: true }),
  orderQueueBySize: shared.NXTK.orderQueueBySize,
  queueSkipReason: shared.NXTK.queueSkipReason,
  isSafeNexusPageUrl: shared.NXTK.isSafeNexusPageUrl,
  CLOUDFLARE_SKIP_LIMIT: shared.NXTK.CLOUDFLARE_SKIP_LIMIT
};
const BLOCKING_CODES = new Set(['cloudflare', 'requires_login', 'account_suspended', 'rate_limited']);
global.NexusExt = {
  Errors: {
    DEFAULT_TIMEOUT_MS: 30000,
    normalize: (error) => ({ ...error, blocking: BLOCKING_CODES.has(error?.code), retryable: false }),
    isBlocking: (error) => BLOCKING_CODES.has(error?.code),
    toLogMessage: (error) => String(error?.code || ''),
    create: (code) => ({ code })
  },
  Auth: {
    getDocumentLoginError: () => null
  },
  Storage: {},
  UI: {}
};

vm.runInThisContext(fs.readFileSync('src/content/ndc.js', 'utf8'), {
  filename: 'src/content/ndc.js'
});

// The page UI is split into what every page loads and the collection bundle; both are checked.
const uiSource = ['src/content/ui.js', 'src/content/ui-collection.js'].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const boundModalList = uiSource.match(/const NDC_BOUND_MODAL_IDS = \[[\s\S]*?\];/)?.[0] || '';
assert.match(
  boundModalList,
  /'nxtk-vortex-check-modal'/,
  'collection teardown must settle and remove an open Vortex preflight'
);

function createHarness(choice) {
  const calls = {
    browserQueue: 0,
    history: 0,
    patch: 0,
    progress: 0,
    ended: 0,
    handoffModal: 0,
    selectedMethod: null
  };

  NexusExt.UI.showVortexHandoffModal = async () => {
    calls.handoffModal += 1;
    return choice;
  };
  NexusExt.Storage.getSettings = async () => ({
    NDC_pauseBetweenDownload: 5,
    NDC_downloadSpeed: 3.2,
    NDC_downloadMethod: 0,
    RequestTimeout: 30000,
    ShowAlertsOnError: true,
    DownloadFolder: 'NexusMods',
    WabbajackImport: true
  });
  NexusExt.Storage.getHistory = async () => {
    calls.history += 1;
    return {};
  };
  NexusExt.Storage.patchSetting = async (key, value) => {
    calls.patch += 1;
    calls.patched = { key, value };
  };

  const ndc = new NexusExt.NDC('game', 'collection');
  ndc.ui = {
    progress: 0,
    modsCount: 0,
    log: () => {},
    logText: () => {},
    setDownloadMethod: (method) => {
      calls.selectedMethod = method;
    },
    startDownload: () => {
      calls.progress += 1;
    },
    endDownload: () => {
      calls.ended += 1;
    }
  };
  ndc.downloadBrowserQueue = async () => {
    calls.browserQueue += 1;
  };

  return { ndc, calls };
}

(async () => {
  const canceled = createHarness('cancel');
  await canceled.ndc.runCollection([], 'all');
  assert.equal(canceled.calls.history, 0, 'cancel must not read or mutate history');
  assert.equal(canceled.calls.progress, 0, 'cancel must not start progress');
  assert.equal(canceled.calls.patch, 0, 'cancel must not change the saved method');

  const browser = createHarness('browser');
  await browser.ndc.runCollection([], 'all');
  assert.equal(browser.ndc.downloadMethod, 1);
  assert.equal(browser.calls.selectedMethod, 1);
  assert.equal(browser.calls.patch, 1);
  assert.deepEqual(browser.calls.patched, { key: 'NDC_downloadMethod', value: 1 });
  assert.equal(browser.calls.browserQueue, 1, 'browser fallback must start the browser queue');
  assert.equal(browser.calls.progress, 0, 'Vortex progress must not start before browser fallback');

  const vortex = createHarness('vortex');
  await vortex.ndc.runCollection([], null);
  assert.equal(vortex.ndc.downloadMethod, 0);
  assert.equal(vortex.calls.selectedMethod, null);
  assert.equal(vortex.calls.patch, 0);
  assert.equal(vortex.calls.browserQueue, 0);
  assert.equal(vortex.calls.progress, 1, 'confirmed Vortex flow must start exactly once');
  assert.equal(vortex.calls.ended, 1, 'confirmed Vortex flow must finish exactly once');

  // An imported modlist has to reach the disk, and the saved collection method
  // must survive the import untouched.
  const modlist = createHarness('vortex');
  const mods = [{ fileId: 1, historyId: '1704:1', file: { fileId: 1, name: 'A.7z', size: 10, mod: { name: 'A', modId: 5, game: { domainName: 'skyrimspecialedition', id: 1704 } } } }];
  await modlist.ndc.initFromMods(mods);
  assert.equal(modlist.ndc.external, true, 'the deck knows it is not a collection');
  assert.equal(modlist.ndc.downloadMethod, 1, 'an imported modlist downloads through the browser');
  assert.equal(modlist.calls.patch, 0, 'importing must not rewrite the saved method');

  await modlist.ndc.runCollection(mods, 'all');
  assert.equal(modlist.calls.handoffModal, 0, 'no Vortex preflight for a modlist');
  assert.equal(modlist.calls.browserQueue, 1, 'the browser queue runs');
  assert.equal(modlist.calls.progress, 0, 'the Vortex loop never starts');
  assert.equal(modlist.calls.patch, 0, 'the saved method is still untouched');
  assert.deepEqual(modlist.ndc.mods.mandatory, modlist.ndc.mods.all, 'mandatory mirrors the full list');
  assert.notEqual(modlist.ndc.mods.mandatory, modlist.ndc.mods.all, 'but is not the same array');

  const uiSourceForDeck = uiSource;
  assert.match(
    uiSourceForDeck,
    /const vortexMethodRow = ndc\.external \? ''/,
    'the deck must drop the Vortex option for an imported modlist'
  );
  assert.match(
    uiSourceForDeck,
    /if \(!ndc\.external\) NexusExt\.Storage\.patchSetting\('NDC_downloadMethod'/,
    'the deck must not save a method chosen inside a modlist run'
  );
  assert.match(
    uiSourceForDeck,
    /if \(ndc\.external && normalized === DOWNLOAD_METHOD_VORTEX\) return;/,
    'setDownloadMethod must refuse to put a modlist back into Vortex mode'
  );

  // A Vortex run has no worker job, so pausing or stopping it must stay local.
  // Sending anyway answered "job-not-found" and logged one error per press.
  const local = createHarness('vortex');
  const commands = [];
  NexusExt.Storage.sendDownloadCommand = async (type) => {
    commands.push(type);
    return { ok: false, error: 'job-not-found' };
  };
  local.ndc.downloadMethod = 0;
  local.ndc.setPaused(true);
  local.ndc.setPaused(false);
  local.ndc.stopBackgroundQueue();
  assert.deepEqual(commands, [], 'a Vortex run must not talk to the background queue');

  local.ndc.downloadMethod = 1;
  local.ndc.setPaused(true);
  local.ndc.stopBackgroundQueue();
  assert.deepEqual(commands, ['NDC_QUEUE_PAUSE', 'NDC_QUEUE_STOP'],
    'a browser run still controls its queue');

  // A Vortex run in size order: the smallest file goes first, a file with no size goes last, and a
  // removed mod is skipped without stopping the rest (#10 follow-up).
  const runVortexQueue = async (mods, answerFor) => {
    const harness = createHarness('vortex');
    const { ndc } = harness;
    const asked = [];
    const handed = [];
    const logs = [];
    let outcome = null;
    ndc.pauseBetweenDownload = 0;
    ndc.showAlertsOnError = false;
    ndc.smallestFirst = true;
    ndc.ui.incrementProgress = () => {};
    ndc.ui.logText = (text) => { logs.push(text); };
    ndc.ui.log = (html) => { logs.push(html); };
    ndc.ui.endDownload = (value) => { outcome = value; };
    NexusExt.Storage.getRateLimit = async () => null;
    ndc.fetchDownloadLinkWithRetry = async (mod) => {
      asked.push(mod.file.name);
      const code = answerFor(mod);
      return code ? { downloadUrl: '', error: { code } } : { downloadUrl: `nxm://game/mods/1/files/${mod.fileId}` };
    };
    ndc.handOffDownload = (mod) => { handed.push(mod.file.name); return true; };
    await ndc.runCollection(mods, null);
    return { asked, handed, logs, outcome };
  };
  const vortexMod = (fileId, name, size) => ({
    fileId,
    file: { fileId, name, size, url: `https://www.nexusmods.com/skyrimspecialedition/mods/${fileId}?tab=files&file_id=${fileId}`, mod: { name, game: { id: 1704 } } }
  });

  const sized = await runVortexQueue([
    vortexMod(1, 'Big.7z', 900000),
    vortexMod(2, 'Removed.7z', 40),
    vortexMod(3, 'No size.7z', 0),
    vortexMod(4, 'Tiny.7z', 12)
  ], (mod) => (mod.file.name === 'Removed.7z' ? 'mod_unavailable' : ''));
  assert.deepEqual(sized.asked, ['Tiny.7z', 'Removed.7z', 'Big.7z', 'No size.7z'],
    'the queue runs smallest first, and a file with no size runs last');
  assert.deepEqual(sized.handed, ['Tiny.7z', 'Big.7z', 'No size.7z'],
    'a removed mod does not stop the files after it');
  assert.equal(sized.outcome, 'partial', 'a run that skipped a file does not read as a clean finish');
  assert.ok(sized.logs.some((line) => /Skipped 1 mods that could not be downloaded/.test(line)),
    'the skipped file is summed up at the end');
  assert.ok(sized.logs.some((line) => /^mod_unavailable · <a href="https:\/\/www\.nexusmods\.com\/[^"]+file_id=2" [^>]*>Removed\.7z<\/a>$/.test(line)),
    'and named, with the reason and a link to its file page (not a Vortex hand-off)');

  // One Cloudflare answer is passed over; the same answer on file after file stops the run.
  const limit = NXTK.CLOUDFLARE_SKIP_LIMIT;
  const walled = await runVortexQueue(
    Array.from({ length: limit + 2 }, (_, index) => vortexMod(index + 1, `Mod ${index + 1}.7z`, index + 1)),
    () => 'cloudflare'
  );
  assert.equal(walled.asked.length, limit + 1, 'the run stops at the first Cloudflare answer past the limit');
  assert.deepEqual(walled.handed, []);
  assert.equal(walled.outcome, 'blocked', 'and asks for the check to be completed');

  const broken = await runVortexQueue(
    Array.from({ length: limit + 2 }, (_, index) => vortexMod(index + 1, `Mod ${index + 1}.7z`, index + 1)),
    (mod) => (mod.fileId === limit ? '' : 'cloudflare')
  );
  assert.equal(broken.asked.length, limit + 2, 'a file that resolves ends the Cloudflare streak');
  assert.deepEqual(broken.handed, [`Mod ${limit}.7z`]);
  assert.equal(broken.outcome, 'partial');

  const off = new NexusExt.NDC('game', 'collection');
  off.loadRunSettings({ NDC_smallestFirst: false });
  assert.equal(off.smallestFirst, false, 'the order can be turned off');
  off.loadRunSettings({});
  assert.equal(off.smallestFirst, true, 'and is on for anyone who never touched it');

  console.log('Vortex preflight behavior OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
