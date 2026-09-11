const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SETTINGS_KEY = 'nxtk_settings';
const ERROR_LOG_KEY = 'nxtk_error_log';
const TOTAL_KEY = 'nxtk_total_downloads';
const ISSUE_PREFIX = 'https://github.com/thomasthanos/nexusmods-bypass/issues/new';

function loadShared({
  settings = {},
  errors = [],
  total = 7,
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0 Safari/537.36',
  manifestExtra = {},
  extensionId = 'test-extension-id',
  prompted = false
} = {}) {
  const store = {
    [SETTINGS_KEY]: { DownloadFolder: 'NexusMods', NDC_downloadMethod: 0, ...settings },
    [ERROR_LOG_KEY]: errors,
    [TOTAL_KEY]: total
  };
  if (prompted) store.nxtk_rating_prompted = true;
  const reads = [];
  const context = {
    console, URL, URLSearchParams, Date, Math, Number, String, Object, Array, Set, Map,
    Promise, RegExp, JSON, Intl, WeakMap, setTimeout, clearTimeout, parseInt, isNaN,
    navigator: { userAgent, language: 'en-GB' },
    location: { href: 'https://www.nexusmods.com/skyrim/mods/1?tab=files&file_id=2', hostname: 'www.nexusmods.com' },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    chrome: {
      runtime: {
        id: extensionId,
        lastError: null,
        getManifest: () => ({ name: 'NexusMods Bypass', version: '2.6.0', ...manifestExtra }),
        sendMessage: () => undefined
      },
      i18n: { getMessage: () => '', getUILanguage: () => 'en-GB' },
      storage: {
        local: {
          get: (key, cb) => {
            reads.push(key);
            const keys = Array.isArray(key) ? key : [key];
            const out = {};
            for (const name of keys) if (name in store) out[name] = store[name];
            cb(out);
          },
          set: (items, cb) => {
            Object.assign(store, items);
            if (cb) cb();
          }
        },
        onChanged: { addListener: () => undefined }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync('src/shared.js', 'utf8'), context, { filename: 'src/shared.js' });
  return { NXTK: context.NXTK, reads, store };
}

function loggedError(overrides = {}) {
  return {
    at: Date.now() - 60000,
    code: 'no_download_url',
    status: null,
    context: 'Reading manual download page',
    action: 'collection run (queued by the download deck) · Vortex handoff (nxm:)',
    userMessage: 'Nexus Mods did not return a usable download link.',
    technicalMessage: 'resp HTTP 200, 4096B, no nxm-link',
    stack: 'Error: boom\n    at getDownloadUrl (chrome-extension://abcdefghij/content/nnw.js:812:19)',
    url: 'https://www.nexusmods.com/skyrim/mods/1?file_id=2',
    ...overrides
  };
}

async function reportContentTests() {
  const { NXTK } = loadShared({
    errors: [
      loggedError({ code: 'rate_limited', status: 429, count: 12, lastAt: Date.now() - 5000 }),
      loggedError(),
      loggedError({ code: 'cloudflare' })
    ]
  });

  const report = await NXTK.buildBugReport({
    code: 'no_nmm_link',
    userMessage: 'Nexus Mods did not return a valid Vortex link.',
    recovery: 'Check the file page and retry.',
    context: 'Generating Vortex download link',
    technicalMessage: 'resp HTTP 200, 512B, no nxm-link',
    stack: 'Error: nope\n    at runDownload (chrome-extension://abcdefghij/content/nnw.js:1024:7)'
  });

  assert.match(report, /NEXUSMODS BYPASS — BUG REPORT/);
  assert.match(report, /Extension: NexusMods Bypass v2\.6\.0/);
  assert.match(report, /Report ID: [0-9a-z]{7} \(same fault, same ID\)/, 'a fingerprint is included');
  assert.match(report, /──────── What went wrong ────────/, 'the digest is included');
  assert.match(report, /12 × rate_limited/, 'repeat counts are totalled in the digest');
  assert.match(report, /×12/, 'the entry itself shows its repeat count');
  assert.match(report, /action:\s+collection run/, 'the stored action survives into the report');
  assert.match(report, /last \d+[smhd] ago/, 'the digest says how recent each code is');
  assert.doesNotMatch(report, /abcdefghij/, 'the extension ID is not needed to read a stack');

  // The same fault must fingerprint identically regardless of install or run.
  const other = loadShared();
  const shapeA = await other.NXTK.buildReportIssueUrl({
    code: 'no_nmm_link', userMessage: 'x', context: 'Generating Vortex download link',
    stack: 'at runDownload (chrome-extension://zzzzzzzzzz/content/nnw.js:1024:7)'
  });
  const shapeB = await other.NXTK.buildReportIssueUrl({
    code: 'no_nmm_link', userMessage: 'x', context: 'Generating Vortex download link',
    stack: 'at runDownload (chrome-extension://abcdefghij/content/nnw.js:1024:7)'
  });
  const idOf = (url) => /Report\+ID%3A\+([0-9a-z]{7})/.exec(decodeURI(url).replace(/ /g, '+'))?.[1]
    || /Report ID: ([0-9a-z]{7})/.exec(decodeURIComponent(url))?.[1];
  assert.ok(idOf(shapeA.url), 'the report ID reaches the URL');
  assert.equal(idOf(shapeA.url), idOf(shapeB.url), 'the same fault gets the same ID on any install');
}

async function issueUrlTests() {
  const { NXTK } = loadShared({ errors: [loggedError()] });
  const result = await NXTK.buildReportIssueUrl({ code: 'no_nmm_link', userMessage: 'No Vortex link.' });

  assert.ok(result.url.startsWith(ISSUE_PREFIX), 'the worker only opens issue-new URLs');
  const params = new URL(result.url).searchParams;
  assert.equal(params.get('template'), 'nexus_bug_report.yml');
  assert.match(params.get('title'), /^\[Bug] no_nmm_link — /);
  assert.match(params.get('report'), /NEXUSMODS BYPASS/, 'the report field is filled');
  assert.match(params.get('browser'), /Chrome 138/, 'the browser field is filled too');
  assert.equal(result.complete, true, 'a short report fits');
  assert.match(result.report, /NEXUSMODS BYPASS/, 'the caller gets the report back to copy');
}

async function truncationTests() {
  const noisy = Array.from({ length: 50 }, (_, index) => loggedError({
    code: `code_${index % 7}`,
    at: Date.now() - (index + 1) * 1000,
    technicalMessage: `x`.repeat(500),
    stack: Array.from({ length: 12 }, (_, frame) => (
      `    at step${frame} (chrome-extension://abcdefghij/content/nnw.js:${frame}:1)`
    )).join('\n')
  }));
  const { NXTK } = loadShared({ errors: noisy });

  const full = await NXTK.buildBugReport();
  assert.ok(full.length > 20000, `an oversized log should not fit (${full.length} chars)`);

  const result = await NXTK.buildReportIssueUrl();
  assert.equal(result.complete, false, 'the URL had to be reduced');
  assert.ok(result.url.length <= 7000, `the URL stays inside the limit (${result.url.length})`);

  const sent = new URL(result.url).searchParams.get('report');
  assert.match(sent, /What went wrong/, 'the digest survives truncation');
  assert.match(sent, /code_0/, 'the codes survive truncation');
  assert.doesNotMatch(sent, /at step11/, 'historical stacks are dropped before entries are');

  assert.match(result.report, /at step11/, 'the clipboard copy keeps the stacks');
  assert.ok(result.report.length > sent.length * 2,
    `the clipboard copy is the untruncated report (${result.report.length} vs ${sent.length})`);
}

async function emptyLogTests() {
  const { NXTK } = loadShared({ errors: [], total: 0 });
  const report = await NXTK.buildBugReport();
  assert.match(report, /\(no errors recorded\)/);
  assert.doesNotMatch(report, /What went wrong/, 'no digest without errors');
  assert.doesNotMatch(report, /Report ID/, 'no fingerprint without an error');

  const result = await NXTK.buildReportIssueUrl();
  assert.equal(result.complete, true);
  assert.equal(new URL(result.url).searchParams.get('title'), '[Bug] ');
}

async function redactionTests() {
  const { NXTK } = loadShared({
    settings: { DownloadFolder: 'C:/Users/Real Name/Mods' },
    errors: [loggedError({
      technicalMessage: 'final=https://premium-files.nexus-cdn.com/1/2/f.zip?key=SECRET&expires=99&user_id=42',
      url: 'https://www.nexusmods.com/skyrim/mods/1?file_id=2&key=SECRET'
    })]
  });
  const report = await NXTK.buildBugReport();
  assert.doesNotMatch(report, /SECRET/, 'signed URL secrets never reach the report');
  assert.doesNotMatch(report, /Real Name/, 'the download folder is described, not quoted');
  assert.match(report, /DownloadFolder: \(set, \d+ characters\)/);
}

async function storeReviewTests() {
  const CHROME_ID = 'chfghiknjhpcncpcjopglefnckckdlpj';
  const EDGE_ID = 'hcjpcnajmkanhodhpkoinodjbkeolgaa';
  const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0 Safari/537.36';
  const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0';

  // The store that issued the id owns the rating, whatever browser it is running in.
  const cases = [
    [{ extensionId: CHROME_ID, userAgent: CHROME_UA }, /chromewebstore\.google\.com/,
      'a Chrome Web Store copy'],
    [{ extensionId: CHROME_ID, userAgent: EDGE_UA }, /chromewebstore\.google\.com/,
      'a Chrome Web Store copy running in Edge'],
    [{ extensionId: EDGE_ID, userAgent: EDGE_UA }, /microsoftedge\.microsoft\.com/,
      'an Edge Add-ons copy'],
    [{ extensionId: EDGE_ID, userAgent: CHROME_UA }, /microsoftedge\.microsoft\.com/,
      'an Edge Add-ons copy running in Chrome'],
    [{ manifestExtra: { browser_specific_settings: { gecko: { id: 'x' } } }, userAgent: CHROME_UA },
      /addons\.mozilla\.org/, 'the Firefox build, whatever the user agent claims'],
    [{ extensionId: 'unpackedcopyaaaaaaaaaaaaaaaaaaaa', userAgent: EDGE_UA },
      /chromewebstore\.google\.com/, 'an unpacked copy falls back to the primary listing'],
    [{ extensionId: '', userAgent: FIREFOX_UA }, /chromewebstore\.google\.com/,
      'a missing id matches no listing by accident']
  ];

  for (const [options, expected, label] of cases) {
    const { NXTK } = loadShared(options);
    const url = NXTK.getStoreReviewUrl();
    assert.match(url, expected, `${label} must be sent to the listing it belongs to`);
    assert.ok(url.startsWith('https://'), 'review links are https');
    assert.ok(NXTK.getStoreListing().name, `${label} has a store name for the link text`);
  }

  // The id used to match has to be the id in that listing's own url, or the match is
  // decorative and would silently send people to a listing they never installed from.
  for (const [options, fragment] of [
    [{ extensionId: CHROME_ID }, CHROME_ID],
    [{ extensionId: EDGE_ID }, EDGE_ID]
  ]) {
    const { NXTK } = loadShared(options);
    assert.ok(NXTK.getStoreReviewUrl().includes(fragment),
      'the listing url carries the same id that selected it');
  }

  const { NXTK } = loadShared();
  assert.match(NXTK.TROUBLESHOOTING_URL, /nexusmods-bypass#-troubleshooting$/, 'blocking errors point at the docs');
}

// The ask is periodic now, which is the kind of thing that turns into a nag if the rules
// are loose. Every gate is pinned down: the milestone, the gap between asks, what a
// dismissal clears, what following a link ends, and that a fault can never produce an ask.
async function ratingFlagTests() {
  const { NXTK } = loadShared();
  const due = NXTK.ratingMilestoneDue;
  const MILESTONES = NXTK.RATING_MILESTONES;
  const fresh = { done: false, cleared: 0, askedAt: 0 };
  const DAY = 24 * 60 * 60 * 1000;

  assert.deepStrictEqual([...MILESTONES], [25, 120, 500, 1500], 'the milestones are as documented');
  for (let index = 1; index < MILESTONES.length; index += 1) {
    assert.ok(MILESTONES[index] > MILESTONES[index - 1] * 2,
      'each milestone is far enough past the last that asks grow further apart, not closer');
  }

  assert.equal(due(0, fresh), 0, 'a new install is not asked');
  assert.equal(due(24, fresh), 0, 'nor one file short of the first milestone');
  assert.equal(due(25, fresh), 25, 'the first milestone comes due on the count');
  assert.equal(due(119, fresh), 25, 'and stays due until the next is reached');
  assert.equal(due(1000000, fresh), 1500,
    'someone arriving long past every milestone is asked once, for the highest');

  const dismissedFirst = { done: false, cleared: 25, askedAt: 0 };
  assert.equal(due(30, dismissedFirst), 0, 'a dismissed milestone does not come back');
  assert.equal(due(119, dismissedFirst), 0, 'nor at any count below the next one');
  assert.equal(due(120, dismissedFirst), 120, 'but the next milestone still comes round');

  assert.equal(due(1000000, { done: true, cleared: 25, askedAt: 0 }), 0,
    'following a link settles it at any count, for good');

  const justAsked = { done: false, cleared: 25, askedAt: Date.now() };
  assert.equal(due(1500, justAsked), 0, 'two asks cannot land in the same three weeks');
  assert.equal(due(1500, { done: false, cleared: 25, askedAt: Date.now() - 20 * DAY }), 0,
    'twenty days is not yet three weeks');
  assert.equal(due(1500, { done: false, cleared: 25, askedAt: Date.now() - 22 * DAY }), 1500,
    'and it comes due once the gap has passed');

  assert.equal(due(1500, null), 0, 'unreadable state is treated as nothing to ask');
  assert.equal(due(1500, undefined), 0);

  const brandNew = loadShared({ total: 1500 });
  assert.equal(await brandNew.NXTK.dueRatingMilestone(1500), 1500, 'a heavy new install is asked');
  brandNew.NXTK.markRatingAsked(1500);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(brandNew.store.nxtk_rating_state?.cleared, 1500, 'showing it records the milestone');
  assert.ok(brandNew.store.nxtk_rating_state?.askedAt > 0, 'and when it was shown');
  assert.equal(brandNew.store.nxtk_rating_state?.done, false, 'showing is not answering');

  const followed = loadShared({ total: 1500 });
  followed.NXTK.markRatingSettled();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(followed.store.nxtk_rating_state?.done, true, 'following a link is recorded as done');

  // An install already asked under the old once-ever rule keeps that promise for the first
  // milestone, with its gap starting now, so upgrading never produces an ask on the spot.
  const upgraded = loadShared({ prompted: true, total: 1500 });
  assert.equal(await upgraded.NXTK.dueRatingMilestone(1500), 0,
    'an upgraded install is not asked straight away');
}

function ratingSurfaceTests() {
  const ui = fs.readFileSync('src/content/ui.js', 'utf8');
  const popup = fs.readFileSync('src/popup/popup.js', 'utf8');

  for (const [label, source] of [['deck', ui], ['popup', popup]]) {
    assert.match(source, /dueRatingMilestone/, `${label}: the milestone decides whether to ask`);
    assert.match(source, /markRatingAsked/, `${label}: showing it records the milestone`);
    assert.match(source, /markRatingSettled/, `${label}: following a link settles it`);
    assert.match(source, /ratingStarCta/, `${label}: GitHub is offered beside the review`);
    assert.match(source, /ratingPromptCount/, `${label}: the copy names the count`);
    assert.doesNotMatch(source, /wasRatingPrompted|markRatingPrompted/,
      `${label}: nothing is left on the once-ever helpers`);
  }

  assert.doesNotMatch(ui, /DECK_ASK_MIN_MODS/, 'the five-file collection floor is gone');
  assert.match(ui, /if \(finishedCount < 1 \|\|/, 'only that the run downloaded something');

  const shared = fs.readFileSync('src/shared.js', 'utf8');
  assert.doesNotMatch(shared, /function wasRatingPrompted|function markRatingPrompted/,
    'the old helpers are removed, not left to rot');
  assert.match(shared, /RATING_PROMPT_KEY/, 'but the old key is still read, for the migration');

  for (const locale of fs.readdirSync('src/_locales')) {
    const messages = JSON.parse(fs.readFileSync(`src/_locales/${locale}/messages.json`, 'utf8'));
    assert.match(messages.ratingPromptCount?.message || '', /\$1/, `${locale}: keeps the count`);
    assert.ok(messages.ratingStarCta?.message, `${locale}: has the GitHub action`);
    assert.equal(messages.ratingPrompt, undefined, `${locale}: the replaced string is gone`);
  }
}

async function activityTrailTests() {
  const { NXTK } = loadShared({ errors: [loggedError()] });

  let report = await NXTK.buildBugReport();
  assert.doesNotMatch(report, /Leading up to it/, 'no trail section when nothing was logged');

  NXTK.noteActivity('info', ['Auto manual: starting download']);
  NXTK.noteActivity('warn', ['Cloudflare blocked the extension request; using the native control.']);
  NXTK.noteActivity('error', [{ code: 'no_nmm_link', message: 'Nexus returned no Vortex link' }]);
  NXTK.noteActivity('info', ['']);

  report = await NXTK.buildBugReport();
  assert.match(report, /──────── Leading up to it ────────/, 'the trail is in the report');
  assert.match(report, /info\s+Auto manual: starting download/);
  assert.match(report, /warn\s+Cloudflare blocked/);
  assert.match(report, /error\s+no_nmm_link/, 'an error object is reduced to its code');
  assert.equal((report.match(/^\d\d:\d\d:\d\d /gm) || []).length, 3, 'blank lines are not recorded');

  // Secrets must not ride along in a breadcrumb.
  NXTK.noteActivity('warn', ['resolved https://premium-files.nexus-cdn.com/1/2/f.zip?key=SECRET&expires=9']);
  report = await NXTK.buildBugReport();
  assert.doesNotMatch(report, /SECRET/, 'a signed URL in a log line is stripped');

  for (let index = 0; index < 20; index += 1) NXTK.noteActivity('info', [`step ${index}`]);
  report = await NXTK.buildBugReport();
  const trailLines = (report.match(/^\d\d:\d\d:\d\d /gm) || []).length;
  assert.ok(trailLines <= 8, `the trail stays short (${trailLines} lines)`);
  assert.match(report, /step 19/, 'and keeps the most recent activity');
  assert.doesNotMatch(report, /step 0\b/, 'dropping the oldest');

  const result = await NXTK.buildReportIssueUrl({ code: 'no_nmm_link', userMessage: 'No link.' });
  assert.equal(result.complete, true, 'an ordinary report with a trail still fits the URL');
  assert.ok(result.url.length <= 7000, `url ${result.url.length} chars`);
}

Promise.resolve()
  .then(reportContentTests)
  .then(issueUrlTests)
  .then(truncationTests)
  .then(emptyLogTests)
  .then(redactionTests)
  .then(storeReviewTests)
  .then(ratingFlagTests)
  .then(ratingSurfaceTests)
  .then(activityTrailTests)
  .then(() => console.log('bug report builder behavior OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
