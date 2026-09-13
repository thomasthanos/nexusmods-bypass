const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { MANUAL_URL, SECOND_MANUAL_URL, VORTEX_URL, runParserCases } = require('./download-parser-cases.cjs');

// The parser as the service worker loads it: through importScripts, with no window, document or location.
function loadWorkerParser({ withShared = true } = {}) {
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    chrome: {
      runtime: { id: 'test-extension-id', lastError: null },
      i18n: { getMessage: () => '', getUILanguage: () => 'en' },
      storage: {
        local: { get: (_key, callback) => callback({}) },
        onChanged: { addListener: () => {} }
      }
    }
  });
  context.importScripts = (...paths) => {
    for (const path of paths) {
      vm.runInContext(fs.readFileSync(`src/${path}`, 'utf8'), context, { filename: `src/${path}` });
    }
  };
  if (withShared) context.importScripts('shared.js');
  context.importScripts('download-url-parser.js');
  return context;
}

function workerRunsEveryCase() {
  const context = loadWorkerParser();
  for (const name of ['window', 'document', 'location']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'undefined', `the worker context has no ${name}`);
  }
  const Parser = context.NXTKDownloadParser;
  runParserCases({
    parse: (text, options) => Parser.findDownloadLink(text, options),
    parseNxmDownloadLink: (text) => Parser.findSignedNxmLink(text),
    label: 'worker'
  });
  return Parser;
}

function workerEdgeCases(Parser) {
  assert.equal(
    Parser.findDownloadLink('{"url":"/api/files/200"}', { mode: 'vortex' })?.url,
    'https://www.nexusmods.com/api/files/200',
    'with no page to resolve against, a relative resolver link resolves against Nexus'
  );
  assert.equal(
    Parser.findDownloadLink('{"url":"/api/files/200"}', { mode: 'vortex', baseUrl: 'https://next.nexusmods.com/skyrim/mods/1' })?.url,
    'https://next.nexusmods.com/api/files/200',
    'and against the page when the caller passes one'
  );

  // The worker's old reader took vortexDownloadUrl in browser mode, which could hand a Nexus page to
  // chrome.downloads as though it were the file.
  assert.equal(
    Parser.findDownloadLink(JSON.stringify({
      vortexDownloadUrl: 'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl'
    })),
    null,
    'a browser download never takes the Vortex resolver page as the file'
  );

  assert.equal(
    Parser.findDownloadLink(JSON.stringify([
      { fileId: 201, downloadUrl: SECOND_MANUAL_URL },
      { fileId: 200, downloadUrl: MANUAL_URL }
    ]), { fileId: 200, allowBareCdn: false })?.url,
    MANUAL_URL,
    'a list of files yields the requested one, whatever its position'
  );
  assert.equal(
    Parser.findDownloadLink(JSON.stringify({ fileId: 201, downloadUrl: SECOND_MANUAL_URL }), { fileId: '200', allowBareCdn: false }),
    null,
    'a link that belongs to another file is refused'
  );

  let deep = { downloadUrl: MANUAL_URL };
  for (let level = 0; level < 40; level += 1) deep = { data: deep };
  assert.equal(Parser.findDownloadLink(JSON.stringify(deep), { allowBareCdn: false }), null,
    'nesting beyond the cap is not followed');

  const crowd = JSON.stringify([
    ...Array.from({ length: 5000 }, (_, index) => ({ fileId: index + 1000 })),
    { downloadUrl: MANUAL_URL }
  ]);
  assert.equal(Parser.findDownloadLink(crowd, { allowBareCdn: false }), null,
    'a huge response stops at the node budget instead of being walked in full');

  const padded = `${' '.repeat(Parser.MAX_INPUT_CHARS)}${JSON.stringify({ downloadUrl: MANUAL_URL })}`;
  assert.equal(Parser.findDownloadLink(padded), null, 'nothing past the input cap is read');

  assert.equal(
    Parser.decodeLinkText('a&amp;b&#38;c&#x26;d&quot;e\\/f\\u0026g'),
    'a&b&c&d"e/f&g',
    'named and numeric entities and JSON escapes are resolved'
  );
  assert.equal(
    Parser.decodeLinkText('&bogus;&#0;&#x110000;&constructor;'),
    '&bogus;&#0;&#x110000;&constructor;',
    'unknown or out-of-range entities are left as written'
  );

  assert.equal(Parser.isSignedNxmLink(VORTEX_URL), true, 'a signed handoff link is recognised');
  assert.equal(Parser.isSignedNxmLink(VORTEX_URL.replace(/&/g, '&amp;')), true, 'also when it arrives encoded');
  assert.equal(Parser.isSignedNxmLink(`${VORTEX_URL}#more`), false, 'a fragment is not part of a handoff link');
  assert.equal(Parser.isSignedNxmLink('nxm://newvegas/mods/100/files/200?key=&expires=1&user_id=7'), false,
    'an empty key is not a signature');
  assert.equal(Parser.isSignedNxmLink('nxm://newvegas/mods/x/files/200?key=a&expires=1&user_id=7'), false,
    'the mod id has to be a number');
  assert.equal(Parser.isSignedNxmLink(`${VORTEX_URL} and more`), false, 'a link with text after it is not the link');
}

function failsClosedWithoutShared() {
  const Parser = loadWorkerParser({ withShared: false }).NXTKDownloadParser;
  assert.equal(Parser.findDownloadLink(JSON.stringify({ downloadUrl: MANUAL_URL })), null,
    'without the shared download-target rules no https link is trusted');
  assert.equal(Parser.findDownloadLink(JSON.stringify({ vortexDownloadUrl: VORTEX_URL }), true)?.url, VORTEX_URL,
    'a signed nxm link is still checked by the parser itself');
}

const Parser = workerRunsEveryCase();
workerEdgeCases(Parser);
failsClosedWithoutShared();
console.log('download-url parser behavior OK');
