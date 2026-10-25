const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// 3.1.0 "friendlier" helpers: presets, error actions, Vortex-open memory, run summary, history view.
const store = {};
const chrome = {
  runtime: { lastError: null },
  storage: { local: {
    get: (key, cb) => cb({ [key]: store[key] }),
    set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); cb?.(); }
  } }
};
const ctx = vm.createContext({ console, URL, URLSearchParams, Intl, setTimeout, clearTimeout, setInterval, clearInterval, chrome });
vm.runInContext(fs.readFileSync('src/lib/shared.js', 'utf8'), ctx, { filename: 'src/lib/shared.js' });
const S = ctx.NXTK;
const plain = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  // Item 2: presets.
  assert.equal(S.matchingPreset(S.DEFAULTS), 'vortex', 'defaults are the Vortex preset');
  const browser = S.applyPreset({ ...S.DEFAULTS, DownloadFolder: 'Mods' }, 'browser');
  assert.equal(browser.NDC_downloadMethod, 1);
  assert.equal(browser.AutoCloseTab, false);
  assert.equal(browser.DownloadFolder, 'Mods', 'a preset keeps settings it does not name');
  assert.equal(S.matchingPreset(browser), 'browser');
  assert.equal(S.matchingPreset(S.applyPreset(S.DEFAULTS, 'minimal')), 'minimal');
  assert.equal(S.matchingPreset({ ...browser, AutoCloseTab: true }), null, 'a mix is "Custom"');
  assert.deepEqual(plain(S.applyPreset({ a: 1 }, 'nope')), { a: 1 }, 'an unknown preset changes nothing');
  for (const preset of Object.values(S.SETTING_PRESETS)) {
    for (const key of Object.keys(preset)) {
      assert.ok(key in S.DEFAULTS, `${key} is a real setting`);
      assert.ok(!/pause|speed|throttle|Delay|Timeout/i.test(key), `presets never touch pacing (${key})`);
    }
  }
  for (const key of S.ADVANCED_SETTING_KEYS) assert.ok(key in S.DEFAULTS, `${key} is a real setting`);

  // Item 3: error actions.
  assert.deepEqual([...S.errorActionsFor({ code: 'requires_login' }, { canRetry: true })], ['signIn']);
  assert.deepEqual([...S.errorActionsFor({ code: 'rate_limited', retryAfterSeconds: 90 }, { canRetry: true, method: 'vortex', canSwitchToBrowser: true })], ['retryIn'],
    'a rate limit waits and never offers a switch');
  assert.deepEqual([...S.errorActionsFor({ code: 'no_nmm_link' }, { canRetry: true, filePageUrl: 'https://www.nexusmods.com/x', method: 'vortex', canSwitchToBrowser: true })],
    ['retry', 'openFilePage', 'switchToBrowser']);
  assert.deepEqual([...S.errorActionsFor({ code: 'no_nmm_link' }, { method: 'browser', canSwitchToBrowser: true })], [], 'already on browser downloads');
  assert.equal(S.formatCountdown(65), '1:05');
  assert.equal(S.formatCountdown(0.2), '0:01');
  assert.equal(S.formatCountdown(-3), '0:00');

  // Items 6 and 7: the Vortex-open memory.
  let st = S.vortexOpenNext(null);
  assert.equal(S.shouldAskVortexOpened(st), true, 'asks until Vortex is confirmed');
  st = S.vortexOpenNext(st, 'answeredYes');
  assert.equal(S.shouldAskVortexOpened(st), false, 'a yes is remembered');
  st = S.vortexOpenNext(st, 'notDetected');
  assert.equal(S.shouldAskVortexOpened(st), true, 'asks again after a failure');
  assert.equal(S.shouldOfferBrowserSwitch(st), false);
  st = S.vortexOpenNext(st, 'answeredNo');
  assert.equal(S.shouldOfferBrowserSwitch(st), true, 'two failures in a row offer browser downloads');
  st = S.vortexOpenNext(st, 'opened');
  assert.deepEqual(plain(st), { confirmed: true, failStreak: 0 }, 'a success resets the streak');
  assert.equal(S.shouldOfferBrowserSwitch(await S.recordVortexOpenEvent('notDetected')), false);
  assert.equal(S.shouldOfferBrowserSwitch(await S.recordVortexOpenEvent('notDetected')), true, 'the streak is stored per profile');
  assert.equal((await S.readVortexOpenState()).failStreak, 2);
  assert.equal(S.VORTEX_TEST_LINK, 'nxm://premium');
  assert.match(S.VORTEX_INSTALL_GUIDE_URL, /^https:\/\/www\.nexusmods\.com\//);

  // A Chrome prompt left open longer than 8 s and then cancelled is still "not opened".
  assert.equal(S.PROTOCOL_BLUR_OPENED_MS, 20000);
  {
    const listeners = {}; let focused = false;
    const win = { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener() {} };
    const doc = { visibilityState: 'visible', hasFocus: () => focused, addEventListener() {}, removeEventListener() {} };
    const watch = S.waitForProtocolHandoff({ win, doc, timeoutMs: 50, maxMs: 300, pollMs: 10 });
    setTimeout(() => { focused = true; }, 200); // "10 s" of an open dialog at this scale, still under maxMs
    assert.equal(await watch, false, 'long-open dialog then cancel is not opened');
  }

  // Item 4: summary text.
  const text = S.formatRunSummaryText({
    sent: [{ name: 'A' }],
    skipped: [{ name: 'B', reason: 'already downloaded' }],
    failed: [{ name: 'C', code: 'no_nmm_link', pageUrl: 'https://www.nexusmods.com/g/mods/1?tab=files' }],
    account: '42'
  });
  assert.match(text, /Sent \(1\)\n- A/);
  assert.match(text, /- B \(already downloaded\)/);
  assert.match(text, /- C \(no_nmm_link\) https:\/\/www\.nexusmods\.com/);
  assert.match(text, /Nexus account: #42$/);
  assert.equal(S.formatRunSummaryText({}), '');

  // Item 5: history view numbers.
  const stats = S.summarizeCollectionHistory({ all: [1, 2], vortexSent_all: [2, 3, 4] }, 'all', [1, 2, 3, 4, 5]);
  assert.equal(stats.downloaded, 2);
  assert.equal(stats.sent, 2, 'a downloaded file is not also counted as sent');
  assert.deepEqual([...stats.missing], [3, 4, 5]);
  assert.equal(S.summarizeCollectionHistory(null, 'all', [7]).missing.length, 1);

  // Item 8: no jargon left in English user-facing strings.
  const en = JSON.parse(fs.readFileSync('src/_locales/en/messages.json', 'utf8'));
  for (const [key, entry] of Object.entries(en)) {
    assert.ok(!/\bhand-?off\b|\bNMM\b|\bfallback\b/i.test(entry.message), `${key} still says "${entry.message}"`);
  }

  // The debug log: hand-off lines go out at once, not in the 2 s batch a closing tab would drop.
  const src = fs.readFileSync('src/lib/shared.js', 'utf8');
  assert.match(src, /DEBUG_FLUSH_NOW_PATTERN = \/\^Vortex hand-off\//);
  assert.match(src, /addEventListener\?\.\('pagehide', flushDebugLog\)/);
  const nnw = fs.readFileSync('src/content/nnw.js', 'utf8');
  assert.match(nnw, /no sign Vortex opened[\s\S]{0,200}cancelScheduledTabClose\(\)/, 'a failed hand-off keeps the tab and its hint');

  // Stress: a 2000-item queue: ETA, ordering, summary text and history numbers stay fast.
  {
    const n = 2000;
    const sizes = Array.from({ length: n }, (_, i) => ((i * 7919) % 500000) + 1);
    let clock = 0;
    const t0 = Date.now();
    const eta = S.createQueueEta(sizes, { now: () => clock });
    for (let i = 0; i < n; i += 1) {
      eta.itemStarted(); clock += 1500; eta.itemCompleted(i); clock += 2000;
      if (i % 50 === 0 && typeof eta.remainingSeconds === 'function') eta.remainingSeconds(i + 1);
    }
    const queue = Array.from({ length: n }, (_, i) => ({ fileId: i, file: { size: sizes[i], name: `Mod ${i}` } }));
    if (typeof S.orderQueueBySize === 'function') assert.equal(S.orderQueueBySize(queue, (m) => m.file.size).length, n);
    const summary = {
      sent: queue.slice(0, 1000).map((m) => ({ name: m.file.name })),
      skipped: queue.slice(1000, 1500).map((m) => ({ name: m.file.name, reason: 'already downloaded' })),
      failed: queue.slice(1500).map((m) => ({ name: m.file.name, code: 'no_nmm_link', pageUrl: `https://www.nexusmods.com/g/mods/${m.fileId}?tab=files` })),
      account: '1'
    };
    const text = S.formatRunSummaryText(summary);
    assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, n);
    const ids = queue.map((m) => m.fileId);
    const stats = S.summarizeCollectionHistory({ all: ids.slice(0, 1200), vortexSent_all: ids.slice(800) }, 'all', ids);
    assert.equal(stats.missing.length, 800);
    assert.equal(stats.sent, 800);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `2000-item ETA/summary work took ${elapsed} ms`);
    assert.equal(S.formatEta(3600 * 30).length > 0, true, 'a 30-hour ETA still formats');
  }

  console.log('UX-friendly helpers OK');
})().catch((error) => { console.error(error); process.exit(1); });
