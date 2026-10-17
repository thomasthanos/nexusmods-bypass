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

// The parser as the service worker loads it: through importScripts, with no window, document or location.
function loadWorkerParser({ withShared = true, url = URL } = {}) {
  const context = vm.createContext({
    console,
    URL: url,
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

  // Why there was no link, as the page and the worker put it in a report: the answer's shape and what
  // became of each candidate, with no link, key, number or page text in it.
  const browser = { mode: 'browser', fileId: '200' };
  const vortex = { mode: 'vortex', fileId: '200' };
  for (const [text, options, expected] of [
    ['{"url":""}', vortex, 'JSON {url}; url empty; no link in it'],
    ['{"success":false,"error":"Invalid file 200 for jane@example.com"}', browser, 'JSON {success, error}; success false; error text present; no link in it'],
    ['{"url":"nxm://skyrimspecialedition/mods/1/files/200?key=abc&expires=17"}', vortex, 'JSON {url}; unsigned nxm link (no user_id)'],
    ['{"url":"https://files.example.net/a.7z"}', browser, 'JSON {url}; link refused (host-not-allowed:files.example.net)'],
    ['{"url":"http://premium-files.nexus-cdn.com/a.7z"}', browser, 'JSON {url}; link refused (bad-protocol:http)'],
    [JSON.stringify({ fileId: 201, downloadUrl: SECOND_MANUAL_URL }), browser, 'JSON {fileId, downloadUrl}; links only for other files'],
    ['{"url":"nxm://skyrimspecialedition/mods/1/files/200?key=a&expires=1&user_id=2"}', browser, 'JSON {url}; nxm link where the browser needs the file'],
    ['<!doctype html><html><body><h3 id="Notice7-title">Adult content disabled</h3></body></html>', vortex, 'HTML page; adult-content notice; no link in it'],
    ['<!doctype html><html><body><h3 id="Notice7-title">Removed by author</h3></body></html>', browser, 'HTML page; removed-or-hidden notice; no link in it'],
    ['<!doctype html><html><body><button id="slowDownloadButton">Slow download</button></body></html>', vortex, 'HTML page; slow-download button; no link in it'],
    ['', browser, 'empty body; no link in it'],
    ['[]', browser, 'empty JSON list; no link in it'],
    ['Service Unavailable', browser, 'plain text body; no link in it']
  ]) {
    assert.equal(Parser.explainMissingLink(text, options), expected, `explained: ${text.slice(0, 60) || '(empty)'}`);
  }
  assert.doesNotMatch(Parser.explainMissingLink('{"error":"Invalid file 200 for jane@example.com"}', browser), /jane|200|Invalid/,
    'the answer\'s own text never reaches the explanation');

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

function readsVortexLinksOnLegacyChromium() {
  const legacy = new LegacyChromiumURL(VORTEX_URL);
  assert.equal(legacy.hostname, '', 'the stand-in reproduces the old parser');
  assert.equal(legacy.pathname, '//newvegas/mods/100/files/200', 'down to the pathname');

  const context = loadWorkerParser({ url: LegacyChromiumURL });
  const Parser = context.NXTKDownloadParser;
  runParserCases({
    parse: (text, options) => Parser.findDownloadLink(text, options),
    parseNxmDownloadLink: (text) => Parser.findSignedNxmLink(text),
    label: 'legacy chromium'
  });
  assert.equal(Parser.isSignedNxmLink(VORTEX_URL), true, 'a signed handoff link is recognised on Chrome 119');
  assert.equal(Parser.findSignedNxmLink(JSON.stringify({ url: VORTEX_URL })), VORTEX_URL,
    'and found in the GenerateDownloadUrl answer');
  assert.equal(Parser.isSignedNxmLink('nxm://newvegas/mods/x/files/200?key=a&expires=1&user_id=7'), false,
    'the checks still apply there');
  assert.equal(Parser.isSignedNxmLink('nxm://user@newvegas/mods/100/files/200?key=a&expires=1&user_id=7'), false,
    'a link with credentials in it is refused');
  assert.equal(Parser.isSignedNxmLink('nxm://newvegas:8080/mods/100/files/200?key=a&expires=1&user_id=7'), false,
    'and so is one with a port');
  assert.equal(context.NXTK.sanitizeUrlForReport(VORTEX_URL), 'nxm://newvegas/mods/100/files/200 (query removed)',
    'a report names the link the same way');
  assert.equal(context.NXTK.validateDownloadTarget(VORTEX_URL, { method: 0 }).hostname, 'newvegas',
    'and the download check reads its game');

  // Vortex hands a link only to the download waiting for that game, mod and file, so a link for
  // another file is never taken for this one.
  const other = 'nxm://newvegas/mods/100/files/999?key=b&expires=1&user_id=7';
  const both = JSON.stringify({ links: [other, VORTEX_URL] });
  assert.equal(Parser.nxmFileId(VORTEX_URL), '200');
  assert.equal(Parser.nxmFileId('nxm://newvegas/mods/100/files/0200/?key=a'), '200', 'leading zeros and a trailing slash read as Vortex reads them');
  assert.equal(Parser.nxmFileId('nxm://newvegas/collections/abc/revisions/3'), '', 'a collection link names no file');
  assert.equal(Parser.findSignedNxmLink(both), other, 'without a file id the first signed link is taken');
  assert.equal(Parser.findSignedNxmLink(both, { fileId: '200' }), VORTEX_URL, 'with one, the link for that file');
  assert.equal(Parser.findSignedNxmLink(other, { fileId: '200' }), null, 'and never another file\'s');
  assert.equal(Parser.findDownloadLink(JSON.stringify({ url: other }), { mode: 'vortex', fileId: '200' }), null,
    'a generator answer that hands back another file\'s link gives no link');
  assert.equal(Parser.findDownloadLink(JSON.stringify({ url: VORTEX_URL }), { mode: 'vortex', fileId: '200' })?.url, VORTEX_URL);
  assert.match(Parser.explainMissingLink(JSON.stringify({ url: other }), { mode: 'vortex', fileId: '200' }), /nxm link for another file/,
    'and a report says so');
}

// Nexus's file components and /api/files/<id>/download routes name a file by its uid: the game id
// times 2^32 plus the file id (Final Fantasy XII is game 2304, so its file 2394 is 9895604652378).
// Taken as a file id, it matched no nxm link and made every right link look like another file's.
function readsFileUids(Parser) {
  const UID = '9895604652378';
  assert.equal(Parser.normalizeFileId(UID), '2394', 'a uid reads as the file id it carries');
  assert.equal(Parser.normalizeFileId(Number(UID)), '2394', 'as a number too');
  assert.equal(Parser.normalizeFileId('2394'), '2394');
  assert.equal(Parser.normalizeFileId(' 0200 '), '200', 'leading zeros and spaces read as the id');
  assert.equal(Parser.normalizeFileId('472446402760'), '200', 'a 12-digit uid (a game id under 233) is a uid as well');
  for (const bad of ['', '0', 'abc', '-5', '1.5', '3000000000', String(2304 * 2 ** 32), '99999999999999999999', null, undefined]) {
    assert.equal(Parser.normalizeFileId(bad), '', `${String(bad)} names no file`);
  }

  const nxm = (file) => `nxm://finalfantasy12/mods/375/files/${file}?key=k&expires=1&user_id=7`;
  const page = `<p>${nxm(2393)}</p><p>${nxm(2394)}</p>`;
  assert.equal(Parser.findSignedNxmLink(page, { fileId: UID }), nxm(2394), 'a uid scopes the search to its file');
  assert.equal(Parser.findSignedNxmLink(nxm(2393), { fileId: UID }), null, 'and never takes the other file');

  // Two files on one files tab, each modal naming its file only by uid, slashes escaped as Nexus writes them.
  const modal = (uid) => `<mod-download-modal file='${JSON.stringify({
    name: 'A', uid: Number(uid),
    downloadUrl: `https://www.nexusmods.com/api/files/${uid}/download`,
    vortexDownloadUrl: `https://www.nexusmods.com/api/files/${uid}/download?nmm=1`
  }).replace(/\//g, '\\/')}'></mod-download-modal>`;
  const tab = modal('9895604652377') + modal(UID);
  assert.equal(Parser.findDownloadLink(tab, { mode: 'vortex', fileId: '2394' })?.url,
    `https://www.nexusmods.com/api/files/${UID}/download?nmm=1`, 'the modal for the requested file is the one read');
  assert.doesNotMatch(Parser.explainMissingLink(modal('9895604652377'), { mode: 'vortex', fileId: '2394' }), /usable link/,
    'a modal that names another file by uid is not this file\'s link');
}

const Parser = workerRunsEveryCase();
workerEdgeCases(Parser);
readsFileUids(Parser);
failsClosedWithoutShared();
readsVortexLinksOnLegacyChromium();
console.log('download-url parser behavior OK');
