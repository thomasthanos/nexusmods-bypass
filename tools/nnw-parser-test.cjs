const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE_FILE = 'src/content/nnw.js';
const MANUAL_URL = 'https://premium-files.nexus-cdn.com/100/200/manual.zip?key=a&expires=2';
const SECOND_MANUAL_URL = 'https://premium-files.nexus-cdn.com/100/201/second.zip?key=b&expires=3';
const VORTEX_URL = 'nxm://newvegas/mods/100/files/200?key=secret&expires=2000000000&user_id=7';

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
  const NXTK = {
    SETTINGS_KEY: 'nxtk_settings',
    isSafeNexusPageUrl: () => true,
    setActivity: () => {},
    setForceEnglish: () => {},
    t: (_key, _substitutions, fallback) => fallback,
    validateDownloadTarget: (url) => ({ ok: true, url })
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
    NXTK,
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

  vm.runInNewContext(fs.readFileSync(SOURCE_FILE, 'utf8'), context, { filename: SOURCE_FILE });
  return { api: context.NexusExt.NNW, calls, state };
}

function embeddedFileAttribute({
  manual = MANUAL_URL,
  vortex = VORTEX_URL,
  quote = '"',
  fileId = null
} = {}) {
  const metadata = {};
  if (fileId !== null) metadata.fileId = fileId;
  if (manual !== null) metadata.downloadUrl = manual;
  if (vortex !== null) metadata.vortexDownloadUrl = vortex;
  const encoded = JSON.stringify(metadata)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<button main-file=${quote}${encoded}${quote}>Download</button>`;
}

function metadataAttribute(metadata, attributeName = 'main-file') {
  const encoded = JSON.stringify(metadata)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<button ${attributeName}="${encoded}">Download</button>`;
}

function parserTests() {
  const { api } = createHarness();
  const parse = api.parseDownloadURLFromResponse;

  assert.deepEqual(
    JSON.parse(JSON.stringify(parse(JSON.stringify({ downloadUrl: MANUAL_URL }), false))),
    { url: MANUAL_URL, source: 'json-downloadUrl' }
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }), false)?.url,
    MANUAL_URL,
    'manual parsing must prefer downloadUrl'
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }), true)?.url,
    VORTEX_URL,
    'Vortex parsing must prefer vortexDownloadUrl'
  );

  assert.equal(
    parse(embeddedFileAttribute({ vortex: null }), false)?.url,
    MANUAL_URL,
    'manual metadata attributes must decode HTML entities'
  );
  assert.equal(
    parse(embeddedFileAttribute({ manual: null }), true)?.url,
    VORTEX_URL,
    'Vortex-only metadata must produce a clean NXM URL'
  );
  assert.equal(
    parse(embeddedFileAttribute(), false)?.url,
    MANUAL_URL,
    'manual mode must not be hijacked by an NXM URL later in the same attribute'
  );
  assert.equal(
    parse(embeddedFileAttribute({ quote: "'" }), true)?.url,
    VORTEX_URL,
    'single-quoted metadata attributes must be supported'
  );

  const malformedThenValid = '<div main-file="{not-json}"></div>'
    + embeddedFileAttribute({ manual: SECOND_MANUAL_URL, vortex: null });
  assert.equal(
    parse(malformedThenValid, false)?.url,
    SECOND_MANUAL_URL,
    'one malformed attribute must not hide a later valid one'
  );

  const profilePayload = embeddedFileAttribute({ vortex: null })
    .replace('main-file=', 'profile=');
  assert.equal(
    parse(profilePayload, { mode: 'browser', allowBareCdn: false }),
    null,
    'profile= must not be mistaken for a file= metadata attribute'
  );

  const invalidThenValid = `<a data-download-url="http://premium-files.nexus-cdn.com/unsafe.zip"></a>`
    + `<a data-download-url="${MANUAL_URL.replace(/&/g, '&amp;')}"></a>`;
  assert.equal(
    parse(invalidThenValid, { mode: 'browser', allowBareCdn: false })?.url,
    MANUAL_URL,
    'an invalid early candidate must not hide a later valid one'
  );

  assert.equal(
    parse(JSON.stringify({ downloadUrl: 'https://evil.example/payload.zip' }), false),
    null,
    'off-domain download candidates must be rejected'
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: 'http://premium-files.nexus-cdn.com/unsafe.zip' }), false),
    null,
    'insecure CDN candidates must be rejected'
  );

  const fileScopedAttributes = embeddedFileAttribute({
    fileId: 201,
    manual: SECOND_MANUAL_URL,
    vortex: null
  }) + embeddedFileAttribute({
    fileId: 200,
    manual: MANUAL_URL,
    vortex: null
  });
  assert.equal(
    parse(fileScopedAttributes, { mode: 'browser', fileId: '200', allowBareCdn: false })?.url,
    MANUAL_URL,
    'file-scoped metadata must select the requested file ID'
  );

  // A nested string sends the parser back through the attribute scanner. The
  // scan must not lose its place, or the decoy is re-read until the node budget
  // is gone and the real link that follows it is never looked at.
  const decoyWithNestedPayload = metadataAttribute({ html: '<div>no link in here</div>' })
    + embeddedFileAttribute({ fileId: 200, manual: MANUAL_URL, vortex: null });
  const afterDecoy = parse(decoyWithNestedPayload, {
    mode: 'browser',
    fileId: '200',
    allowBareCdn: false
  });
  assert.equal(
    afterDecoy?.url,
    MANUAL_URL,
    'an attribute whose nested payload re-enters the parser must not starve later attributes'
  );
  assert.equal(afterDecoy?.source, 'embedded-file-attr');

  const crowdedFilesTab = Array.from({ length: 40 }, (_, index) => (
    metadataAttribute({ html: `<div>row ${index}</div>` })
  )).join('')
    + embeddedFileAttribute({ fileId: 200, manual: MANUAL_URL, vortex: null });
  assert.equal(
    parse(crowdedFilesTab, { mode: 'browser', fileId: '200', allowBareCdn: false })?.url,
    MANUAL_URL,
    'a files tab full of unrelated metadata must not hide the requested file'
  );

  assert.equal(
    parse(
      embeddedFileAttribute({ fileId: 201, manual: SECOND_MANUAL_URL, vortex: null }),
      { mode: 'browser', fileId: '200', allowBareCdn: false }
    ),
    null,
    'metadata for a different file ID must not be used'
  );

  const nested = JSON.stringify({
    data: JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL })
  });
  assert.equal(parse(nested, false)?.url, MANUAL_URL);
  assert.equal(parse(nested, true)?.url, VORTEX_URL);

  const arrayPayload = JSON.stringify([
    { ignored: true },
    { downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }
  ]);
  assert.equal(parse(arrayPayload, false)?.url, MANUAL_URL, 'JSON response arrays must be searched');
  assert.equal(parse(arrayPayload, true)?.url, VORTEX_URL, 'JSON response arrays must honor Vortex mode');

  assert.equal(
    parse(`download = (${MANUAL_URL});`, false)?.url,
    MANUAL_URL,
    'bare CDN extraction must remove JavaScript punctuation'
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&amp;'), false)?.url,
    MANUAL_URL,
    'bare CDN query strings must decode HTML entities'
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&#38;'), false)?.url,
    MANUAL_URL,
    'decimal character references must decode'
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&#x0026;'), false)?.url,
    MANUAL_URL,
    'hexadecimal character references must decode'
  );
  assert.equal(parse(MANUAL_URL, true), null, 'Vortex mode must not fall back to a browser CDN URL');
  assert.equal(
    parse(`first=${MANUAL_URL} second=${SECOND_MANUAL_URL}`, false),
    null,
    'ambiguous bare CDN candidates must not select an arbitrary file'
  );

  assert.equal(api.parseNxmDownloadLink(VORTEX_URL), VORTEX_URL);
  assert.equal(
    api.parseNxmDownloadLink(VORTEX_URL.replace(/&/g, '&amp;')),
    VORTEX_URL,
    'encoded NXM query separators must decode cleanly'
  );
  assert.equal(
    api.parseNxmDownloadLink(VORTEX_URL.replace(/&/g, '&#x26;')),
    VORTEX_URL,
    'numeric NXM query separators must decode cleanly'
  );
  assert.equal(
    api.parseNxmDownloadLink(`</textarea><b>x</b> ${VORTEX_URL}`),
    VORTEX_URL,
    'markup in the response must not cut the value short'
  );
  assert.equal(
    api.parseNxmDownloadLink('nxm://newvegas/mods/100/files/200?key=secret&expires=1'),
    null,
    'unsigned/incomplete NXM URLs must be rejected'
  );
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
