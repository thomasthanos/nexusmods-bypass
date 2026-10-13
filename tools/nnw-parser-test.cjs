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
    const { status = 200, body = '' } = state.pages.shift();
    return {
      ok: status >= 200 && status < 300,
      status,
      url: String(url),
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
    chrome: {
      runtime: { id: 'test-extension-id', sendMessage: () => Promise.resolve() },
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
  return { api: context.NexusExt.NNW, calls, state };
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
  .then(removedModFlowTests)
  .then(legacyChromiumVortexTests)
  .then(vortexGeneratorFirstTests)
  .then(controlClassificationTests)
  .then(() => console.log('nnw.js parser and fallback behavior OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
