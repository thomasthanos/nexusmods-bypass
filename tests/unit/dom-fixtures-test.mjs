// Fixture-based checks of the content scripts against reduced Nexus page snapshots (tests/fixtures).
// Needs the jsdom dev dependency (npm install). Without it the suite is skipped with a notice, unless
// NXTK_REQUIRE_DOM=1 (set in CI), where a missing jsdom fails the gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (_) {
  if (process.env.NXTK_REQUIRE_DOM === '1') {
    console.error('jsdom is required (run npm ci).');
    process.exit(1);
  }
  console.log('DOM fixture tests skipped: jsdom is not installed (run npm install).');
  process.exit(0);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => fs.readFileSync(path.join(root, 'tests', 'fixtures', name), 'utf8');
// Where a large file's link on the Files tab leaves the file it sent the user to answer Nexus's question for.
const LARGE_FILE_CHOICE_KEY = 'nxtk_large_file_choice';
async function waitForState(check, message) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const SCRIPTS = [
  'src/lib/shared.js',
  'src/lib/selectors.js',
  'src/lib/response-classifier.js',
  'src/content/errors.js',
  'src/content/auth.js',
  'src/content/page-check.js'
];

function load(name, url = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=734848', options = {}) {
  const dom = new JSDOM(fixture(name), { url, runScripts: 'outside-only', pretendToBeVisual: true, ...options });
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

// --- Requirements section opened (issue #29) ---------------------------------------------------------
// Nexus's toggle listens for a "tap" that a scripted click does not make, so the section is opened the
// way Nexus opens one it marks expand-default. Checked live: Nexus's own toggle then closes it normally.
{
  const w = load('mod-page-requirements.html', 'https://www.nexusmods.com/stardewvalley/mods/45538');
  w.NexusExt.Storage = { getSettings: async () => ({ ...w.NXTK.DEFAULTS }) };
  for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const NNW = w.NexusExt.NNW;
  const [reqDt, permDt, collDt] = w.document.querySelectorAll('dl.accordion > dt');
  const state = (dt) => ({
    header: dt.classList.contains('accopen'),
    body: dt.nextElementSibling.classList.contains('open'),
    shown: w.getComputedStyle(dt.nextElementSibling).display !== 'none'
  });
  const closed = { header: false, body: false, shown: false };
  const open = { header: true, body: true, shown: true };

  assert.equal(w.NXTK.DEFAULTS.ExpandRequirements, false, 'off unless the user turns it on');
  NNW.expandRequirementsSection();
  assert.deepEqual(state(reqDt), closed, 'nothing is opened while the setting is off');

  NNW.updateConfig({ ...w.NXTK.DEFAULTS, ExpandRequirements: true });
  NNW.expandRequirementsSection();
  assert.deepEqual(state(reqDt), open, 'the Requirements section is open');
  assert.deepEqual(state(permDt), closed, 'other sections are left alone');
  assert.deepEqual(state(collDt), open, 'and one Nexus opened stays as it was');

  // The user closes it, as Nexus's toggle does; a later pass (navigation, a settings change) keeps it closed.
  reqDt.nextElementSibling.classList.remove('open');
  reqDt.nextElementSibling.style.display = 'none';
  reqDt.classList.remove('accopen');
  NNW.expandRequirementsSection();
  assert.deepEqual(state(reqDt), closed, 'a section the user closed stays closed');

  // A description tab Nexus loads again is a new section, opened again.
  const fresh = reqDt.cloneNode(true);
  const freshBody = reqDt.nextElementSibling.cloneNode(true);
  reqDt.parentElement.prepend(fresh, freshBody);
  NNW.expandRequirementsSection();
  assert.deepEqual(state(fresh), open, 'a re-rendered section is opened like a new page');

  // Without the analytics hook, the header is found by the requirements component it opens.
  fresh.removeAttribute('data-accordion-track');
  const again = fresh.cloneNode(true);
  const againBody = freshBody.cloneNode(true);
  againBody.classList.remove('open');
  againBody.style.display = 'none';
  again.classList.remove('accopen');
  fresh.parentElement.prepend(again, againBody);
  NNW.expandRequirementsSection();
  assert.deepEqual(state(again), open, 'found by its main-file-requirements content');
  console.log('requirements section behavior OK');
}

// --- Archived files (issue #33) -------------------------------------------------------------------
// Every file is a header with its own dd in one dl. The box was looked for in the header's parent, the
// dl, which found the first file's box for every header: only the top archived file got its buttons.
// Awaited by the last block, which ends the run.
const archivedFilesDone = (async () => {
  const page = 'https://www.nexusmods.com/riseofthetombraider/mods/23';
  const w = load('mod-files-archived.html', `${page}?tab=files&category=archived`);
  w.NexusExt.Storage = { getSettings: async () => ({ ...w.NXTK.DEFAULTS }) };
  for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const NNW = w.NexusExt.NNW;
  NNW.updateConfig({ ...w.NXTK.DEFAULTS, HandleArchivedFiles: true });
  NNW.archivedFileHandler();
  const box = (id) => w.document.getElementById(`file-expander-header-${id}`).nextElementSibling.querySelector('.accordion-downloads');
  const links = (id) => [...box(id).querySelectorAll('a')].map((a) => a.href);
  const buttons = (id) => [`${page}?tab=files&file_id=${id}&nmm=1`, `${page}?tab=files&file_id=${id}`];
  for (const id of ['301', '202', '101']) {
    assert.deepEqual(links(id), buttons(id), `archived file ${id} gets its own Mod manager and Manual download buttons`);
  }
  assert.deepEqual(links('55'), buttons('55'), 'also when only the header\'s id names the file');
  assert.match(box('77').textContent, /under review/, 'a notice Nexus put in the box stays');
  assert.deepEqual(links('77'), [], 'with no buttons beside it');
  assert.deepEqual(links('88'), [`${page}?tab=files&category=archived#preview-88`], 'a file the virus scan flagged keeps what Nexus shows');
  assert.deepEqual(links('92'), buttons('92'), 'a file with no box of its own never takes the next file\'s');
  assert.deepEqual([...w.document.querySelectorAll('#file-row-66 a')].map((a) => a.href), buttons('66'),
    'a file wrapped on its own finds the box beside it');
  const added = () => w.document.querySelectorAll('.accordion-downloads[data-nxtk-done] a').length;
  NNW.archivedFileHandler();
  assert.equal(added(), 12, 'a second pass adds nothing');

  // Nexus draws another file after the page has settled: it gets its buttons without a page change.
  const list = w.document.querySelector('dl.accordion');
  const addFile = (id) => list.insertAdjacentHTML('beforeend', `<dt id="file-expander-header-${id}" class="file-expander-header" data-id="${id}"><p>Late</p></dt>`
    + `<dd data-id="${id}"><div class="tabbed-block"><ul class="accordion-downloads"></ul></div></dd>`);
  addFile('44');
  await waitForState(() => links('44').length === 2, 'a late archived file must receive its download buttons');
  assert.deepEqual(links('44'), buttons('44'), 'a file Nexus draws later gets its buttons too');

  // Turned off: Nexus's boxes come back, and nothing is added any more.
  NNW.updateConfig({ ...w.NXTK.DEFAULTS, HandleArchivedFiles: false });
  assert.equal(added(), 0, 'every box is back as Nexus drew it');
  addFile('33');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(links('33'), [], 'and a file drawn later stays as it is');
  w.close();
  console.log('archived files behavior OK');
})();

// --- Firefox can start the content scripts on a document with no body (E-1vrmg48) ---------------------
// The requirements-tab handler was attached to document.body, so startup threw "document.body is null"
// and stopped there. Startup now waits for a body, and the handler no longer needs one. Awaited by the
// last block, which ends the run.
const bodylessStartupDone = (async () => {
  const w = load('mod-page-requirements.html', 'https://www.nexusmods.com/stardewvalley/mods/45538');
  w.NexusExt.Storage = { getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false }) };
  for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const clickListeners = [];
  const addListener = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, listener, options) => {
    if (type === 'click') clickListeners.push(options);
    return addListener(type, listener, options);
  };
  const body = w.document.body;
  body.remove();
  assert.equal(w.document.body, null);
  const main = fs.readFileSync(path.join(root, 'src/content/main.js'), 'utf8');
  const waitForBody = new w.Function('document', 'MutationObserver',
    `${main.slice(main.indexOf('  function waitForBody()'), main.indexOf('  async function waitForSafeStartup()'))}; return waitForBody;`
  )(w.document, w.MutationObserver);
  let bodyFound = false;
  const waiting = waitForBody().then(() => { bodyFound = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodyFound, false, 'with no body, startup waits');
  await w.NexusExt.NNW.init();
  assert.deepEqual(clickListeners, [true], 'the requirements tab is skipped from the document, which always exists');
  w.document.documentElement.append(body);
  await waiting;
  assert.equal(bodyFound, true, 'a body the page adds later starts the extension');
  w.close();
  console.log('bodyless startup behavior OK');
})();

// --- A browser download names its mod and version (E-1u4nb29) -------------------------------------------
// For the Mod Organizer 2 .meta the worker writes once the file has finished: without them MO2 showed no
// description for a mod saved from its page. Awaited by the last block, which ends the run.
const browserDownloadLabelsDone = (async () => {
  const w = load('file-page-signed-in.html');
  const commands = [];
  w.fetch = async (url) => {
    const generator = String(url).includes('GenerateDownloadUrl');
    const body = generator ? JSON.stringify({ url: 'https://cf-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z?md5=a&expires=1' }) : '';
    return { ok: generator, status: generator ? 200 : 404, url: String(url), text: async () => body, headers: { get: () => '' } };
  };
  w.NexusExt.Storage = {
    getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false, NDC_downloadMethod: 1 }),
    sendDownloadCommand: async (type, payload) => { commands.push({ type, payload }); return { ok: true, value: {} }; }
  };
  for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await w.NexusExt.NNW.init();
  // The classic files tab names a file's version on its header.
  const header = w.document.createElement('dt');
  header.className = 'file-expander-header';
  header.dataset.id = '734848';
  header.dataset.version = '5.2SE';
  w.document.body.append(header);
  w.document.getElementById('slowDownloadButton').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
  for (let i = 0; i < 100 && !commands.some((c) => c.type === 'DOWNLOAD_START'); i += 1) await new Promise((r) => setTimeout(r, 20));
  const start = commands.find((c) => c.type === 'DOWNLOAD_START');
  assert.ok(start, 'the click starts a browser download');
  assert.equal(start.payload.fileId, '734848');
  assert.equal(start.payload.modName, 'SkyUI', 'the mod, from a classic title ("SkyUI at Skyrim Special Edition Nexus")');
  assert.equal(start.payload.version, '5.2SE', 'and the version its header names');
  // Left open: the page's observers and timers still run after the start, and the run's exit ends them.
  console.log('browser download labels OK');
})();

// --- Nexus's resumable downloads (beta, files over 500 MB; seen live 2026-10-30) ---------------------------
// "Slow download" on a large file opens a Standard-or-Resumable chooser, and a resumable download gets
// its own panel (progress, Pause/Resume/Cancel, "direct download"), which the extension draws over in its
// own look. Nexus's mod-file-download is mimicked: a shadow root with one delegated listener (as React's,
// which never answers for a node it did not draw), the chooser in the card's floating-ui-root, the panel
// in #download-section. The pages are left open (their observers outlive a closed window), and the run's
// exit ends them. Awaited by the last block.
const resumableDownloadsDone = (async () => {
  const FILE_ROW = '<div class="file-row"><span>HeavyRain Greek V1.0.1 - Epic Games</span><span> (1.5GB)</span></div>';
  const CARDS = '<div id="upsell-cards"><div class="rounded-lg p-6"><div><div>Free</div>'
    + '<div>Slow download. Wait more.</div><div>Throttled downloads (3MB/s)</div><div>Delay before each download</div></div>'
    + '<button type="button" class="nxm-button">Slow download</button></div></div>';
  // As Nexus's headlessui Dialog draws it (web-components bundle, 2026-11-01): the dialog, its backdrop, its panel.
  const CHOOSER = '<div class="nxm-modal nxm-modal-md" role="dialog" aria-modal="true"><div class="nxm-modal-backdrop"></div>'
    + '<div class="nxm-modal-content scrollbar"><div class="nxm-modal-header">'
    + '<h2>Download this large file without losing progress</h2><button aria-label="Close" class="nxm-modal-close-button"><svg></svg></button></div>'
    + '<div class="nxm-modal-body"><p>This file is over 500MB. Use resumable downloads so you can pause, track progress, and recover if your connection drops.</p></div>'
    + '<div class="nxm-modal-footer"><button type="button" class="nxm-button"><span>Standard download</span></button>'
    + '<button type="button" class="nxm-button"><span><span>Resumable download</span><span>Beta</span></span></button></div></div></div>';
  const panel = (inner, direct = true) => '<div class="space-y-6"><div class="rounded bg-surface-low p-6 text-center">'
    + `<div class="flex flex-col items-center gap-y-3">${inner}</div>`
    + `${direct ? '<p>Prefer a <button class="nxm-link">direct download</button> instead?</p>' : ''}</div></div>`;
  const PANELS = {
    cards: CARDS,
    progress: panel('<p>Downloading: <strong>8.02%</strong></p><div class="h-4"><div style="width: 8.02%;"></div></div>'
      + '<p>Please keep this page open, use the pause button to save your progress.</p>'
      + '<div class="flex justify-center gap-x-3"><button type="button"><span>Pause</span></button><button type="button"><span>Cancel</span></button></div>'),
    earlier: panel('<p>You have a download in progress from a previous session.</p>'
      + '<div class="flex flex-row items-center gap-x-3"><button type="button">Resume Download</button><button type="button">Cancel</button></div>'),
    preparing: panel('<p>Preparing...</p>'),
    failed: panel('<p class="font-semibold">Something went wrong.</p><p>Your file finished downloading but couldn\'t be saved to disk.</p>'
      + '<button type="button">Restart download</button>', false)
  };

  async function filePage(fileId, { settings = {}, picker = true, start = 'cards', fallback = false, choice = false } = {}) {
    const modPage = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604';
    const w = load('file-page-signed-in.html', `${modPage}?tab=files&file_id=${fileId}`);
    w.document.querySelector('mod-file-download').remove();
    w.document.querySelector('.download-card').remove();
    // Nexus asks only where the browser can write to a file it picks; Firefox cannot.
    if (picker) w.showSaveFilePicker = () => Promise.reject(new Error('not in tests'));
    if (fallback) {
      w.sessionStorage.setItem('nxtk_cloudflare_native_fallback', JSON.stringify({
        modPage, fileId, isNMM: false, autoStartPending: true, expiresAt: Date.now() + 60000
      }));
    }
    // A large file's link elsewhere on the mod page sent the user here (see the Files tab block below).
    if (choice) w.sessionStorage.setItem(LARGE_FILE_CHOICE_KEY, JSON.stringify({ modPage, fileId, expiresAt: Date.now() + 60000 }));
    const fetched = [];
    w.fetch = (url, init) => {
      fetched.push(`${url} ${init?.body || ''}`);
      return new Promise(() => {});
    };
    w.NexusExt.Storage = {
      getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false, ...settings }),
      sendDownloadCommand: async () => ({ ok: true, value: {} })
    };
    const host = w.document.createElement('mod-file-download');
    const attributes = { 'file-id': fileId, 'filesize-bytes': String(2 * 1024 ** 3), 'is-managed-download-enabled': 'true',
      'is-nmm-download': 'false', 'user-is-logged-in': 'true', 'timeout-seconds': '5',
      filename: 'HeavyRain Greek V1.0.1 - Epic Games', filesize: '1.5GB' };
    for (const [name, value] of Object.entries(attributes)) host.setAttribute(name, value);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<div id="download-section">${FILE_ROW}${PANELS[start]}</div><div id="floating-ui-root"></div>`;
    // As React does on a state change: Nexus's part goes, the new one is added at the end.
    const nexusPanel = () => shadow.querySelector('#download-section > .space-y-6, #download-section > #upsell-cards');
    const setPanel = (name) => {
      nexusPanel()?.remove();
      shadow.getElementById('download-section').insertAdjacentHTML('beforeend', PANELS[name]);
    };
    const nexus = { standard: 0, resumable: 0, paused: 0, resumed: 0, cancelled: 0, direct: 0 };
    const closeChooser = () => shadow.querySelector('[role="dialog"]')?.remove();
    shadow.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || button.closest('[data-nxtk-ui]')) return;
      const label = button.textContent.trim();
      // By place, not label: the extension relabels the button while its download starts.
      if (button.closest('#upsell-cards')) shadow.getElementById('floating-ui-root').innerHTML = CHOOSER;
      else if (button.getAttribute('aria-label') === 'Close') closeChooser();
      else if (label === 'Standard download') { nexus.standard++; closeChooser(); }
      else if (label.startsWith('Resumable download')) { nexus.resumable++; closeChooser(); }
      else if (label === 'Pause') nexus.paused++;
      else if (label === 'Resume Download') { nexus.resumed++; setPanel('preparing'); }
      else if (label === 'Cancel') nexus.cancelled++;
      else if (label === 'direct download') nexus.direct++;
    });
    w.document.getElementById('section').append(host);
    for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    await w.NexusExt.NNW.init();
    await new Promise((r) => setTimeout(r, 50));
    const press = (button, label) => {
      assert.ok(button, `the card shows ${label}`);
      button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
      return button;
    };
    const card = () => shadow.querySelector('.nxtk-rd');
    const ask = () => shadow.querySelector('.nxtk-rd-ask');
    return {
      w,
      host,
      nexus,
      card,
      ask,
      nexusPanel,
      setPanel,
      shadow,
      // Nexus's own buttons, never the extension's.
      click: (label) => press(typeof label === 'string'
        ? Array.from(shadow.querySelectorAll('button')).find((b) => !b.closest('[data-nxtk-ui]') && b.textContent.trim().startsWith(label))
        : label, label),
      // A button on the extension's own panel, as the user sees it.
      cardClick: (label) => press(Array.from(card()?.querySelectorAll('button') || []).find((b) => !b.hidden && b.textContent === label), label),
      cardText: (part) => card()?.querySelector(`.nxtk-rd-${part}`)?.textContent || '',
      // The extension's question, and the file's name the extension draws.
      askClick: (label) => press(Array.from(ask()?.querySelectorAll('button') || [])
        .find((b) => b.textContent.trim().startsWith(label) || b.getAttribute('aria-label') === label), label),
      askText: (part) => ask()?.querySelector(`.nxtk-rd-${part}`)?.textContent || '',
      fileRow: () => shadow.querySelector('#download-section > .nxtk-rd-file'),
      requested: () => fetched.filter((f) => f.includes(`fid=${fileId}`) || f.includes(`file_id=${fileId}`)).length,
      chooserOpen: () => !!shadow.querySelector('[role="dialog"]')
    };
  }

  // The chooser is Nexus's: the slow-download click opens it, and its Standard download is the extension's.
  {
    const { host, nexus, card, click, requested, chooserOpen } = await filePage('900001');
    assert.equal(host.getAttribute('timeout-seconds'), '0', 'Nexus\'s countdown before a large file starts is skipped');
    assert.equal(card(), null, 'no panel of the extension\'s over the Free/Premium cards');
    const slow = click('Slow download');
    assert.ok(chooserOpen(), 'on a large file Nexus asks standard or resumable');
    assert.equal(requested(), 0, 'and nothing starts before the answer');
    click('Standard download');
    assert.equal(nexus.standard, 0, 'Standard download is the extension\'s, not also Nexus\'s');
    assert.ok(!chooserOpen(), 'the chooser closes');
    await waitForState(() => requested() === 1, 'Standard download starts the file through the extension');
    assert.notEqual(slow.textContent.trim(), 'Slow download', 'the card\'s button shows the progress');
    click(slow);
    click('Resumable download');
    assert.equal(nexus.resumable, 1, 'Resumable download stays with Nexus');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(requested(), 1, 'and the extension starts nothing for it');
  }

  // The question in the extension's look: drawn inside Nexus's dialog (which keeps its focus trap and
  // Escape), over Nexus's hidden panel, with answers that press Nexus's own buttons.
  {
    const page = await filePage('900010');
    const slow = page.click('Slow download');
    await waitForState(() => page.ask(), 'the extension draws the question');
    const content = page.shadow.querySelector('.nxm-modal-content');
    assert.equal(content.style.display, 'none', 'Nexus\'s panel is hidden behind it');
    assert.equal(page.ask().parentElement, content.parentElement, 'inside Nexus\'s dialog');
    assert.equal(page.askText('file-name'), 'HeavyRain Greek V1.0.1 - Epic Games', 'it names the file');
    assert.equal(page.askText('file-size'), '1.5 GB');
    page.askClick('Standard download');
    assert.ok(!page.chooserOpen(), 'Standard download closes the question');
    assert.equal(page.nexus.standard, 0, 'and is the extension\'s, not also Nexus\'s');
    await waitForState(() => page.requested() === 1, 'it starts the file through the extension');
    page.click(slow);
    await waitForState(() => page.ask(), 'the question is drawn again each time Nexus asks');
    page.askClick('Resumable download');
    assert.equal(page.nexus.resumable, 1, 'Resumable download presses Nexus\'s own, in the same click');
    page.click(slow);
    await waitForState(() => page.ask(), 'and once more');
    page.askClick('Close');
    assert.ok(!page.chooserOpen(), 'Close closes Nexus\'s dialog');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(page.requested(), 1, 'with nothing started');
  }

  // The file's name and size in the extension's look, in place of Nexus's line, on any file's page.
  {
    const page = await filePage('900011');
    await waitForState(() => page.fileRow(), 'the extension draws the file\'s line');
    const nexusRow = page.shadow.querySelector('.file-row');
    assert.equal(nexusRow.style.display, 'none', 'Nexus\'s line is hidden');
    assert.equal(page.fileRow().nextElementSibling, nexusRow, 'in its place');
    assert.equal(page.fileRow().querySelector('.nxtk-rd-file-name').textContent, 'HeavyRain Greek V1.0.1 - Epic Games');
    assert.equal(page.fileRow().querySelector('.nxtk-rd-file-size').textContent, '1.5 GB');
    // As React does when it draws the line again: Nexus's new line is hidden too, with one line of the extension's.
    const redrawn = nexusRow.cloneNode(true);
    redrawn.style.display = '';
    nexusRow.replaceWith(redrawn);
    await waitForState(() => redrawn.style.display === 'none', 'a line Nexus draws again is hidden again');
    assert.equal(page.shadow.querySelectorAll('.nxtk-rd-file').length, 1);
    assert.equal(page.fileRow().nextElementSibling, redrawn);
    const small = await filePage('900012', { picker: false });
    await waitForState(() => small.fileRow(), 'a file Nexus asks nothing about gets the same line');
  }

  // A running resumable download: the extension's panel in Nexus's place, its buttons pressing Nexus's.
  {
    const page = await filePage('900002', { start: 'progress' });
    await waitForState(() => page.card(), 'the extension draws its panel');
    assert.equal(page.nexusPanel().style.display, 'none', 'Nexus\'s panel is hidden behind it');
    assert.equal(page.card().nextElementSibling, page.nexusPanel(), 'in Nexus\'s place');
    assert.equal(page.cardText('percent'), '8.02%');
    assert.equal(page.cardText('state'), 'Downloading...');
    page.cardClick('Pause');
    assert.equal(page.nexus.paused, 1, 'Pause presses Nexus\'s own Pause');
    page.nexusPanel().querySelector('strong').textContent = '9.50%';
    await waitForState(() => page.cardText('percent') === '9.50%', 'the progress follows Nexus\'s');
    page.cardClick('Direct download instead');
    assert.equal(page.nexus.paused, 2, 'a direct download pauses Nexus\'s resumable one first');
    assert.equal(page.nexus.direct, 0);
    await waitForState(() => page.requested() === 1, 'and the extension starts the file');
    page.setPanel('failed');
    await waitForState(() => !page.card(), 'an error is left to Nexus\'s panel, with its Recover and Restart');
    assert.notEqual(page.nexusPanel().style.display, 'none');
  }

  // Without a file picker (Firefox) Nexus never asks: the slow-download click is the extension's as before.
  {
    const { click, requested, chooserOpen } = await filePage('900003', { picker: false });
    click('Slow download');
    assert.ok(!chooserOpen(), 'no chooser');
    await waitForState(() => requested() === 1, 'the extension starts the file');
  }

  // A download left from an earlier visit: with automatic starts on it goes on by itself, and the extension
  // does not fetch the file a second time beside it. With them off, Resume is the user's.
  {
    const auto = await filePage('900004', { start: 'earlier', settings: { AutoStartDownload: true } });
    await waitForState(() => auto.nexus.resumed === 1, 'the earlier download is resumed');
    await waitForState(() => auto.cardText('state') === 'Starting…', 'and the panel follows it');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(auto.nexus.resumed, 1, 'once');
    assert.equal(auto.requested(), 0, 'no second download beside Nexus\'s');
    const manual = await filePage('900007', { start: 'earlier' });
    await waitForState(() => manual.card(), 'the extension draws its panel');
    assert.equal(manual.cardText('state'), 'Unfinished download from an earlier visit');
    assert.equal(manual.nexus.resumed, 0, 'nothing resumes by itself');
    manual.cardClick('Resume');
    assert.equal(manual.nexus.resumed, 1, 'Resume presses Nexus\'s Resume Download');
  }

  // An automatic start on a large file opens Nexus's question instead of starting a standard download
  // unasked; the answer is the user's. A large file's link elsewhere on the mod page does the same with
  // automatic starts off, once.
  {
    const idle = await filePage('900005', { settings: { AutoStartDownload: true } });
    await waitForState(() => idle.chooserOpen(), 'with no resumable download, the automatic start asks standard or resumable');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(idle.requested(), 0, 'and starts nothing before the answer');
    idle.click('Standard download');
    await waitForState(() => idle.requested() === 1, 'Standard download starts the file through the extension');
    const asked = await filePage('900008', { choice: true });
    await waitForState(() => asked.chooserOpen(), 'the link\'s click is answered here: Nexus asks');
    assert.equal(asked.requested(), 0);
    assert.equal(asked.w.sessionStorage.getItem(LARGE_FILE_CHOICE_KEY), null, 'once');
    const other = await filePage('900009');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!other.chooserOpen(), 'with automatic starts off and no such click, the page waits for the user');
  }

  // The Cloudflare fallback clicks "Slow download" for the user, and answers the chooser with Standard.
  {
    const { nexus, requested } = await filePage('900006', { fallback: true });
    await waitForState(() => nexus.standard === 1, 'the fallback answers Standard download');
    assert.equal(nexus.resumable, 0);
    assert.equal(requested(), 0, 'and leaves the download to Nexus');
  }
  console.log('resumable downloads behavior OK');
})();

// --- A large file's link on the Files tab (seen live 2026-11-01, fallout4/mods/318) ----------------------
// Each file's header names its size in KiB (data-size). "Manual download" on a file Nexus would ask about
// goes to the file's page, where Nexus asks standard or resumable, instead of starting a standard download
// unasked. jsdom does not navigate; it reports each navigation it was asked for. Awaited by the last block.
const largeFileLinksDone = (async () => {
  const modPage = 'https://www.nexusmods.com/fallout4/mods/318';
  let navigations = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => { if (/navigation/i.test(error.message)) navigations += 1; });
  const w = load('file-page-signed-in.html', `${modPage}?tab=files`, { virtualConsole });
  w.document.querySelector('mod-file-download').remove();
  w.document.querySelector('.download-card').remove();
  w.showSaveFilePicker = () => Promise.reject(new Error('not in tests'));
  const file = (id, kib, name) => `<dt class="file-expander-header clearfix" id="file-expander-header-${id}" data-id="${id}" data-size="${kib}">`
    + `<p>${name}</p></dt><dd class="clearfix" data-id="${id}"><div class="tabbed-block"><ul class="accordion-downloads clearfix">`
    + `<li><a class="nxm-button nxm-button-secondary" href="/fallout4/mods/318?tab=files&amp;file_id=${id}"><span>Manual download</span></a></li></ul></div></dd>`;
  w.document.getElementById('section').insertAdjacentHTML('beforeend', '<div class="accordionitems"><dl class="accordion">'
    + `${file('138745', 2484904, 'Textures - Ultra 4K Version (2.4GB)')}${file('138746', 4096, 'Readme (4MB)')}${file('138747', 512000, 'Exactly 500 MB')}`
    + '</dl></div>');
  const fetched = [];
  w.fetch = (url, init) => {
    fetched.push(`${url} ${init?.body || ''}`);
    return new Promise(() => {});
  };
  w.NexusExt.Storage = {
    getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false }),
    sendDownloadCommand: async () => ({ ok: true, value: {} })
  };
  for (const name of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, name), 'utf8'));
  await w.NexusExt.NNW.init();
  const requested = (id) => fetched.filter((f) => f.includes(`fid=${id}`) || f.includes(`file_id=${id}`)).length;
  const manual = (id) => w.document.querySelector(`dd[data-id="${id}"] a`).dispatchEvent(
    new w.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));

  assert.equal(manual('138745'), false, 'the extension takes the large file\'s click');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(requested('138745'), 0, 'and starts no standard download for it');
  assert.equal(navigations, 1, 'it goes to the file\'s page instead');
  assert.deepEqual(JSON.parse(w.sessionStorage.getItem(LARGE_FILE_CHOICE_KEY) || '{}').fileId, '138745',
    'which then opens Nexus\'s question for that file');

  manual('138746');
  await waitForState(() => requested('138746') === 1, 'a small file starts at once, as before');
  manual('138747');
  await waitForState(() => requested('138747') === 1, 'so does one of exactly 500 MB, which Nexus does not ask about');
  // Firefox has no file picker, so Nexus never asks there.
  delete w.showSaveFilePicker;
  w.sessionStorage.removeItem(LARGE_FILE_CHOICE_KEY);
  manual('138745');
  await waitForState(() => requested('138745') === 1, 'without a file picker the large file starts at once');
  assert.equal(navigations, 1, 'with no second trip to its page');
  console.log('large file links behavior OK');
})();

// --- The ad-blocker notice (seen live 2026-11-01) --------------------------------------------------------
// "Disable your Adblocker and double your download speed": a script outside Nexus's own draws it with
// generated class names, so it is known by its words. With "Hide ads and Premium panels" on it is answered
// with its own "Continue with adblock"; "Allow ads" and the Premium offer are never pressed. Awaited by the
// last block.
const adblockNoticeDone = (async () => {
  const NOTICE = '<div class="dgEhJe6g"><div class="_9r0K-Oum" style="background-color: rgb(43, 41, 49);"><div class="aI8fZlpv"><div class="_6Tt4x1jq"><div class="_1U8keQ4i">'
    + '<img class="vAfm8xsH" alt="" src="data:,"><h3 class="_8O9Z-ltD">Disable your Adblocker and double your download speed</h3>'
    + '<div class="_2RuuJiGc">Double your download speed from <b>1.5MB/s to 3MB/s</b> by disabling <br>your adblocker. Go premium to remove ads entirely.</div>'
    + '<div class="_4KvUwxDm"><div class="JDeYciWM"><div class="_10qg3IuH"><div class="Frame-buoy__sc-1d4hofp-0 hOxZvH"><button class="_2Sbg_-vS f5CXro_f _9eRJjhym">Allow ads</button></div></div></div>'
    + '<div class="JDeYciWM"><div class="_10qg3IuH"><div><button class="_2Sbg_-vS bpCSdKDu">Remove ads (go premium)</button></div></div></div></div>'
    + '<div class="_4e8HpQ5S"><span class="bB48ietO"><button class="_4ao5eF8B" tabindex="0">Continue with adblock</button></span><span class="_6Gy4an1f">|</span>'
    + '<span class="eX64Bioc">Need help? <a class="clSbgD5d" href="https://forms.gle/example" target="_blank" rel="noopener">Contact support</a></span></div>'
    + '</div></div></div><button tabindex="" aria-label="Close" class="_3p_1XEZR"><svg width="768" height="768" viewBox="0 0 768 768"></svg></button></div></div>';
  const w = load('file-page-signed-in.html');
  w.fetch = () => new Promise(() => {});
  w.NexusExt.Storage = {
    getSettings: async () => ({ ...w.NXTK.DEFAULTS, AutoStartDownload: false, UseOfficialApi: false }),
    sendDownloadCommand: async () => ({ ok: true, value: {} })
  };
  for (const name of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, name), 'utf8'));
  await w.NexusExt.NNW.init();
  const pressed = [];
  const showNotice = () => {
    const wrap = w.document.createElement('div');
    wrap.innerHTML = NOTICE;
    // As the notice's own script does: an answer closes it.
    wrap.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      pressed.push(button.textContent || button.getAttribute('aria-label'));
      if (button.textContent === 'Continue with adblock') wrap.remove();
    });
    w.document.body.append(wrap);
    return wrap;
  };
  // A page's own "Continue" elsewhere is not the notice's.
  const unrelated = w.document.createElement('div');
  unrelated.innerHTML = '<p>Continue with adblock tips in our forum</p><button>Continue with adblock</button>';
  w.document.getElementById('mainContent').append(unrelated);

  const shown = showNotice();
  await waitForState(() => !shown.isConnected, 'the notice is answered and closes');
  assert.deepEqual(pressed, ['Continue with adblock'], 'with its own Continue with adblock, and nothing else');
  assert.equal(w.NXTK.DEFAULTS.HidePremiumUpsells, true, '"Hide ads and Premium panels" is on by default');

  w.NexusExt.NNW.updateConfig({ ...w.NXTK.DEFAULTS, HidePremiumUpsells: false });
  const kept = showNotice();
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(kept.isConnected, 'with the setting off the notice is the user\'s to answer');
  assert.equal(pressed.length, 1);
  console.log('ad-blocker notice behavior OK');
})();

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
  for (const file of ['src/lib/download-url-parser.js', 'src/content/nnw.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
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
  await archivedFilesDone;
  await bodylessStartupDone;
  await browserDownloadLabelsDone;
  await resumableDownloadsDone;
  await largeFileLinksDone;
  await adblockNoticeDone;
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
  container.remove();
  const mainContent = w.document.getElementById('mainContent');
  const heading = w.document.createElement('h1');
  heading.textContent = 'Example collection';
  mainContent.append(heading);
  assert.equal(find()?.container, mainContent, 'rendered content works without next-container classes');
  assert.equal(find()?.layout, 'page-content');
  mainContent.setAttribute('aria-busy', 'true');
  assert.equal(find(), null, 'busy content is not used as a fallback');
  mainContent.removeAttribute('aria-busy');
  mainContent.replaceWith(...mainContent.childNodes);
  assert.equal(find(), null, 'a heading in the body alone is not a safe mount point');
  const semantic = w.document.createElement('main');
  semantic.append(heading);
  w.document.body.append(semantic);
  assert.equal(find()?.container, semantic, 'semantic main works without #mainContent');
  const result = w.NexusExt.PageCheck.runChecks({ doc: w.document, loc: w.location, findCollectionHost: find,
    isCollectionRoute: () => true });
  assert.equal(result.checks.find(c => c.id === 'deck-spot').ok, true);
  assert.ok(main.includes('scheduleDeckMountRetry(ndc)'), 'a missing spot schedules a retry instead of giving up');
}

console.log('DOM fixture behavior OK');
