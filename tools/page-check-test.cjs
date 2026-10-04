const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The page check reads only what it is handed, so a page is a few answers to querySelector.
const store = {};
const session = {};
const recorded = [];
const warned = [];
const context = vm.createContext({
  console, URL, URLSearchParams, JSON, Date, Math, Promise, setTimeout, clearTimeout,
  location: { origin: 'https://www.nexusmods.com', pathname: '/', search: '', href: 'https://www.nexusmods.com/' },
  sessionStorage: {
    getItem: (key) => (key in session ? session[key] : null),
    setItem: (key, value) => { session[key] = String(value); }
  },
  chrome: {
    runtime: { lastError: null },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: store[key] }),
        set: (items, cb) => { Object.assign(store, structuredClone(items)); cb && cb(); }
      }
    }
  },
  NXTK: { recordError: (error) => recorded.push(error) }
});
context.window = context;
context.globalThis = context;
context.window.NexusExt = { NNW: { Logger: { warn: (text) => warned.push(text), info: () => {} } } };
vm.runInContext(fs.readFileSync('src/content/page-check.js', 'utf8'), context, { filename: 'src/content/page-check.js' });
const PageCheck = context.window.NexusExt.PageCheck;

function fakeDoc({ present = [], ids = {}, title = '', scripts = [] } = {}) {
  const has = (selector) => selector.split(',').map((part) => part.trim()).some((part) => present.includes(part));
  return {
    title,
    querySelector: (selector) => (has(selector) ? {} : null),
    querySelectorAll: (selector) => (selector === 'script[src]' ? scripts.map((src) => ({ src })) : []),
    getElementById: (id) => (id in ids ? ids[id] : null)
  };
}
const at = (path, search = '') => ({
  origin: 'https://www.nexusmods.com', pathname: path, search, href: `https://www.nexusmods.com${path}${search}`
});
const signedIn = { isSignedIn: () => true, getDocumentLoginError: () => null };
const signedOut = { isSignedIn: () => false, getDocumentLoginError: () => ({ code: 'requires_login' }) };
const unreadable = { isSignedIn: () => false, getDocumentLoginError: () => null };
const nnwWith = (gameId, roots = null) => ({ getGameId: () => gameId, getSearchRoots: (doc) => roots || [doc] });
const isCollectionRoute = (path) => /\/collections\/[^/]+/.test(path);
const ids = (result) => Object.fromEntries(result.checks.map((entry) => [entry.id, entry.ok]));

// Pages the extension does not act on are not checked at all.
assert.equal(PageCheck.runChecks({ doc: fakeDoc(), loc: at('/users/123'), auth: signedIn, nnw: nnwWith('1') }), null);

// A mod page with everything in place.
let result = PageCheck.runChecks({
  doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266'), auth: signedIn, nnw: nnwWith('1704')
});
assert.equal(result.page, 'mod');
assert.deepEqual(ids(result), { 'sign-in': true, 'game-id': true, 'mod-section': true });

// The mod page loses the things the extension finds its way by.
result = PageCheck.runChecks({
  doc: fakeDoc(), loc: at('/skyrimspecialedition/mods/266'), auth: unreadable, nnw: nnwWith('')
});
assert.deepEqual(ids(result), { 'sign-in': false, 'game-id': false, 'mod-section': false },
  'a missing game id, section and sign-in marker are each named');

// A file page finds its download control, including one inside a shadow root.
const shadow = fakeDoc({ present: ['mod-file-download[file-id="99"]'] });
result = PageCheck.runChecks({
  doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266', '?tab=files&file_id=99'),
  auth: signedIn, nnw: { getGameId: () => '1704', getSearchRoots: (doc) => [doc, shadow] }
});
assert.equal(result.page, 'mod-file');
assert.equal(ids(result)['download-control'], true, 'a control inside a shadow root counts');

result = PageCheck.runChecks({
  doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266', '?tab=files&file_id=99'),
  auth: signedIn, nnw: nnwWith('1704')
});
const control = result.checks.find((entry) => entry.id === 'download-control');
assert.equal(control.ok, false, 'a file page without its control fails');
assert.match(control.detail, /mod-file-download\[file-id="99"\]/, 'and says what was looked for');

result = PageCheck.runChecks({
  doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266', '?tab=files&file_id=99'),
  auth: signedOut, nnw: nnwWith('1704')
});
assert.equal(ids(result)['download-control'], undefined, 'nobody signed out gets a download control, so it is not checked');
assert.equal(ids(result)['sign-in'], true, 'a visible log-in control is a readable sign-in state');

// A removed mod shows a notice instead of the mod, which is not a broken page.
result = PageCheck.runChecks({
  doc: fakeDoc({ present: ['h3[id^="Notice"][id$="-title"]'] }), loc: at('/skyrimspecialedition/mods/266'),
  auth: signedIn, nnw: nnwWith('')
});
assert.equal(result.page, 'mod-notice');
assert.deepEqual(ids(result), { 'sign-in': true });

// The collection panel needs its spot on the page.
result = PageCheck.runChecks({
  doc: fakeDoc(), loc: at('/games/newvegas/collections/jscbqj/mods'), auth: signedIn,
  findCollectionHost: () => null, isCollectionRoute
});
assert.equal(result.page, 'collection');
assert.equal(ids(result)['deck-spot'], false, 'a collection page with nowhere to put the panel fails');
result = PageCheck.runChecks({
  doc: fakeDoc(), loc: at('/games/newvegas/collections/jscbqj'), auth: signedIn,
  findCollectionHost: () => ({ container: {}, legacy: null }), isCollectionRoute
});
assert.equal(ids(result)['deck-spot'], true);

// A Cloudflare check on screen is not the page at all.
result = PageCheck.runChecks({
  doc: fakeDoc({ title: 'Just a moment...' }), loc: at('/skyrimspecialedition/mods/266'), auth: unreadable, nnw: nnwWith('')
});
assert.equal(result.skipped, 'Cloudflare check on screen');
assert.equal(result.checks.length, 0);

// The Nexus build, from whichever form the page gives it in.
assert.equal(PageCheck.detectBuild(fakeDoc({ ids: { __NEXT_DATA__: { textContent: '{"buildId":"aB3_x9-k"}' } } })), 'aB3_x9-k');
assert.equal(PageCheck.detectBuild(fakeDoc({ scripts: ['https://www.nexusmods.com/_next/static/Zx81Q/_buildManifest.js'] })), 'Zx81Q');
const chunksA = PageCheck.detectBuild(fakeDoc({ scripts: ['/_next/static/chunks/main-1a2b.js', '/_next/static/chunks/app-9f.js'] }));
const chunksB = PageCheck.detectBuild(fakeDoc({ scripts: ['/_next/static/chunks/app-9f.js', '/_next/static/chunks/main-1a2b.js'] }));
assert.match(chunksA, /^chunks-[a-z0-9]+$/);
assert.equal(chunksA, chunksB, 'the chunk digest does not depend on script order');
assert.notEqual(chunksA, PageCheck.detectBuild(fakeDoc({ scripts: ['/_next/static/chunks/main-3c4d.js'] })),
  'and changes when Nexus deploys new chunks');
assert.equal(PageCheck.detectBuild(fakeDoc({ scripts: ['https://ads.example/x.js'] })), '', 'no build is invented');

(async () => {
  // A new build is remembered with the one before it, so a report can say when Nexus deployed.
  let record = await PageCheck.rememberBuild('build-1', 1000);
  assert.equal(record.id, 'build-1');
  assert.equal(record.previous, null);
  record = await PageCheck.rememberBuild('build-1', 2000);
  assert.equal(record.since, 1000, 'the same build keeps the day it was first seen');
  record = await PageCheck.rememberBuild('build-2', 3000);
  assert.equal(record.id, 'build-2');
  assert.equal(record.previous.id, 'build-1');
  assert.equal(record.previous.until, 3000);
  assert.equal((await PageCheck.rememberBuild('', 4000)).id, 'build-2', 'a page with no build forgets nothing');

  // A failing check goes to the console every time, but into the error log once per tab.
  const failing = PageCheck.runChecks({
    doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266', '?tab=files&file_id=99'),
    auth: signedIn, nnw: nnwWith('1704')
  });
  PageCheck.reportFailures(failing, record);
  PageCheck.reportFailures(failing, record);
  assert.equal(warned.length, 2, 'the console names it each time');
  assert.equal(recorded.length, 1, 'the error log has it once');
  assert.equal(recorded[0].code, 'nexus_page_changed');
  assert.match(recorded[0].technicalMessage, /download control for this file/);
  assert.match(recorded[0].technicalMessage, /Nexus build: build-2/, 'with the build it happened on');
  const passing = PageCheck.runChecks({
    doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/266'), auth: signedIn, nnw: nnwWith('1704')
  });
  PageCheck.reportFailures(passing, record);
  assert.equal(recorded.length, 1, 'a page that passes logs nothing');

  // The report section.
  const lines = PageCheck.describe({ ...failing, at: 10000 }, record, 15000).join('\n');
  assert.match(lines, /Nexus page check/);
  assert.match(lines, /Page: {3}file download page · checked 5s ago/);
  assert.match(lines, /^FAIL download control for this file/m);
  assert.match(lines, /^ok {3}game id — 1704/m);
  assert.match(lines, /Nexus build: build-2 \(seen since 1970-01-01; before that build-1/);
  assert.deepEqual([...PageCheck.describe(null, null)], [], 'nothing known, nothing printed');

  console.log('Page check behavior OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
