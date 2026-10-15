// Fixture-based checks of the content scripts against reduced Nexus page snapshots (tools/fixtures).
// Needs the jsdom dev dependency (npm install). Without it the suite is skipped with a notice, unless
// NXTK_REQUIRE_DOM=1 (set in CI), where a missing jsdom fails the gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  if (process.env.NXTK_REQUIRE_DOM === '1') {
    console.error('jsdom is required (run npm ci).');
    process.exit(1);
  }
  console.log('DOM fixture tests skipped: jsdom is not installed (run npm install).');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SCRIPTS = [
  'src/shared.js',
  'src/selectors.js',
  'src/response-classifier.js',
  'src/content/errors.js',
  'src/content/auth.js',
  'src/content/page-check.js'
];

function load(name, url = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=734848') {
  const dom = new JSDOM(fixture(name), { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // These synchronous snapshots represent a loaded page; jsdom's load event runs later.
  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
  window.chrome = {
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, sendMessage: () => Promise.resolve(), onMessage: { addListener() {} } },
    storage: { local: { get: (_k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (_v, cb) => (cb ? cb() : Promise.resolve()) }, onChanged: { addListener() {} } },
    i18n: { getMessage: () => '', getUILanguage: () => 'en' }
  };
  // jsdom does no layout, so "visible" means: not inside a display:none ancestor.
  window.Element.prototype.getClientRects = function () {
    for (let el = this; el; el = el.parentElement) {
      if (window.getComputedStyle(el).display === 'none') return [];
    }
    return [{}];
  };
  for (const file of SCRIPTS) window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  return window;
}

// --- Selector registry -------------------------------------------------------------------------
{
  const w = load('file-page-german.html');
  const Sel = w.NexusSelectors;
  assert.ok(Sel.textMatches('Langsamer Download', 'slowDownload'), 'German slow-download label matches');
  assert.ok(Sel.textMatches('  SLOW   download ', 'slowDownload'), 'matching ignores case and spacing');
  assert.ok(!Sel.textMatches('Please wait 5', 'slowDownload'), 'a countdown label does not match');
  assert.equal(Sel.find(w.document, 'signedInStrong'), null, 'no session markers on this fixture');
  assert.equal(Sel.find(w.document, 'nonexistentKey'), null, 'an unknown key degrades to null');
  // An invalid selector in a list is skipped, not thrown.
  const list = Sel.SELECTORS.downloadControl;
  assert.ok(Array.isArray(list) && list.length >= 2, 'download control has fallbacks');
}

// --- Sign-in detection (regression: false "neither profile menu nor log-in control" warning) -----
{
  const w = load('file-page-signed-in.html');
  assert.equal(w.NexusExt.Auth.isSignedIn(w.document), true,
    'a sign-out link inside a closed dropdown still proves a session');
  const result = w.NexusExt.PageCheck.runChecks({ doc: w.document, loc: w.location, nnw: { getGameId: () => '1704', getSearchRoots: (d) => [d] } });
  const signIn = result.checks.find((c) => c.id === 'sign-in');
  assert.equal(signIn.ok, true, 'page check reports signed in');
  assert.equal(result.checks.find((c) => c.id === 'download-control').ok, true, 'download control found');
}
{
  const w = load('file-page-signed-in-no-markers.html');
  const result = w.NexusExt.PageCheck.runChecks({ doc: w.document, loc: w.location, nnw: { getGameId: () => '1704', getSearchRoots: (d) => [d] } });
  const signIn = result.checks.find((c) => c.id === 'sign-in');
  assert.equal(signIn.ok, true, 'missing account controls do not imply a site change');
  assert.match(signIn.detail, /unknown/);
  w.document.getElementById('section').replaceWith(...w.document.getElementById('section').childNodes);
  const heading = w.document.createElement('h1');
  heading.textContent = 'Example mod';
  w.document.getElementById('mainContent').prepend(heading);
  const modern = w.NexusExt.PageCheck.runChecks({ doc: w.document, loc: w.location,
    nnw: { getGameId: () => '1704', getSearchRoots: (d) => [d] } });
  assert.ok(modern.checks.every((c) => c.ok), 'a rendered page without the legacy section or account menu is valid');
}
{
  const w = load('file-page-signed-out.html');
  assert.equal(w.NexusExt.Auth.isSignedIn(w.document), false);
  assert.equal(w.NexusExt.Auth.getDocumentLoginError(w.document)?.code, 'requires_login');
  const result = w.NexusExt.PageCheck.runChecks({ doc: w.document, loc: w.location, nnw: { getGameId: () => '1704', getSearchRoots: (d) => [d] } });
  const signIn = result.checks.find((c) => c.id === 'sign-in');
  assert.equal(signIn.ok, true);
  assert.equal(signIn.detail, 'signed out');
  assert.equal(result.checks.some((c) => c.id === 'download-control'), false, 'a signed-out file page is not asked for a download control');
}

// --- Safe log markup ---------------------------------------------------------------------------
{
  const w = load('file-page-signed-in.html');
  const node = w.document.createElement('div');
  w.NXTK.setSafeHtml(node, '[1] Done <a href="https://www.nexusmods.com/x" target="_blank" onclick="evil()">SkyUI</a>'
    + '<img src=x onerror="evil()"><script>evil()</script><a href="javascript:evil()">bad</a><b>ok</b>');
  assert.equal(node.querySelector('img, script'), null, 'disallowed elements are dropped');
  const links = node.querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute('onclick'), null, 'event handlers are dropped');
  assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
  assert.equal(links[1].hasAttribute('href'), false, 'javascript: links lose their href');
  assert.equal(node.querySelector('b').textContent, 'ok');
  assert.ok(node.textContent.includes('evil()'), 'script text survives only as inert text');
}

// --- Download dedupe (regression: one manual click produced file.zip and file (1).zip) ----------
{
  const w = load('file-page-signed-in.html');
  const nnw = fs.readFileSync(path.join(root, 'src/content/nnw.js'), 'utf8');
  const start = nnw.indexOf('  const DOWNLOAD_DEDUPE_WINDOW_MS');
  const end = nnw.indexOf('  async function runDownload(');
  assert.ok(start > 0 && end > start, 'claimDownload block not found — update the test');
  const make = () => new w.Function('document', 'Date', `${nnw.slice(start, end)}; return claimDownload;`)(w.document, Date);
  const claimA = make();
  const claimB = make(); // a second, orphaned copy of the content script
  const first = claimA('734848', false);
  assert.ok(first, 'the first start is allowed');
  assert.equal(claimA('734848', false), null, 'a second start while in flight is dropped');
  assert.equal(claimB('734848', false), null, 'an orphaned script copy is also blocked via the DOM');
  assert.ok(claimA('734848', true), 'the Vortex hand-off for the same file is tracked separately');
  first.done(true);
  assert.equal(claimA('734848', false), null, 'a start moments after success is dropped');
  const other = claimA('999', false);
  other.done(false);
  assert.ok(claimA('999', false), 'a failed start can be retried at once');
}

// --- Slow-download button binding --------------------------------------------------------------
{
  const nnw = fs.readFileSync(path.join(root, 'src/content/nnw.js'), 'utf8');
  assert.ok(!/setInterval\([^)]*SLOW_DOWNLOAD_POLL_MS/.test(nnw), 'the 1s slow-download poll is gone');
  assert.ok(nnw.includes('boundSlowButtons.add(slowDownloadBtn)'), 'buttons are marked via a WeakSet');
  assert.ok(!nnw.includes("slowDownloadBtn.addEventListener('click'"), 'no per-button listener (it ran after Nexus\'s own)');
}

// --- One owner per click (live test 2.10.1: SkyUI SDK downloaded twice; the requirements modal fetched
// the MAIN file twice). The real nnw.js runs in the page; Nexus's own handlers are stand-ins. ---------
(async () => {
  const w = load('file-page-signed-in.html');
  const generated = [];
  w.fetch = (url, init) => {
    generated.push({ url: String(url), body: String(init?.body || '') });
    return new Promise(() => {}); // never answers: only who asked, and how often, matters here
  };
  w.NexusExt.Storage = {
    getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false }),
    sendDownloadCommand: async () => ({ ok: true, value: {} })
  };
  for (const file of ['src/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const NNW = w.NexusExt.NNW;
  await NNW.init();

  // Nexus's file card: a shadow root with its own listener on the slow-download button.
  const host = w.document.createElement('mod-file-download');
  host.setAttribute('file-id', '734848');
  const shadow = host.attachShadow({ mode: 'open' });
  const slow = w.document.createElement('button');
  slow.id = 'slowDownloadButton';
  slow.textContent = 'Slow download';
  shadow.appendChild(slow);
  let nexusHandled = 0;
  slow.addEventListener('click', () => { nexusHandled++; });
  w.document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 120));

  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
  click(slow);
  click(slow);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(nexusHandled, 0, 'the extension owns the slow-download click: Nexus\'s listener never runs');
  const forFile = (id) => generated.filter((g) => g.body.includes(`fid=${id}`) || g.url.includes(`file_id=${id}`)).length;
  assert.equal(forFile('734848'), 1, 'two clicks, one resolve for the file');

  // A link inside a shadow root (event.target is the host) is still recognised and owned.
  const card = w.document.createElement('mod-file-download');
  card.setAttribute('file-id', '555');
  const cardShadow = card.attachShadow({ mode: 'open' });
  const link = w.document.createElement('a');
  link.href = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=555';
  link.textContent = 'Manual download';
  cardShadow.appendChild(link);
  let navigated = 0;
  link.addEventListener('click', (e) => { if (!e.defaultPrevented) navigated++; });
  w.document.body.appendChild(card);
  click(link);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(navigated, 0, 'Nexus\'s own handling of a shadow-DOM download link does not also run');
  assert.equal(forFile('555'), 1);

  // The requirements modal opened from the SDK card: its download-links name the MAIN file (111).
  const opener = w.document.createElement('mod-file-download');
  opener.setAttribute('file-id', '734849');
  const openerShadow = opener.attachShadow({ mode: 'open' });
  const openerButton = w.document.createElement('span');
  openerButton.textContent = 'Manual download';
  openerShadow.appendChild(openerButton);
  w.document.body.appendChild(opener);
  click(openerButton);
  const modal = w.document.createElement('download-modal');
  modal.setAttribute('download-links', JSON.stringify({ downloadUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=111' }));
  const modalShadow = modal.attachShadow({ mode: 'open' });
  const modalButton = w.document.createElement('button');
  modalButton.textContent = 'Download mod file';
  modalShadow.appendChild(modalButton);
  let modalNative = 0;
  modalButton.addEventListener('click', () => { modalNative++; });
  w.document.body.appendChild(modal);
  click(modalButton);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(modalNative, 0, 'the modal click has one owner');
  assert.equal(forFile('111'), 0, 'the main file is never fetched for another file\'s modal');
  assert.equal(forFile('734849'), 1, 'the clicked file is');

  // pickModalHref, directly.
  const pick = NNW.pickModalHref;
  const base = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604';
  assert.equal(pick({ modalFileId: '7', linksJson: JSON.stringify({ downloadUrl: `${base}?tab=files&file_id=7` }) }), `${base}?tab=files&file_id=7`);
  assert.equal(pick({ modalFileId: '7', linksJson: JSON.stringify({ downloadUrl: `${base}?tab=files&file_id=1` }), base }), `${base}?tab=files&file_id=7`, 'a link for another file is replaced');
  assert.equal(pick({ modalFileId: '7', isNMM: true, base }), `${base}?tab=files&file_id=7&nmm=1`);
  assert.equal(pick({ modalFileId: '', linksJson: '' }), '', 'unknown file: left to Nexus, never guessed');
  assert.equal(pick({ modalFileId: '', buttonHref: `${base}?tab=files&file_id=9` }), `${base}?tab=files&file_id=9`);
  console.log('click ownership behavior OK');
  // nnw.js keeps page timers running; the suite is done.
  w.close();
  process.exit(process.exitCode || 0);
})().catch((error) => { console.error(error); process.exit(1); });

// --- Collection deck spot after late hydration ---------------------------------------------------
{
  const w = load('collection-late-hydration.html', 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abc');
  const main = fs.readFileSync(path.join(root, 'src/content/main.js'), 'utf8');
  const s = main.indexOf('  function findCollectionHost()');
  const e = main.indexOf('  function teardownActiveCollection()');
  const find = new w.Function('document', `${main.slice(s, e)}; return findCollectionHost;`)(w.document);
  assert.equal(find(), null, 'before hydration there is no deck spot');
  const container = w.document.createElement('div');
  container.className = 'next-container';
  w.document.querySelector('#mainContent .relative').appendChild(container);
  assert.equal(find()?.container, container, 'the spot is found once hydration adds it');
  assert.ok(main.includes('scheduleDeckMountRetry(ndc)'), 'a missing spot schedules a retry instead of giving up');
}

console.log('DOM fixture behavior OK');
