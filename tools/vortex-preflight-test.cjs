const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = globalThis;
global.document = {};
global.NXTK = {
  escapeHtml: (value) => String(value ?? ''),
  t: (_key, _substitutions, fallback) => fallback,
  setActivity: () => {},
  validateDownloadTarget: () => ({ ok: true })
};
global.NexusExt = {
  Errors: {
    DEFAULT_TIMEOUT_MS: 30000
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

const uiSource = fs.readFileSync('src/content/ui.js', 'utf8');
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

  const uiSourceForDeck = fs.readFileSync('src/content/ui.js', 'utf8');  assert.match(
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

  console.log('Vortex preflight behavior OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
