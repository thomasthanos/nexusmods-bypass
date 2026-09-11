const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

new Function(fs.readFileSync('src/response-classifier.js', 'utf8'))();

// These helpers live inside the content-script IIFEs and have no runtime
// consumer outside them, so they are lifted out by source instead of widening
// the public surface just for a test.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found — the test needs updating`);

  // Step over the parameter list first: destructured defaults contain braces.
  let cursor = source.indexOf('(', start);
  let parens = 0;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parens += 1;
    else if (source[cursor] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }

  const open = source.indexOf('{', cursor);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return assert.fail(`${name} is unterminated`);
}

const nnw = fs.readFileSync('src/content/nnw.js', 'utf8');
const ui = fs.readFileSync('src/content/ui.js', 'utf8');

function archivedFilesUrlTests() {
  const location = { href: 'https://www.nexusmods.com/skyrim/mods/1?tab=files' };
  const buildArchivedFilesUrl = new Function('location', 'URL',
    `${extractFunction(nnw, 'buildArchivedFilesUrl')}; return buildArchivedFilesUrl;`)(location, URL);

  assert.equal(
    buildArchivedFilesUrl('https://www.nexusmods.com/skyrim/mods/1?tab=files'),
    'https://www.nexusmods.com/skyrim/mods/1?tab=files&category=archived'
  );
  assert.equal(
    buildArchivedFilesUrl('https://www.nexusmods.com/skyrim/mods/1?tab=files#file-2'),
    'https://www.nexusmods.com/skyrim/mods/1?tab=files&category=archived#file-2',
    'the category must stay in the query even when the page URL carries a fragment'
  );
  assert.equal(
    buildArchivedFilesUrl('https://www.nexusmods.com/skyrim/mods/1?tab=files&category=main'),
    'https://www.nexusmods.com/skyrim/mods/1?tab=files&category=archived',
    'an existing category must be replaced, not appended twice'
  );
  assert.equal(buildArchivedFilesUrl('http://['), '', 'an unparsable URL yields no button');
}

function fakeButton({ id = '', text = '', cardText = '', bound = false }) {
  const button = {
    id,
    textContent: text,
    dataset: bound ? { nxtkSlowBound: '1' } : {},
    closest: () => ({ textContent: cardText })
  };
  return button;
}

// Honour whatever attribute the selector excludes, so the test measures the
// production selector instead of one hard-coded in the mock.
function fakeRoot(buttons) {
  return {
    querySelectorAll: (selector) => {
      const excluded = /:not\(\[([a-z-]+)\]\)/.exec(selector)?.[1];
      if (!excluded) return buttons;
      const key = excluded.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return buttons.filter((button) => button.dataset[key] !== '1');
    }
  };
}

function slowDownloadButtonTests() {
  const source = `${extractFunction(nnw, 'normalizeText')}
${extractFunction(nnw, 'findSlowDownloadButtons')}
return findSlowDownloadButtons;`;
  const findSlowDownloadButtons = new Function('String', 'Array', source)(String, Array);

  const button = fakeButton({ id: 'slowDownloadButton', text: 'Please wait 5' });
  const root = fakeRoot([button]);

  assert.deepEqual(findSlowDownloadButtons(root), [], 'a countdown label is not a download button');

  // Nexus re-labels the same element once the wait is over.
  button.textContent = 'Slow download';
  assert.deepEqual(
    findSlowDownloadButtons(root),
    [button],
    'a button that becomes "Slow download" later must still be picked up'
  );

  button.dataset.nxtkSlowBound = '1';
  assert.deepEqual(findSlowDownloadButtons(root), [], 'an already bound button is not returned twice');
  assert.deepEqual(
    findSlowDownloadButtons(root, { includeBound: true }),
    [button],
    'the fallback lookup still sees bound buttons'
  );

  const unrelated = fakeButton({ text: 'Slow download', cardText: 'unrelated card' });
  assert.deepEqual(
    findSlowDownloadButtons(fakeRoot([unrelated])),
    [],
    'a "Slow download" label outside a throttled-download card is ignored'
  );
}

function dominantGameDomainTests() {
  const dominantGameDomain = new Function('String', 'Map', 'Array',
    `${extractFunction(ui, 'dominantGameDomain')}; return dominantGameDomain;`)(String, Map, Array);

  const mod = (domainName) => ({ file: { mod: { game: { domainName } } } });

  assert.equal(dominantGameDomain([]), '', 'an empty list has no game');
  assert.equal(dominantGameDomain([mod('skyrimspecialedition')]), 'skyrimspecialedition');
  assert.equal(
    dominantGameDomain([mod('site'), mod('skyrimspecialedition'), mod('skyrimspecialedition')]),
    'skyrimspecialedition',
    'the game with the most files wins, whatever the manifest order'
  );
  assert.equal(
    dominantGameDomain([mod('skyrimspecialedition'), mod('skyrimspecialedition'), mod('site')]),
    'skyrimspecialedition',
    'reordering the same modlist must not move the history bucket'
  );
  assert.equal(
    dominantGameDomain([mod('starfield'), mod('fallout4')]),
    'fallout4',
    'a tie resolves alphabetically so the bucket stays stable'
  );
  assert.equal(dominantGameDomain([mod(''), mod('valheim')]), 'valheim', 'blank domains are skipped');
}

function extractConstExpression(source, name) {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  assert.ok(match, `${name} was not found — the test needs updating`);
  return match[1];
}

function nativePassthroughTests() {
  const api = new Function(`
    const NATIVE_PASSTHROUGH_TTL_MS = ${extractConstExpression(nnw, 'NATIVE_PASSTHROUGH_TTL_MS')};
    const MAX_NATIVE_PASSTHROUGH_FILES = ${extractConstExpression(nnw, 'MAX_NATIVE_PASSTHROUGH_FILES')};
    const nativePassthroughFiles = new Map();
    ${extractFunction(nnw, 'allowNativeDownload')}
    ${extractFunction(nnw, 'shouldPassThroughToNative')}
    ${extractFunction(nnw, 'clearNativeDownloadPassthrough')}
    return {
      allowNativeDownload,
      shouldPassThroughToNative,
      clearNativeDownloadPassthrough,
      store: nativePassthroughFiles,
      ttl: NATIVE_PASSTHROUGH_TTL_MS,
      cap: MAX_NATIVE_PASSTHROUGH_FILES
    };
  `)();

  assert.ok(api.ttl > 0 && api.ttl <= 15 * 60 * 1000, 'the hand-back window is short-lived');
  assert.equal(api.shouldPassThroughToNative('42'), false, 'nothing is handed back by default');

  api.allowNativeDownload('42');
  assert.equal(api.shouldPassThroughToNative('42'), true, 'the failed file is handed back');
  assert.equal(api.shouldPassThroughToNative(42), true, 'numeric and string IDs are the same file');
  assert.equal(api.shouldPassThroughToNative('43'), false, 'other files are unaffected');

  api.allowNativeDownload('');
  assert.equal(api.store.size, 1, 'a missing file ID is not stored');

  // An expired entry must let the extension try again: whatever blocked the
  // download (a sign-in, a moderation hold) can be resolved while the page lives.
  api.store.set('42', Date.now() - 1);
  assert.equal(api.shouldPassThroughToNative('42'), false, 'the hand-back expires');
  assert.equal(api.store.has('42'), false, 'the expired entry is dropped');

  for (let index = 0; index < api.cap + 6; index += 1) api.allowNativeDownload(String(1000 + index));
  assert.equal(api.store.size, api.cap, 'the set cannot grow without bound');
  assert.equal(api.shouldPassThroughToNative('1000'), false, 'the oldest entries are evicted');
  assert.equal(api.shouldPassThroughToNative(String(1000 + api.cap + 5)), true, 'the newest is kept');

  api.clearNativeDownloadPassthrough();
  assert.equal(api.store.size, 0, 'navigating away clears every hand-back');
}

function importFileFilterTests() {
  const api = new Function('Array', 'RegExp', `
    const IMPORT_FILE_EXTENSIONS = ${extractConstExpression(ui, 'IMPORT_FILE_EXTENSIONS')};
    const IMPORT_FILE_ACCEPT = ${extractConstExpression(ui, 'IMPORT_FILE_ACCEPT')};
    const IMPORT_FILE_PATTERN = ${extractConstExpression(ui, 'IMPORT_FILE_PATTERN')};
    ${extractFunction(ui, 'collectImportFileNames')}
    return { collectImportFileNames, IMPORT_FILE_ACCEPT, IMPORT_FILE_EXTENSIONS };
  `)(Array, RegExp);

  const accept = api.IMPORT_FILE_ACCEPT.split(',');
  assert.ok(accept.every((entry) => /^\.[a-z0-9]+$/.test(entry)), 'every accept entry is an extension');
  for (const extension of ['.zip', '.7z', '.rar']) {
    assert.ok(accept.includes(extension), `${extension} must be offered — Nexus serves it`);
  }
  assert.ok(!accept.includes('.meta'), 'a mod manager sidecar is not a download');

  const picked = api.collectImportFileNames([
    { name: 'Cool Mod-266-1-0.zip' },
    { name: 'Cool Mod-266-1-0.zip.meta' },
    { name: 'Other Mod-1-2.7z' },
    { name: 'Third Mod.RAR' },
    { name: 'Split Mod.part1.001' },
    { name: 'installer.exe' },
    { name: 'readme.txt' },
    { name: 'screenshot.png' },
    { name: 'no-extension' }
  ]);
  assert.deepEqual(
    picked.names,
    ['Cool Mod-266-1-0.zip', 'Other Mod-1-2.7z', 'Third Mod.RAR', 'Split Mod.part1.001', 'installer.exe'],
    'only mod files are handed to the matcher, whatever the case'
  );
  assert.equal(picked.skipped, 4, 'everything else is counted so the user can be told');

  assert.deepEqual(api.collectImportFileNames([]), { names: [], skipped: 0 });
  assert.deepEqual(api.collectImportFileNames(undefined), { names: [], skipped: 0 });
  assert.deepEqual(
    api.collectImportFileNames([{ name: 'a.meta' }, { name: 'b.json' }]),
    { names: [], skipped: 2 },
    'a folder of sidecars imports nothing instead of matching nothing'
  );
}

function skippedArchiveLogTests() {
  const logSkippedArchives = new Function('NXTK', 'String', 'Map', 'Set', 'Array', 'RegExp',
    `const SKIPPED_NAMES_SHOWN = ${extractConstExpression(ui, 'SKIPPED_NAMES_SHOWN')};
     ${extractFunction(ui, 'skippedBucket')}
     ${extractFunction(ui, 'logSkippedArchives')}
     return logSkippedArchives;`)(
    { t: (_key, _subs, fallback) => fallback }, String, Map, Set, Array, RegExp
  );

  const lines = [];
  const ndc = { ui: { logText: (text, type) => lines.push(`${type}|${text}`) } };

  logSkippedArchives(ndc, []);
  assert.deepEqual(lines, [], 'nothing to say when nothing was skipped');

  logSkippedArchives(ndc, [
    ...Array.from({ length: 129 }, (_, index) => ({ name: `Data_File${index}.esm`, reason: 'not-on-nexus:GameFileSource' })),
    { name: 'Mod.Organizer-2.5.2.7z', reason: 'not-on-nexus:Http' },
    { name: 'Synthesis.zip', reason: 'not-on-nexus:GitHub' },
    { name: 'AskMe.7z', reason: 'not-on-nexus:Manual' },
    { name: 'Broken.7z', reason: 'unknown-game:SomeGame' }
  ]);

  assert.equal(lines.length, 5, `a heading and one line per group (got ${lines.length})`);
  assert.match(lines[0], /^info\|Not queued here/);
  assert.match(lines[1], /^info\|· 129 come from your game install/, 'game files are named as such');
  assert.doesNotMatch(lines[1], /Data_File/, 'no point listing files nobody has to fetch');
  assert.match(lines[2], /^info\|· 2 are hosted on other sites/, 'http and github count together');
  assert.match(lines[3], /^info\|· 1 will have to be downloaded by hand.*AskMe\.7z/, 'manual work is spelled out');
  assert.match(lines[4], /^error\|· 1 could not be read by this version/, 'our own failure stands out');
  assert.match(lines[4], /unknown-game:SomeGame/, 'and keeps the detail needed to report it');

  lines.length = 0;
  logSkippedArchives(ndc, Array.from({ length: 20 }, (_, index) => ({
    name: `Manual${index}.7z`,
    reason: 'not-on-nexus:Manual'
  })));
  assert.match(lines[1], /… \+14$/, 'long name lists are capped and the remainder counted');

  for (const [reason, bucket] of [
    ['not-on-nexus:GameFileSource', 'game'],
    ['not-on-nexus:Manual', 'manual'],
    ['not-on-nexus:Http', 'other'],
    ['not-on-nexus', 'other'],
    ['unknown-game:X', 'unreadable'],
    ['incomplete-entry', 'unreadable'],
    ['duplicate-entry', 'unreadable']
  ]) {
    lines.length = 0;
    logSkippedArchives(ndc, [{ name: 'x.7z', reason }]);
    const expected = { game: /game install/, manual: /by hand/, other: /other sites/, unreadable: /could not be read/ };
    assert.match(lines[1], expected[bucket], `${reason} belongs in the ${bucket} group`);
  }
}

function errorDialogTests() {
  // Verbose console output is no longer a switch a reader has to find and flip:
  // the report carries its own trail, and the console stays quiet while things work.
  assert.doesNotMatch(ui, /key: 'DebugLogs'/, 'the settings dialog no longer offers the log switch');
  const nnw = fs.readFileSync('src/content/nnw.js', 'utf8');
  assert.match(nnw, /info: \(\.\.\.args\) => \{ NXTK\.noteActivity\?\.\('info', args\); if \(cfg\.DebugLogs\)/, 'info is recorded but not printed');
  assert.match(nnw, /warn: \(\.\.\.args\) => \{ NXTK\.noteActivity\?\.\('warn', args\); emitLog/, 'warn is recorded and printed');
  assert.match(nnw, /debug: \(\.\.\.args\) => \{ if \(cfg\.DebugLogs\)/, 'debug stays behind the flag');
  const shared = fs.readFileSync('src/shared.js', 'utf8');
  assert.match(shared, /DebugLogs: false/, 'the stored setting stays so nothing needs migrating');
  // A rate limit, a sign-in and a Cloudflare check are Nexus asking for something,
  // not faults to file. Offering "Report a bug" for them fills the tracker.
  const footer = ui.slice(ui.indexOf('nxtk-error-footer'), ui.indexOf('nxtk-error-footer') + 900);
  assert.match(footer, /normalized\.blocking/, 'the footer must branch on the blocking flag');
  assert.match(footer, /dlgWhatDoesThisMean/, 'blocking errors get an explanation link');
  assert.match(footer, /TROUBLESHOOTING_URL/, 'pointing at the troubleshooting section');
  assert.match(footer, /data-report/, 'real failures still offer the reporter');

  const blocking = ['requires_login', 'cloudflare', 'rate_limited', 'account_suspended'];
  const errors = fs.readFileSync('src/content/errors.js', 'utf8');
  for (const code of blocking) {
    const at = errors.indexOf(`    ${code}: {`);
    assert.notEqual(at, -1, `${code} must exist`);
    const block = errors.slice(at, errors.indexOf('\n    },', at));
    assert.match(block, /blocking: true/, `${code} must stay flagged as blocking`);
  }
  for (const code of ['no_download_url', 'unsafe_download_url', 'request_failed', 'invalid_response']) {
    const at = errors.indexOf(`    ${code}: {`);
    const block = errors.slice(at, errors.indexOf('\n    },', at));
    assert.doesNotMatch(block, /blocking: true/, `${code} is a real failure and keeps the reporter`);
  }
}

// The Nexus ad timer is bypassed with a cookie, and a cookie is the one thing a
// service worker cannot write. A background collection run therefore depends on this
// tab refreshing it, so both the writer and the refresher are pinned down here.
function adTimerCookieBehaviour() {
  const nnw = fs.readFileSync('src/content/nnw.js', 'utf8');
  const body = extractFunction(nnw, 'refreshAdTimerCookie');

  const build = ({ hostname = 'www.nexusmods.com', hideAds = true } = {}) => {
    const written = [];
    let now = 1700000000000;
    const DateShim = function (value) {
      return new Date(value === undefined ? now : value);
    };
    DateShim.now = () => now;
    const factory = new Function('written', 'hostname', 'hideAds', 'DateShim', `
      const AD_TIMER_WINDOW_MS = 5 * 60 * 1000;
      const AD_TIMER_REFRESH_MS = 60 * 1000;
      let adTimerWrittenAt = 0;
      const cfg = { HidePremiumUpsells: hideAds };
      const location = { hostname };
      const document = { set cookie(value) { written.push(value); } };
      const Date = DateShim;
      ${body}
      return refreshAdTimerCookie;
    `);
    return {
      written,
      run: factory(written, hostname, hideAds, DateShim),
      advance: (ms) => { now += ms; }
    };
  };

  const off = build({ hideAds: false });
  off.run();
  assert.deepStrictEqual(off.written, [], 'with the ads setting off, no cookie is written');

  const foreign = build({ hostname: 'example.com' });
  foreign.run();
  assert.deepStrictEqual(foreign.written, [], 'the cookie is never written off Nexus');

  const nexus = build();
  nexus.run();
  assert.equal(nexus.written.length, 1, 'a Nexus page writes the cookie');
  assert.match(nexus.written[0], /^ab=0\|\d+;/, 'as ab=0 plus an elapsed stamp');
  assert.match(nexus.written[0], /domain=nexusmods\.com/);
  assert.match(nexus.written[0], /Secure/, 'and it is not sent in the clear');

  nexus.run();
  assert.equal(nexus.written.length, 1, 'repeat calls inside a minute are ignored');
  nexus.advance(30000);
  nexus.run();
  assert.equal(nexus.written.length, 1, 'still ignored half a minute in');
  nexus.advance(31000);
  nexus.run();
  assert.equal(nexus.written.length, 2, 'and refreshed once the minute is up');

  // The five minute life is shorter than a collection run, so the watchdog that polls
  // the background queue has to keep it alive or the rest of the run goes unprotected.
  const ndc = fs.readFileSync('src/content/ndc.js', 'utf8');
  assert.match(
    ndc,
    /const runWatchdog = \(\) => \{\s*NexusExt\.NNW\?\.refreshAdTimerCookie\?\.\(\);/,
    'the queue watchdog refreshes the cookie on every tick'
  );
  const upFront = ndc.indexOf("NexusExt.NNW?.refreshAdTimerCookie?.();\n        watchdogTimer");
  assert.notEqual(upFront, -1, 'and once up front, before the interval is armed');
  assert.ok(upFront < ndc.indexOf('Promise.resolve(start())'), 'which must precede the start command');
}

// An archive that has to be extracted is the user's next step, not a fault, so it must not
// arrive wrapped in the failure wording that invites a bug report.
function needsExtractingIsNotAFailure() {
  const ui = fs.readFileSync('src/content/ui.js', 'utf8');
  const at = ui.indexOf("if (cause?.code === 'needs-extracting')");
  assert.notEqual(at, -1, 'the dialog separates it from a read failure');

  const block = ui.slice(at, at + 460);
  assert.match(block, /wjImportNeedsExtracting/, 'and uses its own string');
  assert.doesNotMatch(block.slice(0, block.indexOf('return;')), /wjImportFailed/,
    'never the "could not read this modlist" wording');
  assert.match(block, /return;/, 'and stops there rather than falling through');

  const catalogues = fs.readdirSync('src/_locales');
  for (const locale of catalogues) {
    const messages = JSON.parse(fs.readFileSync(`src/_locales/${locale}/messages.json`, 'utf8'));
    const entry = messages.wjImportNeedsExtracting;
    assert.ok(entry?.message, `${locale} carries the string`);
    assert.match(entry.message, /\$1/, `${locale} keeps the format placeholder`);
    assert.match(entry.message, /\.wabbajack/, `${locale} still names the file to pick`);
  }

  const importer = fs.readFileSync('src/content/wabbajack-importer.js', 'utf8');
  assert.match(importer, /error\.format = unreadable;/, 'the format is attached for the dialog');
}

// The remaining-time figure is the one number in the deck a user will plan around, so it
// has to come from measurement and say nothing at all until there is something to measure.
function queueEtaBehaviour() {
  const ndc = fs.readFileSync('src/content/ndc.js', 'utf8');
  const body = extractFunction(ndc, 'createQueueEta');

  const build = (sizesKb) => {
    let now = 0;
    const DateShim = function (value) { return new Date(value === undefined ? now : value); };
    DateShim.now = () => now;
    const factory = new Function('sizes', 'DateShim', `
      const Date = DateShim;
      ${body}
      return createQueueEta(sizes);
    `);
    return { eta: factory(sizesKb, DateShim), at: (ms) => { now = ms; } };
  };

  const TEN_MB_KB = 10 * 1024;

  const nothingYet = build([TEN_MB_KB, TEN_MB_KB, TEN_MB_KB]);
  assert.equal(nothingYet.eta.remainingSeconds(0, 3), 0, 'no estimate before a file has finished');
  nothingYet.at(0);
  nothingYet.eta.itemStarted();
  assert.equal(nothingYet.eta.remainingSeconds(0, 3), 0, 'and none while the first file is still running');

  // 10 MB in 5 s is 2 MB/s, so the two files left are ten seconds of transfer.
  const run = build([TEN_MB_KB, TEN_MB_KB, TEN_MB_KB]);
  run.at(0);
  run.eta.itemStarted();
  run.at(5000);
  run.eta.itemCompleted(0);
  assert.equal(Math.round(run.eta.remainingSeconds(1, 3)), 10, 'measured throughput drives the estimate');

  // A second file, started a second after the first finished: that gap is the link
  // resolve, and it is charged to every file still to come.
  run.at(6000);
  run.eta.itemStarted();
  run.at(11000);
  run.eta.itemCompleted(1);
  assert.equal(Math.round(run.eta.remainingSeconds(2, 3)), 6,
    'five seconds of transfer plus the one second gap the queue really spends');

  // A pause makes the sample meaningless, so it is dropped rather than averaged in.
  run.at(12000);
  run.eta.itemStarted();
  run.eta.spoil();
  run.at(300000);
  run.eta.itemCompleted(2);
  assert.equal(Math.round(run.eta.remainingSeconds(2, 3)), 6,
    'a paused file does not drag the average down');

  // A file the collection page gave no size for is charged the average of the known ones.
  const mixed = build([TEN_MB_KB, 0, TEN_MB_KB]);
  mixed.at(0);
  mixed.eta.itemStarted();
  mixed.at(5000);
  mixed.eta.itemCompleted(0);
  assert.equal(Math.round(mixed.eta.remainingSeconds(1, 3)), 10,
    'an unknown size counts as an average one rather than as nothing');

  const noSizes = build([0, 0, 0]);
  noSizes.at(0);
  noSizes.eta.itemStarted();
  noSizes.at(5000);
  noSizes.eta.itemCompleted(0);
  assert.equal(noSizes.eta.remainingSeconds(1, 3), 0,
    'with no size anywhere there is nothing to claim');

  const ui = fs.readFileSync('src/content/ui.js', 'utf8');
  const setter = ui.slice(ui.indexOf('ui.setTimeLeft = (seconds)'));
  assert.match(setter.slice(0, 420), /row\.hidden = true;/, 'zero hides the row instead of showing 0s');
  assert.match(setter.slice(0, 620), /deckTimeLeft/, 'and the text is translated');
  assert.match(ui, /ui\.endDownload = \(outcome = 'finished'\) => \{\s*ui\.setTimeLeft\?\.\(0\);/,
    'a finished run stops claiming a remaining time');

  for (const locale of fs.readdirSync('src/_locales')) {
    const messages = JSON.parse(fs.readFileSync(`src/_locales/${locale}/messages.json`, 'utf8'));
    assert.match(messages.deckTimeLeft?.message || '', /\$1/, `${locale} keeps the duration placeholder`);
  }
}

// A rating can only be left on the listing a copy was installed from. Each store issues
// its own extension id, so the id decides — not the browser, which was the old guess and
// sent every Edge user to the Edge listing even when their copy came from Chrome's.
function storeListingBehaviour() {
  const shared = fs.readFileSync('src/shared.js', 'utf8');
  const body = extractFunction(shared, 'getStoreListing');
  const listings = extractConstExpression(shared, 'STORE_LISTINGS');

  const resolve = ({ id, gecko = false, ua = '' }) => {
    const factory = new Function('id', 'gecko', 'userAgent', `
      const STORE_LISTINGS = ${listings};
      const chrome = {
        runtime: {
          id,
          getManifest: () => (gecko ? { browser_specific_settings: { gecko: { id: 'x' } } } : {})
        }
      };
      const navigator = { userAgent };
      ${body}
      return getStoreListing();
    `);
    return factory(id, gecko, ua);
  };

  const chromeId = 'chfghiknjhpcncpcjopglefnckckdlpj';
  const edgeId = 'hcjpcnajmkanhodhpkoinodjbkeolgaa';

  const onChrome = resolve({ id: chromeId });
  assert.equal(onChrome.name, 'Chrome Web Store');
  assert.match(onChrome.reviewUrl, /^https:\/\/chromewebstore\.google\.com\//);

  // The whole point: an Edge browser running a Chrome Web Store copy is sent to Chrome.
  const chromeCopyInEdge = resolve({ id: chromeId, ua: 'Mozilla/5.0 Chrome/140 Edg/140' });
  assert.equal(chromeCopyInEdge.name, 'Chrome Web Store',
    'the browser does not override where the copy came from');

  const onEdge = resolve({ id: edgeId, ua: 'Mozilla/5.0 Chrome/140 Edg/140' });
  assert.equal(onEdge.name, 'Edge Add-ons');
  assert.match(onEdge.reviewUrl, /^https:\/\/microsoftedge\.microsoft\.com\//);

  // And an Edge Add-ons copy running in plain Chrome still belongs to Edge.
  assert.equal(resolve({ id: edgeId, ua: 'Mozilla/5.0 Chrome/140' }).name, 'Edge Add-ons');

  const firefox = resolve({ id: 'anything', gecko: true });
  assert.equal(firefox.name, 'Firefox Add-ons');
  assert.match(firefox.reviewUrl, /^https:\/\/addons\.mozilla\.org\//);

  // An unpacked copy has an id of its own; the primary listing is the sane default.
  assert.equal(resolve({ id: 'abcdefghijklmnopabcdefghijklmnop' }).name, 'Chrome Web Store');
  assert.equal(resolve({ id: '', ua: 'Mozilla/5.0 Edg/140' }).name, 'Chrome Web Store',
    'a missing id never matches a listing by accident');

  // The ids in the review links must be the ids being matched, or the match is decorative.
  for (const [key, storeId] of [['chromewebstore', chromeId], ['microsoftedge', edgeId]]) {
    const listing = Object.values(JSON.parse(JSON.stringify(
      new Function(`return ${listings};`)()
    ))).find((entry) => entry.reviewUrl.includes(key));
    assert.equal(listing.id, storeId, `${key}: the matched id is the one in its own url`);
    assert.ok(listing.reviewUrl.includes(storeId), `${key}: url and id agree`);
  }

  assert.doesNotMatch(body, /navigator|userAgent|Edg/,
    'no user-agent sniffing is left in the decision');

  const ui = fs.readFileSync('src/content/ui.js', 'utf8');
  const popup = fs.readFileSync('src/popup/popup.js', 'utf8');
  for (const [label, source] of [['deck', ui], ['popup', popup]]) {
    assert.match(source, /getStoreListing/, `${label}: uses the resolved listing`);
    assert.match(source, /ratingCta/, `${label}: names the store in the link`);
    assert.match(source, /aria-hidden/, `${label}: the stars are decoration, not a control`);
  }

  for (const locale of fs.readdirSync('src/_locales')) {
    const messages = JSON.parse(fs.readFileSync(`src/_locales/${locale}/messages.json`, 'utf8'));
    assert.match(messages.ratingCta?.message || '', /\$1/, `${locale} keeps the store placeholder`);
  }
}

// The phrases that mean "this mod is gone" are read from the whole page, description and
// changelog included. An author writing about some other mod being pulled must not get their
// own live mod refused, and a mod that really is gone must still be recognised.
function modUnavailableTests() {
  const errors = fs.readFileSync('src/content/errors.js', 'utf8');
  const classify = extractFunction(errors, 'classifyContent');

  const run = (html) => {
    const factory = new Function('html', `
      const create = (code, extra) => ({ code, ...extra });
      const isLiveDocumentSignedIn = () => false;
      const MAX_CLASSIFY_CHARS = 200000;
      const safeUrl = (u) => String(u || '');
      ${classify}
      return classifyContent(html, { status: 200 });
    `);
    return factory(html);
  };

  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  const fileControl = '<a data-download-url="https://premium-files.nexus-cdn.com/x.zip">Download</a>';

  // A live file page whose description talks about another mod being pulled.
  for (const description of [
    'The original version of this mod has been removed by its author, so I reuploaded it here.',
    'Note: this file has been removed from the old page, grab it here instead.',
    'this mod is archived, use the new one linked below',
    'This mod has hidden requirements — read the description before installing.',
    'the predecessor mod is no longer available anywhere'
  ]) {
    const page = `<html><body>${signedIn}<div class="mod-description">${description}</div>${fileControl}</body></html>`;
    const verdict = run(page);
    assert.notEqual(verdict?.code, 'mod_unavailable',
      `a live page offering a file is not refused for: ${description.slice(0, 48)}`);
  }

  // The real thing: the phrase, and no download control anywhere.
  for (const phrase of [
    'This mod has been set to hidden',
    'The author has hidden this mod',
    'This mod has been removed',
    'This file has been removed'
  ]) {
    const page = `<html><body>${signedIn}<h1>Not available</h1><p>${phrase}</p></body></html>`;
    const verdict = run(page);
    assert.equal(verdict?.code, 'mod_unavailable', `still recognised: ${phrase}`);
    assert.match(verdict.technicalMessage, /hidden\/removed mod page markup: "/,
      'and the report names which phrase matched');
  }

  // Which phrase it was has to reach the report, or the next case is guesswork again.
  const named = run(`<html><body>${signedIn}<p>this mod has been set to hidden</p></body></html>`);
  assert.match(named.technicalMessage, /this mod has been set to hidden/, 'the phrase is quoted');

  // Each corroborating marker on its own is enough to keep a live page.
  for (const marker of [
    '<a data-download-url="https://x/y.zip">go</a>',
    '<input id="dl_link" value="https://x/y.zip">',
    "<input id='dl_link' value='https://x/y.zip'>",
    '<a href="/file?nmm=1">vortex</a>'
  ]) {
    const page = `<html><body>${signedIn}<p>this mod has been removed</p>${marker}</body></html>`;
    assert.notEqual(run(page)?.code, 'mod_unavailable', `kept live by: ${marker.slice(0, 40)}`);
  }

  const sharedClassifier = globalThis.NXTKResponseClassifier.classify;
  assert.equal(sharedClassifier({ text: '<p>This mod has been removed</p>' })?.code,
    'mod_unavailable', 'shared classifier: refuses a gone mod');
  assert.equal(sharedClassifier({ text: '<p>This mod has been removed</p><a data-download-url="x">d</a>' }),
    null, 'shared classifier: keeps a page that still offers a file');
}

// These three verdicts stop the queue and tell the reader their account or their connection is
// the problem, so a phrase in a mod description must never be enough to reach them.
function blockingVerdictTests() {
  const errors = fs.readFileSync('src/content/errors.js', 'utf8');
  const classify = extractFunction(errors, 'classifyContent');
  const run = (html) => new Function('html', `
    const create = (code, extra) => ({ code, ...extra });
    const isLiveDocumentSignedIn = () => false;
    const MAX_CLASSIFY_CHARS = 200000;
    const safeUrl = (u) => String(u || '');
    ${classify}
    return classifyContent(html, { status: 200 });
  `)(html);

  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  const fileControl = '<a data-download-url="https://premium-files.nexus-cdn.com/x.zip">Download</a>';

  // Ordinary description text on a working page.
  const innocent = [
    ['just a moment', 'Wait just a moment for the plugin to initialise.'],
    ['temporarily suspended', 'Updates are temporarily suspended while I rebuild the meshes.'],
    ['too many requests', 'The old mirror died from too many requests, so use this one.']
  ];
  for (const [phrase, description] of innocent) {
    const page = `<html><body>${signedIn}<div class="mod-description">${description}</div>${fileControl}</body></html>`;
    const verdict = run(page);
    assert.equal(verdict, null, `"${phrase}" in a description does not stop the queue`);
  }

  // The same phrase where there is no Nexus page around it.
  assert.equal(run('<html><head><title>Just a moment...</title></head><body></body></html>')?.code,
    'cloudflare', 'a bare challenge page is still caught');
  assert.equal(run('<html><body><h1>Account temporarily suspended</h1></body></html>')?.code,
    'account_suspended', 'a real suspension notice is still caught');
  assert.equal(run('<html><body><p>Too many requests</p></body></html>')?.code,
    'rate_limited', 'a real rate-limit notice is still caught');

  // The markers that cannot occur in ordinary page text are still trusted on their own, even
  // on a page that otherwise looks normal — a challenge can be injected into anything.
  for (const marker of [
    '<div id="challenge-form"></div>',
    '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    '<div class="cf-chl-interstitial"></div>',
    '<!-- cf-mitigated -->',
    '<div>cf_chl_opt</div>',
    '<title>Attention Required! | Cloudflare</title>'
  ]) {
    const page = `<html><body>${signedIn}${fileControl}${marker}</body></html>`;
    assert.equal(run(page)?.code, 'cloudflare', `strong marker still fires: ${marker.slice(0, 42)}`);
  }

  // A page that offers the file cannot simultaneously be a refusal.
  for (const [phrase, code] of [['temporarily suspended', 'account_suspended'], ['too many requests', 'rate_limited']]) {
    const page = `<html><body><p>${phrase}</p>${fileControl}</body></html>`;
    assert.notEqual(run(page)?.code, code, `"${phrase}" beside a download control is not ${code}`);
  }

}

// Page requests and service-worker requests must attach the same meaning to the same Nexus
// response. Both real wrappers are exercised so a future copy/paste classifier cannot drift.
function classifierParityTests() {
  const errors = fs.readFileSync('src/content/errors.js', 'utf8');
  const background = fs.readFileSync('src/background.js', 'utf8');
  const contentClassify = extractFunction(errors, 'classifyContent');
  const workerClassify = extractFunction(background, 'classifyNexusResponse');

  const runContent = new Function('text', 'options', `
    const create = (code, extra) => ({ code, ...extra });
    const isLiveDocumentSignedIn = () => options.liveSignedIn === true;
    ${contentClassify}
    return classifyContent(text, options);
  `);
  const runWorker = new Function('response', 'text', 'RESPONSE_CLASSIFIER', `
    ${workerClassify}
    return classifyNexusResponse(response, text);
  `);
  const shared = globalThis.NXTKResponseClassifier;

  const cases = [
    ['API login response', '{"code":"unauthenticated"}', {}, 'requires_login'],
    ['GraphQL login error', '{"errors":[{"message":"Sign in","extensions":{"code":"UNAUTHENTICATED"}}]}',
      { contentType: 'application/json' }, 'requires_login'],
    ['GraphQL unavailable-mod error', '{"errors":[{"message":"This mod has been removed"}]}',
      { contentType: 'application/graphql-response+json' }, 'mod_unavailable'],
    ['successful GraphQL user prose', '{"data":{"collection":{"description":"Just a moment: too many requests; temporarily suspended; this mod has been removed"}}}',
      { contentType: 'application/json; charset=utf-8' }, null],
    ['login button', '<button>Sign in</button>', {}, 'requires_login'],
    ['login button beside file offer', '<button>Sign in</button><a data-download-url="x">Download</a>', {}, null],
    ['login link on signed-in page', '<a>Sign in</a><a href="/auth/sign_out">Log out</a>', {}, null],
    ['login redirect wins over signed-in markup', '<a href="/auth/sign_out">Log out</a>',
      { finalUrl: 'https://users.nexusmods.com/auth/sign_in' }, 'requires_login'],
    ['Cf-Mitigated header', '<html></html>', { cfMitigated: 'challenge' }, 'cloudflare'],
    ['strong Cloudflare marker', '<div id="challenge-form"></div>', {}, 'cloudflare'],
    ['bare attention wording', '<h1>Attention required!</h1>', {}, null],
    ['Cloudflare title', '<title>Attention Required! | Cloudflare</title>', {}, 'cloudflare'],
    ['bare challenge page', '<title>Just a moment...</title>', {}, 'cloudflare'],
    ['mislabelled JSON challenge page', '<title>Just a moment...</title>', { contentType: 'application/json' }, 'cloudflare'],
    ['challenge prose on live page', '<a href="/auth/sign_out">Log out</a><a data-download-url="x">Download</a><p>Just a moment</p>', {}, null],
    ['removed mod', '<p>This mod has been removed</p>', {}, 'mod_unavailable'],
    ['removed prose beside encoded file offer', '<p>This mod has been removed</p><a href="/file?x=1&amp;nmm=1">Download</a>', {}, null],
    ['account suspension', '<h1>Account temporarily suspended</h1>', {}, 'account_suspended'],
    ['account suspension inside signed-in shell', '<a href="/auth/sign_out">Log out</a><h1>Your account has been temporarily suspended</h1>', {}, 'account_suspended'],
    ['rate limit', '<p>Too many requests</p>', {}, 'rate_limited'],
    ['account-scoped rate limit', '<p>Too many requests from your account</p>', {}, 'rate_limited'],
    ['account suspension inside file shell', '<a data-download-url="x">Download</a><p>Your account has been temporarily suspended</p>', {}, null],
    ['account-scoped rate limit inside file shell', '<a data-download-url="x">Download</a><p>Too many requests from your account</p>', {}, null],
    ['rate-limit prose on live page', '<a href="/auth/sign_out">Log out</a><a id="dl_link">Download</a><p>Too many requests</p>', {}, null],
    ['ordinary response', '<html><body>Skyrim Special Edition</body></html>', {}, null]
  ];
  cases.push([
    'large successful GraphQL user prose',
    JSON.stringify({
      data: {
        padding: 'x'.repeat(shared.MAX_CLASSIFY_CHARS + 1000),
        description: 'Your account has been temporarily suspended; just a moment; this mod has been removed'
      }
    }),
    { contentType: 'application/json' },
    null
  ]);

  for (const [label, body, options, expected] of cases) {
    const input = {
      text: body,
      finalUrl: options.finalUrl || '',
      cfMitigated: options.cfMitigated || '',
      contentType: options.contentType || '',
      liveSignedIn: false
    };
    const contentCode = runContent(body, { status: 200, ...options })?.code || null;
    const workerCode = runWorker({
      url: input.finalUrl,
      cfMitigated: input.cfMitigated,
      contentType: input.contentType
    }, body, shared)?.code || null;
    const sharedCode = shared.classify(input)?.code || null;

    assert.equal(contentCode, expected, `${label}: content verdict`);
    assert.equal(workerCode, expected, `${label}: worker verdict`);
    assert.equal(sharedCode, expected, `${label}: shared verdict`);
  }

  assert.equal(runContent('<button>Sign in</button>', { status: 200, liveSignedIn: true }), null,
    'a content script with live signed-in session evidence ignores page login prose');
  assert.equal(runContent('{"code":"unauthenticated"}', { status: 200, liveSignedIn: true })?.code,
    'requires_login', 'an explicit API authentication failure overrides stale signed-in page UI');
}

async function requestClassifierForwardingTests() {
  const responseClassifier = fs.readFileSync('src/response-classifier.js', 'utf8');
  const errorsSource = fs.readFileSync('src/content/errors.js', 'utf8');

  const requestWith = async ({ body = '<html></html>', finalUrl = 'https://www.nexusmods.com/', headers = {} }) => {
    const runtime = vm.createContext({
      console,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      window: { NexusExt: {} },
      document: { querySelector: () => null },
      navigator: { onLine: true },
      chrome: { runtime: { lastError: null }, tabs: { create: () => {} } },
      NXTK: {
        REPORT_ISSUE_URL: 'https://example.invalid/report',
        recordError: () => {},
        sanitizeUrlForReport: (value) => String(value || '')
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        url: finalUrl,
        text: async () => body,
        headers: {
          get: (name) => Object.entries(headers)
            .find(([key]) => key.toLowerCase() === String(name).toLowerCase())?.[1] || ''
        }
      })
    });
    vm.runInContext(responseClassifier, runtime, { filename: 'src/response-classifier.js' });
    vm.runInContext(errorsSource, runtime, { filename: 'src/content/errors.js' });
    return runtime.window.NexusExt.Errors.request('https://www.nexusmods.com/source');
  };

  const redirected = await requestWith({ finalUrl: 'https://users.nexusmods.com/auth/sign_in' });
  assert.equal(redirected.error?.code, 'requires_login',
    'the real request path forwards the final response URL to the classifier');

  const challenged = await requestWith({ headers: { 'Cf-Mitigated': 'challenge' } });
  assert.equal(challenged.error?.code, 'cloudflare',
    'the real request path forwards Cf-Mitigated to the classifier');
}

// What the deck shows when a file fails. The worker sends a code with its measurements
// attached; a screenshot of that read as a stack trace, and the numbers now live in the report.
function failureTextTests() {
  const errors = fs.readFileSync('src/content/errors.js', 'utf8');
  const ndc = fs.readFileSync('src/content/ndc.js', 'utf8');

  const definitions = extractConstExpression(errors, 'DEFINITIONS');
  const render = new Function('raw', `
    const DEFINITIONS = ${definitions};
    ${extractFunction(errors, 'buildError')}
    ${extractFunction(errors, 'normalize')}
    ${extractFunction(errors, 'messageKeyFor')}
    const globalThis = {};
    ${extractFunction(errors, 'displayText')}
    ${extractFunction(errors, 'toLogMessage')}
    const Errors = { normalize, displayText, toLogMessage };
    const code = String(raw || '').split(' ')[0].trim();
    const known = code && Errors.normalize({ code }).code === code;
    return known
      ? Errors.toLogMessage({ code })
      : (raw || Errors.displayText({ code: 'request_failed' }).message);
  `);

  // The exact string from the reported screenshot.
  const reported = 'short_file (got 16103 of 166716 declared, Nexus listed 166912, application/x-7z-compressed)';
  const shown = render(reported);
  assert.equal(shown, 'The download stopped before the whole file arrived. Retry it. If it keeps stopping, download that one from its file page.',
    'a measured failure reads as a sentence with recovery advice, not as its measurements');
  assert.doesNotMatch(shown, /\d{4}/, 'no byte counts are put in front of the reader');
  assert.doesNotMatch(shown, /_/, 'and no internal code either');

  for (const [code, expected] of [
    ['empty_file', /empty file/i],
    ['not_a_file', /page instead of the file/i],
    ['download_not_started', /refused to start/i],
    ['cloudflare', /./],
    ['requires_login', /./],
    ['mod_unavailable', /./]
  ]) {
    assert.match(render(`${code} (detail here)`), expected, `${code} has a sentence of its own`);
  }

  // A code with no sentence keeps its raw text rather than being flattened to something generic.
  assert.equal(render('queue-items-missing'), 'queue-items-missing',
    'an unregistered code is left as it came, so nothing is lost');
  assert.equal(render('interrupted'), 'interrupted', 'including the browser\'s own wording');
  assert.ok(render('').length > 0, 'and an empty reason still says something');

  // Every code the worker can send for a failed file must be spelled the way the
  // definitions are, or the sentence lookup silently misses.
  const bg = fs.readFileSync('src/background.js', 'utf8');
  const workerCodes = [...new Set([...bg.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]))];
  for (const code of ['short_file', 'empty_file', 'not_a_file', 'download_not_started']) {
    assert.ok(workerCodes.includes(code), `the worker emits ${code}`);
    assert.match(errors, new RegExp(`^\\s{4}${code}:\\s*\\{`, 'm'), `and ${code} is defined`);
  }
  assert.doesNotMatch(bg, /short-file|empty-file|not-a-file|download-not-started/,
    'no hyphenated spelling is left behind to miss the lookup');
  assert.match(ndc, /Errors\.normalize\(\{ code \}\)\.code === code/, 'the deck checks before translating');
  assert.match(ndc, /Errors\.toLogMessage\(\{ code \}\)/,
    'a known queue failure includes its translated recovery advice');
  // The copy of the logic above proves the wording; this pins the real call site, so changing
  // it cannot pass unnoticed.
  assert.match(ndc, /:\s*\(raw \|\| Errors\.displayText\(\{ code: 'request_failed' \}\)\.message\)/,
    'an unregistered code keeps its own text rather than being flattened to something generic');
  assert.match(ndc, /const code = raw\.split\(' '\)\[0\]\.trim\(\);/,
    'and the code is taken from the front of what the worker sent');
}

// A report that contradicts itself costs whoever reads it time. The settings block said the
// tab auto-close was on while the action line said it was off, because auto-close is a Vortex
// step and the flag was recorded as false for every browser download.
function activityLineTests() {
  const shared = fs.readFileSync('src/shared.js', 'utf8');
  const describe = new Function('source', `
    const TRIGGER_LABELS = ${extractConstExpression(shared, 'TRIGGER_LABELS')};
    const METHOD_LABELS = ${extractConstExpression(shared, 'METHOD_LABELS')};
    const activity = {};
    ${extractFunction(shared, 'describeActivity')}
    return describeActivity(source);
  `);

  const browser = describe({ trigger: 'automatic', method: 'browser', fileId: '1000169376', autoClose: false });
  assert.match(browser, /browser download/, 'the method is still named');
  assert.doesNotMatch(browser, /auto-close/,
    'a browser download says nothing about closing a tab it never opens');

  const vortexOff = describe({ trigger: 'manual', method: 'vortex', autoClose: false });
  assert.match(vortexOff, /tab auto-close off/, 'a Vortex handoff still reports it off');
  const vortexOn = describe({ trigger: 'manual', method: 'vortex', autoClose: true });
  assert.match(vortexOn, /tab auto-close armed/, 'and armed');

  assert.equal(describe({ trigger: 'popup' }), 'popup action', 'a bare trigger is unchanged');
  assert.equal(describe({}), '', 'and nothing without one');
}

archivedFilesUrlTests();
slowDownloadButtonTests();
dominantGameDomainTests();
nativePassthroughTests();
importFileFilterTests();
skippedArchiveLogTests();
errorDialogTests();
adTimerCookieBehaviour();
needsExtractingIsNotAFailure();
queueEtaBehaviour();
storeListingBehaviour();
modUnavailableTests();
blockingVerdictTests();
classifierParityTests();
failureTextTests();
activityLineTests();
requestClassifierForwardingTests()
  .then(() => console.log('content-script helper behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
