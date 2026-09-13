const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { MANUAL_URL, SECOND_MANUAL_URL, VORTEX_URL, runParserCases } = require('./download-parser-cases.cjs');

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
  responses = []
} = {}) {
  const parsedLocation = new URL(href);
  const calls = [];
  const state = {
    sectionGameId,
    dataGameIds: [...dataGameIds],
    scripts: [...scripts],
    responses: [...responses]
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
    Errors,
    Auth: {},
    Storage: { DEFAULTS: {} },
    UI: {}
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
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document,
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
  for (const file of ['src/shared.js', 'src/download-url-parser.js', SOURCE_FILE]) {
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
  .then(() => console.log('nnw.js parser and fallback behavior OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
