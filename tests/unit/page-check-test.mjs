import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
assert.deepEqual(ids(result), { 'sign-in': true, 'game-id': false, 'mod-section': false },
  'missing content is a failure; missing account controls are inconclusive');
assert.match(result.checks[0].detail, /unknown/);

// A modern mod page can have usable content without the legacy wrapper or account controls.
result = PageCheck.runChecks({
  doc: fakeDoc({ present: ['mod-download-buttons'] }), loc: at('/skyrimspecialedition/mods/266'),
  auth: unreadable, nnw: nnwWith('1704')
});
assert.ok(result.checks.every((entry) => entry.ok), 'rendered mod components count as content');
const loading = PageCheck.runChecks({
  doc: { ...fakeDoc(), readyState: 'loading' }, loc: at('/skyrimspecialedition/mods/266'), auth: unreadable, nnw: nnwWith('')
});
assert.equal(loading.skipped, 'Nexus page still loading');
assert.equal(loading.checks.length, 0);

const jsonHost = { tagName: 'MOD-FILE-DOWNLOAD', fileId: '99' };
result = PageCheck.runChecks({
  doc: { ...fakeDoc({ ids: { section: {} } }), querySelectorAll: () => [jsonHost] },
  loc: at('/skyrimspecialedition/mods/266', '?tab=files&file_id=99'), auth: unreadable,
  nnw: { ...nnwWith('1704'), fileIdFromNode: (node) => node.fileId }
});
assert.ok(result.checks.every((entry) => entry.ok), 'JSON file data is a valid download control');

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
result = PageCheck.runChecks({
  doc: fakeDoc(), loc: at('/games/newvegas/collections/jscbqj'), auth: signedIn,
  findCollectionHost: () => null, isCollectionRoute, collectionMountPending: () => true
});
assert.equal(result.skipped, 'Collection panel still loading', 'mount retries are not a site change');
result = PageCheck.runChecks({
  doc: fakeDoc(), loc: at('/games/newvegas/collections/jscbqj'), auth: signedIn,
  findCollectionHost: () => null, isCollectionRoute, collectionMountPending: () => false
});
assert.equal(ids(result)['deck-spot'], false, 'exhausted mount recovery still reports a genuine failure');
result = PageCheck.runChecks({
  doc: fakeDoc({ ids: { 'nxtk-control-deck': {} } }), loc: at('/games/newvegas/collections/jscbqj'), auth: signedIn,
  findCollectionHost: () => null, isCollectionRoute
});
assert.equal(ids(result)['deck-spot'], true, 'a mounted panel proves the mount worked');

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

  // A modal open or the adult-content gate is a legitimate variant, not a site change.
  const before = recorded.length;
  const variantFailing = PageCheck.runChecks({
    doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/267', '?tab=files&file_id=98'),
    auth: signedIn, nnw: nnwWith('1704')
  });
  const withModal = { querySelector: (sel) => (sel.includes('download-modal') ? {} : null) };
  const withGate = { querySelector: (sel) => (sel === 'main' ? { innerText: 'This collection contains adult content. Show adult content?' } : null) };
  PageCheck.reportFailures(variantFailing, record, withModal);
  PageCheck.reportFailures(variantFailing, record, withGate);
  assert.equal(recorded.length, before, 'no nexus_page_changed with a modal open or behind the adult gate');
  assert.equal(PageCheck.pageVariant(withModal), 'modal open');
  assert.equal(PageCheck.pageVariant(withGate), 'adult content gate');
  assert.equal(PageCheck.pageVariant({ querySelector: () => null }), '');
  // A file page for a file that does not exist: a notice with the Files tab, not a site-change warning.
  const missingFile = { title: 'Object not found', location: { href: 'https://www.nexusmods.com/skyrimspecialedition/mods/267?tab=files&file_id=1' },
    querySelector: (sel) => (sel === 'main' ? { innerText: 'Object not found. The file you are looking for does not exist.' } : null) };
  assert.equal(PageCheck.pageVariant(missingFile), 'file not found');
  const notices = [];
  const savedUi = context.NexusExt.UI;
  context.NexusExt.UI = { ...(savedUi || {}), showNotice: (n) => notices.push(n) };
  PageCheck.reportFailures(variantFailing, record, missingFile);
  PageCheck.reportFailures(variantFailing, record, missingFile);
  context.NexusExt.UI = savedUi;
  assert.equal(recorded.length, before, 'a missing file is not a site change');
  assert.equal(notices.length, 1, 'the missing-file notice is shown once');
  assert.match(notices[0].actions[0].href, /\/mods\/267\?tab=files$/);

  // E-0wu48au: "missing: page content region" from Next.js-rendered mod pages (build chunks-…) said
  // nothing about what those pages had. The report now carries the page's structure, never its text.
  const element = (tagName, attrs = {}) => ({ tagName, getAttribute: (name) => attrs[name] ?? null });
  const nextPage = ({ text = 'Text on the page. '.repeat(20), title = 'Mod at Nexus Mods', nodes = [] } = {}) => {
    const body = { innerText: text, getElementsByTagName: () => nodes };
    return {
      title,
      body,
      getElementById: (id) => (id === '__next' ? {} : null),
      querySelector: (sel) => (sel === 'main' ? null : null),
      querySelectorAll: (sel) => {
        if (sel === 'script[src]') return [{ src: 'https://www.nexusmods.com/_next/static/chunks/app-1.js' }];
        if (sel === 'main') return [];
        if (sel === 'h1') return [element('H1')];
        if (sel === '[data-e2e-id]') return nodes.filter((node) => node.getAttribute('data-e2e-id'));
        return [];
      }
    };
  };
  const nodes = [element('DIV'), element('NEXUS-HEADER'), element('MOD-PAGE-HEADER'), element('NXTK-TOAST'),
    element('SECTION', { 'data-e2e-id': 'mod-tile' }), element('DIV', { 'data-e2e-id': 'Tab Files 2394' })];
  const shape = PageCheck.pageShape(nextPage({ nodes }));
  assert.equal(shape, 'shape: next app; main none; h1 one; components nexus-header, mod-page-header; e2e mod-tile; text some; title nexus');
  const contentFailing = PageCheck.runChecks({ doc: fakeDoc(), loc: at('/skyrimspecialedition/mods/268'), auth: signedIn, nnw: nnwWith('1704') });
  const beforeShape = recorded.length;
  PageCheck.reportFailures(contentFailing, record, nextPage({ nodes }));
  assert.equal(recorded.length, beforeShape + 1);
  assert.match(recorded.at(-1).technicalMessage, /^missing: page content region \(#section or rendered page content\) \| shape: next app; main none; h1 one; components nexus-header, mod-page-header; e2e mod-tile; text some; title nexus \| Nexus build: build-2$/);
  assert.match(PageCheck.pageShape(nextPage({ text: '' })), /text none/);
  assert.match(PageCheck.pageShape(nextPage({ text: 'Application error: a client-side exception has occurred (see the browser console for more information).' })),
    /text little; next error text/, 'a crashed Next.js page says so, since an extension can cause that');
  assert.equal(PageCheck.pageVariant(nextPage({ text: '404 This page could not be found.', title: '404: This page could not be found.' })), 'page not found',
    'Next.js\'s own not-found page is not a site change');

  // E-0wu48au "unknown app; main none; h1 one; components none; title other": no Nexus app at all and a
  // title that is not Nexus's is Cloudflare's check or block page, or a bare 429/503 page, at a mod's
  // address. Reported as "Nexus page may have changed" from several builds; it is not a site change.
  const foreign = (title, text) => ({
    title,
    body: { innerText: text, getElementsByTagName: () => [element('H1')] },
    getElementById: () => null,
    querySelector: (sel) => (sel === 'main' ? null : null),
    querySelectorAll: (sel) => (sel === 'h1' ? [element('H1')] : [])
  });
  for (const [title, text] of [
    ['Just a moment...', 'www.nexusmods.com Verify you are human by completing the action below. www.nexusmods.com needs to review the security of your connection before proceeding.'],
    ['Attention Required! | Cloudflare', 'Sorry, you have been blocked. You are unable to access nexusmods.com.'],
    ['429 Too Many Requests', '429 Too Many Requests nginx']
  ]) {
    assert.equal(PageCheck.pageVariant(foreign(title, text)), 'not a Nexus page', `not a site change: ${title}`);
    const beforeForeign = recorded.length;
    PageCheck.reportFailures(contentFailing, record, foreign(title, text));
    assert.equal(recorded.length, beforeForeign, `and not reported: ${title}`);
  }
  assert.equal(PageCheck.pageVariant(foreign('', 'text')), '', 'a page with no title is not taken for somebody else\'s');
  assert.equal(PageCheck.pageVariant({ ...foreign('Some Mod at Skyrim Nexus - Mods and Community', 'text') }), '',
    'a Nexus title keeps a page with no app markers in the checks');
  assert.equal(PageCheck.pageVariant({ ...foreign('Just a moment...', 'text'), getElementById: (id) => (id === '__next' ? {} : null) }), '',
    'and so does the Nexus app, whatever the title');
  assert.equal(PageCheck.pageVariant({ ...foreign('Loading…', 'text'),
    querySelectorAll: (sel) => (sel === 'script[src]' ? [{ src: 'https://www.nexusmods.com/_next/static/chunks/app-1.js' }] : []) }), '',
  'a Nexus app known only by its scripts is still checked');
  assert.equal(PageCheck.pageVariant({ ...foreign('Just a moment...', 'text'), getElementById: (id) => (id === 'section' ? {} : null) }), '',
    'as is the legacy layout');

  // E-1opts0d: a file page where Nexus shows one of its notices (sign in, moderation, an archived or
  // unavailable file) instead of the download control. Nexus says why; nothing changed.
  const noticeFailing = PageCheck.runChecks({
    doc: fakeDoc({ ids: { section: {} } }), loc: at('/skyrimspecialedition/mods/269', '?tab=files&file_id=97'),
    auth: signedIn, nnw: nnwWith('1704')
  });
  assert.deepEqual([...noticeFailing.checks.filter((entry) => !entry.ok).map((entry) => entry.id)], ['download-control']);
  const withNotice = { title: 'Mod at Skyrim Nexus', getElementById: (id) => (id === 'section' ? {} : null),
    querySelector: (sel) => (sel === '[id^="Notice"][id$="-title"]' ? {} : null), querySelectorAll: () => [] };
  const beforeNotice = recorded.length;
  // A new tab, so the once-per-tab rule cannot hide whether the notice is what kept it quiet.
  for (const key of Object.keys(session)) delete session[key];
  PageCheck.reportFailures(noticeFailing, record, withNotice);
  assert.equal(recorded.length, beforeNotice, 'a Nexus notice in place of the download control is not a site change');
  for (const key of Object.keys(session)) delete session[key];
  context.document = withNotice;
  PageCheck.reportFailures(noticeFailing, record);
  delete context.document;
  assert.equal(recorded.length, beforeNotice, 'the scheduled live-page call also recognizes the Nexus notice without an explicit document');
  const withoutNotice = { ...withNotice, querySelector: () => null };
  for (const key of Object.keys(session)) delete session[key]; // a new tab: the same failure may be reported again
  PageCheck.reportFailures(noticeFailing, record, withoutNotice);
  assert.equal(recorded.length, beforeNotice + 1, 'without one, a missing download control is still reported');
  // The notice only explains a missing download control: a page that lost its content region too is
  // still a site change, notice or not.
  const bothFailing = PageCheck.runChecks({
    doc: fakeDoc(), loc: at('/skyrimspecialedition/mods/270', '?tab=files&file_id=96'), auth: signedIn, nnw: nnwWith('1704')
  });
  assert.ok(bothFailing.checks.filter((entry) => !entry.ok).length > 1, 'the fixture fails more than the download control');
  for (const key of Object.keys(session)) delete session[key];
  PageCheck.reportFailures(bothFailing, record, withNotice);
  assert.equal(recorded.length, beforeNotice + 2, 'a notice does not excuse the rest of the page going missing');
  const beforeNotFound = recorded.length;
  const bareFailing = PageCheck.runChecks({ doc: fakeDoc(), loc: at('/skyrimspecialedition/mods/269'), auth: signedIn, nnw: nnwWith('') });
  PageCheck.reportFailures(bareFailing, record, nextPage({ text: '404 This page could not be found.' }));
  assert.equal(recorded.length, beforeNotFound, 'and is not logged as one');
  assert.equal(PageCheck.pageShape(null), '');

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
