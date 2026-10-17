const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
  LegacyChromiumURL,
  MANUAL_URL,
  SECOND_MANUAL_URL,
  VORTEX_URL,
  runParserCases
} = require('./download-parser-cases.cjs');

const SOURCE_FILE = 'src/content/nnw.js';

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function createTextarea() {
  let html = '';
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
      this.value = decodeHtml(html);
    },
    value: ''
  };
}

function response(text, overrides = {}) {
  return {
    ok: true,
    status: 200,
    text,
    finalUrl: 'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl',
    error: null,
    ...overrides
  };
}

function createHarness({
  href = 'https://www.nexusmods.com/newvegas/mods/100?tab=files&file_id=200',
  sectionGameId = '',
  dataGameIds = [],
  scripts = [],
  responses = [],
  // With pages, requests go through the real errors.js and response classifier and are answered from this list.
  pages = null,
  // The URL class the page sees, for a browser whose parser differs from Node's.
  url = URL
} = {}) {
  const parsedLocation = new URL(href);
  const calls = [];
  const recorded = [];
  const listeners = {};
  const state = {
    sectionGameId,
    dataGameIds: [...dataGameIds],
    scripts: [...scripts],
    responses: [...responses],
    pages: [...(pages || [])]
  };

  const document = {
    body: {},
    cookie: '',
    documentElement: {},
    createElement: (name) => {
      assert.equal(name, 'textarea');
      return createTextarea();
    },
    getElementById: (id) => {
      if (id !== 'section' || !state.sectionGameId) return null;
      return { dataset: { gameId: state.sectionGameId } };
    },
    querySelectorAll: (selector) => {
      if (selector === '[data-game-id]') {
        return state.dataGameIds.map((gameId) => ({ dataset: { gameId } }));
      }
      if (selector === 'script') {
        return state.scripts.map((textContent) => ({ textContent }));
      }
      return [];
    }
  };

  const Errors = {
    DEFAULT_TIMEOUT_MS: 30000,
    create: (code, details = {}) => ({ code, retryable: false, ...details }),
    record: (error) => recorded.push(error),
    isBlocking: () => false,
    request: async (url, options = {}, metadata = {}) => {
      calls.push({ url, options, metadata });
      if (!state.responses.length) throw new Error(`Unexpected request: ${url}`);
      return state.responses.shift();
    }
  };

  const NexusExt = {
    ...(pages ? {} : { Errors }),
    Auth: {},
    Storage: { DEFAULTS: {} },
    UI: {}
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!state.pages.length) throw new Error(`Unexpected request: ${url}`);
    const { status = 200, body = '', failure, finalUrl } = state.pages.shift();
    if (failure) throw failure;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: finalUrl || String(url),
      text: async () => body,
      headers: { get: () => '' }
    };
  };
  const context = {
    AbortController,
    Array,
    Date,
    Error,
    JSON,
    Map,
    Math,
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    NexusExt,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL: url,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document,
    fetch,
    navigator: { onLine: true },
    location: {
      href: parsedLocation.href,
      origin: parsedLocation.origin,
      pathname: parsedLocation.pathname,
      hostname: parsedLocation.hostname,
      assign: () => {}
    },
    setInterval,
    setTimeout,
    addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); },
    chrome: {
      runtime: { id: 'test-extension-id', sendMessage: (message) => {
        if (message.type === 'ERROR_LOG_APPEND') recorded.push(message.payload.entry);
        return Promise.resolve();
      } },
      storage: { onChanged: { addListener: () => {} } }
    }
  };
  context.window = context;

  // In the order the manifest loads them: the shared rules and the link parser come before nnw.js.
  const files = pages
    ? ['src/shared.js', 'src/selectors.js', 'src/response-classifier.js', 'src/download-url-parser.js', 'src/content/errors.js', SOURCE_FILE]
    : ['src/shared.js', 'src/selectors.js', 'src/download-url-parser.js', SOURCE_FILE];
  for (const file of files) {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  const fire = (type) => (listeners[type] || []).forEach((listener) => listener({ type }));
  return { api: context.NexusExt.NNW, calls, state, recorded, fire };
}

// Discord reports from 3.1.1: an unreadable /api/files redirect stopped the flow before the
// same-origin generator could answer. Exercise actual Errors.request, not a canned error object.
async function apiRouteRecoveryTests() {
  const href = 'https://www.nexusmods.com/api/files/200?game=130';
  for (const isNMM of [false, true]) {
    const link = isNMM ? VORTEX_URL : MANUAL_URL;
    const h = createHarness({ sectionGameId: '130', pages: [
      { failure: new TypeError('Failed to fetch') },
      { body: JSON.stringify({ url: link }) }
    ] });
    const result = await h.api.getDownloadUrl({ isNMM, href });
    assert.equal(result.url, link, 'the generator recovers an unreadable API route');
    assert.equal(h.calls.length, 2, 'one route attempt and one generator attempt');
    const body = new URLSearchParams(h.calls[1].options.body);
    assert.equal(body.get('fid'), '200', 'the clicked file is recovered from the API path');
    assert.equal(body.get('game_id'), '130');
    assert.equal(body.get('nmm'), isNMM ? '1' : null);
    assert.equal(h.recorded.length, 0, 'a successful fallback creates no error report');
  }
  for (const status of [401, 403, 404, 429]) {
    const h = createHarness({ pages: [{ status }] });
    const result = await h.api.getDownloadUrl({ fileId: '200', isNMM: false, href });
    assert.ok(result.error, `HTTP ${status} remains an error`);
    assert.equal(h.calls.length, 1, 'authentication, access and rate limits are not worked around');
    assert.equal(h.recorded.length, 1, 'one final failure is recorded');
  }
  const failed = createHarness({ sectionGameId: '130', pages: Array.from({ length: 4 }, () => ({ failure: new TypeError('Failed to fetch') })) });
  const result = await failed.api.getDownloadUrl({ fileId: '200', isNMM: false, href });
  assert.equal(result.error.code, 'network_error');
  assert.equal(failed.recorded.length, 1, 'multiple failed attempts record just the final failure');
  assert.match(result.error.technicalMessage, /GET|POST/);
  assert.match(result.error.technicalMessage, /no readable HTTP response/);
  assert.doesNotMatch(result.error.technicalMessage, /api\/files\/200|\?game=|https:/);
  assert.equal(failed.calls[2].url, 'https://www.nexusmods.com/newvegas/mods/100?tab=files&file_id=200', 'the page fallback loads the file page, not the failed API route again');
}

// nnw.js reads responses through download-url-parser.js; every parser case has to hold through its wrappers.
function parserTests() {
  const { api } = createHarness();
  runParserCases({
    parse: api.parseDownloadURLFromResponse,
    parseNxmDownloadLink: api.parseNxmDownloadLink,
    label: 'page'
  });
}

async function downloadFlowTests() {
  const bothUrls = JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL });

  {
    const harness = createHarness({ sectionGameId: '130', responses: [response(bothUrls)] });
    const result = await harness.api.getDownloadUrl({ fileId: '200', isNMM: false });
    assert.equal(result.url, MANUAL_URL, 'manual flow must not return the Vortex URL');
    assert.equal(new URLSearchParams(harness.calls[0].options.body).get('game_id'), '130');
  }

  {
    const harness = createHarness({ sectionGameId: '130', responses: [response(bothUrls)] });
    const result = await harness.api.getDownloadUrl({ fileId: '200', isNMM: true });
    assert.equal(result.url, VORTEX_URL, 'Vortex flow must select the signed NXM URL');
    assert.equal(new URLSearchParams(harness.calls[0].options.body).get('nmm'), '1');
  }

  {
    const harness = createHarness({
      scripts: ['window.bootstrap = { "game_id": 130 };'],
      responses: [response(JSON.stringify({ downloadUrl: MANUAL_URL }))]
    });
    await harness.api.getDownloadUrl({ fileId: '200', isNMM: false });
    assert.equal(
      new URLSearchParams(harness.calls[0].options.body).get('game_id'),
      '130',
      'script metadata must supply the numeric game ID when page markers are absent'
    );
  }

  {
    const harness = createHarness({
      responses: [response(JSON.stringify({ downloadUrl: MANUAL_URL }))]
    });
    await harness.api.getDownloadUrl({ fileId: '200', isNMM: false });
    assert.equal(
      new URLSearchParams(harness.calls[0].options.body).get('game_id'),
      'newvegas',
      'legacy pages must fall back to the game-domain slug'
    );
  }

  {
    const harness = createHarness({
      scripts: [
        'window.first = { gameId: 130 };',
        'window.second = { gameId: 999 };'
      ],
      responses: [response(JSON.stringify({ downloadUrl: MANUAL_URL }))]
    });
    await harness.api.getDownloadUrl({ fileId: '200', isNMM: false });
    assert.equal(
      new URLSearchParams(harness.calls[0].options.body).get('game_id'),
      'newvegas',
      'conflicting script IDs must be ignored in favor of the canonical game slug'
    );
  }

  {
    const harness = createHarness({
      responses: [response(JSON.stringify({ downloadUrl: MANUAL_URL }))]
    });
    await harness.api.getDownloadUrl({
      fileId: '200',
      isNMM: false,
      href: 'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl'
    });
    assert.equal(
      new URLSearchParams(harness.calls[0].options.body).get('game_id'),
      'newvegas',
      '/Core resolver URLs must inherit the canonical page slug, never send Core as the game ID'
    );
  }

  {
    const harness = createHarness({
      scripts: ['window.bootstrap = { gameId: 130 };'],
      responses: [
        response(JSON.stringify({ downloadUrl: MANUAL_URL })),
        response(JSON.stringify({ downloadUrl: SECOND_MANUAL_URL }))
      ]
    });
    await harness.api.getDownloadUrl({ fileId: '200', isNMM: false });
    harness.state.scripts = ['window.bootstrap = { gameId: 999 };'];
    await harness.api.getDownloadUrl({ fileId: '201', isNMM: false });
    assert.equal(
      new URLSearchParams(harness.calls[1].options.body).get('game_id'),
      '130',
      'a game-domain cache hit must avoid rescanning conflicting script data'
    );
  }
}

// Bug report #7: residentevilrequiem/mods/972?file_id=2576 belonged to a mod its author had removed. Nexus
// answered the file page with a notice, the flow reported "no usable link", and every Retry asked the
// generator twice more. The page's answer now names the reason and ends the attempt.
async function removedModFlowTests() {
  const href = 'https://www.nexusmods.com/residentevilrequiem/mods/972?file_id=2576';
  const removedPage = '<html><body><form action="https://users.nexusmods.com/auth/sign_out"></form>'
    + '<div class="wrapper" id="mainContent"><div id="Notice3354" class="info warning clearfix site-notice " style="">'
    + ' <div class="info-content"> <h3 id="Notice3354-title">Removed by author</h3>'
    + ' <p id="Notice3354-paragraph"> The mod you were looking for was removed by its author </p> </div> </div>'
    + '</div></body></html>';
  const harness = createHarness({
    href,
    // What the generator says without a link is not known for this case; any linkless answer will do.
    pages: [{ body: JSON.stringify({ url: '' }) }, { body: removedPage }]
  });

  const result = await harness.api.getDownloadUrl({ fileId: '2576', isNMM: false, href });
  assert.equal(result.url, null);
  assert.equal(result.error?.code, 'mod_unavailable', 'the removed mod is named as such');
  assert.equal(result.error?.retryable, false, 'so the dialog offers Done rather than Retry');
  assert.match(result.error?.technicalMessage || '', /"Removed by author" notice/, 'and the report says which notice');
  assert.deepEqual(harness.calls.map((call) => call.url), [
    'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl',
    href
  ], 'nothing is asked a second time');
}

// Bug report #9: on Chrome 119 the Vortex button of masseffectlegendaryedition/mods/23 ended in "Nexus Mods
// did not return a valid Vortex link" every time. Nexus had answered with a signed link; that browser gave
// nxm:// URLs no host, and the check refused it.
async function legacyChromiumVortexTests() {
  const href = 'https://www.nexusmods.com/masseffectlegendaryedition/mods/23?tab=files&file_id=12218&nmm=1';
  const link = 'nxm://masseffectlegendaryedition/mods/23/files/12218?key=signed&expires=2000000000&user_id=7';
  const harness = createHarness({
    href,
    url: LegacyChromiumURL,
    responses: [
      response(JSON.stringify({ url: link })),
      response('<html><body><div id="mainContent">Slow download</div></body></html>', { finalUrl: href })
    ]
  });

  const result = await harness.api.getDownloadUrl({ fileId: '12218', isNMM: true, href });
  assert.equal(result.error, undefined, 'no error is reported');
  assert.equal(result.url, link, 'the signed link Nexus generated is handed to Vortex');
  assert.equal(new URLSearchParams(harness.calls[0].options.body).get('nmm'), '1');
}

// Live report (SkyUI 12604): the Vortex hand-off waited seconds for the whole file page before asking for
// the link. The generator is asked first, and the page is not loaded at all when it answers.
async function vortexGeneratorFirstTests() {
  const href = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35407&nmm=1';
  const link = 'nxm://skyrimspecialedition/mods/12604/files/35407?key=k&expires=2000000000&user_id=7';
  const quick = createHarness({ href, responses: [response(JSON.stringify({ url: link }))] });
  const result = await quick.api.getDownloadUrl({ fileId: '35407', isNMM: true, href });
  assert.equal(result.url, link);
  assert.deepEqual(quick.calls.map((call) => call.url),
    ['https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl'],
    'one small POST, no file-page load');

  // No link from the generator: the page is still read, and the generator is not asked twice.
  const fallback = createHarness({
    href,
    responses: [
      response(JSON.stringify({ url: '' })),
      response(`<html><body><a href="${link}">x</a></body></html>`, { finalUrl: href })
    ]
  });
  const second = await fallback.api.getDownloadUrl({ fileId: '35407', isNMM: true, href });
  assert.equal(second.url, link, 'the page fallback still finds the link');
  assert.equal(fallback.calls.length, 2, 'generator once, page once');
}

// Discord reports from 3.1.4 (Opera, Edge, Chrome): "no Vortex link" arrived with no context and no
// technical cause, and a failed generator POST said nothing about the steps around it. The final error
// now names what each step was answered, as a shape with no link, key, number or page text in it.
async function missingLinkTrailTests() {
  const href = 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35407&nmm=1';
  const vortex = createHarness({
    href,
    responses: [
      response('{"url":""}'),
      response('<!doctype html><html><body><button id="slowDownloadButton">Slow download</button></body></html>', { finalUrl: href })
    ]
  });
  const result = await vortex.api.getDownloadUrl({ fileId: '35407', isNMM: true, href });
  assert.equal(result.error.code, 'no_nmm_link');
  assert.equal(result.error.context, 'Finding the Vortex link', 'the report says which action it was');
  assert.equal(result.error.technicalMessage,
    'steps: generator HTTP 200: JSON {url}; url empty; no link in it'
    + ' | page HTTP 200: HTML page; slow-download button; no link in it',
    'and what the generator and the page answered');
  assert.equal(vortex.recorded.length, 1, 'recorded once');
  assert.equal(vortex.recorded[0].technicalMessage, result.error.technicalMessage, 'with the steps in the log');

  const refused = createHarness({
    href,
    responses: [
      response('{"url":"nxm://skyrimspecialedition/mods/12604/files/35407?key=k&expires=2000000000"}'),
      response('<!doctype html><html><body></body></html>', { finalUrl: href })
    ]
  });
  const unsigned = await refused.api.getDownloadUrl({ fileId: '35407', isNMM: true, href });
  assert.match(unsigned.error.technicalMessage, /generator HTTP 200: JSON \{url\}; unsigned nxm link \(no user_id\)/,
    'a link that came back without its signature says so');
  assert.doesNotMatch(unsigned.error.technicalMessage, /nxm:\/\/|key=|2000000000/, 'without the link itself');

  // A browser download whose generator POST fails while the page loads: the request, not the
  // connection, is what failed, and the time it took says how.
  const blocked = createHarness({
    pages: [
      { failure: new TypeError('Failed to fetch') },
      { body: '<!doctype html><html><body><h1>Example</h1></body></html>' },
      { failure: new TypeError('Failed to fetch') }
    ]
  });
  const network = await blocked.api.getDownloadUrl({ fileId: '200', isNMM: false });
  assert.equal(network.error.code, 'network_error');
  assert.match(network.error.technicalMessage, /fetch failed after \d+ms: POST Nexus download generator; no readable HTTP response/);
  assert.match(network.error.technicalMessage,
    /steps: generator network_error \| page HTTP 200: HTML page; no link in it \| generator network_error$/);
  assert.equal(blocked.recorded.length, 1, 'one final failure is recorded');
}

// Live reports: "Mod manager download" rendered as a plain button skipped the requirement-screen skip,
// and the requirements modal's Close button was taken as a download, so the modal could not be closed.
function controlClassificationTests() {
  const api = createHarness({ href: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files' }).api;
  const node = (text, attrs = {}, extra = {}) => ({
    textContent: text,
    className: extra.className || '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
    matches: (selector) => (extra.id ? selector === `#${extra.id}` : false),
    closest: () => null
  });
  // Nexus's components carry the file as JSON (live SkyUI markup), not as file-id.
  const el = (tagName, attrs) => ({ nodeType: 1, tagName, id: '', dataset: {}, getAttribute: (n) => attrs[n] ?? null });
  assert.equal(api.fileIdFromNode(el('MOD-FILE-DOWNLOAD', { file: '{"id":35407,"name":"SkyUI"}' })), '35407');
  assert.equal(api.fileIdFromNode(el('MOD-DOWNLOAD-BUTTONS', { 'main-file': '{"id":35408}' })), '35408');
  assert.equal(api.fileIdFromNode(el('MOD-DOWNLOAD-MODAL', { file: '{"fileId":7}' })), '7');
  assert.equal(api.fileIdFromNode(el('DOWNLOAD-MODAL', { 'file-id': '9' })), '9');
  assert.equal(api.fileIdFromNode(el('MOD-FILE-DOWNLOAD', { file: 'not json' })), '');
  assert.equal(api.hrefWantsNmm('/x/mods/1?tab=files&file_id=2&nmm=1'), true);
  assert.equal(api.hrefWantsNmm('/x/mods/1?tab=files&file_id=2&nmm=0'), false, 'nmm=0 is not Vortex');
  assert.equal(api.hrefWantsNmm('/x/mods/1?file_id=2&nmmx=1'), false);

  assert.equal(api.classifyDownloadControl(node('Mod manager download')), 'nmm');
  assert.equal(api.classifyDownloadControl(node('Vortex')), 'nmm');
  assert.equal(api.classifyDownloadControl(node('', {}, { id: 'action-nmm' })), 'nmm', 'by id, whatever the text');
  assert.equal(api.classifyDownloadControl(node('Manual download')), 'manual');
  assert.equal(api.classifyDownloadControl(node('Endorse')), '', 'other buttons are left alone');

  for (const close of [node('Close'), node('×'), node('', { 'aria-label': 'Close' }), node('Cancel'),
    node('', { 'data-close': '' }), node('x', {}, { className: 'modal-close' }), node('Schließen')]) {
    assert.equal(api.isDismissControl(close), true, `"${close.textContent || close.className}" dismisses`);
    assert.equal(api.classifyDownloadControl(close), '', 'and is never a download');
  }
}

// Discord reports E-1r1m6gn (3.1.5 and 3.1.6, every browser, Vortex and Mod Organizer 2): "the nxm
// link names another file" on finalfantasy12/mods/375. Nexus's modal names the file by uid
// (game 2304 * 2^32 + file 2394) in /api/files/<uid>/download, and that uid was taken as the file id:
// the link search lost its scope and the right link was then refused as another file's.
async function fileUidTests() {
  const UID = '9895604652378';
  const href = `https://www.nexusmods.com/api/files/${UID}/download?nmm=1`;
  const nxm = (file) => `nxm://finalfantasy12/mods/375/files/${file}?key=k&expires=2000000000&user_id=7`;
  const page = 'https://www.nexusmods.com/finalfantasy12/mods/375?tab=files';

  const scoped = createHarness({ href: page, sectionGameId: '2304', pages: [
    { body: `<div>${nxm(2393)} ${nxm(2394)}</div>` }
  ] });
  const result = await scoped.api.getDownloadUrl({ fileId: UID, isNMM: true, href });
  assert.equal(result.url, nxm(2394), 'the link for the uid\'s own file, not the first one on the page');

  const recovered = createHarness({ href: page, sectionGameId: '2304', pages: [
    { failure: new TypeError('Failed to fetch') },
    { body: JSON.stringify({ url: nxm(2394) }) }
  ] });
  const viaGenerator = await recovered.api.getDownloadUrl({ fileId: UID, isNMM: true, href });
  assert.equal(viaGenerator.url, nxm(2394));
  assert.equal(new URLSearchParams(recovered.calls[1].options.body).get('fid'), '2394', 'the generator is asked for the file id');

  const fromPath = createHarness({ href: page, sectionGameId: '2304', pages: [
    { failure: new TypeError('Failed to fetch') },
    { body: JSON.stringify({ url: nxm(2394) }) }
  ] });
  await fromPath.api.getDownloadUrl({ isNMM: true, href });
  assert.equal(new URLSearchParams(fromPath.calls[1].options.body).get('fid'), '2394', 'also when the id comes from the route');

  // E-0jjutro: "page HTTP 200: plain text body". Asked with X-Requested-With, Nexus answers a mod page
  // with the tab fragment, which has no nxm link; the download page a click opens carries it in
  // <mod-file-download download-url>. The generator is no help here: the site never asks it for nmm=1.
  const filePage = `${page}&file_id=2394&nmm=1`;
  const loaded = createHarness({ href: filePage, sectionGameId: '2304', responses: [
    response('[]'),
    response(`<!doctype html><html><body><mod-file-download file-id="2394" is-nmm-download="true" download-url="${nxm(2394).replace(/&/g, '&amp;')}"></mod-file-download></body></html>`, { finalUrl: filePage })
  ] });
  const fromPage = await loaded.api.getDownloadUrl({ fileId: '2394', isNMM: true, href: filePage });
  assert.equal(fromPage.url, nxm(2394));
  assert.equal(loaded.calls[1].url, filePage);
  assert.equal(loaded.calls[1].options.headers?.['X-Requested-With'], undefined, 'the page is loaded the way a click loads it');

  const api = scoped.api;
  const el = (tagName, attrs) => ({ nodeType: 1, tagName, id: '', dataset: {}, getAttribute: (n) => attrs[n] ?? null });
  assert.equal(api.fileIdFromNode(el('MOD-DOWNLOAD-MODAL', { file: `{"name":"A","uid":${UID}}` })), '2394', 'a modal that names only its uid');
  assert.equal(api.fileIdFromNode(el('MOD-DOWNLOAD-MODAL', { file: `{"id":"Z2lkOi8vYXBpL01vZEZpbGUv","uid":"${UID}"}` })), '2394',
    'a GraphQL global id is passed over for the uid');
  const links = (uid) => JSON.stringify({ vortexDownloadUrl: `https://www.nexusmods.com/api/files/${uid}/download?nmm=1` });
  assert.equal(api.pickModalHref({ modalFileId: '2394', linksJson: links(UID), isNMM: true }), href,
    'the modal\'s own route is kept when it names the clicked file by uid');
  assert.equal(api.pickModalHref({ modalFileId: '2394', linksJson: links('9895604652377'), isNMM: true, base: page.replace('?tab=files', '') }),
    `${page}&file_id=2394&nmm=1`, 'and replaced when it names another file');
}

// E-0fk41cm: "Failed to fetch after 4580ms … page hidden". A tab that is closed or navigated drops its
// requests with the same TypeError a dead connection gives; that is the page going away, not a fault.
async function leavingPageTests() {
  const h = createHarness({ pages: [{ failure: new TypeError('Failed to fetch') }, { failure: new TypeError('Failed to fetch') }] });
  h.fire('pagehide');
  const result = await h.api.getDownloadUrl({ fileId: '200', isNMM: true });
  assert.equal(result.error.code, 'aborted', 'a request cut off by leaving the page is a cancel');
  assert.equal(h.recorded.length, 0, 'and is not logged as an error');

  const back = createHarness({ pages: [{ failure: new TypeError('Failed to fetch') }] });
  back.fire('pagehide');
  back.fire('pageshow');
  assert.equal((await back.api.getDownloadUrl({ fileId: '200', isNMM: true })).error.code, 'network_error',
    'a page restored from the back-forward cache reports failures again');
}

function modPageDetectionTests() {
  const cases = [
    ['https://www.nexusmods.com/newvegas/mods/100', true, 'a mod page is handled'],
    ['https://www.nexusmods.com/newvegas/mods/100/', true, 'a trailing slash must not switch the hooks off'],
    ['https://www.nexusmods.com/newvegas/mods/100?tab=files&file_id=200', true, 'a file page is handled'],
    ['https://www.nexusmods.com/newvegas/mods', false, 'a mod list page is left alone'],
    ['https://www.nexusmods.com/newvegas/collections/abc', false, 'collection pages are left alone']
  ];
  for (const [href, expected, message] of cases) {
    assert.equal(createHarness({ href }).api.isActionablePage(), expected, message);
  }
}

Promise.resolve()
  .then(parserTests)
  .then(modPageDetectionTests)
  .then(downloadFlowTests)
  .then(apiRouteRecoveryTests)
  .then(removedModFlowTests)
  .then(legacyChromiumVortexTests)
  .then(vortexGeneratorFirstTests)
  .then(controlClassificationTests)
  .then(missingLinkTrailTests)
  .then(fileUidTests)
  .then(leavingPageTests)
  .then(() => console.log('nnw.js parser and fallback behavior OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
