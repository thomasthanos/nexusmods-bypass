const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The queue policy is the real one from shared.js; shared.js needs no browser to load.
const shared = vm.createContext({ console, URL, URLSearchParams, Intl, setTimeout, clearTimeout, setInterval, clearInterval });
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
  CLOUDFLARE_SKIP_LIMIT: shared.NXTK.CLOUDFLARE_SKIP_LIMIT,
  vortexSentType: shared.NXTK.vortexSentType,
  nxmLinkInfo: shared.NXTK.nxmLinkInfo,
  isNxmLinkExpired: shared.NXTK.isNxmLinkExpired,
  isNexusUserMismatch: shared.NXTK.isNexusUserMismatch,
  isConnectionFailure: shared.NXTK.isConnectionFailure,
  // Connection waits end at the first tick, and two of them run out, so the tests stay quick.
  networkWaitMs: () => 0,
  NETWORK_WAIT_MAX_STRIKES: 2,
  // Vortex "opens" instantly unless a test says otherwise.
  waitForProtocolHandoff: async () => true
};
const BLOCKING_CODES = new Set(['cloudflare', 'requires_login', 'account_suspended', 'rate_limited']);
global.NexusExt = {
  Errors: {
    DEFAULT_TIMEOUT_MS: 30000,
    normalize: (error) => ({ ...error, blocking: BLOCKING_CODES.has(error?.code), retryable: false }),
    isBlocking: (error) => BLOCKING_CODES.has(error?.code),
    toLogMessage: (error) => `${error?.code || ''} — full advice`,
    displayText: (error) => ({ message: String(error?.code || ''), recovery: 'advice' }),
    create: (code, extra = {}) => ({ code, ...extra }),
    fromException: (cause) => { console.error('RUN THREW', cause); return { code: 'unknown' }; },
    classifyContent: () => null
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
assert.match(boundModalList, /'nxtk-vortex-opened-modal'/,
  'collection teardown must settle and remove an open "Did Vortex open?" question');

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
      const code = answerFor(mod, ndc);
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
  assert.ok(sized.logs.every((line) => !/full advice/.test(line) || !/Skipped/.test(line)),
    'a skip names the reason, not the advice that goes with an error');
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

  // A dropped connection is waited out on the same file. Failing it and moving on failed every file
  // after it within seconds, each with its own error dialog.
  const threeMods = () => [vortexMod(1, 'One.7z', 1), vortexMod(2, 'Two.7z', 2), vortexMod(3, 'Three.7z', 3)];
  let dropsLeft = 2;
  const recovered = await runVortexQueue(threeMods(), (mod) => {
    if (mod.fileId !== 2 || !dropsLeft) return '';
    dropsLeft -= 1;
    return 'network_error';
  });
  assert.deepEqual(recovered.asked, ['One.7z', 'Two.7z', 'Two.7z', 'Two.7z', 'Three.7z'],
    'the same file is asked for again after each wait');
  assert.deepEqual(recovered.handed, ['One.7z', 'Two.7z', 'Three.7z'], 'and nothing is lost to the drop');
  assert.equal(recovered.outcome, 'finished');
  assert.ok(recovered.logs.some((line) => /^Cannot reach Nexus Mods\. Trying again in /.test(line)),
    'the wait names the connection, not a rate limit');

  const down = await runVortexQueue(threeMods(), (mod) => (mod.fileId === 1 ? '' : 'offline'));
  assert.deepEqual(down.asked, ['One.7z', ...Array(NXTK.NETWORK_WAIT_MAX_STRIKES + 1).fill('Two.7z')],
    'once every wait has run out the run stops, and the files after it are never asked for');
  assert.deepEqual(down.handed, ['One.7z']);
  assert.equal(down.outcome, 'error');
  assert.ok(down.logs.some((line) => /Collection paused/.test(line)), 'and says the completed files are kept');

  const broke = await runVortexQueue(threeMods(), (mod) => (mod.fileId === 2 ? 'request_failed' : ''));
  assert.deepEqual(broke.asked, ['One.7z', 'Two.7z', 'Three.7z'], 'a fault that is not the connection fails just that file');
  assert.equal(broke.outcome, 'partial');

  // Pause holds the run after a skipped file too; the next file used to be sent while "Paused" showed.
  const STATUS_PAUSED = 1;
  const askedWhilePaused = [];
  const pausing = await runVortexQueue(threeMods(), (mod, ndc) => {
    if (ndc.runStatus === STATUS_PAUSED) askedWhilePaused.push(mod.file.name);
    if (mod.fileId !== 1) return '';
    ndc.runStatus = STATUS_PAUSED; // Pause pressed while the first file was being looked up
    setTimeout(() => { ndc.runStatus = 0; }, 300);
    return 'mod_unavailable';
  });
  assert.deepEqual(askedWhilePaused, [], 'nothing past the skipped file is asked for while paused');
  assert.deepEqual(pausing.handed, ['Two.7z', 'Three.7z'], 'and the run carries on after Resume');

  // "Retry failed" on the summary of a run that ended on a sign-in (or stopped, or blocked) retries:
  // the run left the status at Stopped, which used to skip every retry without a word.
  let card = null;
  let runNdc = null;
  const savedSummary = NexusExt.UI.showRunSummary;
  NexusExt.UI.showRunSummary = (summary, options) => { card = { summary, options }; };
  const signIn = await runVortexQueue([vortexMod(1, 'A.7z', 1), vortexMod(2, 'B.7z', 2)], (mod, ndc) => {
    runNdc = ndc;
    return mod.fileId === 1 ? 'server_error' : 'requires_login';
  });
  NexusExt.UI.showRunSummary = savedSummary;
  assert.equal(signIn.outcome, 'requires_login');
  assert.deepEqual(card?.summary.failed.map((entry) => entry.name), ['A.7z']);
  runNdc.runStatus = 3; // what the deck's endDownload leaves after a run that ended this way
  const retried = [];
  runNdc.retryMod = async (mod) => { retried.push(mod.file.name); };
  await card.options.onRetryFailed();
  assert.deepEqual(retried, ['A.7z'], 'the failed file is retried');

  // Nexus re-renders the page mid-run and the deck is mounted again: a Vortex run has no worker job to
  // attach to, so the new deck is set up from the run's own count, with its Stop and Pause.
  const remounted = [];
  await runVortexQueue(threeMods(), (mod, ndc) => {
    if (mod.fileId !== 2) return '';
    const fresh = {
      ...ndc.ui,
      startDownload: (total, options) => remounted.push(['start', total, options?.resumed === true]),
      setProgress: (done, total) => remounted.push(['progress', done, total]),
      setDownloadStatus: (status) => remounted.push(['status', status])
    };
    ndc.ui = fresh;
    ndc.running = true;
    ndc.resumeBackgroundRun().then((attached) => remounted.push(['attached', attached]));
    return '';
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(remounted, [['start', 3, true], ['progress', 1, 3], ['attached', true]],
    'the new deck shows the run, one file in, without asking the worker');

  // The second file waits for a Vortex the first link may have started (a link that arrives while
  // Vortex is still loading is dropped); the files after it do not.
  NXTK.VORTEX_STARTUP_GAP_SECONDS = 1;
  const askedAt = [];
  await runVortexQueue(threeMods(), () => { askedAt.push(Date.now()); return ''; });
  delete NXTK.VORTEX_STARTUP_GAP_SECONDS;
  assert.ok(askedAt[1] - askedAt[0] >= 900, `the second file waits for Vortex to start (${askedAt[1] - askedAt[0]} ms)`);
  assert.ok(askedAt[2] - askedAt[1] < 900, `the third does not wait again (${askedAt[2] - askedAt[1]} ms)`);

  const off = new NexusExt.NDC('game', 'collection');
  off.loadRunSettings({ NDC_smallestFirst: false });
  assert.equal(off.smallestFirst, false, 'the order can be turned off');
  off.loadRunSettings({});
  assert.equal(off.smallestFirst, true, 'and is on for anyone who never touched it');

  // Nexus renaming a GraphQL field shows as a validation error, and is named as an API change.
  document.location = { href: 'https://www.nexusmods.com/games/game/collections/collection' };
  const api = new NexusExt.NDC('game', 'collection');
  const answer = (body) => { NexusExt.Errors.request = async () => ({ ok: true, text: JSON.stringify(body) }); };
  answer({ errors: [{ message: 'Cannot query field "modFiles" on type "CollectionRevision".' }], data: { collectionRevision: null } });
  assert.equal(await api.fetchMods(), null);
  assert.equal(api.lastError.code, 'nexus_api_changed', 'a schema error reads as Nexus changing its API');
  assert.match(api.lastError.technicalMessage, /GraphQL: Cannot query field "modFiles"/, 'and carries what GraphQL said');
  // E-0p8soab: a collection under review came in as "Unexpected response from Nexus · Refresh the page".
  for (const message of ['This collection 7Mbc1t currently being moderated', 'Collection not found', 'This collection has been hidden']) {
    answer({ errors: [{ message }], data: { collectionRevision: null } });
    await api.fetchMods();
    assert.equal(api.lastError.code, 'collection_unavailable', `"${message}" is the collection being unavailable`);
    assert.match(api.lastError.technicalMessage, /GraphQL: /, 'and carries what GraphQL said');
  }
  answer({ errors: [{ message: 'Internal server error' }], data: { collectionRevision: null } });
  await api.fetchMods();
  assert.equal(api.lastError.code, 'invalid_response', 'any other GraphQL error is not called an API change');
  assert.match(api.lastError.technicalMessage, /Internal server error/);
  answer({ data: { collection: null } });
  assert.equal(await api.fetchRevisions(), null);
  assert.equal(api.lastError.code, 'invalid_response');
  assert.match(api.lastError.technicalMessage, /no collection\.revisions/, 'a missing field is named');
  answer({ errors: [{ message: 'Unknown argument "slug" on field "Query.collection".' }] });
  await api.fetchRevisions();
  assert.equal(api.lastError.code, 'nexus_api_changed');

  // Asked with X-Requested-With, Nexus answers a mod page with the tab fragment, which has no nxm link,
  // and the deck handed that answer on to the page resolver as already loaded. The deck asks for the
  // page the way a click does (as nnw.js has since 3.1.7).
  {
    const asked = [];
    const nxm = 'nxm://game/mods/1/files/2?key=k&expires=2000000000&user_id=7';
    NexusExt.Errors.request = async (url, options) => {
      asked.push({ url, options });
      return { ok: true, status: 200, text: `<mod-file-download download-url="${nxm.replace(/&/g, '&amp;')}"></mod-file-download>`, finalUrl: url };
    };
    const savedNnw = NexusExt.NNW;
    NexusExt.NNW = {
      parseDownloadURLFromResponse: () => null,
      parseNxmDownloadLink: (text) => (String(text || '').includes('nxm://') ? nxm : null)
    };
    const deck = new NexusExt.NDC('game', 'collection');
    const mod = { fileId: 2, file: { fileId: 2, url: 'https://www.nexusmods.com/game/mods/1?tab=files&file_id=2', mod: { game: { id: 9 } } } };
    const found = await deck.fetchDownloadLink(mod);
    NexusExt.NNW = savedNnw;
    assert.equal(found.downloadUrl, nxm);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://www.nexusmods.com/game/mods/1?tab=files&file_id=2&nmm=1');
    assert.equal(asked[0].options.headers?.['X-Requested-With'], undefined, 'the file page is loaded the way a click loads it');
  }

  // ---- Vortex hand-off improvements (feat/vortex-handoff).
  {
    const S = shared.NXTK;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 10;
    const link = (exp, uid = '42') => `nxm://skyrimspecialedition/mods/1/files/2?key=k&expires=${exp}&user_id=${uid}`;
    assert.equal(S.vortexSentType('all'), 'vortexSent_all');
    assert.deepEqual({ ...S.nxmLinkInfo(link(future)) }, { expiresAt: future * 1000, userId: '42' });
    assert.deepEqual({ ...S.nxmLinkInfo('https://x/?expires=1') }, { expiresAt: null, userId: null }, 'only nxm links are read');
    assert.equal(S.isNxmLinkExpired(link(future)), false);
    assert.equal(S.isNxmLinkExpired(link(past)), true);
    assert.equal(S.isNxmLinkExpired(link(Math.floor(Date.now() / 1000) + 10)), true, 'a link about to expire counts as expired');
    assert.equal(S.isNxmLinkExpired('nxm://g/mods/1/files/2?key=k'), false, 'no expires is not expired');
    assert.equal(S.isNexusUserMismatch('1', '2'), true);
    assert.equal(S.isNexusUserMismatch('1', '1'), false);
    assert.equal(S.isNexusUserMismatch('1', null), false, 'unknown page user is not a mismatch');

    const target = () => {
      const listeners = {};
      return { listeners, visibilityState: 'visible',
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; } };
    };
    const win = target(); const doc = target();
    const blurred = S.waitForProtocolHandoff({ win, doc, timeoutMs: 1000, maxMs: 30 });
    win.listeners.blur();
    assert.equal(await blurred, true, 'a blur that lasts (Vortex holds the focus) means the link was handed on');
    assert.equal(win.listeners.blur, undefined, 'listeners are removed');
    const winC = target(); const docC = target();
    const canceled = S.waitForProtocolHandoff({ win: winC, doc: docC, timeoutMs: 1000, maxMs: 1000 });
    winC.listeners.blur();
    winC.listeners.focus();
    assert.equal(await canceled, false, 'blur then focus back (the browser prompt was cancelled or answered) is not proof');
    const winF = target(); const docF = target();
    const focusOnly = S.waitForProtocolHandoff({ win: winF, doc: docF, timeoutMs: 30 });
    winF.listeners.focus();
    assert.equal(await focusOnly, false, 'a focus without a blur first means nothing');
    const win2 = target(); const doc2 = target();
    const hidden = S.waitForProtocolHandoff({ win: win2, doc: doc2, timeoutMs: 1000 });
    doc2.visibilityState = 'hidden'; doc2.listeners.visibilitychange();
    assert.equal(await hidden, true, 'a hidden page counts too');
    assert.equal(await S.waitForProtocolHandoff({ win: target(), doc: target(), timeoutMs: 20 }), false, 'nothing happening times out');

    // Chrome's own "Open Vortex?" dialog: the window blurs, and on Cancel no 'focus' event fires,
    // but document.hasFocus() is true again. That must read as "not opened", well before maxMs.
    const winN = target(); const docN = target(); let focused = true; const reasons = [];
    docN.hasFocus = () => focused;
    const nativeCancel = S.waitForProtocolHandoff({ win: winN, doc: docN, timeoutMs: 1000, maxMs: 5000, pollMs: 10, onResult: (r) => reasons.push(r) });
    focused = false; winN.listeners.blur();
    setTimeout(() => { focused = true; }, 40);
    const startedAt = Date.now();
    assert.equal(await nativeCancel, false, 'focus back without a focus event (cancelled native dialog) is not opened');
    assert.ok(Date.now() - startedAt < 1000, 'decided by polling, not by maxMs');
    assert.deepEqual([...reasons], ['focus-returned']);
    // The dialog already holds focus when the watch starts.
    const winP = target(); const docP = target(); let focusP = false;
    docP.hasFocus = () => focusP;
    const preBlurred = S.waitForProtocolHandoff({ win: winP, doc: docP, timeoutMs: 1000, maxMs: 5000, pollMs: 10 });
    setTimeout(() => { focusP = true; }, 30);
    assert.equal(await preBlurred, false, 'a watch that starts while the dialog is open still sees the cancel');
    const winV = target(); const docV = target(); const reasonsV = [];
    docV.hasFocus = () => false;
    assert.equal(await S.waitForProtocolHandoff({ win: winV, doc: docV, timeoutMs: 1000, maxMs: 40, pollMs: 10, onResult: (r) => reasonsV.push(r) }), true, 'focus kept away for maxMs means Vortex opened');
    assert.deepEqual([...reasonsV], ['blur-persisted']);
    // A page already in the background when the link went out: no focus to lose and hidden already,
    // which used to read as "opened" at once, closing the tab and remembering Vortex as working.
    const winH = target(); const docH = target(); const reasonsH = [];
    docH.visibilityState = 'hidden';
    docH.hasFocus = () => false;
    assert.equal(await S.waitForProtocolHandoff({ win: winH, doc: docH, timeoutMs: 1000, maxMs: 40, pollMs: 10, onResult: (r) => reasonsH.push(r) }), false,
      'a hand-off from a hidden page is unknown, not opened');
    assert.deepEqual([...reasonsH], ['started-hidden']);
    assert.deepEqual(Object.keys(winH.listeners), [], 'and leaves no listeners behind');

    // A typed run: hand-offs land in the sent list, a sent file is sent again, a downloaded one is skipped.
    const typedRun = async ({ history = {}, opened = true, modalAnswer = 'yes', links = null, mods }) => {
      const harness = createHarness('vortex');
      const { ndc } = harness;
      const handed = []; const logs = []; const recorded = []; let outcome = null; let modalShown = 0;
      ndc.pauseBetweenDownload = 0; ndc.showAlertsOnError = false; ndc.smallestFirst = false;
      ndc.ui.incrementProgress = () => {};
      ndc.ui.logText = (text) => { logs.push(text); };
      ndc.ui.log = (html) => { logs.push(html); };
      ndc.ui.endDownload = (value) => { outcome = value; };
      NexusExt.Storage.getRateLimit = async () => null;
      NexusExt.Storage.getHistory = async () => JSON.parse(JSON.stringify(history));
      NexusExt.UI.showHistoryDecisionModal = async () => 'skip';
      NexusExt.Storage.clearHistoryType = async () => history;
      NexusExt.UI.showVortexOpenedModal = async () => { modalShown += 1; return modalAnswer; };
      NXTK.waitForProtocolHandoff = async () => opened;
      ndc.recordHistoryEntry = async (type, id) => { recorded.push([type, id]); return history; };
      const queue = links ? [...links] : null;
      ndc.fetchDownloadLinkWithRetry = async (mod) => ({ downloadUrl: queue ? queue.shift() : link(future) + mod.fileId });
      ndc.handOffDownload = (mod, url) => { handed.push([mod.file.name, url]); return true; };
      await ndc.runCollection(mods, 'all');
      NXTK.waitForProtocolHandoff = async () => true;
      return { handed, logs, recorded, outcome, modalShown };
    };
    const three = [vortexMod(1, 'A.7z', 1), vortexMod(2, 'B.7z', 2), vortexMod(3, 'C.7z', 3)];

    const typed = await typedRun({
      history: { game: { collection: { all: [1], vortexSent_all: [2] } } },
      mods: three
    });
    assert.deepEqual(typed.handed.map(([name]) => name), ['B.7z', 'C.7z'], 'downloaded is skipped, sent is sent again');
    assert.deepEqual(typed.recorded, [['vortexSent_all', 2], ['vortexSent_all', 3]], 'hand-offs are recorded as sent, not downloaded');
    assert.ok(typed.logs.some((l) => /Sent to Vortex before; sending again/.test(l)), 'the re-send is explained');
    assert.ok(typed.logs.some((l) => /start it in Vortex/.test(l)), 'collection guidance is given');
    assert.ok(typed.logs.some((l) => /kept as "sent", not "downloaded"/.test(l)), 'the summary explains how to resend');
    assert.equal(typed.modalShown, 0, 'no question when Vortex visibly opened');

    const refused = await typedRun({ opened: false, modalAnswer: 'no', mods: three });
    assert.equal(refused.handed.length, 1, 'only the first file is sent when Vortex did not open');
    assert.equal(refused.modalShown, 1, 'the user is asked once');
    assert.equal(refused.outcome, 'stopped');
    assert.ok(refused.logs.some((l) => /Vortex did not open/.test(l)));

    const confirmed = await typedRun({ opened: false, modalAnswer: 'yes', mods: three });
    assert.equal(confirmed.handed.length, 3, 'a "yes" sends the rest');
    assert.equal(confirmed.modalShown, 1, 'and is asked only once per run');

    // Item 7: a remembered "yes" skips the question; a remembered failure asks again.
    let memory = { confirmed: true, failStreak: 0 }; const events = []; let summaries = 0; let offered = 0;
    NXTK.readVortexOpenState = async () => memory;
    NXTK.recordVortexOpenEvent = async (event) => { events.push(event); memory = shared.NXTK.vortexOpenNext(memory, event); return memory; };
    NXTK.shouldAskVortexOpened = shared.NXTK.shouldAskVortexOpened;
    NXTK.shouldOfferBrowserSwitch = shared.NXTK.shouldOfferBrowserSwitch;
    NexusExt.UI.showRunSummary = () => { summaries += 1; };
    NexusExt.UI.offerBrowserSwitch = () => { offered += 1; };
    const remembered = await typedRun({ opened: false, modalAnswer: 'no', mods: three });
    assert.equal(remembered.modalShown, 0, 'a remembered yes is not asked again');
    assert.equal(remembered.handed.length, 3);
    assert.ok(remembered.logs.some((l) => /confirmed before/.test(l)));
    assert.equal(summaries, 1, 'item 4: the run ends with a summary card');
    memory = { confirmed: false, failStreak: 1 };
    const again = await typedRun({ opened: false, modalAnswer: 'no', mods: three });
    assert.equal(again.modalShown, 1, 'after a failure the question comes back');
    assert.equal(memory.failStreak, 2);
    assert.equal(offered, 1, 'item 6: the second failure in a row offers browser downloads');
    delete NXTK.readVortexOpenState; delete NXTK.recordVortexOpenEvent;

    // Browser runs end with the same summary card, built from the worker's per-file events.
    {
      const harness = createHarness('browser');
      const { ndc } = harness;
      delete ndc.downloadBrowserQueue;
      NXTK.createQueueEta = shared.NXTK.createQueueEta; NXTK.formatBytes = shared.NXTK.formatBytes; NXTK.MAX_TRACKED_SKIPS = shared.NXTK.MAX_TRACKED_SKIPS;
      ndc.ui.setProgress = () => {}; ndc.ui.setTimeLeft = () => {}; ndc.ui.setDownloadStatus = () => {};
      let listener = null;
      const savedChrome = global.chrome; const savedDoc = global.document;
      global.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };
      global.chrome = { runtime: { onMessage: { addListener: (fn) => { listener = fn; }, removeListener: () => {} } } };
      NexusExt.Storage.sendDownloadCommand = async (command) => (command === 'NDC_QUEUE_START'
        ? { ok: true, value: { jobId: 'job-b' } }
        : { ok: true, value: { status: 'running', index: 0 } });
      let card = null; let retried = null;
      NexusExt.UI.showRunSummary = (summary, options) => { card = { summary, options }; };
      ndc.ui.endDownload = () => {};
      const mods = [vortexMod(1, 'A.7z', 1), vortexMod(2, 'B.7z', 2), vortexMod(3, 'C.7z', 3)];
      const run = ndc.downloadBrowserQueue(mods, 'all', {});
      for (let i = 0; i < 50 && !(listener && ndc.backgroundJobId); i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(listener, 'the run listens for worker events');
      const emit = (message) => listener({ jobId: 'job-b', ...message });
      emit({ type: 'NXT_NDC_PROGRESS', itemState: 'complete', itemName: 'A.7z', index: 1, total: 3 });
      emit({ type: 'NXT_NDC_PROGRESS', itemState: 'failed', itemName: 'B.7z', error: 'download_not_started', index: 2, total: 3 });
      emit({ type: 'NXT_NDC_DONE', outcome: 'partial', skipped: [{ name: 'C.7z', pageUrl: '', reason: 'mod_unavailable' }] });
      await run;
      global.chrome = savedChrome; global.document = savedDoc;
      assert.ok(card, 'a browser run shows the summary card');
      assert.deepEqual(card.summary.sent.map((e) => e.name), ['A.7z']);
      assert.deepEqual(card.summary.failed.map((e) => [e.name, e.code]), [['B.7z', 'download_not_started']]);
      assert.deepEqual(card.summary.skipped.map((e) => e.name), ['C.7z']);
      ndc.downloadMods = async (list, type) => { retried = [list.map((m) => m.file.name), type]; };
      await card.options.onRetryFailed();
      assert.deepEqual(retried, [['B.7z'], 'all'], 'Retry failed queues only the failed files');
    }

    const stale = await typedRun({ links: [link(past), link(future)], mods: [vortexMod(1, 'A.7z', 1)] });
    assert.deepEqual(stale.handed, [['A.7z', link(future)]], 'an expired link is fetched again, never sent');
    assert.ok(stale.logs.some((l) => /Link expired, fetching a new one/.test(l)));

    // The real hand-off: refuses an expired link, and names the account once per run.
    const real = createHarness('vortex').ndc;
    const realLogs = [];
    real.ui.log = (html, level) => realLogs.push([html, level]);
    real.ui.logText = (text, level) => realLogs.push([text, level]);
    const mod = vortexMod(9, 'Real.7z', 5);
    const savedDocument = global.document;
    global.document = { location: {}, querySelector: (sel) => (/data-user-id/.test(sel) ? { getAttribute: (n) => (n === 'data-user-id' ? '42' : null) } : null) };
    assert.equal(real.handOffDownload(mod, link(past), '[1]'), false, 'an expired link is not sent');
    assert.ok(realLogs.some(([l]) => /Link expired before it could be sent/.test(l)));
    assert.equal(real.handOffDownload(mod, link(future), '[1]'), true);
    assert.ok(realLogs.some(([l, level]) => /Vortex must be signed into the same account/.test(l) && level === 'info'));
    assert.equal(document.location.href, link(future));
    real.vortexAccountNoted = null;
    assert.equal(real.handOffDownload(mod, link(future, '7'), '[2]'), true);
    assert.ok(realLogs.some(([l, level]) => /signed for Nexus account #7, but this page is signed in as #42/.test(l) && level === 'error'),
      'a link for another account warns');
    const before = realLogs.length;
    real.handOffDownload(mod, link(future, '7'), '[3]');
    assert.equal(realLogs.filter(([l]) => /account #/.test(l)).length, realLogs.slice(0, before).filter(([l]) => /account #/.test(l)).length,
      'the account is named once per run');
    assert.equal(NexusExt.NDC_HELPERS.pageNexusUserId({ querySelector: (sel) => (/users/.test(sel) ? { getAttribute: () => '/users/123' } : null) }), '123');
    assert.equal(NexusExt.NDC_HELPERS.pageNexusUserId({ querySelector: () => null }), null);
    global.document = savedDocument;
  }

  console.log('Vortex preflight behavior OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
